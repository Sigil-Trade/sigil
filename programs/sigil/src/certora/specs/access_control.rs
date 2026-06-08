// CVLR Specification: Access Control Constants & Logic
//
// Verifies safety-critical constants and pure helper functions
// that underpin Sigil's authorization model.
// V2: TrackerTier removed — epoch-based circular buffer replaces tiered tracking.
// V3: Oracle system removed — stablecoin-only architecture.

use crate::state::{
    AgentEntry, AgentVault, VaultStatus, CAPABILITY_DISABLED, CAPABILITY_OBSERVER,
    CAPABILITY_OPERATOR, EPOCH_DURATION, MAX_ALLOWED_DESTINATIONS, MAX_ALLOWED_PROTOCOLS,
    MAX_DEVELOPER_FEE_RATE, MAX_OWNER_SESSION_DURATION_SECONDS, NUM_EPOCHS, ROLLING_WINDOW_SECONDS,
    SESSION_DURATION_SECONDS,
};
use anchor_lang::prelude::Pubkey;
use cvlr::prelude::*;

// Helper (spec-only): build a single-agent vault whose sole agent carries the
// given capability byte. Used by the capability-separation rules so the prover
// reasons over a concrete one-element `agents` Vec (well within loop_iter=3)
// while the capability byte itself is symbolic. This is NOT a handler driver —
// it constructs plain program state and exercises the program's own
// `AgentVault::has_capability` decision function. (The enclosing `certora`
// module is already `#[cfg(feature = "certora")]` gated at lib.rs, so no
// per-item gate is needed here.)
fn vault_with_one_agent(agent: Pubkey, capability: u8) -> AgentVault {
    AgentVault {
        owner: Pubkey::new_from_array([1u8; 32]),
        vault_id: 0,
        agents: vec![AgentEntry {
            pubkey: agent,
            capability,
            spending_limit_usd: 0,
            paused: false,
            consecutive_failures: 0,
            _reserved: [0u8; 6],
        }],
        fee_destination: Pubkey::default(),
        status: VaultStatus::Active,
        bump: 0,
        created_at: 0,
        total_transactions: 0,
        total_volume: 0,
        total_fees_collected: 0,
        total_deposited_usd: 0,
        total_withdrawn_usd: 0,
        total_failed_transactions: 0,
        active_sessions: 0,
        observe_only: false,
        frozen_at_timestamp: 0,
        freeze_reason: 0,
        owner_type: 0,
        vault_authority: Pubkey::default(),
    }
}

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
// Rule 2: Session duration is 30 seconds (wall-clock)
//
// Audit F5-H1: replaces the prior slot-based 20 (~8s at 400ms/slot,
// ~30s at 1.5s/slot). Wall-clock enforcement is congestion-immune.
// MAX_OWNER_SESSION_DURATION_SECONDS bounds owner-configurable values
// (was 450 slots, now 90 seconds).
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_session_duration_is_30_seconds() {
    cvlr_assert!(SESSION_DURATION_SECONDS == 30);
}

#[rule]
pub fn rule_max_owner_session_duration_is_90_seconds() {
    cvlr_assert!(MAX_OWNER_SESSION_DURATION_SECONDS == 90);
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

// ─────────────────────────────────────────────────────────────────
// Rule 6 (STATEFUL): Capability separation — only OPERATOR may spend
//
// Sigil's authorization model: owner = full authority, agent = execute
// only, and the per-agent `capability` byte gates WHAT an agent may do.
// `AgentVault::has_capability(signer, is_spending)` is the single decision
// function the spending path relies on (finalize_session resolves the agent
// then trusts capability >= OPERATOR for spend). This rule proves that
// function's core safety property over a SYMBOLIC capability byte:
//
//   For ANY capability value, an agent is granted SPENDING authority
//   (`has_capability(.., true) == true`) ONLY when its capability is
//   at least CAPABILITY_OPERATOR. Equivalently, any sub-OPERATOR agent
//   (Disabled=0, Observer=1) can NEVER spend.
//
// This is the on-chain encoding of "agent = execute within policy, never
// elevate" at the capability layer. (The complementary guarantee that an
// agent signer cannot mutate PolicyConfig is enforced by Anchor
// `has_one = owner` account constraints on the policy-update handlers —
// an account-context property outside the reach of the cvlr-only spec
// harness, which cannot drive instruction handlers. This rule proves the
// strongest capability-layer invariant the harness CAN express.)
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_agent_capability_separation() {
    let capability: u8 = nondet();
    let agent = Pubkey::new_from_array([7u8; 32]);
    let vault = vault_with_one_agent(agent, capability);

    // Spending authority is granted IFF capability >= OPERATOR.
    let may_spend = vault.has_capability(&agent, true);
    cvlr_assert!(may_spend == (capability >= CAPABILITY_OPERATOR));

    // Contrapositive made explicit: a sub-OPERATOR agent can never spend.
    if capability < CAPABILITY_OPERATOR {
        cvlr_assert!(!may_spend);
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 7 (STATEFUL): Observer capability is non-spending, execute-capable
//
// Pins the exact Observer/Operator split that the capability model
// depends on:
//   - An OBSERVER agent may perform non-spending operations
//     (`has_capability(.., false) == true`)
//   - An OBSERVER agent may NOT perform spending operations
//     (`has_capability(.., true) == false`)
//   - A DISABLED agent may do neither.
//
// Without this split, an Observer-only agent (intended for read/monitor
// roles) could be silently elevated to move funds. Proving it over the
// real `has_capability` function guarantees the boundary holds for the
// actual code path finalize_session trusts.
// ─────────────────────────────────────────────────────────────────

#[rule]
pub fn rule_observer_capability_is_nonspending() {
    let observer = Pubkey::new_from_array([9u8; 32]);
    let v_obs = vault_with_one_agent(observer, CAPABILITY_OBSERVER);
    // Observer: execute-yes, spend-no.
    cvlr_assert!(v_obs.has_capability(&observer, false));
    cvlr_assert!(!v_obs.has_capability(&observer, true));

    // Disabled: neither.
    let disabled = Pubkey::new_from_array([11u8; 32]);
    let v_dis = vault_with_one_agent(disabled, CAPABILITY_DISABLED);
    cvlr_assert!(!v_dis.has_capability(&disabled, false));
    cvlr_assert!(!v_dis.has_capability(&disabled, true));

    // Operator: both.
    let operator = Pubkey::new_from_array([13u8; 32]);
    let v_op = vault_with_one_agent(operator, CAPABILITY_OPERATOR);
    cvlr_assert!(v_op.has_capability(&operator, false));
    cvlr_assert!(v_op.has_capability(&operator, true));
}
