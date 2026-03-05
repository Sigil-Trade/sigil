use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::state::{ConstraintEntry, ConstraintOperator, DataConstraint};

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
            PhalnxError::ConstraintViolated
        );
        let actual = &ix_data[offset..offset + len];
        let expected = &dc.value;
        let passes = match dc.operator {
            ConstraintOperator::Eq => actual == expected.as_slice(),
            ConstraintOperator::Ne => actual != expected.as_slice(),
            ConstraintOperator::Gte => compare_le_unsigned(actual, expected) >= 0,
            ConstraintOperator::Lte => compare_le_unsigned(actual, expected) <= 0,
        };
        require!(passes, PhalnxError::ConstraintViolated);
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

/// Compare two byte slices as little-endian unsigned integers.
/// Returns: 1 if a > b, -1 if a < b, 0 if equal.
/// Shorter slices are padded with zeros on the high end.
fn compare_le_unsigned(a: &[u8], b: &[u8]) -> i32 {
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
            },
            ConstraintEntry {
                program_id: pk2,
                data_constraints: vec![],
            },
        ];
        assert!(find_constraint_entry(&entries, &pk1).is_some());
        assert!(find_constraint_entry(&entries, &pk2).is_some());
        assert!(find_constraint_entry(&entries, &Pubkey::new_unique()).is_none());
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
}
