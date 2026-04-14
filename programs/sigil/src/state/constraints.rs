use anchor_lang::prelude::*;
use anchor_spl::token::ID as SPL_TOKEN_PROGRAM_ID;

use super::TOKEN_2022_PROGRAM_ID;
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

/// BYTE LAYOUT REGISTRY — Canonical assignment of padding bytes.
///
/// Both `feat/multi-format-discriminator` and `feat/actiontype-elimination`
/// branches carve fields from the original 6-byte `_padding`. This registry
/// is the single source of truth. When merging, the layout MUST be:
///
///   byte 554: discriminator_format  (this branch)
///   byte 555: is_spending           (actiontype-elimination branch)
///   byte 556: position_effect       (actiontype-elimination branch)
///   bytes 557-559: _padding[3]      (reserved for future use)
///
/// Total: 32+320+200+1+1+1+1+1+3 = 560 (unchanged).
/// The branch that merges second MUST rebase and adjust its slot to match.
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
        // Enforce consistent discriminator_format per program_id.
        // Mixed formats for the same program create OR-logic dominance
        // where the loosest format (Spl1) nullifies stricter entries (Anchor8).
        {
            let mut seen_formats: [(Pubkey, DiscriminatorFormat); MAX_CONSTRAINT_ENTRIES] =
                [(Pubkey::default(), DiscriminatorFormat::Anchor8); MAX_CONSTRAINT_ENTRIES];
            let mut seen_count = 0usize;
            for entry in entries {
                let mut found = false;
                for seen in seen_formats.iter().take(seen_count) {
                    if seen.0 == entry.program_id {
                        require!(
                            seen.1 == entry.discriminator_format,
                            SigilError::InvalidConstraintConfig
                        );
                        found = true;
                        break;
                    }
                }
                if !found {
                    seen_formats[seen_count] = (entry.program_id, entry.discriminator_format);
                    seen_count += 1;
                }
            }
        }

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
            // Non-zero discriminator value required. All-zero values are either
            // accidentally uninitialized or a bypass attempt. This also blocks
            // SPL Token's InitializeMint (opcode 0x00) when format=Spl1, which
            // is correct — agents should never initialize new token mints.
            require!(
                first.value.iter().any(|&b| b != 0),
                SigilError::InvalidConstraintConfig
            );

            // Bind Spl1 format to SPL Token / Token-2022 program IDs.
            // Spl1 reduces the A5 discriminator minimum from 8 bytes to 1.
            // This is only safe for programs that use 1-byte enum discriminators.
            // Applying Spl1 to an Anchor program (8-byte SHA-256 discriminators)
            // would create first-byte collisions (~N/256 probability per instruction).
            // This check eliminates that attack vector entirely.
            if entry.discriminator_format == DiscriminatorFormat::Spl1 {
                require!(
                    entry.program_id == SPL_TOKEN_PROGRAM_ID
                        || entry.program_id == TOKEN_2022_PROGRAM_ID,
                    SigilError::InvalidConstraintConfig
                );

                // Reject Spl1 entries whose discriminator targets a blocked SPL opcode.
                // These opcodes are hard-rejected by scan_instruction_shared() in
                // validate_and_authorize.rs before constraint verification runs.
                // Creating constraint entries for them is misleading — they will
                // never match a real instruction because the instruction gets
                // blocked first. Blocked: Transfer(3), Approve(4), SetAuthority(6),
                // Burn(8), CloseAccount(9), TransferChecked(12), ApproveChecked(13),
                // BurnChecked(15), TransferCheckedWithFee(26, Token-2022 only).
                // Opcode 26 is safe to block universally — it doesn't exist on
                // base SPL Token and will never be submitted for that program.
                // first.value.len() >= 1 guaranteed by min_discriminator_len check above
                const BLOCKED_SPL_OPCODES: [u8; 9] = [3, 4, 6, 8, 9, 12, 13, 15, 26];
                require!(
                    !BLOCKED_SPL_OPCODES.contains(&first.value[0]),
                    SigilError::BlockedSplOpcode
                );
            }

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
    use bytemuck::Zeroable;

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
        // For Spl1 format, use the real SPL Token program ID (required by H-1 binding).
        // For Anchor8, use default (any program).
        let program_id = match format {
            DiscriminatorFormat::Spl1 => SPL_TOKEN_PROGRAM_ID,
            DiscriminatorFormat::Anchor8 => Pubkey::default(),
        };
        ConstraintEntry {
            program_id,
            data_constraints,
            account_constraints: vec![],
            is_spending: 1,
            position_effect: 0,
            discriminator_format: format,
        }
    }

    fn mk_entry_with_program(
        data_constraints: Vec<DataConstraint>,
        format: DiscriminatorFormat,
        program_id: Pubkey,
    ) -> ConstraintEntry {
        ConstraintEntry {
            program_id,
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
        // SPL Token MintTo = opcode 0x07 (1 byte, non-blocked). Format Spl1 allows >= 1.
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x07], // SPL Token MintTo (non-blocked)
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
                value: vec![0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01],
                // SPL MintTo(0x07) + amount=1 (u64 LE) — non-blocked opcode
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
    fn validate_entries_spl1_with_freeze_account_discriminator() {
        // SPL Token FreezeAccount = opcode 0x0A (10). Non-blocked opcode.
        let entries = vec![mk_entry_with_format(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x0A], // FreezeAccount (non-blocked)
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
                value: vec![0x07], // Non-blocked opcode, but wrong operator
            }],
            DiscriminatorFormat::Spl1,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    // ─── Security elimination tests ────────────────────────────────────────

    #[test]
    fn validate_entries_rejects_spl1_on_non_spl_program() {
        // H-1 elimination: Spl1 format MUST be paired with SPL Token or Token-2022.
        // Using Spl1 on a random program (Pubkey::default) must be rejected.
        let entries = vec![mk_entry_with_program(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x07],
            }],
            DiscriminatorFormat::Spl1,
            Pubkey::default(), // Not SPL Token — rejected
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_accepts_spl1_on_spl_token_program() {
        // H-1: Spl1 on the actual SPL Token program ID is accepted.
        let entries = vec![mk_entry_with_program(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x07], // MintTo (non-blocked)
            }],
            DiscriminatorFormat::Spl1,
            SPL_TOKEN_PROGRAM_ID,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_accepts_spl1_on_token_2022_program() {
        // H-1: Spl1 on Token-2022 program ID is accepted.
        let entries = vec![mk_entry_with_program(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x07], // MintTo (non-blocked)
            }],
            DiscriminatorFormat::Spl1,
            TOKEN_2022_PROGRAM_ID,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_rejects_spl1_with_blocked_transfer_opcode() {
        // M-1 elimination: Spl1 + Transfer(0x03) is unreachable at runtime
        // because scan_instruction_shared blocks it first. Reject at creation.
        let entries = vec![mk_entry_with_program(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x03], // Transfer — blocked
            }],
            DiscriminatorFormat::Spl1,
            SPL_TOKEN_PROGRAM_ID,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_rejects_spl1_with_blocked_approve_opcode() {
        // M-1: Approve(0x04) is also blocked at runtime.
        let entries = vec![mk_entry_with_program(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x04], // Approve — blocked
            }],
            DiscriminatorFormat::Spl1,
            SPL_TOKEN_PROGRAM_ID,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_accepts_spl1_with_non_blocked_opcode() {
        // M-1: MintTo(0x07) is NOT in the blocked list — constraint is valid.
        let entries = vec![mk_entry_with_program(
            vec![DataConstraint {
                offset: 0,
                operator: ConstraintOperator::Eq,
                value: vec![0x07], // MintTo — NOT blocked
            }],
            DiscriminatorFormat::Spl1,
            SPL_TOKEN_PROGRAM_ID,
        )];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_entries_rejects_mixed_format_same_program() {
        // M-2 elimination: Two entries for same program_id with different formats
        // create OR-logic dominance. Must be rejected.
        let entries = vec![
            mk_entry_with_program(
                vec![discriminator_anchor()],
                DiscriminatorFormat::Anchor8,
                SPL_TOKEN_PROGRAM_ID,
            ),
            mk_entry_with_program(
                vec![DataConstraint {
                    offset: 0,
                    operator: ConstraintOperator::Eq,
                    value: vec![0x07],
                }],
                DiscriminatorFormat::Spl1,
                SPL_TOKEN_PROGRAM_ID,
            ),
        ];
        assert!(InstructionConstraints::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_entries_accepts_same_format_same_program() {
        // M-2: Two Spl1 entries for same program_id with same format is fine.
        let entries = vec![
            mk_entry_with_program(
                vec![DataConstraint {
                    offset: 0,
                    operator: ConstraintOperator::Eq,
                    value: vec![0x07], // MintTo
                }],
                DiscriminatorFormat::Spl1,
                SPL_TOKEN_PROGRAM_ID,
            ),
            mk_entry_with_program(
                vec![DataConstraint {
                    offset: 0,
                    operator: ConstraintOperator::Eq,
                    value: vec![0x0A], // FreezeAccount
                }],
                DiscriminatorFormat::Spl1,
                SPL_TOKEN_PROGRAM_ID,
            ),
        ];
        assert!(InstructionConstraints::validate_entries(&entries).is_ok());
    }

    // ─── L-1: Write-only semantics defensive test ──────────────────────────

    #[test]
    fn discriminator_format_is_write_only_at_runtime() {
        // L-1: Confirm that an invalid discriminator_format byte in the ZC struct
        // does NOT affect runtime verification. verify_data_constraints_zc() uses
        // value_len directly and never reads discriminator_format. This test pins
        // that behavior — if a future change reads the field at runtime, this
        // test documents that it was intentionally write-only.
        let mut entry = ConstraintEntryZC::zeroed();
        entry.discriminator_format = 0xFF; // Invalid format — should be ignored at runtime
        entry.data_count = 1;
        entry.data_constraints[0].offset = 0;
        entry.data_constraints[0].operator = 0; // Eq
        entry.data_constraints[0].value_len = 1;
        entry.data_constraints[0].value[0] = 0x07;

        // Runtime verification should succeed despite invalid format byte
        let ix_data = vec![0x07, 0x00, 0x00, 0x00];
        use crate::instructions::integrations::generic_constraints::verify_data_constraints_zc;
        assert!(verify_data_constraints_zc(&ix_data, &entry).is_ok());
    }

    // ─── L-2: TryFrom<u8> coverage ────────────────────────────────────────

    #[test]
    fn discriminator_format_try_from_valid_values() {
        assert_eq!(
            DiscriminatorFormat::try_from(0),
            Ok(DiscriminatorFormat::Anchor8)
        );
        assert_eq!(
            DiscriminatorFormat::try_from(1),
            Ok(DiscriminatorFormat::Spl1)
        );
    }

    #[test]
    fn discriminator_format_try_from_rejects_invalid_values() {
        assert!(DiscriminatorFormat::try_from(2).is_err());
        assert!(DiscriminatorFormat::try_from(3).is_err());
        assert!(DiscriminatorFormat::try_from(127).is_err());
        assert!(DiscriminatorFormat::try_from(255).is_err());
    }

    #[test]
    fn discriminator_format_round_trip_discriminants() {
        assert_eq!(DiscriminatorFormat::Anchor8 as u8, 0);
        assert_eq!(DiscriminatorFormat::Spl1 as u8, 1);
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
        // Zero stale data before packing. Eliminates ghost bytes in unused
        // DC/AC slots, value bytes beyond value_len, and padding fields.
        // ConstraintEntryZC implements Zeroable via #[zero_copy].
        dst[i] = bytemuck::Zeroable::zeroed();

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
