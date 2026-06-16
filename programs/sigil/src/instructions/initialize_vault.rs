use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::VaultCreated;
use crate::state::*;
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = AgentVault::SIZE,
        seeds = [b"vault", owner.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        init,
        payer = owner,
        space = PolicyConfig::SIZE,
        seeds = [b"policy", vault.key().as_ref()],
        bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Zero-copy SpendTracker
    #[account(
        init,
        payer = owner,
        space = SpendTracker::SIZE,
        seeds = [b"tracker", vault.key().as_ref()],
        bump,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Agent spend overlay — per-agent contribution tracking
    #[account(
        init,
        payer = owner,
        space = AgentSpendOverlay::SIZE,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    /// Phase 7 — audit log of SUCCESS-path mutating instructions.
    /// Allocated at vault creation. Owner pays rent. Failure to allocate
    /// aborts vault creation (init failure → atomic rollback).
    #[account(
        init,
        payer = owner,
        space = AuditLogSuccess::SIZE,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// Phase 7 — audit log of REJECTED finalize attempts (permissionless-
    /// crank window). Separate from success buffer per Audit #2 F-19 so a
    /// rejected-finalize burst cannot displace legitimate success history.
    #[account(
        init,
        payer = owner,
        space = AuditLogRejected::SIZE,
        seeds = [b"audit_rejected", vault.key().as_ref()],
        bump,
    )]
    pub audit_log_rejected: AccountLoader<'info, AuditLogRejected>,

    /// CHECK: This is the fee destination wallet; validated by the caller/SDK.
    pub fee_destination: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
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
    // TA-12 (Phase 5 post-exec): combined USDC+USDT vault floor enforced
    // at every finalize_session. 6-decimal USDC face value. Default 0
    // (no reserve) preserves existing vault behavior; owners opt in via
    // a non-zero value. Bound by TA-19 at canonical digest position 18.
    stable_balance_floor: u64,
    // TA-14 (Phase 5 post-exec): per-recipient rolling 24h outflow cap.
    // 6-decimal USDC face value. Default 0 (no per-recipient cap).
    // Bound by TA-19 at canonical digest position 19.
    per_recipient_daily_cap_usd: u64,
    // G6 (audit 2026-05-18 cosign opt-in): owner-controlled opt-in to
    // TA-09 cosign enforcement on elevated mutations. Default false
    // (low-friction, owner-signature-only). When true, future calls to
    // `queue_policy_update` with elevated mutations REQUIRE a cosign
    // session. Disabling cosign on a live policy where this is true
    // is itself an elevated mutation (one-way ratchet — see
    // `queue_policy_update`). Bound by TA-19 at canonical digest
    // position 20.
    //
    // L1-2 (audit 2026-06-15, LOW / defense-in-depth — DOCUMENTED, by-design):
    // setting this `true` at init does NOT bind a cosigner. There is no init
    // arg for `cosign_session_pubkey`; it is forced to `Pubkey::default()`
    // below (see the policy write). The resulting {cosign_required=true,
    // pubkey=default} state is INTENTIONAL and SAFE — it is the M-2 no-brick
    // design (a strict match against the zero key would brick the vault). In
    // that state cosign is INERT as a second factor: `has_bound_cosigner`
    // (register_agent.rs) falls back to "any non-owner signer", and
    // `classify_operator_grant_tier` (utils/operator_grant.rs:97) classifies
    // the vault as the SINGLE-KEY tier (an unbound cosigner is not a real 2nd
    // factor — Council C-1), so OPERATOR grants still route through the
    // timelock floor rather than the instant cosign path. Cosign becomes a
    // real second factor ONLY after the owner BINDS a `cosign_session_pubkey`
    // via `queue_policy_update`. The enforcement half — rejecting the
    // false→true enable transition unless a pubkey is bound — lives in
    // `apply_pending_policy` (L1-2a); init deliberately leaves the unbound
    // state reachable so an owner can opt into cosign without first
    // committing (and risking the loss of) a specific cosigner key.
    cosign_required: bool,
    preview_digest: [u8; 32],
) -> Result<()> {
    crate::reject_cpi!();

    // Phase 2 Option A: protocol_mode MUST be ALLOWLIST (1). Permissive ALL/DENYLIST deleted.
    require!(
        protocol_mode == PROTOCOL_MODE_ALLOWLIST,
        SigilError::InvalidProtocolMode
    );

    // TA-05 (Phase 3 pre-execution guard #2): operating_hours is a 24-bit
    // UTC bitmask. Upper 8 bits MUST be zero — anything else indicates a
    // misconfigured caller (or hostile data) and is rejected at write time.
    // The bitmask is bound by TA-19, so the signed-digest path also catches
    // a divergent value; this is the local validation step.
    require!(
        operating_hours & !OPERATING_HOURS_VALID_MASK == 0,
        SigilError::ErrOutsideOperatingHours
    );

    // TA-17 (Phase 3 pre-execution guard #7): auto_revoke_threshold bounded
    // to [3, 20] at policy-write time. Floor 3 prevents trivial brick-by-3
    // attacks where minor agent errors auto-revoke; ceiling 20 prevents
    // owners disabling the gate by setting it impractically high.
    require!(
        (AUTO_REVOKE_THRESHOLD_MIN..=AUTO_REVOKE_THRESHOLD_MAX).contains(&auto_revoke_threshold),
        SigilError::InvalidPermissions
    );
    require!(
        protocols.len() <= MAX_ALLOWED_PROTOCOLS,
        SigilError::TooManyAllowedProtocols
    );
    require!(
        developer_fee_rate <= MAX_DEVELOPER_FEE_RATE,
        SigilError::DeveloperFeeTooHigh
    );
    require!(
        max_slippage_bps <= MAX_SLIPPAGE_BPS,
        SigilError::SlippageBpsTooHigh
    );
    require!(
        ctx.accounts.fee_destination.key() != Pubkey::default(),
        SigilError::InvalidFeeDestination
    );
    require!(
        allowed_destinations.len() <= MAX_ALLOWED_DESTINATIONS,
        SigilError::TooManyDestinations
    );
    require!(
        timelock_duration >= MIN_TIMELOCK_DURATION,
        SigilError::TimelockTooShort
    );

    // Validate per-protocol caps
    if !protocol_caps.is_empty() {
        require!(
            protocol_mode == PROTOCOL_MODE_ALLOWLIST,
            SigilError::ProtocolCapsMismatch
        );
        require!(
            protocol_caps.len() == protocols.len(),
            SigilError::ProtocolCapsMismatch
        );
    }

    // F-11: an active vault (non-observe_only) must have at least ONE protocol OR
    // at least ONE destination on the allowlist. Otherwise the vault is silently
    // inert — accepts deposits but cannot execute any spending action. observe_only
    // vaults are explicitly inert by design, so the empty-allowlist check is skipped.
    if !observe_only {
        require!(
            !protocols.is_empty() || !allowed_destinations.is_empty(),
            SigilError::ActiveVaultRequiresAllowlist
        );
    }

    // PEN-CROSS-2 (Phase 2 close-up): capture init slot BEFORE the digest
    // check so the close+reinit replay window is closed. A signed
    // initialize_vault tx that ran against a previously closed vault encodes
    // the OLD slot in its preview digest; replaying that tx against the
    // freshly-allocated PDA at the same (owner, vault_id) compares the
    // OLD slot encoded in `preview_digest` against the NEW slot here and
    // mismatches.
    let clock = Clock::get()?;
    let created_at_slot = clock.slot;

    // Phase 2 TA-19: assert the owner's signed digest matches the recomputed
    // digest over the resulting policy fields. Closes pending-PDA tampering +
    // signer-blind-sign risks. The resulting policy uses RESTRICTED destination
    // mode (Option A default-tightening; OPEN_WITH_CAP deleted) and the caller's
    // observe_only flag.
    let recomputed_digest = compute_policy_preview_digest(&PolicyPreviewFields {
        daily_spending_cap_usd,
        max_transaction_size_usd,
        max_slippage_bps,
        // PEN-CROSS-6: developer_fee_rate is bound by the owner-signed digest.
        developer_fee_rate,
        protocol_mode,
        protocols: &protocols,
        destination_mode: DESTINATION_MODE_RESTRICTED,
        allowed_destinations: &allowed_destinations,
        timelock_duration,
        session_expiry_seconds: 0,
        observe_only,
        has_post_assertions: 0,
        // PEN-CROSS-2: defends against close+reinit replay.
        created_at_slot,
        // TA-05 (Phase 3 pre-exec): operating_hours bound at digest position 15.
        operating_hours,
        // TA-07/17 (Phase 3 pre-exec): auto_promote_grays + auto_revoke_threshold
        // bound at digest positions 16/17.
        auto_promote_grays,
        auto_revoke_threshold,
        // TA-12 (Phase 5 post-exec): owner-chosen reserve bound at position 18.
        stable_balance_floor,
        // TA-14 (Phase 5 post-exec): per-recipient cap bound at position 19.
        per_recipient_daily_cap_usd,
        // G6 (audit 2026-05-18 cosign opt-in): owner's cosign choice bound
        // at canonical digest position 20.
        cosign_required,
        // Phase 8 PEN-CROSS-1 (Council ISC-141): at init the vault has an
        // empty agent set, so the agent_set_hash is the deterministic
        // empty-Vec SHA-256 (`compute_agent_set_hash(&[])`). The off-chain
        // SDK computes the same empty value when building the init digest.
        agent_set_hash: compute_agent_set_hash(&[]),
        // D-5 (audit 2026-05-19, F-RP3-1): at init the reactivate-cosign
        // gate is disabled (`Pubkey::default()`). Owners opt in later via
        // `queue_policy_update` by setting a non-default pubkey. Bound at
        // canonical digest position 22.
        cosign_session_pubkey: Pubkey::default(),
        // F-Q6 (2026-06-02): at init operator_grant_delay_seconds = 0
        // (default). Bound at canonical digest position 22; the off-chain SDK
        // computes the same default-0 value when building the init digest.
        operator_grant_delay_seconds: 0,
        // M-1 (audit 2026-06-11): caps bound at positions 23-24. At init,
        // has_protocol_caps is derived !protocol_caps.is_empty() (matches the
        // policy write below) and protocol_caps is the init arg slice.
        has_protocol_caps: !protocol_caps.is_empty(),
        protocol_caps: &protocol_caps,
    });
    require!(
        recomputed_digest == preview_digest,
        SigilError::PolicyPreviewMismatch
    );

    // Initialize vault
    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.agents = Vec::new();
    vault.fee_destination = ctx.accounts.fee_destination.key();
    vault.vault_id = vault_id;
    vault.status = VaultStatus::Active;
    vault.bump = ctx.bumps.vault;
    vault.created_at = clock.unix_timestamp;
    vault.total_transactions = 0;
    vault.total_volume = 0;
    vault.total_fees_collected = 0;
    vault.total_deposited_usd = 0;
    vault.total_withdrawn_usd = 0;
    vault.total_failed_transactions = 0;
    vault.active_sessions = 0;
    // Phase 2 TA-19: observer-only mode (set by owner at init).
    vault.observe_only = observe_only;
    // Phase 8: freeze-state fields. Zero on a freshly-initialized Active
    // vault — `vault.status != Frozen` means readers gate on status before
    // ever inspecting these bytes. Populated on every transition to Frozen
    // (`freeze_vault`, `revoke_agent` auto-freeze, future `freeze_internal`).
    vault.frozen_at_timestamp = 0;
    vault.freeze_reason = 0;
    // Phase 8 LBL-01: immutable PDA seed-key. Set once here, never written
    // again. Equals `owner.key()` at init so the on-chain PDA address is
    // identical to the pre-LBL-01 layout (the init constraint at line 20
    // derives the PDA from `owner.key()`). After `accept_ownership_transfer`
    // mutates `vault.owner`, this field stays put — every downstream
    // owner-side ix derives its vault PDA from `vault.vault_authority`
    // instead of `owner.key()`, so the account remains addressable under
    // the new owner.
    vault.vault_authority = ctx.accounts.owner.key();
    // F-Q6 (2026-06-02): a fresh vault is single-key (EOA) by default. The owner
    // opts into a multisig owner later via accept_ownership_transfer_multisig
    // (which sets owner_type = MULTISIG). NOT digest-bound (program-set fact).
    vault.owner_type = OWNER_TYPE_EOA;

    // Initialize policy
    let policy = &mut ctx.accounts.policy;
    policy.vault = vault.key();
    policy.daily_spending_cap_usd = daily_spending_cap_usd;
    policy.max_transaction_size_usd = max_transaction_size_usd;
    policy.protocol_mode = protocol_mode;
    policy.protocols = protocols;
    policy.developer_fee_rate = developer_fee_rate;
    policy.max_slippage_bps = max_slippage_bps;
    policy.timelock_duration = timelock_duration;
    policy.allowed_destinations = allowed_destinations;
    policy.has_protocol_caps = !protocol_caps.is_empty();
    policy.protocol_caps = protocol_caps;
    policy.session_expiry_seconds = 0;
    policy.bump = ctx.bumps.policy;
    policy.policy_version = 0;
    policy.has_post_assertions = 0;
    // Phase 2 Option A: destination_mode is RESTRICTED. OPEN_WITH_CAP path deleted.
    policy.destination_mode = DESTINATION_MODE_RESTRICTED;
    // Phase 2 TA-19: pin the owner-signed digest into live policy.
    policy.policy_preview_digest = preview_digest;
    // PEN-CROSS-2 (Phase 2 close-up): persist the slot bound by TA-19.
    policy.created_at_slot = created_at_slot;
    // TA-05 (Phase 3): persist operating_hours after the digest assertion.
    // Caller MUST pass an explicit value; the SDK helper defaults to
    // 0x00FFFFFF when the owner did not configure narrow hours. Encoding
    // this on the digest ensures owner-blind-sign cannot slip a permissive
    // mask when the owner thought they signed a narrow one.
    policy.operating_hours = operating_hours;
    // TA-07 (Phase 3): persist owner's graylist-bypass choice. Default
    // false — the owner opts in to skip the 24h friction window.
    policy.auto_promote_grays = auto_promote_grays;
    // TA-07 (Phase 3): empty graylist at init (no destinations have been
    // added yet via queue_policy_update; the initial allowedDestinations
    // is owner-signed at init and considered pre-vetted).
    policy.destination_graylist = Vec::new();
    // TA-17 (Phase 3): persist auto-revoke threshold; range pre-validated.
    policy.auto_revoke_threshold = auto_revoke_threshold;
    // TA-12 (Phase 5): persist combined stablecoin floor. Bound by TA-19
    // at canonical digest position 18 — the owner's chosen reserve is
    // part of the signed configuration and cannot be silently lowered
    // by a tampered SDK or pending-PDA mutation.
    policy.stable_balance_floor = stable_balance_floor;
    // TA-14 (Phase 5): persist per-recipient daily cap. Bound by TA-19
    // at canonical digest position 19 — silent raises (or removals) of
    // the cap cannot bypass the owner's signed digest.
    policy.per_recipient_daily_cap_usd = per_recipient_daily_cap_usd;
    // G6 (audit 2026-05-18 cosign opt-in): persist owner's cosign choice.
    // Bound by TA-19 at canonical digest position 20 — a tampered SDK
    // cannot silently flip cosign on/off between owner approval and
    // on-chain landing.
    //
    // L1-2 (take-over hardening 2026-06-16): cosign CANNOT be enabled at vault
    // creation. There is no init argument to BIND a specific cosigner, so
    // allowing `cosign_required=true` here would create the inert
    // {cosign_required=true, cosign_session_pubkey=default} state — where the
    // gate would degrade to "any non-owner signer" (a false sense of two-factor,
    // now fail-closed in `has_bound_cosigner`). Cosign is enabled post-creation
    // via `queue_policy_update` (elevated + timelocked), which force-binds a
    // DISTINCT cosigner pubkey (!= owner, per queue_policy_update's C-1 check).
    // A single user who doesn't want a 2nd wallet simply leaves cosign off (the
    // default). ErrCosignRequired (6080) reused: cosign required but no bound
    // cosigner can be supplied at init.
    require!(!cosign_required, SigilError::ErrCosignRequired);
    policy.cosign_required = cosign_required;
    // D-5 (audit 2026-05-19, F-RP3-1): initialize the reactivate-cosign
    // pubkey to `Pubkey::default()` so the gate at `reactivate_vault` is
    // OFF for fresh vaults. Owners opt in via `queue_policy_update` by
    // setting a non-default pubkey. Bound by TA-19 at canonical digest
    // position 22 (the init recomputed digest above also encodes
    // `Pubkey::default()` so the assertion passes).
    policy.cosign_session_pubkey = Pubkey::default();
    // F-Q6 (2026-06-02): OPERATOR-grant delay defaults to 0 (instant, subject
    // to the per-tier rules in register_agent). Owner opts into a delay later
    // via queue_policy_update. Bound by TA-19 at canonical digest position 22.
    policy.operator_grant_delay_seconds = 0;

    // Initialize zero-copy tracker (buckets + protocol_counters zero-initialized by allocator)
    let mut tracker = ctx.accounts.tracker.load_init()?;
    tracker.vault = vault.key();
    tracker.bump = ctx.bumps.tracker;

    // Initialize agent spend overlay
    {
        let mut overlay = ctx.accounts.agent_spend_overlay.load_init()?;
        overlay.vault = vault.key();
        overlay.bump = ctx.bumps.agent_spend_overlay;
    }

    // Phase 7 — initialise audit-log success buffer.
    {
        let mut log = ctx.accounts.audit_log_success.load_init()?;
        log.vault = vault.key();
        log.bump = ctx.bumps.audit_log_success;
        // head, count, _padding, entries[..] all zero-init by allocator.
    }

    // Phase 7 — initialise audit-log rejected buffer.
    {
        let mut log = ctx.accounts.audit_log_rejected.load_init()?;
        log.vault = vault.key();
        log.bump = ctx.bumps.audit_log_rejected;
    }

    emit!(VaultCreated {
        vault: vault.key(),
        owner: ctx.accounts.owner.key(),
        vault_id,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
