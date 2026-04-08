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
    pub _padding: [u8; 6], // 6 (align: 32+320+200+1+1+6=560)
}
// = 560 bytes

#[account(zero_copy)]
pub struct InstructionConstraints {
    pub vault: [u8; 32],                                      // 32
    pub entries: [ConstraintEntryZC; MAX_CONSTRAINT_ENTRIES], // 64 * 560 = 35,840
    pub entry_count: u8,                                      // 1 (active entries, 0..=64)
    pub strict_mode: u8,   // 1 (0 = permissive, non-zero = strict)
    pub bump: u8,          // 1
    pub _padding: [u8; 5], // 5 (align: 32+35840+1+1+1+5=35880)
}

impl InstructionConstraints {
    // SIZE = 8 (discriminator) + 35,880 (fields) = 35,888 bytes
    pub const SIZE: usize = 8 + 32 + (560 * MAX_CONSTRAINT_ENTRIES) + 1 + 1 + 1 + 5;

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
            // an Eq at offset 0 with a non-zero value of at least 8 bytes
            // (standard Anchor instruction discriminator width). This check
            // supersedes the old "reject fully empty entries" rule since a
            // non-empty data_constraints implies a non-empty entry.
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
            require!(first.value.len() >= 8, SigilError::InvalidConstraintConfig);
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
    }
    *count_out = entries.len() as u8;
    Ok(())
}
