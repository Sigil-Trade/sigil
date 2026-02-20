// CVLR Specification: Access Control Constants & Logic
//
// Verifies safety-critical constants and pure helper functions
// that underpin AgentShield's authorization model.

use crate::state::{
    SessionAuthority, TrackerTier, MAX_ALLOWED_DESTINATIONS, MAX_ALLOWED_PROTOCOLS,
    MAX_ALLOWED_TOKENS, MAX_DEVELOPER_FEE_RATE, MAX_RECENT_TRANSACTIONS, ROLLING_WINDOW_SECONDS,
    SESSION_EXPIRY_SLOTS,
};
use cvlr::prelude::*;

// ─────────────────────────────────────────────────────────────────
// Rule 1: Developer fee rate ceiling
//
// MAX_DEVELOPER_FEE_RATE must be 50 (0.5 BPS). This is the hard
// cap checked by both initialize_vault and update_policy. Any
// accidental change to this constant would break the fee model.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_max_fee_rate_is_50() {
    cvlr_assert!(MAX_DEVELOPER_FEE_RATE == 50);
}

// ─────────────────────────────────────────────────────────────────
// Rule 2: Session expiry window is 20 slots
//
// SESSION_EXPIRY_SLOTS must be 20 (~8 seconds at 400ms/slot).
// Changing this constant affects the atomicity guarantee of
// composed transactions.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_session_expiry_is_20_slots() {
    cvlr_assert!(SESSION_EXPIRY_SLOTS == 20);
}

// ─────────────────────────────────────────────────────────────────
// Rule 3: Rolling window is exactly 24 hours
//
// ROLLING_WINDOW_SECONDS must be 86400 (24h). The spending cap
// enforcement depends on this being exactly one day.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_rolling_window_is_24h() {
    cvlr_assert!(ROLLING_WINDOW_SECONDS == 86_400);
}

// ─────────────────────────────────────────────────────────────────
// Rule 4: Vector bounds prevent unbounded growth
//
// All on-chain vectors must have bounded max sizes. Verifies the
// constants that enforce account size limits.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_vector_bounds_finite() {
    cvlr_assert!(MAX_ALLOWED_TOKENS == 10);
    cvlr_assert!(MAX_ALLOWED_PROTOCOLS == 10);
    cvlr_assert!(MAX_ALLOWED_DESTINATIONS == 10);
    cvlr_assert!(MAX_RECENT_TRANSACTIONS == 50);
}

// ─────────────────────────────────────────────────────────────────
// Rule 5: Tracker tier capacity matches specification
//
// Each TrackerTier variant must return the correct max_spend_entries
// value. Standard=200, Pro=500, Max=1000.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_tracker_tier_capacities() {
    cvlr_assert!(TrackerTier::Standard.max_spend_entries() == 200);
    cvlr_assert!(TrackerTier::Pro.max_spend_entries() == 500);
    cvlr_assert!(TrackerTier::Max.max_spend_entries() == 1000);
}

// ─────────────────────────────────────────────────────────────────
// Rule 6: TrackerTier::from_u8 roundtrip
//
// Valid tier values (0, 1, 2) must round-trip through from_u8,
// and invalid values must return None.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_tracker_tier_from_u8_valid() {
    let val: u8 = nondet();
    cvlr_assume!(val <= 2);

    let tier = TrackerTier::from_u8(val);
    // Valid values must produce Some
    cvlr_assert!(tier.is_some());
}

#[rule]
pub fn rule_tracker_tier_from_u8_invalid() {
    let val: u8 = nondet();
    cvlr_assume!(val > 2);

    let tier = TrackerTier::from_u8(val);
    // Invalid values must produce None
    cvlr_assert!(tier.is_none());
}
