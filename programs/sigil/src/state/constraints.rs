use anchor_lang::prelude::*;

use crate::errors::SigilError;

pub const MAX_CONSTRAINT_ENTRIES: usize = 64;
pub const MAX_DATA_CONSTRAINTS_PER_ENTRY: usize = 8;
pub const MAX_CONSTRAINT_VALUE_LEN: usize = 32;
pub const MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY: usize = 5;

// ─── Borsh types (used as instruction parameters — DO NOT REMOVE) ───────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum ConstraintOperator {
    Eq,        // 0: exact byte match
    Ne,        // 1: not equal
    Gte,       // 2: >= (LE unsigned integer)
    Lte,       // 3: <= (LE unsigned integer)
    GteSigned, // 4: >= (LE signed integer, two's complement)
    LteSigned, // 5: <= (LE signed integer, two's complement)
    Bitmask,   // 6: (actual & mask) == mask (all mask bits must be set)
}

impl TryFrom<u8> for ConstraintOperator {
    type Error = ();
    fn try_from(v: u8) -> core::result::Result<Self, Self::Error> {
        match v {
            0 => Ok(ConstraintOperator::Eq),
            1 => Ok(ConstraintOperator::Ne),
            2 => Ok(ConstraintOperator::Gte),
            3 => Ok(ConstraintOperator::Lte),
            4 => Ok(ConstraintOperator::GteSigned),
            5 => Ok(ConstraintOperator::LteSigned),
            6 => Ok(ConstraintOperator::Bitmask),
            _ => Err(()),
        }
    }
}

/// Discriminator format for the first DataConstraint in a ConstraintEntry.
/// Controls the minimum byte length required for the instruction discriminator
/// anchor (A5 invariant). Different Solana programs use different discriminator
/// widths — Anchor uses 8-byte SHA-256 prefixes, SPL Token uses 1-byte enum
/// indices. The format is checked at constraint creation time only; runtime
/// verification in verify_data_constraints_zc() uses value_len directly.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum DiscriminatorFormat {
    /// 8-byte Anchor discriminator (SHA-256("global:<name>")[0..8]).
    /// Default for all programs. Zero-initialized _padding maps here.
    Anchor8 = 0,
    /// 1-byte SPL Token / Token-2022 instruction enum index.
    /// Transfer=0x03, Approve=0x04, TransferChecked=0x0C, etc.
    Spl1 = 1,
}

impl DiscriminatorFormat {
    /// Minimum byte length for the first DataConstraint value under this format.
    pub fn min_discriminator_len(&self) -> usize {
        match self {
            DiscriminatorFormat::Anchor8 => 8,
            DiscriminatorFormat::Spl1 => 1,
        }
    }
}

impl TryFrom<u8> for DiscriminatorFormat {
    type Error = ();
    fn try_from(v: u8) -> core::result::Result<Self, Self::Error> {
        match v {
            0 => Ok(DiscriminatorFormat::Anchor8),
            1 => Ok(DiscriminatorFormat::Spl1),
            _ => Err(()),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct DataConstraint {
    pub offset: u16,                  // 2
    pub operator: ConstraintOperator, // 1
    pub value: Vec<u8>,               // 4 + max 32
}

/// Account-index constraint: requires a specific pubkey at a specific account index.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct AccountConstraint {
    pub index: u8,        // 1
    pub expected: Pubkey, // 32
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct ConstraintEntry {
    pub program_id: Pubkey,                          // 32
    pub data_constraints: Vec<DataConstraint>,       // bounded to MAX_DATA_CONSTRAINTS_PER_ENTRY
    pub account_constraints: Vec<AccountConstraint>, // bounded to MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY
    /// Spending classification: 1=Spending, 2=NonSpending. Required (0 rejected).
    pub is_spending: u8,
    /// Position effect: 0=None, 1=Increment, 2=Decrement.
    pub position_effect: u8,
    /// Discriminator format for this entry's target program. Controls the
    /// minimum byte length of the first DataConstraint (the A5 anchor).
    /// Default: Anchor8 (0). Use Spl1 (1) for SPL Token / Token-2022.
    pub discriminator_format: DiscriminatorFormat,
}

// ─── Zero-copy types (on-chain account layout) ─────────────────────────────

#[zero_copy]
pub struct DataConstraintZC {
    pub offset: u16,                           // 2
    pub operator: u8,                          // 1 (ConstraintOperator discriminant 0-6)
    pub value_len: u8,                         // 1 (actual bytes used in value, 1..=32)
    pub value: [u8; MAX_CONSTRAINT_VALUE_LEN], // 32
    pub _padding: [u8; 4],                     // 4 (align to 8 bytes: 2+1+1+32+4=40)
}
// = 40 bytes

#[zero_copy]
pub struct AccountConstraintZC {
    pub expected: [u8; 32], // 32
    pub index: u8,          // 1
    pub _padding: [u8; 7],  // 7 (align to 8 bytes: 32+1+7=40)
}
// = 40 bytes

#[zero_copy]
pub struct ConstraintEntryZC {
    pub program_id: [u8; 32], // 32
    pub data_constraints: [DataConstraintZC; MAX_DATA_CONSTRAINTS_PER_ENTRY], // 8 * 40 = 320
    pub account_constraints: [AccountConstraintZC; MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY], // 5 * 40 = 200
    pub data_count: u8,    // 1 (active data constraints in this entry)
    pub account_count: u8, // 1 (active account constraints in this entry)
    /// Spending classification: 0=Unset (treated as spending), 1=Spending, 2=NonSpending.
    /// Set by vault owner at constraint creation time. The constraint engine returns
    /// this value when it matches an entry — replaces ActionType.is_spending().
    pub is_spending: u8, // 1 (byte 554)
    /// Position tracking: 0=None, 1=Increment (opens position), 2=Decrement (closes position).
    /// Replaces ActionType.position_effect().
    pub position_effect: u8, // 1 (byte 555)
    /// DiscriminatorFormat discriminant (0=Anchor8, 1=Spl1). Write-time only —
    /// verify_data_constraints_zc() does not read this field at runtime.
    /// Zero-initialized on existing V1 PDAs → 0 → Anchor8 (backward compatible).
    pub discriminator_format: u8, // 1 (byte 556)
    pub _padding: [u8; 3], // 3 (32+320+200+1+1+1+1+1+3=560)
}
// = 560 bytes (unchanged)

#[account(zero_copy)]
pub struct InstructionConstraints {
    pub vault: [u8; 32],                                      // 32
    pub entries: [ConstraintEntryZC; MAX_CONSTRAINT_ENTRIES], // 64 * 560 = 35,840
    pub entry_count: u8,                                      // 1 (active entries, 0..=64)
    pub strict_mode: u8, // 1 (0 = permissive, non-zero = strict)
    pub bump: u8,        // 1
    /// Constraint schema version. Always 1 for new deployments.
    pub constraint_version: u8, // 1 (was padding[0])
    pub _padding: [u8; 4], // 4 (reduced from 5: 32+35840+1+1+1+1+4=35880)
}

impl InstructionConstraints {
    // SIZE = 8 (discriminator) + 35,880 (fields) = 35,888 bytes
    // 8 (disc) + 32 (vault) + 35840 (entries) + 1 (entry_count) + 1 (strict_mode) + 1 (bump) + 1 (constraint_version) + 4 (padding) = 35888
    pub const SIZE: usize = 8 + 32 + (560 * MAX_CONSTRAINT_ENTRIES) + 1 + 1 + 1 + 1 + 4;

    /// Validate constraint entries in their Borsh-deserialized form (instruction parameters).
    /// Called before pack_entries() converts them to the zero-copy layout.
    pub fn validate_entries(entries: &[ConstraintEntry]) -> Result<()> {
        require!(
            entries.len() <= MAX_CONSTRAINT_ENTRIES,
            SigilError::InvalidConstraintConfig
        );
        for entry in entries {
            require!(
                entry.data_constraints.len() <= MAX_DATA_CONSTRAINTS_PER_ENTRY,
                SigilError::InvalidConstraintConfig
            );
            require!(
                entry.account_constraints.len() <= MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY,
                SigilError::InvalidConstraintConfig
            );
            // Fix A5: every entry MUST anchor on the target instruction
            // discriminator via its FIRST DataConstraint. Without this, an
            // entry with data_constraints=[] and only account_constraints
            // passes validation and matches ANY instruction with the
            // matching program_id — privilege escalation via account-layout
            // conflation (different Anchor instructions on the same program
            // often share account slots). The first DataConstraint must be
            // an Eq at offset 0 with a non-zero value whose length meets the
            // minimum for the entry's discriminator_format.
            // See docs/SECURITY-FINDINGS-2026-04-07.md Finding 1.
            require!(
                !entry.data_constraints.is_empty(),
                SigilError::InvalidConstraintConfig
            );
            let first = &entry.data_constraints[0];
            require!(first.offset == 0, SigilError::InvalidConstraintConfig);
            require!(
                first.operator == ConstraintOperator::Eq,
                SigilError::InvalidConstraintConfig
            );
            // Format-aware minimum discriminator length (A5 extended).
            // Anchor8 (0) requires >= 8 bytes (original A5 behavior).
            // Spl1 (1) requires >= 1 byte (SPL Token 1-byte opcode).
            let min_len = entry.discriminator_format.min_discriminator_len();
            require!(
                first.value.len() >= min_len,
                SigilError::InvalidConstraintConfig
            );
            require!(
                first.value.iter().any(|&b| b != 0),
                SigilError::InvalidConstraintConfig
            );

            for dc in &entry.data_constraints {
                require!(
                    dc.value.len() <= MAX_CONSTRAINT_VALUE_LEN,
                    SigilError::InvalidConstraintConfig
                );
                // Reject zero-length constraint values
                require!(!dc.value.is_empty(), SigilError::InvalidConstraintConfig);
                // Fix A3: reject all-zero Bitmask masks. They act as universal
                // wildcards because `(actual & 0) == 0` is always true for any
                // input — a policy that looks like a byte-level filter but uses
                // a zero mask is a silent no-op. The `bitmask_check` math
                // primitive in integrations/generic_constraints.rs is left
                // unchanged because its behavior on zero masks is
                // mathematically correct; we block zero masks one layer up so
                // they can never reach it in production.
                // See docs/SECURITY-FINDINGS-2026-04-07.md Finding 2.
                if dc.operator == ConstraintOperator::Bitmask {
                    require!(
                        dc.value.iter().any(|&b| b != 0),
                        SigilError::InvalidConstraintConfig
                    );
                }
            }

            // is_spending must be 1 (Spending) or 2 (NonSpending). 0 (Unset) rejected.
            require!(
                entry.is_spending == 1 || entry.is_spending == 2,
                SigilError::InvalidConstraintConfig
            );
            // position_effect must be 0-2
            require!(
                entry.position_effect <= 2,
                SigilError::InvalidConstraintConfig
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Standard 8-byte Anchor discriminator anchor used by valid test entries.
    fn discriminator_anchor() -> DataConstraint {
        DataConstraint {
            offset: 0,
            operator: ConstraintOperator::Eq,
            value: vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        }
    }

    fn mk_entry(data_constraints: Vec<DataConstraint>) -> ConstraintEntry {
        ConstraintEntry {
            program_id: Pubkey::default(),
            data_constraints,
            account_constraints: vec![],
            is_spending: 1,
            position_effect: 0,
            discriminator_format: DiscriminatorFormat::Anchor8,
        }
    }

    fn mk_entry_with_format(
        data_constraints: Vec<DataConstraint>,
        format: DiscriminatorFormat,
    ) -> ConstraintEntry {
        ConstraintEntry {
            program_id: Pubkey::default(),
            data_constraints,
            account_constraints: vec![],
            is_spending: 1,
            position_effect: 0,
            discriminator_format: format,
        }
    }

    fn mk_entry_with_accounts(
        data_constraints: Vec<DataConstraint>,
        account_constraints: Vec<AccountConstraint>,
    ) -> ConstraintEntry {
        ConstraintEntry {
            program_id: Pubkey::default(),
            data_constraints,
            account_constraints,
            is_spending: 1,
            position_effect: 0,
            discriminator_format: DiscriminatorFormat::Anchor8,
        }
    }

    // ─── A3 tests (zero-mask Bitmask rejection) ─────────────────────────────

    #[test]
    fn validate_entries_rejects_single_byte_zero_mask_bitmask() {
        // A3: Bitmask with all-zero mask at a non-anchor offset is rejected.
        let entries = vec![mk_entry(vec![
            discriminator_anchor(),
            DataConstraint {
                offset: 8,
                operator: ConstraintOperator::Bitmask,
                value: vec![0x00],
            },
        ])];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_rejects_multi_byte_zero_mask_bitmask() {
        let entries = vec![mk_entry(vec![
            discriminator_anchor(),
            DataConstraint {
                offset: 8,
                operator: ConstraintOperator::Bitmask,
                value: vec![0u8; 8],
            },
        ])];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_accepts_non_zero_mask_bitmask() {
        let entries = vec![mk_entry(vec![
            discriminator_anchor(),
            DataConstraint {
                offset: 8,
                operator: ConstraintOperator::Bitmask,
                value: vec![0x00, 0x80, 0x00],
            },
        ])];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_accepts_all_zero_eq_value_at_non_anchor_offset() {
        // Non-anchor Eq with all-zero value is a legitimate constraint
        // (e.g., "bytes 8..16 must be zero"). Only the FIRST DC must be a
        // non-zero discriminator anchor (Fix A5).
        let entries = vec![mk_entry(vec![
            discriminator_anchor(),
            DataConstraint {
                offset: 8,
                operator: ConstraintOperator::Eq,
                value: vec![0u8; 8],
            },
        ])];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    // ─── A5 tests (discriminator anchor invariant) ──────────────────────────

    #[test]
    fn validate_entries_rejects_empty_data_constraints_with_accounts() {
        // A5 PoC: account-only entry matches ANY instruction on the
        // program_id. Must be rejected at validation time.
        let entries = vec![mk_entry_with_accounts(
            vec![],
            vec![AccountConstraint {
                index: 0,
                expected: Pubkey::default(),
            }],
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_rejects_fully_empty_entry() {
        // Trivially invalid: no data, no accounts. The A5 check catches
        // this as a side effect (data_constraints must be non-empty).
        let entries = vec![mk_entry(vec![])];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_rejects_first_dc_not_eq() {
        // First DC must be Eq. Lte @ offset 0 is a range pin, not an
        // instruction discriminator — reject.
        let entries = vec![mk_entry(vec![DataConstraint {
            offset: 0,
            operator: ConstraintOperator::Lte,
            value: vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        }])];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_rejects_first_dc_at_nonzero_offset() {
        // First DC must be at offset 0 (instruction discriminator byte
        // range). Eq @ offset 8 is not an anchor.
        let entries = vec![mk_entry(vec![DataConstraint {
            offset: 8,
            operator: ConstraintOperator::Eq,
            value: vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        }])];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_rejects_first_dc_short_value() {
        // Standard Anchor discriminator is 8 bytes. Shorter values do not
        // form a full discriminator match.
        let entries = vec![mk_entry(vec![DataConstraint {
            offset: 0,
            operator: ConstraintOperator::Eq,
            value: vec![0x01, 0x02, 0x03, 0x04],
        }])];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_rejects_first_dc_all_zero_value() {
        // An all-zero "discriminator" is almost certainly a caller bug or
        // a bypass attempt — Blake3 discriminators are effectively never
        // all zero. Reject unambiguously.
        let entries = vec![mk_entry(vec![DataConstraint {
            offset: 0,
            operator: ConstraintOperator::Eq,
            value: vec![0u8; 8],
        }])];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_accepts_valid_anchor_only() {
        // Minimal valid entry: just the discriminator anchor. Pins a
        // specific Anchor instruction with no additional field-level or
        // account-level checks.
        let entries = vec![mk_entry(vec![discriminator_anchor()])];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_accepts_anchor_plus_account_constraint() {
        // Anchor + account constraint: pin the instruction AND require a
        // specific pubkey at a specific account index.
        let entries = vec![mk_entry_with_accounts(
            vec![discriminator_anchor()],
            vec![AccountConstraint {
                index: 3,
                expected: Pubkey::default(),
            }],
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_accepts_anchor_with_longer_value() {
        // First DC can be longer than 8 bytes — discriminator + first arg
        // bytes all constrained as one Eq match.
        let entries = vec![mk_entry(vec![DataConstraint {
            offset: 0,
            operator: ConstraintOperator::Eq,
            value: vec![
                0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, // discriminator
                0xAA, 0xBB, 0xCC, 0xDD, // + first 4 arg bytes
            ],
        }])];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    // ─── Multi-format discriminator tests ──────────────────────────────────

    #[test]
    fn validate_entries_accepts_spl1_format_with_1_byte_discriminator() {
        // SPL Token Transfer = opcode 0x03 (1 byte). Format Spl1 allows >= 1.
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x03], // SPL Token Transfer
            }],
            DiscriminatorFormat::Spl1,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_rejects_spl1_format_with_empty_value() {
        // Spl1 requires >= 1 byte. Empty value must be rejected.
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![],
            }],
            DiscriminatorFormat::Spl1,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_rejects_spl1_format_with_all_zero_value() {
        // Even with Spl1, all-zero discriminator is rejected (non-zero check).
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x00],
            }],
            DiscriminatorFormat::Spl1,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_accepts_spl1_format_with_longer_value() {
        // Spl1 with a value longer than 1 byte is valid — pins discriminator
        // plus additional argument bytes in one Eq match.
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01],
                // SPL Transfer + amount=1 (u64 LE)
            }],
            DiscriminatorFormat::Spl1,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_legacy_format_0_still_requires_8_bytes() {
        // Regression: format=Anchor8 with a 4-byte value must still be
        // rejected. The original A5 behavior is preserved for format 0.
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x01, 0x02, 0x03, 0x04],
            }],
            DiscriminatorFormat::Anchor8,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_format_0_default_backward_compatible() {
        // Format=Anchor8 with a full 8-byte discriminator works exactly
        // as before — existing behavior unchanged.
        let entries = vec![mk_entry_with_format(
            vec![discriminator_anchor()],
            DiscriminatorFormat::Anchor8,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_spl1_with_transfer_checked_discriminator() {
        // SPL Token TransferChecked = opcode 0x0C. Verify a real opcode.
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x0C], // TransferChecked
            }],
            DiscriminatorFormat::Spl1,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_spl1_still_requires_eq_at_offset_0() {
        // Even with Spl1 format, the A5 invariant requires Eq at offset 0.
        // Lte at offset 0 must be rejected regardless of format.
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Lte,
                value: vec![0x03],
            }],
            DiscriminatorFormat::Spl1,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }
}

/// Pack Borsh-deserialized constraint entries into the zero-copy fixed-array layout.
/// Called by create, queue, and apply handlers after validate_entries().
pub(crate) fn pack_entries(
    entries: &[ConstraintEntry],
    dst: &mut [ConstraintEntryZC; MAX_CONSTRAINT_ENTRIES],
    count_out: &mut u8,
) -> Result<()> {
    for (i, entry) in entries.iter().enumerate() {
        dst[i].program_id = entry.program_id.to_bytes();
        dst[i].data_count = entry.data_constraints.len() as u8;
        dst[i].account_count = entry.account_constraints.len() as u8;
        // Write-time metadata: discriminator format for A5 validation.
        // verify_data_constraints_zc() does not read this at runtime.
        dst[i].discriminator_format = entry.discriminator_format as u8;

        for (j, dc) in entry.data_constraints.iter().enumerate() {
            dst[i].data_constraints[j].offset = dc.offset;
            dst[i].data_constraints[j].operator = dc.operator as u8;
            dst[i].data_constraints[j].value_len = dc.value.len() as u8;
            dst[i].data_constraints[j].value[..dc.value.len()].copy_from_slice(&dc.value);
        }

        for (k, ac) in entry.account_constraints.iter().enumerate() {
            dst[i].account_constraints[k].expected = ac.expected.to_bytes();
            dst[i].account_constraints[k].index = ac.index;
        }

        // Copy spending classification + position effect to zero-copy layout.
        // Without this, fields default to 0 (Pod zero-init), silently
        // breaking spending classification and position tracking on-chain.
        dst[i].is_spending = entry.is_spending;
        dst[i].position_effect = entry.position_effect;
    }
    *count_out = entries.len() as u8;
    Ok(())
}
