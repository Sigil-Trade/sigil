// CVLR Specification: Session PDA Lifecycle
//
// Verifies properties of SessionAuthority::calculate_expiry() by calling
// the actual program function with nondeterministic inputs.

use crate::state::{SessionAuthority, SESSION_EXPIRY_SLOTS};
use cvlr::prelude::*;

// ─────────────────────────────────────────────────────────────────
// Rule 1: calculate_expiry never returns less than the input slot
//
// SessionAuthority::calculate_expiry uses saturating_add, so the
// result is always >= current_slot (never wraps backward).
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_expiry_at_least_current_slot() {
    let slot: u64 = nondet();
    let expires = SessionAuthority::calculate_expiry(slot, SESSION_EXPIRY_SLOTS);
    cvlr_assert!(expires >= slot);
}

// ─────────────────────────────────────────────────────────────────
// Rule 2: calculate_expiry equals slot.saturating_add(expiry_slots)
//
// Verifies the implementation matches the specification exactly.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_expiry_equals_saturating_add() {
    let slot: u64 = nondet();
    let expires = SessionAuthority::calculate_expiry(slot, SESSION_EXPIRY_SLOTS);
    cvlr_assert!(expires == slot.saturating_add(SESSION_EXPIRY_SLOTS));
}

// ─────────────────────────────────────────────────────────────────
// Rule 3: Session is guaranteed expired after the window
//
// For any creation slot S (not near u64::MAX), the session must
// be expired at slot S + SESSION_EXPIRY_SLOTS + 1.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_session_expires_after_window() {
    let creation_slot: u64 = nondet();
    cvlr_assume!(creation_slot < u64::MAX - SESSION_EXPIRY_SLOTS);

    let expires_at = SessionAuthority::calculate_expiry(creation_slot, SESSION_EXPIRY_SLOTS);
    let after_window = creation_slot + SESSION_EXPIRY_SLOTS + 1;

    // is_expired checks: current_slot > expires_at_slot
    cvlr_assert!(after_window > expires_at);
}

// ─────────────────────────────────────────────────────────────────
// Rule 4: Session is not expired at creation slot
//
// A freshly created session must NOT be expired at the slot it
// was created in (creation_slot <= expires_at).
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_session_valid_at_creation() {
    let creation_slot: u64 = nondet();
    let expires_at = SessionAuthority::calculate_expiry(creation_slot, SESSION_EXPIRY_SLOTS);

    // is_expired = current_slot > expires_at_slot
    // At creation_slot, this must be false
    cvlr_assert!(creation_slot <= expires_at);
}

// ─────────────────────────────────────────────────────────────────
// Rule 5: Saturation at u64::MAX
//
// When current_slot is near u64::MAX, calculate_expiry must
// saturate to u64::MAX rather than wrapping around.
// Uses concrete values to avoid prover sanity-check issues with
// nondeterministic assumptions near u64::MAX.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_expiry_saturates_at_max() {
    // u64::MAX itself must saturate
    let expires_max = SessionAuthority::calculate_expiry(u64::MAX, SESSION_EXPIRY_SLOTS);
    cvlr_assert!(expires_max == u64::MAX);

    // u64::MAX - 10 is within the saturation zone (> u64::MAX - 20)
    let expires_near = SessionAuthority::calculate_expiry(u64::MAX - 10, SESSION_EXPIRY_SLOTS);
    cvlr_assert!(expires_near == u64::MAX);
}
