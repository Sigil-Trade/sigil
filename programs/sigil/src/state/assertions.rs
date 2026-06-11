//! Agnostic assertion primitives — the KEPT comparison/equality core.
//!
//! M1-04 (constraints-engine teardown, 2026-05-31): these helpers were
//! relocated here from `state/constraints.rs`, `state/pending_constraints.rs`,
//! and `instructions/integrations/generic_constraints.rs` BEFORE those files
//! were deleted, because they are used by KEPT modules:
//!   - `ConstraintOperator` + `bytes_match` (and its LE/bitmask helpers) →
//!     `finalize_session` (balance-delta / post-assertion outcome checks) and
//!     `state/post_assertions`.
//!   - `ct_eq_32` → `apply_agent_grant` (constant-time digest compare).
//!   - `MAX_CONSTRAINT_VALUE_LEN` → `state/post_assertions` (value buffer size).
//!
//! These primitives are protocol-agnostic OUTCOME comparison (Lighthouse-style
//! state assertions), NOT the dead instruction-data-parsing engine removed in
//! M1-04. They are the "golden goose" agnostic core that survives the teardown.
//!
//! `ConstraintOperator` keeps its name + discriminant order (0=Eq … 6=Bitmask)
//! because the on-chain PostExecutionAssertions account and the SDK encode the
//! operator as a raw u8 — renaming or reordering would be a wire-format change.

use anchor_lang::prelude::*;

/// Maximum length of a comparison value buffer (bytes). Mirrors the legacy
/// constraints layout; PostExecutionAssertions depends on this exact value.
pub const MAX_CONSTRAINT_VALUE_LEN: usize = 32;

// ─── Comparison operator (encoded as raw u8 on-chain + in the SDK) ──────────

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

// ─── Byte-comparison helpers (LE unsigned/signed + bitmask) ─────────────────

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

/// Compare `actual` against `expected` using the given operator.
/// Used by `finalize_session` and `state/post_assertions` for agnostic
/// outcome (post-execution state) assertions.
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

// ─── Constant-time 32-byte equality (digest compare) ────────────────────────

/// Constant-time comparison of two 32-byte arrays. XORs all 32 byte pairs and
/// checks `diff == 0` so the comparison time does not depend on where the first
/// differing byte is (defends digest checks against timing side-channels). The
/// load-bearing property is DETERMINISM/constant-time, not speed (~30 CU vs ~8
/// CU for `==`). Used by `apply_agent_grant` for pending-grant digest re-bind.
#[inline]
pub fn ct_eq_32(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff: u8 = 0;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}
