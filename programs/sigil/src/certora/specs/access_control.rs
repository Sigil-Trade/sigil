// CVLR Specification: Access Control Constants & Logic
//
// Verifies safety-critical constants and pure helper functions
// that underpin Sigil's authorization model.
// V2: TrackerTier removed — epoch-based circular buffer replaces tiered tracking.
// V3: Oracle system removed — stablecoin-only architecture.

use crate::state::{
    EPOCH_DURATION, MAX_ALLOWED_DESTINATIONS, MAX_ALLOWED_PROTOCOLS, MAX_DEVELOPER_FEE_RATE,
    NUM_EPOCHS, ROLLING_WINDOW_SECONDS, SESSION_EXPIRY_SLOTS,
};
use cvlr::prelude::*;

// ─────────────────────────────────────────────────────────────────
// Rule 1: Developer fee rate ceiling
//
// MAX_DEVELOPER_FEE_RATE must be 500 (5 BPS). This is the hard
// cap checked by both initialize_vault and queue_policy_update. Any
// accidental change to this constant would break the fee model.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_max_fee_rate_is_500() {
    cvlr_assert!(MAX_DEVELOPER_FEE_RATE == 500);
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
    cvlr_assert!(MAX_ALLOWED_PROTOCOLS == 10);
    cvlr_assert!(MAX_ALLOWED_DESTINATIONS == 10);
}

// ─────────────────────────────────────────────────────────────────
// Rule 5: Epoch buffer constants are internally consistent
//
// V2 replaced TrackerTier with a fixed 144-epoch circular buffer.
// Each epoch covers EPOCH_DURATION seconds (600 = 10 minutes).
// NUM_EPOCHS × EPOCH_DURATION must equal ROLLING_WINDOW_SECONDS
// so the buffer covers exactly the rolling 24h window.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_epoch_buffer_constants() {
    cvlr_assert!(EPOCH_DURATION == 600);
    cvlr_assert!(NUM_EPOCHS == 144);
    // Invariant: buffer covers exactly the rolling window
    cvlr_assert!((EPOCH_DURATION as usize) * NUM_EPOCHS == (ROLLING_WINDOW_SECONDS as usize));
}
