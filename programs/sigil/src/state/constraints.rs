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
    pub offset: u16,                              // 2
    pub operator: u8,                             // 1 (ConstraintOperator discriminant 0-6)
    pub value_len: u8,                            // 1 (actual bytes used in value, 1..=32)
    pub value: [u8; MAX_CONSTRAINT_VALUE_LEN],    // 32
    pub _padding: [u8; 4],                        // 4 (align to 8 bytes: 2+1+1+32+4=40)
}
// = 40 bytes

#[zero_copy]
pub struct AccountConstraintZC {
    pub expected: [u8; 32],   // 32
    pub index: u8,            // 1
    pub _padding: [u8; 7],    // 7 (align to 8 bytes: 32+1+7=40)
}
// = 40 bytes

#[zero_copy]
pub struct ConstraintEntryZC {
    pub program_id: [u8; 32],                                                           // 32
    pub data_constraints: [DataConstraintZC; MAX_DATA_CONSTRAINTS_PER_ENTRY],            // 8 * 40 = 320
    pub account_constraints: [AccountConstraintZC; MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY],   // 5 * 40 = 200
    pub data_count: u8,       // 1 (active data constraints in this entry)
    pub account_count: u8,    // 1 (active account constraints in this entry)
    pub _padding: [u8; 6],    // 6 (align: 32+320+200+1+1+6=560)
}
// = 560 bytes

#[account(zero_copy)]
pub struct InstructionConstraints {
    pub vault: [u8; 32],                                                // 32
    pub entries: [ConstraintEntryZC; MAX_CONSTRAINT_ENTRIES],           // 64 * 560 = 35,840
    pub entry_count: u8,      // 1 (active entries, 0..=64)
    pub strict_mode: u8,      // 1 (0 = permissive, non-zero = strict)
    pub bump: u8,             // 1
    pub _padding: [u8; 5],    // 5 (align: 32+35840+1+1+1+5=35880)
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
            dst[i].data_constraints[j].value[..dc.value.len()]
                .copy_from_slice(&dc.value);
        }

        for (k, ac) in entry.account_constraints.iter().enumerate() {
            dst[i].account_constraints[k].expected = ac.expected.to_bytes();
            dst[i].account_constraints[k].index = ac.index;
        }
    }
    *count_out = entries.len() as u8;
    Ok(())
}
