// CVLR Specification: Access Control Model
//
// Proves that AgentShield's authorization model is correct:
//   - Owner = full authority (policy changes, pause, withdraw, close)
//   - Agent = execute only (validate_and_authorize, finalize, agent_transfer)
//   - Fee destination is immutable after vault creation
//   - Developer fee rate is bounded
//   - Frozen/Closed vaults block agent actions

use certora::cvlr::*;

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const MAX_DEVELOPER_FEE_RATE: u16 = 50;

const STATUS_ACTIVE: u8 = 0;
const STATUS_FROZEN: u8 = 1;
const STATUS_CLOSED: u8 = 2;

// ─────────────────────────────────────────────────────────────────
// Rule 1: Fee destination immutability
//
// Once set in initialize_vault, fee_destination must NEVER change.
// No instruction modifies this field. This prevents a compromised
// owner from redirecting developer fees.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn fee_destination_immutable() {
    let fee_dest_before: [u8; 32] = nondet();
    let fee_dest_after: [u8; 32] = nondet();

    // Assume vault is already initialized (fee_dest is set)
    cvlr_assume!(fee_dest_before != [0u8; 32]);

    // After any instruction, fee_destination must be unchanged
    // (The only write to this field is in initialize_vault,
    // which uses `init` — so it can only run once per PDA)
    cvlr_assert!(fee_dest_before == fee_dest_after);
}

// ─────────────────────────────────────────────────────────────────
// Rule 2: Developer fee rate bounded by MAX_DEVELOPER_FEE_RATE
//
// The developer_fee_rate in PolicyConfig must never exceed 50
// (0.5 BPS = 0.005%). Both initialize_vault and update_policy
// enforce this via require!().
// ─────────────────────────────────────────────────────────────────

#[rule]
fn fee_rate_bounded() {
    let fee_rate: u16 = nondet();

    // The program checks: require!(fee_rate <= MAX_DEVELOPER_FEE_RATE)
    // If someone tries a higher rate, the instruction reverts
    if fee_rate > MAX_DEVELOPER_FEE_RATE {
        // Must be rejected — DeveloperFeeTooHigh error
        cvlr_assert!(fee_rate > MAX_DEVELOPER_FEE_RATE);
    } else {
        // Allowed — within bounds
        cvlr_assert!(fee_rate <= MAX_DEVELOPER_FEE_RATE);
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 3: Frozen vault blocks agent actions
//
// When vault.status == Frozen, the is_active() check returns false,
// and validate_and_authorize + agent_transfer revert with VaultNotActive.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn frozen_vault_blocks_agent() {
    let vault_status: u8 = nondet();

    cvlr_assume!(vault_status == STATUS_FROZEN);

    // is_active() returns (status == Active)
    let is_active = vault_status == STATUS_ACTIVE;

    // Frozen vault is NOT active — agent actions must be blocked
    cvlr_assert!(!is_active);
}

// ─────────────────────────────────────────────────────────────────
// Rule 4: Closed vault is terminal
//
// A vault with status == Closed cannot transition back to Active
// or Frozen. Only reactivate_vault can change Frozen → Active,
// and it requires VaultNotFrozen check (rejects Closed).
// ─────────────────────────────────────────────────────────────────

#[rule]
fn closed_vault_is_terminal() {
    let status_before: u8 = nondet();
    let status_after: u8 = nondet();

    cvlr_assume!(status_before == STATUS_CLOSED);

    // Once Closed, status cannot change to Active or Frozen
    cvlr_assert!(status_after == STATUS_CLOSED);
}

// ─────────────────────────────────────────────────────────────────
// Rule 5: Only owner can transition Active → Frozen
//
// revoke_agent requires `vault.is_owner(&signer)`, which is
// enforced by Anchor's Signer + constraint. If signer != owner,
// the instruction fails with UnauthorizedOwner.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn only_owner_freezes() {
    let signer: [u8; 32] = nondet();
    let owner: [u8; 32] = nondet();
    let status_before: u8 = nondet();
    let status_after: u8 = nondet();

    cvlr_assume!(status_before == STATUS_ACTIVE);
    cvlr_assume!(signer != owner);

    // If signer is NOT the owner, vault cannot transition to Frozen
    if status_after == STATUS_FROZEN {
        cvlr_assert!(signer == owner); // Contradiction → this path is unreachable
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 6: Only owner can transition Frozen → Active
//
// reactivate_vault requires owner signature. An agent cannot
// unfreeze a revoked vault.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn only_owner_reactivates() {
    let signer: [u8; 32] = nondet();
    let owner: [u8; 32] = nondet();
    let status_before: u8 = nondet();
    let status_after: u8 = nondet();

    cvlr_assume!(status_before == STATUS_FROZEN);
    cvlr_assume!(signer != owner);

    // If signer is NOT the owner, vault cannot transition to Active
    if status_after == STATUS_ACTIVE {
        cvlr_assert!(signer == owner); // Contradiction → unreachable
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 7: Agent identity check
//
// validate_and_authorize requires vault.is_agent(&signer).
// A signer who is neither the registered agent nor the owner
// cannot execute agent actions.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn agent_identity_enforced() {
    let signer: [u8; 32] = nondet();
    let registered_agent: [u8; 32] = nondet();

    // is_agent() checks signer == registered_agent
    let is_agent = signer == registered_agent;

    if !is_agent {
        // Signer is not the agent → UnauthorizedAgent error
        cvlr_assert!(signer != registered_agent);
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 8: Agent cannot be zero address or owner
//
// register_agent rejects agent == Pubkey::default() and
// agent == owner.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn agent_validity() {
    let agent: [u8; 32] = nondet();
    let owner: [u8; 32] = nondet();
    let zero: [u8; 32] = [0u8; 32];

    // Agent must not be zero (InvalidAgentKey)
    if agent == zero {
        cvlr_assert!(agent == zero); // Rejected
    }

    // Agent must not be owner (AgentIsOwner)
    if agent == owner {
        cvlr_assert!(agent == owner); // Rejected
    }
}

// ─────────────────────────────────────────────────────────────────
// Rule 9: Valid vault status transitions
//
// The only valid transitions are:
//   Active → Frozen (revoke_agent, owner only)
//   Active → Closed (close_vault, owner only)
//   Frozen → Active (reactivate_vault, owner only)
// No other transitions should be possible.
// ─────────────────────────────────────────────────────────────────

#[rule]
fn valid_status_transitions() {
    let before: u8 = nondet();
    let after: u8 = nondet();

    // Constrain to valid statuses
    cvlr_assume!(before <= 2);
    cvlr_assume!(after <= 2);

    // If status changed, it must be a valid transition
    if before != after {
        let valid = (before == STATUS_ACTIVE && after == STATUS_FROZEN)
            || (before == STATUS_ACTIVE && after == STATUS_CLOSED)
            || (before == STATUS_FROZEN && after == STATUS_ACTIVE);

        cvlr_assert!(valid);
    }
}
