use anchor_lang::prelude::*;

use crate::state::constraints::{ConstraintOperator, MAX_CONSTRAINT_VALUE_LEN};

/// Maximum number of post-execution assertion entries per vault.
/// Kept small to limit compute cost in finalize_session.
pub const MAX_POST_ASSERTION_ENTRIES: usize = 4;

/// Assertion mode enum — used at validation and evaluation boundaries.
/// On-chain field is u8 for Pod compatibility; this enum provides type safety.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
pub enum AssertionMode {
    /// Check current value against expected_value (Phase B1)
    Absolute = 0,
    /// Check (snapshot - current) ≤ expected_value; passes if value increases (Phase B2)
    MaxDecrease = 1,
    /// Check (current - snapshot) ≤ expected_value; passes if value decreases (Phase B2)
    MaxIncrease = 2,
    /// Check current == snapshot — byte-for-byte equality (Phase B2)
    NoChange = 3,
}

impl TryFrom<u8> for AssertionMode {
    type Error = ();
    fn try_from(v: u8) -> core::result::Result<Self, Self::Error> {
        match v {
            0 => Ok(AssertionMode::Absolute),
            1 => Ok(AssertionMode::MaxDecrease),
            2 => Ok(AssertionMode::MaxIncrease),
            3 => Ok(AssertionMode::NoChange),
            _ => Err(()),
        }
    }
}

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
    ///     NOTE: If value increases (current > snapshot), check ALWAYS PASSES (saturating sub = 0).
    ///     For bidirectional protection, pair with MaxIncrease or use NoChange.
    /// 2 = MaxIncrease: check (current - snapshot) ≤ expected_value (Phase B2)
    ///     NOTE: If value decreases, check ALWAYS PASSES.
    /// 3 = NoChange: check current == snapshot — byte-for-byte equality (Phase B2)
    pub assertion_mode: u8, // 1

    /// Phase B3: Second field offset for CrossFieldLte (little-endian u16).
    /// When cross_field_flags & 0x01: read field_B at offset_b (value_len bytes) from same target.
    /// Check: field_A × 10000 ≤ multiplier_bps × field_B (using u128 arithmetic).
    /// Stored as [u8; 2] for zero-copy Pod alignment compatibility.
    pub cross_field_offset_b: [u8; 2], // 2

    /// Phase B3: Multiplier in basis points for CrossFieldLte (little-endian u32).
    /// 10000 = 1.0x, 100000 = 10x, 5000000 = 500x.
    /// Must be > 0 when cross_field_flags is enabled.
    /// Stored as [u8; 4] for zero-copy Pod alignment compatibility.
    pub cross_field_multiplier_bps: [u8; 4], // 4

    /// Phase B3: Flags byte. Bit 0 = enable CrossFieldLte.
    /// When enabled, assertion_mode MUST be 0 (Absolute).
    /// Unknown bits (1-7) must be 0.
    pub cross_field_flags: u8, // 1
}
// = 76 bytes per entry (32 + 2 + 1 + 1 + 32 + 1 + 2 + 4 + 1 = 76)

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
        // Must have at least 1 entry (creating empty assertions wastes rent)
        require!(
            !entries.is_empty() && entries.len() <= MAX_POST_ASSERTION_ENTRIES,
            crate::errors::SigilError::InvalidConstraintConfig
        );
        for entry in entries {
            // Value length must be 1-32
            require!(
                entry.value_len > 0 && entry.value_len as usize <= MAX_CONSTRAINT_VALUE_LEN,
                crate::errors::SigilError::InvalidConstraintConfig
            );
            // Expected value must be at least value_len bytes
            require!(
                entry.expected_value.len() >= entry.value_len as usize,
                crate::errors::SigilError::InvalidConstraintConfig
            );
            // Operator must be valid (0-6)
            require!(
                ConstraintOperator::try_from(entry.operator).is_ok(),
                crate::errors::SigilError::InvalidConstraintOperator
            );
            // Assertion mode must be valid (0-3)
            require!(
                AssertionMode::try_from(entry.assertion_mode).is_ok(),
                crate::errors::SigilError::InvalidConstraintConfig
            );

            // Phase B2: delta modes (1-3) require value_len <= 8 for numeric comparison
            if entry.assertion_mode >= 1 && entry.assertion_mode <= 3 {
                require!(
                    entry.value_len <= 8,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
            }

            // Phase B3: CrossFieldLte validation
            if entry.cross_field_flags & 0x01 != 0 {
                // CrossFieldLte parses fields as u64 — value_len must fit (audit C1)
                require!(
                    entry.value_len <= 8,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
                // CrossFieldLte only composes with Absolute mode
                require!(
                    entry.assertion_mode == 0,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
                // Multiplier must be positive
                require!(
                    entry.cross_field_multiplier_bps > 0,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
                // No unknown flags
                require!(
                    entry.cross_field_flags & 0xFE == 0,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
            } else {
                // When CrossFieldLte disabled, B3 fields must be zeroed
                require!(
                    entry.cross_field_offset_b == 0 && entry.cross_field_multiplier_bps == 0,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
            }
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
    /// Phase B3: second field offset for CrossFieldLte (0 if unused)
    pub cross_field_offset_b: u16,
    /// Phase B3: multiplier in BPS for CrossFieldLte (0 if unused)
    pub cross_field_multiplier_bps: u32,
    /// Phase B3: flags byte — bit 0 = enable CrossFieldLte (0 if unused)
    pub cross_field_flags: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Helpers ────────────────────────────────────────────────────────

    fn mk_assertion_entry(mode: u8, value_len: u8) -> PostAssertionEntry {
        PostAssertionEntry {
            target_account: Pubkey::default(),
            offset: 0,
            value_len,
            operator: 0, // Eq
            expected_value: vec![0u8; value_len as usize],
            assertion_mode: mode,
            cross_field_offset_b: 0,
            cross_field_multiplier_bps: 0,
            cross_field_flags: 0,
        }
    }

    fn mk_crossfield_entry(multiplier_bps: u32, flags: u8) -> PostAssertionEntry {
        PostAssertionEntry {
            target_account: Pubkey::default(),
            offset: 0,
            value_len: 8,
            operator: 0,
            expected_value: vec![0u8; 8],
            assertion_mode: 0, // Absolute — required for CrossFieldLte
            cross_field_offset_b: 100,
            cross_field_multiplier_bps: multiplier_bps,
            cross_field_flags: flags,
        }
    }

    // ─── AssertionMode TryFrom<u8> ──────────────────────────────────────

    #[test]
    fn assertion_mode_try_from_valid_discriminants() {
        assert_eq!(AssertionMode::try_from(0), Ok(AssertionMode::Absolute));
        assert_eq!(AssertionMode::try_from(1), Ok(AssertionMode::MaxDecrease));
        assert_eq!(AssertionMode::try_from(2), Ok(AssertionMode::MaxIncrease));
        assert_eq!(AssertionMode::try_from(3), Ok(AssertionMode::NoChange));
    }

    #[test]
    fn assertion_mode_try_from_rejects_4() {
        assert!(AssertionMode::try_from(4).is_err());
    }

    #[test]
    fn assertion_mode_try_from_rejects_255() {
        assert!(AssertionMode::try_from(255).is_err());
    }

    #[test]
    fn assertion_mode_round_trip_discriminants() {
        assert_eq!(AssertionMode::Absolute as u8, 0);
        assert_eq!(AssertionMode::MaxDecrease as u8, 1);
        assert_eq!(AssertionMode::MaxIncrease as u8, 2);
        assert_eq!(AssertionMode::NoChange as u8, 3);
    }

    // ─── B2: delta modes in validate_entries ────────────────────────────

    #[test]
    fn validate_accepts_max_decrease_with_value_len_8() {
        let entries = vec![mk_assertion_entry(1, 8)]; // MaxDecrease, 8 bytes
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_accepts_max_increase_with_value_len_4() {
        let entries = vec![mk_assertion_entry(2, 4)]; // MaxIncrease, 4 bytes
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_accepts_no_change_with_value_len_1() {
        let entries = vec![mk_assertion_entry(3, 1)]; // NoChange, 1 byte
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_max_decrease_with_value_len_9() {
        let entries = vec![mk_assertion_entry(1, 9)]; // MaxDecrease, 9 bytes — too large for delta
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_max_decrease_with_value_len_32() {
        let entries = vec![mk_assertion_entry(1, 32)]; // MaxDecrease, 32 bytes — way too large
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_unknown_mode_4() {
        let entries = vec![mk_assertion_entry(4, 4)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_unknown_mode_255() {
        let entries = vec![mk_assertion_entry(255, 4)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    // ─── B3: CrossFieldLte in validate_entries ──────────────────────────

    #[test]
    fn validate_accepts_crossfield_enabled_absolute_mode_positive_multiplier() {
        // flags=1 (enabled), mode=0 (Absolute), multiplier>0 → valid
        let entries = vec![mk_crossfield_entry(10_000, 1)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_crossfield_enabled_with_delta_mode() {
        // flags=1 (enabled) but mode=1 (MaxDecrease) → must be Absolute
        let mut entry = mk_crossfield_entry(10_000, 1);
        entry.assertion_mode = 1;
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_crossfield_enabled_with_zero_multiplier() {
        // flags=1 (enabled) but multiplier=0 → invalid
        let entries = vec![mk_crossfield_entry(0, 1)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_crossfield_enabled_with_unknown_flags() {
        // flags=3 (bit 0 + bit 1 set) → unknown bit 1 must be rejected
        let entries = vec![mk_crossfield_entry(10_000, 3)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_accepts_crossfield_disabled_zeroed_fields() {
        // flags=0 (disabled), offset_b=0, multiplier=0 → valid
        let entries = vec![mk_assertion_entry(0, 8)]; // all B3 fields are 0
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_crossfield_disabled_but_nonzero_offset_b() {
        // flags=0 (disabled) but offset_b != 0 → unused fields must be zeroed
        let mut entry = mk_assertion_entry(0, 8);
        entry.cross_field_offset_b = 42;
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_crossfield_disabled_but_nonzero_multiplier() {
        // flags=0 (disabled) but multiplier != 0 → unused fields must be zeroed
        let mut entry = mk_assertion_entry(0, 8);
        entry.cross_field_multiplier_bps = 5000;
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }
}
