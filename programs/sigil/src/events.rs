use anchor_lang::prelude::*;

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub vault_id: u64,
    pub timestamp: i64,
}

#[event]
pub struct FundsDeposited {
    pub vault: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct AgentRegistered {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub capability: u8,
    pub spending_limit_usd: u64,
    pub timestamp: i64,
}

#[event]
pub struct AgentSpendLimitChecked {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub agent_rolling_spend: u64,
    pub spending_limit_usd: u64,
    pub amount: u64,
    pub timestamp: i64,
}

// PolicyUpdated event removed — replaced by PolicyChangeApplied (queue/apply path).

#[event]
pub struct ActionAuthorized {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub usd_amount: u64,
    pub protocol: Pubkey,
    pub rolling_spend_usd_after: u64,
    pub daily_cap_usd: u64,
    pub delegated: bool,
    pub timestamp: i64,
}

#[event]
pub struct SessionFinalized {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub success: bool,
    pub is_expired: bool,
    pub timestamp: i64,
    /// Actual stablecoin spend measured by balance delta (0 for non-spending actions).
    pub actual_spend_usd: u64,
    /// Vault stablecoin balance after this transaction (0 for non-spending).
    pub balance_after_usd: u64,
}

#[event]
pub struct DelegationRevoked {
    pub vault: Pubkey,
    pub token_account: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AgentRevoked {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub remaining_agents: u8,
    pub timestamp: i64,
}

#[event]
pub struct VaultReactivated {
    pub vault: Pubkey,
    pub new_agent: Option<Pubkey>,
    pub new_agent_capability: Option<u8>,
    pub timestamp: i64,
}

#[event]
pub struct FundsWithdrawn {
    pub vault: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeesCollected {
    pub vault: Pubkey,
    pub token_mint: Pubkey,
    pub protocol_fee_amount: u64,
    pub developer_fee_amount: u64,
    pub protocol_fee_rate: u16,
    pub developer_fee_rate: u16,
    pub transaction_amount: u64,
    pub protocol_treasury: Pubkey,
    pub developer_fee_destination: Pubkey,
    pub cumulative_developer_fees: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultClosed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct PolicyChangeQueued {
    pub vault: Pubkey,
    pub executes_at: i64,
}

#[event]
pub struct PolicyChangeApplied {
    pub vault: Pubkey,
    pub applied_at: i64,
}

#[event]
pub struct PolicyChangeCancelled {
    pub vault: Pubkey,
}

/// Async cosign approval (2026-06-17): the bound cosigner K approved an elevated
/// queued policy update via `approve_pending_policy`. `apply_pending_policy` then
/// requires `cosign_approved == true`.
#[event]
pub struct PolicyCosignApproved {
    pub vault: Pubkey,
    pub cosigner: Pubkey,
    pub approved_at_slot: u64,
}

#[event]
pub struct AgentTransferExecuted {
    pub vault: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
}

// AgentPermissionsUpdated event removed — replaced by AgentPermissionsChangeApplied (queue/apply path).
// PositionsSynced event removed — sync_positions instruction deleted with position counter (2026-04-19).

// M1-04 (constraints-engine teardown, 2026-05-31): the constraints-engine
// events were removed with their (deleted) emitters: InstructionConstraintsCreated,
// PdaAllocated, PdaExtended, ConstraintsChange{Queued,Applied,Cancelled},
// CloseConstraints{Queued,Applied,Cancelled}, OrphanConstraintsPdaCleaned.

// Escrow events (EscrowCreated, EscrowSettled, EscrowRefunded) REMOVED in
// Stage 1 of the v2 revamp.

#[event]
pub struct VaultFrozen {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub agents_preserved: u8,
    /// Number of active session SPL delegations revoked during freeze (F2-H1 fix).
    /// Caller passes (session_pda, vault_token_account) pairs in remaining_accounts;
    /// each pair whose session_pda matches the expected derivation is revoked.
    pub sessions_revoked: u32,
    pub timestamp: i64,
    /// Phase 8 — discriminant of `FreezeReason` enum recording WHY the vault
    /// was frozen. 0 = Manual (`freeze_vault`), 1 = AutoRevoke (last agent
    /// removed via `revoke_agent`), 2 = EmergencyBoard (reserved v1.1).
    /// APPENDED at end per APPEND-ONLY event-stability rule.
    pub freeze_reason: u8,
}

#[event]
pub struct AgentPausedEvent {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AgentUnpausedEvent {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub timestamp: i64,
}

// --- TOCTOU fix: queued agent permissions + constraint closure events ---

#[event]
pub struct AgentPermissionsChangeQueued {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub executes_at: i64,
}

#[event]
pub struct AgentPermissionsChangeApplied {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub applied_at: i64,
}

#[event]
pub struct AgentPermissionsChangeCancelled {
    pub vault: Pubkey,
    pub agent: Pubkey,
}

// --- Post-execution assertions (Phase B) ---

#[event]
pub struct PostAssertionsCreated {
    pub vault: Pubkey,
    pub entry_count: u8,
    pub timestamp: i64,
}

#[event]
pub struct PostAssertionsClosed {
    pub vault: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct PostAssertionChecked {
    pub vault: Pubkey,
    pub entry_index: u8,
    pub passed: bool,
    pub timestamp: i64,
}

// --- F-12 audit fix: observe_only direct flip ---

/// Emitted when `set_observe_only` flips `vault.observe_only`. Off-chain
/// monitors use `new_policy_preview_digest` + `new_policy_version` for OCC
/// reconciliation against their cached policy view.
#[event]
pub struct ObserveOnlyChanged {
    pub vault: Pubkey,
    pub old_value: bool,
    pub new_value: bool,
    pub new_policy_version: u64,
    pub new_policy_preview_digest: [u8; 32],
    pub timestamp: i64,
}

// --- Phase 3 pre-execution guards events ---

/// TA-07 (Phase 3): a destination entered the graylist with a 24h unlock
/// (or `unlock_unix == now` if `auto_promote_grays` was true). Emitted
/// from `apply_pending_policy` when allowed_destinations gains a new entry.
#[event]
pub struct GraylistEntered {
    pub vault: Pubkey,
    pub destination: Pubkey,
    pub unlock_unix: i64,
    pub auto_promoted: bool,
    pub timestamp: i64,
}

/// TA-07 (Phase 3): owner promoted a destination out of the graylist via
/// `promote_graylist_destination`. `promoted = false` when the destination
/// was already past unlock (no-op promotion — still emitted for audit).
#[event]
pub struct GraylistPromoted {
    pub vault: Pubkey,
    pub destination: Pubkey,
    pub promoted: bool,
    pub timestamp: i64,
}

/// TA-17 (Phase 3): an agent's capability was auto-revoked after
/// `consecutive_failures >= policy.auto_revoke_threshold` policy-violation
/// failures. Owner re-enables via `queue_agent_permissions_update`.
#[event]
pub struct AgentAutoRevoked {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub threshold: u8,
    pub consecutive_failures: u8,
    pub timestamp: i64,
}

// --- Phase 8 (C26 ownership transfer) events ---
// Appended at END to preserve existing event layouts. Off-chain indexers
// keyed by event-account ordinal will pick these up as the next slots.

/// Phase 8 C26 — owner queued a `PendingOwnershipTransfer`. Off-chain
/// monitors should ALERT on this event for any vault they protect — if the
/// owner did not initiate the queue, this is a phished-key attack signal
/// and the owner has `min_delay_seconds` (default 48h) to
/// `cancel_ownership_transfer` before the timelock elapses.
#[event]
pub struct OwnershipTransferInitiated {
    pub vault: Pubkey,
    pub current_owner: Pubkey,
    pub new_owner: Pubkey,
    pub queued_at: i64,
    pub is_multisig_target: bool,
}

/// Phase 8 C26 — `new_owner` (or the multisig PDA, Batch 4) accepted a queued
/// transfer past timelock. `previous_owner` is the pubkey that signed the
/// initiate (and matches `pending.current_owner`). `via_multisig` flags the
/// Batch 4 path so off-chain monitors can distinguish EOA vs Squads accepts.
#[event]
pub struct OwnershipTransferAccepted {
    pub vault: Pubkey,
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
    pub via_multisig: bool,
    pub timestamp: i64,
}

/// Phase 8 C26 — `current_owner` cancelled a queued transfer. `cancelled_new_owner`
/// echoes the target pubkey from the cancelled PDA so off-chain monitors
/// can correlate cancel ↔ initiate without re-fetching the (now-closed) PDA.
#[event]
pub struct OwnershipTransferCancelled {
    pub vault: Pubkey,
    pub current_owner: Pubkey,
    pub cancelled_new_owner: Pubkey,
    pub timestamp: i64,
}

// --- Phase 8 PEN-CROSS-1 (Batch 6) — queue/apply agent grant events ---
// Appended at END preserving event-stream layout.

/// Phase 8 PEN-CROSS-1 — owner queued an OPERATOR-class agent grant. The
/// agent is NOT yet in `vault.agents`; off-chain monitors should ALERT on
/// this event for any vault they protect. If the owner didn't initiate the
/// queue, this is a phished-key attack signal — the owner has
/// `min_delay_seconds` (default 1800s = 30 min) to abort before
/// `apply_agent_grant` can land. (A `cancel_agent_grant` instruction is
/// planned for a follow-up batch; until then, observers should freeze the
/// vault if the queue was unauthorized.)
#[event]
pub struct AgentGrantQueued {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub capability: u8,
    pub spending_limit_usd: u64,
    pub queued_at: i64,
    pub executes_at: i64,
}

/// Phase 8 PEN-CROSS-1 — owner applied a queued OPERATOR-class agent grant
/// past the timelock window. The agent is now in `vault.agents` and the
/// policy_preview_digest has been re-derived to bind the new agent_set_hash.
/// `new_policy_version` is the post-bump version; in-flight
/// `validate_and_authorize` ix snapshotted the prior version will fail fast
/// with PolicyVersionMismatch under the new authority surface.
#[event]
pub struct AgentGrantApplied {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub capability: u8,
    pub spending_limit_usd: u64,
    pub queued_at: i64,
    pub applied_at: i64,
    pub new_policy_version: u64,
}

/// Phase 8 §RP Fix-Up B (PEN-02b CRITICAL, audit 2026-05-19) — owner
/// cancelled a queued OPERATOR-class agent grant during the timelock window.
/// `cancelled_agent` echoes the agent pubkey from the closed PDA so off-chain
/// monitors can correlate the queue ↔ cancel pair without re-fetching the
/// now-closed PDA. Off-chain monitors should ALERT on this event for any
/// vault they protect — if the owner did not initiate the cancel, this is
/// a phished-key attempt to abort a legitimate grant.
#[event]
pub struct AgentGrantCancelled {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub cancelled_agent: Pubkey,
    pub timestamp: i64,
}
