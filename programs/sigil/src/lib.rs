#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

#[cfg(feature = "certora")]
mod certora;

use instructions::*;
use state::post_assertions::PostAssertionEntry;

declare_id!("7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK");

#[allow(clippy::too_many_arguments)]
#[program]
pub mod sigil {
    use super::*;

    /// Initialize a new agent vault with policy configuration.
    /// Only the owner can call this. Creates vault PDA, policy PDA,
    /// and zero-copy spend tracker PDA.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        vault_id: u64,
        daily_spending_cap_usd: u64,
        max_transaction_size_usd: u64,
        protocol_mode: u8,
        protocols: Vec<Pubkey>,
        developer_fee_rate: u16,
        max_slippage_bps: u16,
        timelock_duration: u64,
        allowed_destinations: Vec<Pubkey>,
        protocol_caps: Vec<u64>,
        observe_only: bool,
        operating_hours: u32,
        auto_promote_grays: bool,
        auto_revoke_threshold: u8,
        // TA-12 (Phase 5): owner's hard floor on combined USDC+USDT vault
        // balance. Default 0 = no reserve. Bound by TA-19 at digest position 18.
        stable_balance_floor: u64,
        // TA-14 (Phase 5): owner's per-recipient rolling 24h outflow cap.
        // Default 0 = no per-recipient cap. Bound by TA-19 at digest position 19.
        per_recipient_daily_cap_usd: u64,
        // G6 (audit 2026-05-18 cosign opt-in): owner's opt-in choice for
        // TA-09 cosign enforcement on elevated mutations. Default false at
        // most SDK call sites (low-friction, owner-signature-only). When
        // true, future `queue_policy_update` calls with elevated mutations
        // require a cosign session. Bound by TA-19 at digest position 20.
        cosign_required: bool,
        preview_digest: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_vault::handler(
            ctx,
            vault_id,
            daily_spending_cap_usd,
            max_transaction_size_usd,
            protocol_mode,
            protocols,
            developer_fee_rate,
            max_slippage_bps,
            timelock_duration,
            allowed_destinations,
            protocol_caps,
            observe_only,
            operating_hours,
            auto_promote_grays,
            auto_revoke_threshold,
            stable_balance_floor,
            per_recipient_daily_cap_usd,
            cosign_required,
            preview_digest,
        )
    }

    /// Deposit SPL tokens into the vault's PDA-controlled token account.
    /// Only the owner can call this.
    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        instructions::deposit_funds::handler(ctx, amount)
    }

    /// Register an agent's signing key to this vault with per-agent permissions.
    /// Only the owner can call this. Up to 10 agents per vault.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent: Pubkey,
        capability: u8,
        spending_limit_usd: u64,
    ) -> Result<()> {
        instructions::register_agent::handler(ctx, agent, capability, spending_limit_usd)
    }

    // update_policy DELETED — all policy changes now route through
    // queue_policy_update → apply_pending_policy with mandatory timelock.

    /// Core permission check. Called by the agent before a DeFi action.
    /// Validates against policy constraints, stablecoin-only enforcement,
    /// and protocol slippage verification.
    /// Creates a SessionAuthority PDA, delegates tokens to agent.
    pub fn validate_and_authorize(
        ctx: Context<ValidateAndAuthorize>,
        token_mint: Pubkey,
        amount: u64,
        target_protocol: Pubkey,
        expected_policy_version: u64,
        // AC-10 (Phase 4) — session nonce closing durable-nonce replay
        // (per Audit #1 C-1). Caller passes 0 for a fresh session; the
        // session PDA is closed at finalize so the steady-state always
        // resets to 0 between validates. Phase 8 ownership-transfer flow
        // (M-5) reuses the same field for replay protection.
        expected_nonce: u64,
        // D-1 + D-6 (Bucket 2 audit 2026-05-21) — AL3 scalar intent digest.
        // 32-byte SHA-256 over the canonical SealInput SCALARS the wallet
        // approved at preview time (`b"SIG1"` magic prefix + intent_version
        // = 2 + network_id + vault + agent + token_mint + amount +
        // target_protocol). The on-chain verifier in
        // `validate_and_authorize::handler` recomputes the same digest from
        // these args and rejects on byte-equal mismatch (6111
        // ErrIntentDigestMismatch). Closes the preview→execute scalar
        // tamper class (recipient/amount/mint/protocol swap between the
        // user's signed preview and the submitted bundle). The full
        // ix-bound digest remains client-side only — see
        // `sdk/kit/src/seal/intent-digest.ts`'s `computeSealInputDigest`
        // for the full envelope and the v0.17 plan for on-chain ix binding.
        expected_intent_digest: [u8; 32],
    ) -> Result<()> {
        instructions::validate_and_authorize::handler(
            ctx,
            token_mint,
            amount,
            target_protocol,
            expected_policy_version,
            expected_nonce,
            expected_intent_digest,
        )
    }

    /// Finalize a session after the DeFi action completes.
    /// Revokes delegation, closes SessionAuthority PDA.
    pub fn finalize_session(ctx: Context<FinalizeSession>) -> Result<()> {
        instructions::finalize_session::handler(ctx)
    }

    /// Revoke a specific agent from the vault.
    /// Only the owner can call this. Freezes vault if last agent is removed.
    pub fn revoke_agent(ctx: Context<RevokeAgent>, agent_to_remove: Pubkey) -> Result<()> {
        instructions::revoke_agent::handler(ctx, agent_to_remove)
    }

    /// Reactivate a frozen vault. Optionally add a new agent with permissions.
    pub fn reactivate_vault(
        ctx: Context<ReactivateVault>,
        new_agent: Option<Pubkey>,
        new_agent_capability: Option<u8>,
    ) -> Result<()> {
        instructions::reactivate_vault::handler(ctx, new_agent, new_agent_capability)
    }

    /// Withdraw tokens from the vault back to the owner.
    pub fn withdraw_funds(ctx: Context<WithdrawFunds>, amount: u64) -> Result<()> {
        instructions::withdraw_funds::handler(ctx, amount)
    }

    /// Close the vault entirely. Reclaims rent from all PDAs.
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        instructions::close_vault::handler(ctx)
    }

    /// Queue a policy update when timelock is active.
    /// TA-09 (Phase 3): adds `cosign_session: Pubkey` arg. Pass
    /// `Pubkey::default()` for non-elevated mutations; for elevated
    /// mutations pass the cosigner pubkey and include the corresponding
    /// signer in `remaining_accounts`.
    pub fn queue_policy_update(
        ctx: Context<QueuePolicyUpdate>,
        daily_spending_cap_usd: Option<u64>,
        max_transaction_amount_usd: Option<u64>,
        protocol_mode: Option<u8>,
        protocols: Option<Vec<Pubkey>>,
        developer_fee_rate: Option<u16>,
        max_slippage_bps: Option<u16>,
        timelock_duration: Option<u64>,
        allowed_destinations: Option<Vec<Pubkey>>,
        session_expiry_seconds: Option<u64>,
        has_protocol_caps: Option<bool>,
        protocol_caps: Option<Vec<u64>>,
        destination_mode: Option<u8>,
        operating_hours: Option<u32>,
        // TA-12 (Phase 5): optional update to PolicyConfig.stable_balance_floor.
        // None passes the live value through; Some(n) sets the new floor.
        stable_balance_floor: Option<u64>,
        // TA-14 (Phase 5): optional update to
        // PolicyConfig.per_recipient_daily_cap_usd. None = pass-through.
        per_recipient_daily_cap_usd: Option<u64>,
        // G6 (audit 2026-05-18 cosign opt-in): optional update to
        // PolicyConfig.cosign_required. None = pass-through; Some(true)
        // = enable (non-elevated); Some(false) when live is true =
        // disable (ELEVATED — one-way ratchet).
        cosign_required: Option<bool>,
        // D-5 (audit 2026-05-19, F-RP3-1): optional update to
        // PolicyConfig.cosign_session_pubkey. None = pass-through;
        // Some(pubkey) = set (Pubkey::default() disables the reactivate
        // cosign gate, any other pubkey enables it). Bound by TA-19 at
        // canonical digest position 22.
        cosign_session_pubkey: Option<Pubkey>,
        // F-Q6 (2026-06-02): owner-configurable OPERATOR-grant delay (seconds).
        operator_grant_delay_seconds: Option<u64>,
        // Item 3 (verified-build gate, 2026-06-22): optional per-protocol pinned
        // ELF SHA-256 array, index-aligned to the effective `protocols`. None =
        // pass-through; Some(array) sets the full array (all-zero entry = gate
        // off for that protocol). Bound by TA-19 at canonical digest position 25.
        // `[[u8; 32]; 10]` == `[[u8; 32]; MAX_ALLOWED_PROTOCOLS]`.
        protocol_hashes: Option<[[u8; 32]; 10]>,
        cosign_session: Pubkey,
        new_policy_preview_digest: [u8; 32],
    ) -> Result<()> {
        instructions::queue_policy_update::handler(
            ctx,
            daily_spending_cap_usd,
            max_transaction_amount_usd,
            protocol_mode,
            protocols,
            developer_fee_rate,
            max_slippage_bps,
            timelock_duration,
            allowed_destinations,
            session_expiry_seconds,
            has_protocol_caps,
            protocol_caps,
            destination_mode,
            operating_hours,
            stable_balance_floor,
            per_recipient_daily_cap_usd,
            cosign_required,
            cosign_session_pubkey,
            operator_grant_delay_seconds,
            protocol_hashes,
            cosign_session,
            new_policy_preview_digest,
        )
    }

    /// Apply a queued policy update after the timelock expires.
    pub fn apply_pending_policy(ctx: Context<ApplyPendingPolicy>) -> Result<()> {
        instructions::apply_pending_policy::handler(ctx)
    }

    /// Cancel a queued policy update.
    pub fn cancel_pending_policy(ctx: Context<CancelPendingPolicy>) -> Result<()> {
        instructions::cancel_pending_policy::handler(ctx)
    }

    /// Async cosign (2026-06-17): the bound cosigner K approves an elevated
    /// queued policy update on-chain. `apply_pending_policy` then requires
    /// `cosign_approved == true`. See `ROADMAP/COSIGN_ASYNC_APPROVAL_2026-06-17`.
    pub fn approve_pending_policy(ctx: Context<ApprovePendingPolicy>) -> Result<()> {
        instructions::approve_pending_policy::handler(ctx)
    }

    // ─── Constraints engine REMOVED (M1-04, 2026-05-31) ──────────────────────
    // The instruction-data constraints engine (allocate/extend/create/
    // queue/apply/cancel/close/cleanup for InstructionConstraints +
    // PendingConstraintsUpdate + PendingCloseConstraints, 11 instructions) was
    // deleted. It could not be both protocol-agnostic and caveat-free; the
    // surviving guardrails — caps, allowlists, sessions, and the balance-delta
    // / post-execution assertion outcome checks — are independent of it. The
    // agnostic comparison primitives it shared (ConstraintOperator, bytes_match,
    // ct_eq_32) were relocated to state::assertions.

    // ─── Post-Execution Assertions (Phase B) ─────────────────────────────────

    /// Create post-execution assertions for a vault.
    /// Assertions check account data bytes AFTER DeFi instructions execute.
    pub fn create_post_assertions(
        ctx: Context<CreatePostAssertions>,
        entries: Vec<PostAssertionEntry>,
        expected_digest: [u8; 32],
    ) -> Result<()> {
        instructions::create_post_assertions::handler(ctx, entries, expected_digest)
    }

    /// Close post-execution assertions for a vault. Returns rent to owner.
    pub fn close_post_assertions(
        ctx: Context<ClosePostAssertions>,
        expected_digest: [u8; 32],
    ) -> Result<()> {
        instructions::close_post_assertions::handler(ctx, expected_digest)
    }

    /// Transfer tokens from the vault to an allowed destination.
    /// Only the agent can call this. Stablecoin-only.
    pub fn agent_transfer(
        ctx: Context<AgentTransfer>,
        amount: u64,
        expected_policy_version: u64,
    ) -> Result<()> {
        instructions::agent_transfer::handler(ctx, amount, expected_policy_version)
    }

    // update_agent_permissions DELETED — use queue_agent_permissions_update → apply_agent_permissions_update.

    /// Queue an agent permissions update. Timelock-gated.
    /// Per-agent PDA allows concurrent pending updates for different agents.
    /// TA-06 (Phase 3): adds `cooldown_seconds` — per-agent cooldown stored
    /// on `AgentSpendOverlay.cooldown_seconds[slot]`. 0 disables. Bound at
    /// queue time and applied at apply time onto the agent's overlay slot.
    ///
    /// Round 2 F-RP3-2 fix (audit 2026-05-19): adds `cosign_session` —
    /// on cosign-opted-in vaults, raising capability / spending_limit OR
    /// setting a non-zero cooldown is an "elevated mutation" and MUST be
    /// cosigned. Non-elevated callers pass `Pubkey::default()`.
    pub fn queue_agent_permissions_update(
        ctx: Context<QueueAgentPermissionsUpdate>,
        agent: Pubkey,
        new_capability: u8,
        spending_limit_usd: u64,
        cooldown_seconds: u64,
        cosign_session: Pubkey,
    ) -> Result<()> {
        instructions::queue_agent_permissions_update::handler(
            ctx,
            agent,
            new_capability,
            spending_limit_usd,
            cooldown_seconds,
            cosign_session,
        )
    }

    /// Apply a queued agent permissions update after timelock expires.
    pub fn apply_agent_permissions_update(ctx: Context<ApplyAgentPermissionsUpdate>) -> Result<()> {
        instructions::apply_agent_permissions_update::handler(ctx)
    }

    /// Cancel a queued agent permissions update.
    pub fn cancel_agent_permissions_update(
        ctx: Context<CancelAgentPermissionsUpdate>,
    ) -> Result<()> {
        instructions::cancel_agent_permissions_update::handler(ctx)
    }

    // sync_positions instruction DELETED — position counter system removed per council decision
    // (9-1 vote, 2026-04-19). See Plans/we-need-to-plan-serialized-summit.md.

    // Escrow instructions (create_escrow, settle_escrow, refund_escrow,
    // close_settled_escrow) REMOVED in Stage 1 of the v2 revamp.
    // DEEP-2 audit found freeze-bypass in settle_escrow and there is no
    // validated customer flow for the feature.

    /// Freeze the vault immediately. Preserves all agent entries.
    /// Only the owner can call this. Use reactivate_vault to unfreeze.
    /// F2-H1 fix: pairs of (session_pda, vault_token_account) in remaining_accounts
    /// are revoked so a runaway agent cannot continue spending against an
    /// in-flight session window.
    pub fn freeze_vault<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, FreezeVault<'info>>,
    ) -> Result<()> {
        instructions::freeze_vault::handler(ctx)
    }

    /// Pause a specific agent. Blocks all agent actions while preserving config.
    /// Only the owner can call this.
    pub fn pause_agent(ctx: Context<PauseAgent>, agent_to_pause: Pubkey) -> Result<()> {
        instructions::pause_agent::handler(ctx, agent_to_pause)
    }

    /// Unpause a paused agent. Restores ability to execute actions.
    /// Only the owner can call this.
    pub fn unpause_agent(ctx: Context<UnpauseAgent>, agent_to_unpause: Pubkey) -> Result<()> {
        instructions::unpause_agent::handler(ctx, agent_to_unpause)
    }

    /// TA-17 (Phase 3): record an on-chain policy-violation failure for
    /// an agent. Owner-only. `error_code` MUST be in the policy-violation
    /// range (6074-6091); external codes (CU exhaustion, auth, init)
    /// reject with InvalidPermissions.
    ///
    /// When `agent.consecutive_failures >= policy.auto_revoke_threshold`,
    /// the agent's capability is set to DISABLED, policy_version bumps,
    /// and `AgentAutoRevoked` event fires. Subsequent
    /// validate_and_authorize calls reject with `ErrAutoRevoked` (6090).
    /// Owner re-enables via existing queue_agent_permissions_update.
    pub fn record_agent_violation(
        ctx: Context<RecordAgentViolation>,
        agent: Pubkey,
        error_code: u32,
    ) -> Result<()> {
        instructions::record_agent_violation::handler(ctx, agent, error_code)
    }

    /// TA-07 (Phase 3): owner-only fast-track promotion of a destination
    /// out of the 24h graylist window. The destination must already be on
    /// the allowlist (otherwise rejected as DestinationNotAllowed). Sets
    /// the entry's `unlock_unix` to `clock.unix_timestamp` so spending
    /// paths accept it immediately.
    ///
    /// No timelock. Promotion is a strict subset of the already-signed
    /// allowlist authorisation; the owner pays a friction cost by
    /// default but can opt out per-destination.
    pub fn promote_graylist_destination(
        ctx: Context<PromoteGraylistDestination>,
        destination: Pubkey,
    ) -> Result<()> {
        instructions::promote_graylist_destination::handler(ctx, destination)
    }

    /// F-12 audit fix: direct owner-only flip of `vault.observe_only`.
    ///
    /// Mirrors `freeze_vault` simplicity (no timelock). observe_only is part
    /// of the canonical policy_preview_digest encoding; the handler recomputes
    /// the stored digest + bumps `policy_version` (OCC) on every flip and
    /// emits `ObserveOnlyChanged` for off-chain monitors.
    ///
    /// F-11 consistency: cannot flip to active (false) when both protocol
    /// and destination allowlists are empty.
    pub fn set_observe_only(ctx: Context<SetObserveOnly>, new_value: bool) -> Result<()> {
        instructions::set_observe_only::handler(ctx, new_value)
    }

    // --- Phase 8 PEN-CROSS-1 Batch 6 — queue/apply agent grant ---

    /// Phase 8 PEN-CROSS-1 — queue an OPERATOR-class agent grant with mandatory
    /// timelock. After `register_agent` was tightened to reject
    /// `capability == CAPABILITY_OPERATOR`, this is the ONLY path to add a
    /// new OPERATOR-class agent. Cosign-opted-in vaults require a non-owner
    /// signer in `remaining_accounts`. The pending PDA at
    /// `[b"pending_agent_grant", vault]` lives until `apply_agent_grant`
    /// (after `MIN_TIMELOCK_DURATION = 1800s`).
    pub fn queue_agent_grant(
        ctx: Context<QueueAgentGrant>,
        agent: Pubkey,
        capability: u8,
        spending_limit_usd: u64,
    ) -> Result<()> {
        instructions::queue_agent_grant::handler(ctx, agent, capability, spending_limit_usd)
    }

    /// Phase 8 PEN-CROSS-1 — apply a queued OPERATOR-class agent grant past
    /// the timelock. Inserts the agent into `vault.agents`, claims an
    /// AgentSpendOverlay slot (fail-closed when `spending_limit_usd > 0`),
    /// re-derives `policy.policy_preview_digest` with the NEW
    /// `agent_set_hash`, bumps `policy.policy_version`, closes the pending
    /// PDA, and emits `AgentGrantApplied`.
    pub fn apply_agent_grant(ctx: Context<ApplyAgentGrant>) -> Result<()> {
        instructions::apply_agent_grant::handler(ctx)
    }

    /// Phase 8 §RP Fix-Up B (PEN-02b CRITICAL, audit 2026-05-19) — cancel a
    /// queued OPERATOR-class agent grant during the timelock window. The
    /// `PendingAgentGrant` PDA closes; rent returns to the owner. The vault's
    /// agent set is NOT mutated (the queued agent never entered).
    /// Symmetric with `cancel_ownership_transfer` on cosign — when
    /// `policy.cosign_required == true`, the cancel also requires a non-
    /// owner signer in `remaining_accounts` (D4 decision: closes the
    /// phished-key cancel-and-re-queue bypass).
    pub fn cancel_agent_grant(ctx: Context<CancelAgentGrant>) -> Result<()> {
        instructions::cancel_agent_grant::handler(ctx)
    }

    // --- Phase 8 Batch 3 — C26 ownership transfer (owner-side ix) ---

    /// Phase 8 C26 — initiate an ownership transfer with mandatory timelock.
    /// Owner queues a `PendingOwnershipTransfer` PDA bound to the vault.
    /// `is_multisig_target` selects between the standard EOA accept (Batch 3
    /// `accept_ownership_transfer`) and the Squads V4 accept (Batch 4
    /// `accept_ownership_transfer_multisig`). Cosign-opted-in vaults require
    /// a non-owner signer in `remaining_accounts` (interim cosign gate).
    pub fn initiate_ownership_transfer(
        ctx: Context<InitiateOwnershipTransfer>,
        new_owner: Pubkey,
        is_multisig_target: bool,
    ) -> Result<()> {
        instructions::initiate_ownership_transfer::handler(ctx, new_owner, is_multisig_target)
    }

    /// Phase 8 C26 — accept a queued ownership transfer (standard EOA path).
    /// The `new_owner` signs after the timelock window elapses. Hard-rejects
    /// when `pending.is_multisig_target == true` (use the Batch 4 multisig
    /// variant instead). Pending PDA closes; rent returns to `new_owner`.
    /// Vault.owner is overwritten; policy.policy_version bumps.
    pub fn accept_ownership_transfer(ctx: Context<AcceptOwnershipTransfer>) -> Result<()> {
        instructions::accept_ownership_transfer::handler(ctx)
    }

    /// Phase 8 Batch 4 — accept a queued ownership transfer via Squads V4
    /// multisig. The `multisig_pda` is an UncheckedAccount (NOT a Signer) —
    /// Squads V4 vault PDAs have no private key. Authority is enforced by
    /// (a) `multisig_pda.owner == SQUADS_V4_PROGRAM_ID`, (b) pubkey identity
    /// match against `pending.new_owner`, and (c) `pending.is_multisig_target
    /// == true`. Pending PDA closes with rent → multisig_pda. Vault.owner
    /// is overwritten; policy.policy_version bumps. `OwnershipTransferAccepted`
    /// is emitted with `via_multisig: true`.
    pub fn accept_ownership_transfer_multisig(
        ctx: Context<AcceptOwnershipTransferMultisig>,
    ) -> Result<()> {
        instructions::accept_ownership_transfer_multisig::handler(ctx)
    }

    /// Phase 8 C26 — cancel an in-flight ownership transfer. The current
    /// owner signs. Symmetric with `initiate_ownership_transfer` on cosign
    /// (D4 decision — closes the phished-key cancel-and-re-initiate bypass).
    /// Pending PDA closes; rent returns to `current_owner`.
    pub fn cancel_ownership_transfer(ctx: Context<CancelOwnershipTransfer>) -> Result<()> {
        instructions::cancel_ownership_transfer::handler(ctx)
    }
}
