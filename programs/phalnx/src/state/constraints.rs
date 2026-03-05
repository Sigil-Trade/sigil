use anchor_lang::prelude::*;

use crate::errors::PhalnxError;

pub const MAX_CONSTRAINT_ENTRIES: usize = 10;
pub const MAX_DATA_CONSTRAINTS_PER_ENTRY: usize = 5;
pub const MAX_CONSTRAINT_VALUE_LEN: usize = 32;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum ConstraintOperator {
    Eq,  // exact match
    Ne,  // not equal
    Gte, // >= (LE unsigned integer)
    Lte, // <= (LE unsigned integer)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct DataConstraint {
    pub offset: u16,                  // 2
    pub operator: ConstraintOperator, // 1
    pub value: Vec<u8>,               // 4 + max 32
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct ConstraintEntry {
    pub program_id: Pubkey,                    // 32
    pub data_constraints: Vec<DataConstraint>, // bounded to MAX_DATA_CONSTRAINTS_PER_ENTRY
}

#[account]
pub struct InstructionConstraints {
    pub vault: Pubkey,                 // 32
    pub entries: Vec<ConstraintEntry>, // bounded to MAX_CONSTRAINT_ENTRIES
    pub bump: u8,                      // 1
}

impl InstructionConstraints {
    // SIZE calculation: worst case
    // 8 (disc) + 32 (vault) + 4 (vec len) +
    //   10 * (32 (program_id) + 4 (vec len) + 5 * (2 + 1 + 4 + 32)) +
    //   1 (bump)
    // = 8 + 32 + 4 + 10 * (32 + 4 + 5 * 39) + 1
    // = 8 + 32 + 4 + 10 * (36 + 195) + 1
    // = 8 + 32 + 4 + 10 * 231 + 1
    // = 8 + 32 + 4 + 2310 + 1 = 2355
    pub const SIZE: usize = 2355;

    pub fn validate_entries(entries: &[ConstraintEntry]) -> Result<()> {
        require!(
            entries.len() <= MAX_CONSTRAINT_ENTRIES,
            PhalnxError::InvalidConstraintConfig
        );
        for entry in entries {
            require!(
                entry.data_constraints.len() <= MAX_DATA_CONSTRAINTS_PER_ENTRY,
                PhalnxError::InvalidConstraintConfig
            );
            for dc in &entry.data_constraints {
                require!(
                    dc.value.len() <= MAX_CONSTRAINT_VALUE_LEN,
                    PhalnxError::InvalidConstraintConfig
                );
            }
        }
        Ok(())
    }
}
