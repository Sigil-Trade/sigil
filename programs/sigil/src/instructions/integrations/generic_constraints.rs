use anchor_lang::prelude::*;

use anchor_lang::solana_program::instruction::AccountMeta;

use crate::errors::SigilError;
use crate::state::{
    AccountConstraint, ConstraintEntry, ConstraintEntryZC, ConstraintOperator, DataConstraint,
    InstructionConstraints,
};

/// Verify all data constraints against instruction data.
/// Each constraint is ANDed — all must pass.
pub fn verify_data_constraints(ix_data: &[u8], constraints: &[DataConstraint]) -> Result<()> {
    for dc in constraints {
        let offset = dc.offset as usize;
        let len = dc.value.len();
        // Out of bounds = violation (not passthrough)
        require!(
            offset
                .checked_add(len)
                .is_some_and(|end| end <= ix_data.len()),
            SigilError::ConstraintViolated
        );
        let actual = &ix_data[offset..offset + len];
        let expected = &dc.value;
        let passes = match dc.operator {
            ConstraintOperator::Eq => actual == expected.as_slice(),
            ConstraintOperator::Ne => actual != expected.as_slice(),
            ConstraintOperator::Gte => compare_le_unsigned(actual, expected) >= 0,
            ConstraintOperator::Lte => compare_le_unsigned(actual, expected) <= 0,
            ConstraintOperator::GteSigned => compare_le_signed(actual, expected) >= 0,
            ConstraintOperator::LteSigned => compare_le_signed(actual, expected) <= 0,
            ConstraintOperator::Bitmask => bitmask_check(actual, expected),
        };
        require!(passes, SigilError::ConstraintViolated);
    }
    Ok(())
}

/// Verify account-index constraints against instruction accounts.
/// Each constraint requires a specific pubkey at a specific account index.
pub fn verify_account_constraints(
    ix_accounts: &[AccountMeta],
    constraints: &[AccountConstraint],
) -> Result<()> {
    for ac in constraints {
        let idx = ac.index as usize;
        require!(idx < ix_accounts.len(), SigilError::ConstraintViolated);
        require!(
            ix_accounts[idx].pubkey == ac.expected,
            SigilError::ConstraintViolated
        );
    }
    Ok(())
}

/// Find a constraint entry matching the given program_id.
pub fn find_constraint_entry<'a>(
    entries: &'a [ConstraintEntry],
    program_id: &Pubkey,
) -> Option<&'a ConstraintEntry> {
    entries.iter().find(|e| e.program_id == *program_id)
}

/// Verify an instruction against all matching constraint entries for a program.
/// Multiple entries with the same program_id are ORed: if ANY entry passes, the instruction is allowed.
/// Within each entry, data_constraints and account_constraints are ANDed (all must pass).
/// Returns Ok(true) if at least one entry matched and passed, Ok(false) if no entries matched.
pub fn verify_against_entries(
    entries: &[ConstraintEntry],
    program_id: &Pubkey,
    ix_data: &[u8],
    ix_accounts: &[AccountMeta],
) -> Result<bool> {
    let mut found_any = false;
    let mut any_passed = false;

    for entry in entries.iter().filter(|e| e.program_id == *program_id) {
        found_any = true;
        let data_ok = verify_data_constraints(ix_data, &entry.data_constraints).is_ok();
        let acct_ok = verify_account_constraints(ix_accounts, &entry.account_constraints).is_ok();
        if data_ok && acct_ok {
            any_passed = true;
            break;
        }
    }

    if !found_any {
        return Ok(false); // No entries for this program — caller decides policy
    }

    require!(any_passed, SigilError::ConstraintViolated);
    Ok(true)
}

/// Compare two byte slices as little-endian unsigned integers.
/// Returns: 1 if a > b, -1 if a < b, 0 if equal.
/// Shorter slices are padded with zeros on the high end.
pub(crate) fn compare_le_unsigned(a: &[u8], b: &[u8]) -> i32 {
    let max_len = a.len().max(b.len());
    // Compare from most-significant byte (highest index in LE) to least
    for i in (0..max_len).rev() {
        let a_byte = if i < a.len() { a[i] } else { 0 };
        let b_byte = if i < b.len() { b[i] } else { 0 };
        if a_byte > b_byte {
            return 1;
        }
        if a_byte < b_byte {
            return -1;
        }
    }
    0
}

/// Compare two byte slices as little-endian signed (two's complement) integers.
/// Returns: 1 if a > b, -1 if a < b, 0 if equal.
/// Shorter slices are sign-extended (padded with 0x00 if positive, 0xFF if negative).
pub(crate) fn compare_le_signed(a: &[u8], b: &[u8]) -> i32 {
    let max_len = a.len().max(b.len());
    // Sign bit is MSB of the highest byte (last byte in LE)
    let a_negative = !a.is_empty() && (a[a.len() - 1] & 0x80) != 0;
    let b_negative = !b.is_empty() && (b[b.len() - 1] & 0x80) != 0;

    // Different signs: negative < positive
    if a_negative && !b_negative {
        return -1;
    }
    if !a_negative && b_negative {
        return 1;
    }

    // Same sign: sign-extend and compare MSB-first
    let a_pad: u8 = if a_negative { 0xFF } else { 0x00 };
    let b_pad: u8 = if b_negative { 0xFF } else { 0x00 };

    for i in (0..max_len).rev() {
        let a_byte = if i < a.len() { a[i] } else { a_pad };
        let b_byte = if i < b.len() { b[i] } else { b_pad };
        if a_byte > b_byte {
            return 1;
        }
        if a_byte < b_byte {
            return -1;
        }
    }
    0
}

/// Bitmask check: all bits set in `mask` must also be set in `actual`.
/// Semantic: (actual & mask) == mask.
/// If actual is shorter than mask, missing bytes are treated as 0x00.
pub(crate) fn bitmask_check(actual: &[u8], mask: &[u8]) -> bool {
    for (i, &m) in mask.iter().enumerate() {
        let a = if i < actual.len() { actual[i] } else { 0x00 };
        if (a & m) != m {
            return false;
        }
    }
    true
}

// ─── Zero-copy verification functions ────────────────────────────────────────

/// Compare actual bytes against expected using the given operator.
/// Extracted for reuse in PostExecutionAssertions (Phase B).
pub(crate) fn bytes_match(actual: &[u8], operator: &ConstraintOperator, expected: &[u8]) -> bool {
    match operator {
        ConstraintOperator::Eq => actual == expected,
        ConstraintOperator::Ne => actual != expected,
        ConstraintOperator::Gte => compare_le_unsigned(actual, expected) >= 0,
        ConstraintOperator::Lte => compare_le_unsigned(actual, expected) <= 0,
        ConstraintOperator::GteSigned => compare_le_signed(actual, expected) >= 0,
        ConstraintOperator::LteSigned => compare_le_signed(actual, expected) <= 0,
        ConstraintOperator::Bitmask => bitmask_check(actual, expected),
    }
}

/// Zero-copy variant: verify data constraints from a ConstraintEntryZC.
pub fn verify_data_constraints_zc(ix_data: &[u8], entry: &ConstraintEntryZC) -> Result<()> {
    for j in 0..(entry.data_count as usize) {
        let dc = &entry.data_constraints[j];
        let offset = dc.offset as usize;
        let len = dc.value_len as usize;
        require!(
            offset
                .checked_add(len)
                .is_some_and(|end| end <= ix_data.len()),
            SigilError::ConstraintViolated
        );
        let actual = &ix_data[offset..offset + len];
        let expected = &dc.value[..len];
        let op = ConstraintOperator::try_from(dc.operator)
            .map_err(|_| error!(SigilError::InvalidConstraintOperator))?;
        require!(
            bytes_match(actual, &op, expected),
            SigilError::ConstraintViolated
        );
    }
    Ok(())
}

/// Zero-copy variant: verify account constraints from a ConstraintEntryZC.
pub fn verify_account_constraints_zc(
    ix_accounts: &[AccountMeta],
    entry: &ConstraintEntryZC,
) -> Result<()> {
    for k in 0..(entry.account_count as usize) {
        let ac = &entry.account_constraints[k];
        let idx = ac.index as usize;
        require!(idx < ix_accounts.len(), SigilError::ConstraintViolated);
        let expected_pk = Pubkey::from(ac.expected);
        require!(
            ix_accounts[idx].pubkey == expected_pk,
            SigilError::ConstraintViolated
        );
    }
    Ok(())
}

/// Zero-copy variant: verify an instruction against all constraint entries.
/// Multiple entries with the same program_id are ORed.
/// Returns Ok(true) if matched and passed, Ok(false) if no entries matched.
pub fn verify_against_entries_zc(
    constraints: &InstructionConstraints,
    program_id: &Pubkey,
    ix_data: &[u8],
    ix_accounts: &[AccountMeta],
) -> Result<bool> {
    let program_bytes = program_id.to_bytes();
    let count = constraints.entry_count as usize;
    let mut found_any = false;
    let mut any_passed = false;

    for i in 0..count {
        let entry = &constraints.entries[i];
        if entry.program_id != program_bytes {
            continue;
        }
        found_any = true;
        let data_ok = verify_data_constraints_zc(ix_data, entry).is_ok();
        let acct_ok = verify_account_constraints_zc(ix_accounts, entry).is_ok();
        if data_ok && acct_ok {
            any_passed = true;
            break;
        }
    }

    if !found_any {
        return Ok(false);
    }
    require!(any_passed, SigilError::ConstraintViolated);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dc(offset: u16, op: ConstraintOperator, value: Vec<u8>) -> DataConstraint {
        DataConstraint {
            offset,
            operator: op,
            value,
        }
    }

    #[test]
    fn eq_match_passes() {
        let ix_data = vec![0xAA, 0xBB, 0xCC, 0xDD];
        let constraints = vec![dc(1, ConstraintOperator::Eq, vec![0xBB, 0xCC])];
        assert!(verify_data_constraints(&ix_data, &constraints).is_ok());
    }

    #[test]
    fn eq_mismatch_fails() {
        let ix_data = vec![0xAA, 0xBB, 0xCC, 0xDD];
        let constraints = vec![dc(1, ConstraintOperator::Eq, vec![0xFF, 0xCC])];
        assert!(verify_data_constraints(&ix_data, &constraints).is_err());
    }

    #[test]
    fn ne_works() {
        let ix_data = vec![0xAA, 0xBB];
        // Not equal → passes
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::Ne, vec![0xFF])]).is_ok()
        );
        // Equal → fails
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::Ne, vec![0xAA])])
                .is_err()
        );
    }

    #[test]
    fn gte_lte_with_u64_le_values() {
        // u64 LE: 100 = [100, 0, 0, 0, 0, 0, 0, 0]
        let ix_data = 100u64.to_le_bytes().to_vec();
        let val_50 = 50u64.to_le_bytes().to_vec();
        let val_100 = 100u64.to_le_bytes().to_vec();
        let val_200 = 200u64.to_le_bytes().to_vec();

        // 100 >= 50 → pass
        assert!(verify_data_constraints(
            &ix_data,
            &[dc(0, ConstraintOperator::Gte, val_50.clone())]
        )
        .is_ok());
        // 100 >= 100 → pass
        assert!(verify_data_constraints(
            &ix_data,
            &[dc(0, ConstraintOperator::Gte, val_100.clone())]
        )
        .is_ok());
        // 100 >= 200 → fail
        assert!(verify_data_constraints(
            &ix_data,
            &[dc(0, ConstraintOperator::Gte, val_200.clone())]
        )
        .is_err());

        // 100 <= 200 → pass
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::Lte, val_200)]).is_ok()
        );
        // 100 <= 100 → pass
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::Lte, val_100)]).is_ok()
        );
        // 100 <= 50 → fail
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::Lte, val_50)]).is_err()
        );
    }

    #[test]
    fn offset_out_of_bounds_is_violation() {
        let ix_data = vec![0xAA, 0xBB];
        // offset 1, len 2 → needs byte index 1..3 but only 2 bytes exist
        let constraints = vec![dc(1, ConstraintOperator::Eq, vec![0xBB, 0xCC])];
        assert!(verify_data_constraints(&ix_data, &constraints).is_err());
    }

    #[test]
    fn empty_constraints_passthrough() {
        let ix_data = vec![0xAA, 0xBB, 0xCC];
        assert!(verify_data_constraints(&ix_data, &[]).is_ok());
    }

    #[test]
    fn multiple_constraints_and_logic() {
        let ix_data = vec![0x01, 0x02, 0x03, 0x04];
        let constraints = vec![
            dc(0, ConstraintOperator::Eq, vec![0x01]),
            dc(2, ConstraintOperator::Eq, vec![0x03]),
        ];
        // Both match → pass
        assert!(verify_data_constraints(&ix_data, &constraints).is_ok());

        let constraints_fail = vec![
            dc(0, ConstraintOperator::Eq, vec![0x01]), // match
            dc(2, ConstraintOperator::Eq, vec![0xFF]), // mismatch
        ];
        // Second fails → whole thing fails (AND)
        assert!(verify_data_constraints(&ix_data, &constraints_fail).is_err());
    }

    #[test]
    fn zero_length_value_always_passes_eq() {
        let ix_data = vec![0xAA];
        // Zero-length slice comparison: empty == empty → true
        let constraints = vec![dc(0, ConstraintOperator::Eq, vec![])];
        assert!(verify_data_constraints(&ix_data, &constraints).is_ok());
    }

    #[test]
    fn find_constraint_entry_works() {
        let pk1 = Pubkey::new_unique();
        let pk2 = Pubkey::new_unique();
        let entries = vec![
            ConstraintEntry {
                program_id: pk1,
                data_constraints: vec![],
                account_constraints: vec![],
            },
            ConstraintEntry {
                program_id: pk2,
                data_constraints: vec![],
                account_constraints: vec![],
            },
        ];
        assert!(find_constraint_entry(&entries, &pk1).is_some());
        assert!(find_constraint_entry(&entries, &pk2).is_some());
        assert!(find_constraint_entry(&entries, &Pubkey::new_unique()).is_none());
    }

    #[test]
    fn or_logic_any_entry_passes() {
        let pk = Pubkey::new_unique();
        let entries = vec![
            ConstraintEntry {
                program_id: pk,
                data_constraints: vec![dc(0, ConstraintOperator::Eq, vec![0xFF])],
                account_constraints: vec![],
            },
            ConstraintEntry {
                program_id: pk,
                data_constraints: vec![dc(0, ConstraintOperator::Eq, vec![0xAA])],
                account_constraints: vec![],
            },
        ];
        let ix_data = vec![0xAA];
        // First entry fails (0xAA != 0xFF), second passes (0xAA == 0xAA) → Ok(true)
        assert_eq!(
            verify_against_entries(&entries, &pk, &ix_data, &[]).unwrap(),
            true
        );
    }

    #[test]
    fn or_logic_all_fail() {
        let pk = Pubkey::new_unique();
        let entries = vec![
            ConstraintEntry {
                program_id: pk,
                data_constraints: vec![dc(0, ConstraintOperator::Eq, vec![0xFF])],
                account_constraints: vec![],
            },
            ConstraintEntry {
                program_id: pk,
                data_constraints: vec![dc(0, ConstraintOperator::Eq, vec![0xEE])],
                account_constraints: vec![],
            },
        ];
        let ix_data = vec![0xAA];
        // Both fail → ConstraintViolated
        assert!(verify_against_entries(&entries, &pk, &ix_data, &[]).is_err());
    }

    #[test]
    fn or_logic_single_entry_passes() {
        let pk = Pubkey::new_unique();
        let entries = vec![ConstraintEntry {
            program_id: pk,
            data_constraints: vec![dc(0, ConstraintOperator::Eq, vec![0xAA])],
            account_constraints: vec![],
        }];
        let ix_data = vec![0xAA];
        assert_eq!(
            verify_against_entries(&entries, &pk, &ix_data, &[]).unwrap(),
            true
        );
    }

    #[test]
    fn no_matching_entries_returns_false() {
        let pk1 = Pubkey::new_unique();
        let pk2 = Pubkey::new_unique();
        let entries = vec![ConstraintEntry {
            program_id: pk1,
            data_constraints: vec![dc(0, ConstraintOperator::Eq, vec![0xAA])],
            account_constraints: vec![],
        }];
        let ix_data = vec![0xAA];
        // No entries for pk2 → Ok(false)
        assert_eq!(
            verify_against_entries(&entries, &pk2, &ix_data, &[]).unwrap(),
            false
        );
    }

    #[test]
    fn compare_le_unsigned_correctness() {
        assert_eq!(compare_le_unsigned(&[0], &[0]), 0);
        assert_eq!(compare_le_unsigned(&[1], &[0]), 1);
        assert_eq!(compare_le_unsigned(&[0], &[1]), -1);
        // Multi-byte LE: 256 = [0, 1] vs 255 = [255, 0]
        assert_eq!(compare_le_unsigned(&[0, 1], &[255, 0]), 1);
        // Padding: [1] vs [1, 0] should be equal
        assert_eq!(compare_le_unsigned(&[1], &[1, 0]), 0);
    }

    // ========== Signed comparison tests ==========

    #[test]
    fn compare_le_signed_basic() {
        assert_eq!(compare_le_signed(&[0], &[0]), 0);
        assert_eq!(compare_le_signed(&[1], &[0]), 1);
        assert_eq!(compare_le_signed(&[0], &[1]), -1);
    }

    #[test]
    fn signed_positive_gte_positive() {
        // 100i64 >= 50i64
        let a = 100i64.to_le_bytes();
        let b = 50i64.to_le_bytes();
        assert!(compare_le_signed(&a, &b) >= 0);
    }

    #[test]
    fn signed_positive_lte_positive() {
        // 50i64 <= 100i64
        let a = 50i64.to_le_bytes();
        let b = 100i64.to_le_bytes();
        assert!(compare_le_signed(&a, &b) <= 0);
    }

    #[test]
    fn signed_negative_lt_positive() {
        // -1i64 < 100i64 (critical: unsigned would say -1 > 100)
        let a = (-1i64).to_le_bytes();
        let b = 100i64.to_le_bytes();
        assert_eq!(compare_le_signed(&a, &b), -1);
    }

    #[test]
    fn signed_positive_gt_negative() {
        // 100i64 > -10i64
        let a = 100i64.to_le_bytes();
        let b = (-10i64).to_le_bytes();
        assert_eq!(compare_le_signed(&a, &b), 1);
    }

    #[test]
    fn signed_negative_gte_negative() {
        // -5i64 >= -10i64
        let a = (-5i64).to_le_bytes();
        let b = (-10i64).to_le_bytes();
        assert!(compare_le_signed(&a, &b) >= 0);
    }

    #[test]
    fn signed_negative_lte_negative() {
        // -10i64 <= -5i64
        let a = (-10i64).to_le_bytes();
        let b = (-5i64).to_le_bytes();
        assert!(compare_le_signed(&a, &b) <= 0);
    }

    #[test]
    fn signed_equal() {
        let a = (-1i64).to_le_bytes();
        assert_eq!(compare_le_signed(&a, &a), 0);
    }

    #[test]
    fn signed_zero_boundary() {
        let zero = 0i64.to_le_bytes();
        let neg = (-1i64).to_le_bytes();
        let pos = 1i64.to_le_bytes();
        assert!(compare_le_signed(&zero, &neg) >= 0); // 0 >= -1
        assert!(compare_le_signed(&zero, &pos) <= 0); // 0 <= 1
    }

    #[test]
    fn signed_i64_min() {
        let min = i64::MIN.to_le_bytes();
        let max = i64::MAX.to_le_bytes();
        assert_eq!(compare_le_signed(&min, &max), -1);
    }

    #[test]
    fn signed_i64_max() {
        let min = i64::MIN.to_le_bytes();
        let max = i64::MAX.to_le_bytes();
        assert_eq!(compare_le_signed(&max, &min), 1);
    }

    #[test]
    fn signed_cross_width_i16_vs_i32() {
        // -1i16 = [0xFF, 0xFF], sign-extended to i32 = [0xFF, 0xFF, 0xFF, 0xFF]
        let a = (-1i16).to_le_bytes();
        let b = (-1i32).to_le_bytes();
        assert_eq!(compare_le_signed(&a, &b), 0);
    }

    #[test]
    fn signed_single_byte_negative() {
        // [0x80] = -128 as i8, [0x7F] = 127 as i8
        assert_eq!(compare_le_signed(&[0x80], &[0x7F]), -1);
    }

    #[test]
    fn signed_all_ff() {
        // [0xFF] = -1 as i8, [0x01] = 1 as i8
        assert_eq!(compare_le_signed(&[0xFF], &[0x01]), -1);
    }

    #[test]
    fn signed_empty_slices() {
        assert_eq!(compare_le_signed(&[], &[]), 0);
    }

    #[test]
    fn signed_padding_positive() {
        // [1] vs [1, 0] — both represent 1, zero-extended
        assert_eq!(compare_le_signed(&[1], &[1, 0]), 0);
    }

    #[test]
    fn signed_padding_negative() {
        // [0xFF] = -1i8, sign-extended = [0xFF, 0xFF] = -1i16
        assert_eq!(compare_le_signed(&[0xFF], &[0xFF, 0xFF]), 0);
    }

    #[test]
    fn signed_boundary_0x80() {
        // [0x80] is negative (-128), [0x7F] is positive (127)
        assert!(compare_le_signed(&[0x80], &[0x7F]) < 0);
        assert!(compare_le_signed(&[0x7F], &[0x80]) > 0);
    }

    #[test]
    fn signed_i128_works() {
        let a = (-1000i128).to_le_bytes();
        let b = 1000i128.to_le_bytes();
        assert_eq!(compare_le_signed(&a, &b), -1);
        assert_eq!(compare_le_signed(&b, &a), 1);
    }

    #[test]
    fn signed_verify_data_gte() {
        // 100i64 >= 50i64 via GteSigned
        let ix_data = 100i64.to_le_bytes().to_vec();
        let bound = 50i64.to_le_bytes().to_vec();
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::GteSigned, bound)])
                .is_ok()
        );
    }

    #[test]
    fn signed_verify_data_lte() {
        // -5i64 <= 10i64 via LteSigned
        let ix_data = (-5i64).to_le_bytes().to_vec();
        let bound = 10i64.to_le_bytes().to_vec();
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::LteSigned, bound)])
                .is_ok()
        );
    }

    #[test]
    fn signed_verify_positive_passes_negative_bound() {
        // GteSigned(-10): actual=100 passes (unsigned Gte would fail because unsigned(100) < unsigned(-10))
        let ix_data = 100i64.to_le_bytes().to_vec();
        let bound = (-10i64).to_le_bytes().to_vec();
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::GteSigned, bound)])
                .is_ok()
        );
    }

    #[test]
    fn signed_verify_negative_passes_positive_upper() {
        // LteSigned(10): actual=-1 passes (unsigned Lte would fail)
        let ix_data = (-1i64).to_le_bytes().to_vec();
        let bound = 10i64.to_le_bytes().to_vec();
        assert!(
            verify_data_constraints(&ix_data, &[dc(0, ConstraintOperator::LteSigned, bound)])
                .is_ok()
        );
    }

    // ========== Bitmask tests ==========

    #[test]
    fn bitmask_all_bits_set_passes() {
        // mask=0x0F, actual=0xFF → all lower 4 bits set → passes
        assert!(bitmask_check(&[0xFF], &[0x0F]));
    }

    #[test]
    fn bitmask_exact_match_passes() {
        // mask=0x0F, actual=0x0F → exact match
        assert!(bitmask_check(&[0x0F], &[0x0F]));
    }

    #[test]
    fn bitmask_missing_bit_fails() {
        // mask=0x0F, actual=0x0E → bit 0 missing
        assert!(!bitmask_check(&[0x0E], &[0x0F]));
    }

    // NOTE: `bitmask_zero_mask_always_passes` was removed as part of the
    // A3 fix (docs/SECURITY-FINDINGS-2026-04-07.md Finding 2). The
    // `bitmask_check` math primitive itself is unchanged — it still
    // returns true for all-zero masks because mathematically
    // `(actual & 0) == 0` is always true. The fix lives one layer up
    // in `InstructionConstraints::validate_entries` (state/constraints.rs),
    // which now rejects zero-mask Bitmask constraints at validation time
    // so they can never be packed into the zero-copy account and
    // therefore can never reach `bitmask_check` in production. Tests
    // asserting the new rejection behavior live in the `tests` module
    // of `state/constraints.rs`.

    #[test]
    fn bitmask_multi_byte() {
        // mask=[0x01, 0x80], actual=[0x03, 0xC0] → passes (bits 0 and 15 set)
        assert!(bitmask_check(&[0x03, 0xC0], &[0x01, 0x80]));
    }

    #[test]
    fn bitmask_actual_shorter_fails() {
        // actual=[0x0F], mask=[0x0F, 0x01] → second mask byte has bit set, actual missing → fails
        assert!(!bitmask_check(&[0x0F], &[0x0F, 0x01]));
    }

    #[test]
    fn bitmask_verify_data_passes() {
        let ix_data = vec![0xFF, 0xFF];
        assert!(verify_data_constraints(
            &ix_data,
            &[dc(0, ConstraintOperator::Bitmask, vec![0x0F, 0x80])]
        )
        .is_ok());
    }

    #[test]
    fn bitmask_verify_data_fails() {
        let ix_data = vec![0x0E, 0xFF]; // bit 0 of byte 0 not set
        assert!(verify_data_constraints(
            &ix_data,
            &[dc(0, ConstraintOperator::Bitmask, vec![0x0F])]
        )
        .is_err());
    }

    #[test]
    fn bitmask_single_bit_check() {
        // mask=0x40, actual=0x41 passes (bit 6 set), actual=0x01 fails
        assert!(bitmask_check(&[0x41], &[0x40]));
        assert!(!bitmask_check(&[0x01], &[0x40]));
    }

    #[test]
    fn bitmask_all_ones_mask() {
        // mask=0xFF, only actual=0xFF passes
        assert!(bitmask_check(&[0xFF], &[0xFF]));
        assert!(!bitmask_check(&[0xFE], &[0xFF]));
        assert!(!bitmask_check(&[0x7F], &[0xFF]));
    }
}
