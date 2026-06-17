use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentPermissionsChangeQueued;
use crate::state::*;
use crate::utils::cosign_digest::{
    compute_agent_perms_cosign_digest, AgentPermsCosignDigestFields,
};

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct QueueAgentPermissionsUpdate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        init,
        payer = owner,
        space = PendingAgentPermissionsUpdate::SIZE,
        seeds = [b"pending_agent_perms", vault.key().as_ref(), agent.as_ref()],
        bump,
    )]
    pub pending_agent_perms: Account<'info, PendingAgentPermissionsUpdate>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<QueueAgentPermissionsUpdate>,
    agent: Pubkey,
    new_capability: u8,
    spending_limit_usd: u64,
    cooldown_seconds: u64,
    // Round 2 F-RP3-2 fix (audit 2026-05-19): cosigning session pubkey.
    // `Pubkey::default()` means "non-elevated mutation OR cosign not
    // required by policy" — the value is recorded but the gate is a
    // no-op. For elevated mutations on a cosign-opted-in vault the
    // caller MUST pass a non-default pubkey AND include the corresponding
    // signer in `remaining_accounts`.
    cosign_session: Pubkey,
) -> Result<()> {
    crate::reject_cpi!();

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // M1-03 (systemic frozen-gate, 2026-05-31): a frozen vault MUST NOT accept a
    // newly-staged agent-permissions update. Staging an escalation during a
    // freeze is ADDITIVE — gate queue AND apply (defense in depth). Owner
    // reactivates (deliberate) before queuing. Frozen surfaces VaultNotActive;
    // Closed is rejected above with its own diagnostic.
    require!(
        vault.status != VaultStatus::Frozen,
        SigilError::VaultNotActive
    );

    // Timelock must be configured (always true now with MIN_TIMELOCK_DURATION)
    require!(
        policy.timelock_duration > 0,
        SigilError::NoTimelockConfigured
    );

    // Validate agent exists in vault — and capture the existing entry's
    // capability / spending_limit / per-slot cooldown for the elevation
    // check below.
    let live_entry = vault
        .agents
        .iter()
        .find(|a| a.pubkey == agent)
        .ok_or(SigilError::UnauthorizedAgent)?;
    let live_capability = live_entry.capability;
    let live_spending_limit_usd = live_entry.spending_limit_usd;

    // Validate capability (Phase 2 TA-04: reserved values 3..=255 explicitly rejected).
    require!(
        new_capability <= FULL_CAPABILITY,
        SigilError::InvalidCapability
    );

    // Round 2 F-RP3-2 fix (audit 2026-05-19): elevated mutation gate.
    //
    // When `policy.cosign_required == true`, queueing a permission update
    // that:
    //   1. RAISES the agent's capability (new > live), OR
    //   2. RAISES the spending limit (new > live), OR
    //   3. SETS A non-zero cooldown (which always implies the owner is
    //      defining or changing the cooldown — defensive: require cosign
    //      to bind the chosen value).
    //
    // Without this gate an owner-only signer can timelock-queue an
    // unrestricted-FULL capability promotion on any existing agent on a
    // cosign-opted-in vault.
    //
    // NOTE on cooldown predicate: the `AgentSpendOverlay` slot is per-agent
    // and NOT included in `QueueAgentPermissionsUpdate` Accounts struct —
    // threading it in just for the live-cooldown read would force every
    // queue call to pass the overlay. Instead we use the conservative
    // predicate "any non-zero queued cooldown is elevated when
    // cosign_required is on". The honest case "lengthening cooldown"
    // (strengthening) suffers a cosign requirement; the hostile case
    // "shortening cooldown" is captured. `cooldown_seconds == 0` is the
    // no-op default and is NOT elevated. Same "conservative if uncertain"
    // pattern queue_policy_update uses for protocol_caps elevation.
    let raises_capability = new_capability > live_capability;
    let raises_spending_limit = spending_limit_usd > live_spending_limit_usd;
    let sets_non_zero_cooldown = cooldown_seconds != 0;

    let is_elevated = policy.cosign_required
        && (raises_capability || raises_spending_limit || sets_non_zero_cooldown);

    // Compute the cosign digest binding. For non-elevated mutations
    // (cosign not required OR no elevation triggers), record zero values
    // — same convention as queue_policy_update's non-elevated branch.
    let (cosign_session_pubkey, cosign_digest_bound): (Pubkey, [u8; 32]) = if is_elevated {
        // Elevated mutation: cosign_session MUST be a non-default pubkey.
        require_keys_neq!(
            cosign_session,
            Pubkey::default(),
            SigilError::ErrCosignRequired
        );
        // Cosign signer MUST be DISTINCT from the owner.
        require_keys_neq!(
            cosign_session,
            ctx.accounts.owner.key(),
            SigilError::ErrCosignRequired
        );
        // Take-over 2026-06-16 (3rd-review Finding — same class as the Finding 2
        // policy-update pin): the elevated cosigner MUST be the vault's BOUND
        // cosigner, not merely any non-owner key. Without this, a holder of the
        // owner key alone could raise an existing agent's capability /
        // spending_limit with a throwaway 2nd keypair, evading the 2nd factor on
        // a cosign-guarded escalation (and silently lifting the owner's own
        // spending guardrail). `is_elevated` implies `policy.cosign_required`
        // (:128) and the {cosign_required => bound} invariant guarantees the
        // bound key is non-default here. Mirrors queue_agent_grant's
        // has_bound_cosigner pin and queue_policy_update's elevated pin.
        require_keys_eq!(
            cosign_session,
            policy.cosign_session_pubkey,
            SigilError::ErrCosignRequired
        );
        // The corresponding signer MUST be present in remaining_accounts
        // with `is_signer == true`. Solana enforces the signature; this
        // handler validates presence.
        let cosign_present = ctx
            .remaining_accounts
            .iter()
            .any(|ai| ai.key == &cosign_session && ai.is_signer);
        require!(cosign_present, SigilError::ErrCosignRequired);

        let digest = compute_agent_perms_cosign_digest(&AgentPermsCosignDigestFields {
            cosign_session: &cosign_session,
            agent: &agent,
            new_capability,
            spending_limit_usd,
            cooldown_seconds,
        });
        (cosign_session, digest)
    } else {
        // Non-elevated: zero digest + default session pubkey signals
        // "no cosign required" at apply time. We REJECT silent swallow
        // of a caller-supplied cosign_session when not elevated, mirroring
        // FIX-8 Option A semantics on queue_policy_update — pass
        // `Pubkey::default()` when no cosign is intended.
        require_keys_eq!(
            cosign_session,
            Pubkey::default(),
            SigilError::InvalidPermissions
        );
        (Pubkey::default(), [0u8; 32])
    };

    // F-Q6 (2026-06-03): the OPERATOR-elevation path here is timelocked by
    // policy.timelock_duration, floored at MIN_TIMELOCK_DURATION (1800s) which is
    // ALWAYS >= SINGLE_KEY_OPERATOR_DELAY_FLOOR (600s) — compile-asserted in
    // utils/operator_grant.rs. So an Observer→OPERATOR elevation already
    // satisfies the F-Q6 single-key floor. We deliberately do NOT pull in the
    // configurable operator_grant_delay_seconds (0..48h): this PDA family's
    // apply-time freshness ceiling is the NARROW MAX_APPLY_AGE_SLOTS (~24h), so a
    // configured delay in (24h, 48h] would mature only AFTER the apply window
    // closes and permanently brick the grant (a tier-2 liveness failure). The
    // configurable delay governs the dedicated OPERATOR-SEATING paths
    // (register_agent / queue_agent_grant, which use the wide admin ceiling),
    // NOT re-permissioning of an already-registered agent.
    let clock = Clock::get()?;
    let pending = &mut ctx.accounts.pending_agent_perms;
    pending.vault = vault.key();
    pending.agent = agent;
    pending.new_capability = new_capability;
    pending.spending_limit_usd = spending_limit_usd;
    pending.queued_at = clock.unix_timestamp;
    // L-2 (audit 2026-06-11): checked cast — see queue_policy_update. Avoids a
    // wrap-to-negative timelock on an out-of-range (no-ceiling) duration.
    let timelock_secs =
        i64::try_from(policy.timelock_duration).map_err(|_| error!(SigilError::Overflow))?;
    pending.executes_at = clock
        .unix_timestamp
        .checked_add(timelock_secs)
        .ok_or(error!(SigilError::Overflow))?;
    // F-10 audit fix: capture queue slot for slot-bounded freshness check.
    pending.queued_at_slot = clock.slot;
    pending.bump = ctx.bumps.pending_agent_perms;
    // TA-06 (Phase 3): per-agent cooldown_seconds bound at queue time;
    // applied at apply onto AgentSpendOverlay.cooldown_seconds[slot].
    pending.cooldown_seconds = cooldown_seconds;
    // Round 2 F-RP3-2 fix: persist cosign binding for apply-time
    // re-validation. `[0u8; 32]` + default session = non-elevated.
    pending.cosign_digest = cosign_digest_bound;
    pending.cosign_session = cosign_session_pubkey;

    emit!(AgentPermissionsChangeQueued {
        vault: vault.key(),
        agent,
        executes_at: pending.executes_at,
    });

    Ok(())
}
