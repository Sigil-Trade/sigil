use anchor_lang::prelude::*;

use crate::state::constraints::{ConstraintOperator, MAX_CONSTRAINT_VALUE_LEN};

/// Maximum number of post-execution assertion entries per vault.
/// Kept small to limit compute cost in finalize_session.
pub const MAX_POST_ASSERTION_ENTRIES: usize = 4;

/// Post-execution assertion: checks account data bytes AFTER the DeFi
/// instruction executes, within the same atomic transaction.
///
/// Same bytes-at-offset pattern as DataConstraintZC, but applied to
/// account data instead of instruction data. Protocol-agnostic — the
/// vault owner configures byte offsets from protocol documentation.
///
/// Phase B1: absolute value assertions (check field ≤ max, field ≥ min).
/// Phase B3 will add CrossFieldLte for leverage ratio enforcement.
#[zero_copy]
pub struct PostAssertionEntryZC {
    /// The account to read after execution (passed via remaining_accounts).
    /// Typically a Position PDA, User account, or similar protocol state.
    pub target_account: [u8; 32], // 32

    /// Byte offset in the target account's data to read.
    pub offset: u16, // 2

    /// Length of the value to compare (1-32 bytes).
    pub value_len: u8, // 1

    /// Comparison operator (reuses ConstraintOperator: Eq, Ne, Gte, Lte, etc.)
    pub operator: u8, // 1

    /// Expected value for comparison (same max as DataConstraint).
    pub expected_value: [u8; MAX_CONSTRAINT_VALUE_LEN], // 32

    /// Assertion mode:
    /// 0 = Absolute: check current value against expected_value
    /// 1 = MaxDecrease: check (snapshot - current) ≤ expected_value (Phase B2)
    /// 2 = MaxIncrease: check (current - snapshot) ≤ expected_value (Phase B2)
    /// 3 = NoChange: check current == snapshot (Phase B2)
    pub assertion_mode: u8, // 1

    /// Padding to align to 8 bytes. Total: 32 + 2 + 1 + 1 + 32 + 1 + 7 = 76
    /// Future: 4 bytes for cross-field offset_b (Phase B3 CrossFieldLte)
    /// Future: 2 bytes for cross-field multiplier (Phase B3)
    /// Future: 1 byte for cross-field flags
    pub _padding: [u8; 7], // 7
}
// = 76 bytes per entry

/// On-chain account storing post-execution assertions for a vault.
/// Seeds: [b"post_assertions", vault.key()]
#[account(zero_copy)]
pub struct PostExecutionAssertions {
    /// The vault this assertion set belongs to.
    pub vault: [u8; 32], // 32

    /// Assertion entries (fixed-size array, up to MAX_POST_ASSERTION_ENTRIES).
    pub entries: [PostAssertionEntryZC; MAX_POST_ASSERTION_ENTRIES], // 4 * 76 = 304

    /// Number of active entries (0..=4).
    pub entry_count: u8, // 1

    /// PDA bump seed.
    pub bump: u8, // 1

    /// Reserved for future use.
    pub _padding: [u8; 6], // 6
}
// Total: 8 (discriminator) + 32 + 304 + 1 + 1 + 6 = 352 bytes

impl PostExecutionAssertions {
    pub const SIZE: usize = 8 + 32 + (76 * MAX_POST_ASSERTION_ENTRIES) + 1 + 1 + 6;

    /// Validate a set of assertion entries before storing.
    pub fn validate_entries(entries: &[PostAssertionEntry]) -> Result<()> {
        require!(
            entries.len() <= MAX_POST_ASSERTION_ENTRIES,
            crate::errors::SigilError::InvalidConstraintConfig
        );
        for entry in entries {
            // Value length must be 1-32
            require!(
                entry.value_len > 0 && entry.value_len as usize <= MAX_CONSTRAINT_VALUE_LEN,
                crate::errors::SigilError::InvalidConstraintConfig
            );
            // Operator must be valid (0-6)
            require!(
                ConstraintOperator::try_from(entry.operator).is_ok(),
                crate::errors::SigilError::InvalidConstraintOperator
            );
            // Assertion mode must be 0 for Phase B1 (absolute only)
            require!(
                entry.assertion_mode == 0,
                crate::errors::SigilError::InvalidConstraintConfig
            );
        }
        Ok(())
    }
}

/// Borsh-serializable assertion entry (instruction parameter form).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PostAssertionEntry {
    pub target_account: Pubkey,
    pub offset: u16,
    pub value_len: u8,
    pub operator: u8,
    pub expected_value: Vec<u8>,
    pub assertion_mode: u8,
}
