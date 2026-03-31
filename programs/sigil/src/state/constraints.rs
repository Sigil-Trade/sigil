use anchor_lang::prelude::*;

use crate::errors::SigilError;

pub const MAX_CONSTRAINT_ENTRIES: usize = 16;
pub const MAX_DATA_CONSTRAINTS_PER_ENTRY: usize = 8;
pub const MAX_CONSTRAINT_VALUE_LEN: usize = 32;
pub const MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY: usize = 5;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum ConstraintOperator {
    Eq,        // 0: exact byte match
    Ne,        // 1: not equal
    Gte,       // 2: >= (LE unsigned integer)
    Lte,       // 3: <= (LE unsigned integer)
    GteSigned, // 4: >= (LE signed integer, two's complement)
    LteSigned, // 5: <= (LE signed integer, two's complement)
    Bitmask,   // 6: (actual & mask) == mask (all mask bits must be set)
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

#[account]
pub struct InstructionConstraints {
    pub vault: Pubkey,                 // 32
    pub entries: Vec<ConstraintEntry>, // bounded to MAX_CONSTRAINT_ENTRIES
    pub strict_mode: bool,             // 1 — reject programs without matching entries
    pub bump: u8,                      // 1
}

impl InstructionConstraints {
    // SIZE calculation: worst case
    // 8 (disc) + 32 (vault) + 4 (vec len) +
    //   16 * (32 (program_id) + 4 (data_constraints vec len) + 8 * (2 + 1 + 4 + 32)
    //          + 4 (account_constraints vec len) + 5 * (1 + 32)) +
    //   1 (strict_mode) + 1 (bump)
    // = 8 + 32 + 4 + 16 * (32 + 4 + 312 + 4 + 165) + 1 + 1
    // = 8 + 32 + 4 + 16 * 517 + 1 + 1 = 8318
    pub const SIZE: usize = 8318;

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
            // Reject fully empty entries (no data_constraints AND no account_constraints)
            require!(
                !entry.data_constraints.is_empty() || !entry.account_constraints.is_empty(),
                SigilError::InvalidConstraintConfig
            );
            for dc in &entry.data_constraints {
                require!(
                    dc.value.len() <= MAX_CONSTRAINT_VALUE_LEN,
                    SigilError::InvalidConstraintConfig
                );
                // Reject zero-length constraint values
                require!(!dc.value.is_empty(), SigilError::InvalidConstraintConfig);
            }
        }
        Ok(())
    }
}
