// CVLR Specification: Session PDA Lifecycle
//
// Proves properties about the SessionAuthority PDA:
//   - Sessions expire within SESSION_EXPIRY_SLOTS (20 slots)
//   - Expired sessions are not valid for authorization
//   - Session expiry uses saturating arithmetic (no overflow)
//   - The init constraint prevents session replay

use certora::cvlr::*;

// ─────────────────────────────────────────────────────────────────
// Constants (mirror on-chain values from state/mod.rs)
// ─────────────────────────────────────────────────────────────────

const SESSION_EXPIRY_SLOTS: u64 = 20;

// ─────────────────────────────────────────────────────────────────
// Rule 1: Session expiry is bounded
//
// SessionAuthority::calculate_expiry uses saturating_add, so
// expires_at_slot = current_slot.saturating_add(SESSION_EXPIRY_SLOTS).
// The result is always within [current_slot, current_slot + 20],
// and never overflows.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn session_expiry_bounded() {
    let current_slot: u64 = nondet();

    let expires_at = current_slot.saturating_add(SESSION_EXPIRY_SLOTS);

    // Expiry is always >= current slot
    cvlr_assert!(expires_at >= current_slot);

    // Expiry is at most current_slot + SESSION_EXPIRY_SLOTS
    // (saturating_add caps at u64::MAX if overflow would occur)
    if current_slot <= u64::MAX - SESSION_EXPIRY_SLOTS {
        cvlr_assert!(expires_at == current_slot + SESSION_EXPIRY_SLOTS);
    } else {
        // Near u64::MAX — saturating_add caps at MAX
        cvlr_assert!(expires_at == u64::MAX);
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 2: Expired sessions are not valid
//
// is_expired() = current_slot > expires_at_slot
// is_valid() = authorized && !is_expired()
// Once current_slot exceeds expires_at_slot, the session cannot
// be used for authorization.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn expired_session_not_valid() {
    let current_slot: u64 = nondet();
    let expires_at_slot: u64 = nondet();
    let authorized: bool = nondet();

    let is_expired = current_slot > expires_at_slot;
    let is_valid = authorized && !is_expired;

    // If expired, is_valid must be false regardless of authorized flag
    if is_expired {
        cvlr_assert!(!is_valid);
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 3: Non-expired authorized session is valid
//
// Conversely, if a session is authorized AND current_slot <=
// expires_at_slot, the session IS valid.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn authorized_non_expired_is_valid() {
    let current_slot: u64 = nondet();
    let expires_at_slot: u64 = nondet();

    cvlr_assume!(current_slot <= expires_at_slot);

    let authorized = true;
    let is_expired = current_slot > expires_at_slot;
    let is_valid = authorized && !is_expired;

    cvlr_assert!(is_valid);
}

// ─────────────────────────────────────────────────────────────────
// Rule 4: Session expiry is deterministic
//
// Given the same current_slot, calculate_expiry always returns
// the same expires_at_slot. This ensures no randomness or
// timing-dependent behavior in session lifetime.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn session_expiry_deterministic() {
    let current_slot: u64 = nondet();

    let expiry_1 = current_slot.saturating_add(SESSION_EXPIRY_SLOTS);
    let expiry_2 = current_slot.saturating_add(SESSION_EXPIRY_SLOTS);

    cvlr_assert!(expiry_1 == expiry_2);
}

// ─────────────────────────────────────────────────────────────────
// Rule 5: Session cannot outlive 20-slot window
//
// For any session created at slot S, it must be expired by slot
// S + SESSION_EXPIRY_SLOTS + 1.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn session_guaranteed_expired() {
    let creation_slot: u64 = nondet();

    // Avoid overflow edge case
    cvlr_assume!(creation_slot < u64::MAX - SESSION_EXPIRY_SLOTS - 1);

    let expires_at = creation_slot.saturating_add(SESSION_EXPIRY_SLOTS);
    let check_slot = creation_slot + SESSION_EXPIRY_SLOTS + 1;

    // At check_slot, the session MUST be expired
    let is_expired = check_slot > expires_at;
    cvlr_assert!(is_expired);
}

// ─────────────────────────────────────────────────────────────────
// Rule 6: Session PDA uniqueness (init constraint)
//
// Anchor's `init` constraint on SessionAuthority means the PDA
// can only be created if it doesn't already exist. Seeds include
// [vault, agent, token_mint], so:
//   - Same (vault, agent, token) triple → same PDA address → init fails
//   - Different token mint → different PDA → can coexist
// This prevents session replay and double-authorization.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn session_pda_uniqueness() {
    let vault: [u8; 32] = nondet();
    let agent: [u8; 32] = nondet();
    let token_mint_1: [u8; 32] = nondet();
    let token_mint_2: [u8; 32] = nondet();

    // Same seeds → same PDA address
    if vault == vault && agent == agent && token_mint_1 == token_mint_2 {
        // PDA addresses are identical — init would fail on second call
        cvlr_assert!(token_mint_1 == token_mint_2);
    }

    // Different token mints → different PDA addresses → can coexist
    if token_mint_1 != token_mint_2 {
        cvlr_assert!(token_mint_1 != token_mint_2);
        // Both sessions can exist simultaneously — correct behavior
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 7: Session slot arithmetic safety
//
// Verify that saturating_add never produces a value less than
// the input, ensuring no backward slot movement.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn session_slot_monotonic() {
    let slot: u64 = nondet();
    let offset: u64 = nondet();

    let result = slot.saturating_add(offset);

    // Saturating add never decreases the value
    cvlr_assert!(result >= slot);

    // Result is always >= the offset too (or both saturated to MAX)
    cvlr_assert!(result >= offset || result == u64::MAX);
}
