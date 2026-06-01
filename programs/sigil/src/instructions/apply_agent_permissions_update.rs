use anchor_lang::accounts::account_loader::AccountLoader;
use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentPermissionsChangeApplied;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::cosign_digest::{
    compute_agent_perms_cosign_digest, AgentPermsCosignDigestFields,
};
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

#[derive(Accounts)]
pub struct ApplyAgentPermissionsUpdate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = vault.owner == owner.key() @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        mut,
        constraint = pending_agent_perms.vault == vault.key(),
        seeds = [
            b"pending_agent_perms",
            vault.key().as_ref(),
            pending_agent_perms.agent.as_ref(),
        ],
        bump = pending_agent_perms.bump,
        close = owner,
    )]
    pub pending_agent_perms: Account<'info, PendingAgentPermissionsUpdate>,

    /// Agent spend overlay — per-agent tracking slot.
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump = agent_spend_overlay.load()?.bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    /// M-6 (audit 2026-05-21) — success audit log; entry appended after
    /// the capability / spending_limit / policy_version mutations land.
    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// CHECK: M-6 — slot_hashes sysvar; address-pinned so the framework
    /// rejects any mismatched sysvar pubkey before the handler runs.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ApplyAgentPermissionsUpdate>) -> Result<()> {
    crate::reject_cpi!();

    // M1-03 (systemic frozen-gate, 2026-05-31): a queued agent-permissions
    // update MUST NOT apply to a frozen/closed vault. freeze_vault does not
    // pause this timelock, so without this gate a staged agent ESCALATION would
    // land once the timelock elapses, defeating "freeze halts all churn".
    // Applying a staged permission change is ADDITIVE — gated. Mirrors
    // apply_agent_grant / apply_pending_policy.
    require!(
        ctx.accounts.vault.status == VaultStatus::Active,
        SigilError::VaultNotActive
    );

    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending_agent_perms;

    // Timelock must have expired
    require!(
        pending.is_ready(clock.unix_timestamp),
        SigilError::TimelockNotExpired
    );

    // F-10 audit fix: slot-bounded freshness check defends against durable-nonce
    // pre-signing attacks (Drift Protocol April 2026 $285M analog).
    require!(
        clock.slot.saturating_sub(pending.queued_at_slot) < MAX_APPLY_AGE_SLOTS,
        SigilError::QueuedUpdateExpired,
    );

    let agent = pending.agent;
    let new_capability = pending.new_capability;
    let spending_limit_usd = pending.spending_limit_usd;
    // TA-06 (Phase 3): pull pending cooldown_seconds for slot apply below.
    let pending_cooldown_seconds = pending.cooldown_seconds;
    // Round 2 F-RP3-2 fix (audit 2026-05-19): pull persisted cosign
    // binding for the apply-time digest re-validation below.
    let pending_cosign_session = pending.cosign_session;
    let pending_cosign_digest = pending.cosign_digest;

    // Phase 2 TA-04 (Audit #2 F-4): defense in depth. The pending PDA was
    // validated at queue time, but a rogue program with the same account
    // discriminator could have overwritten the field between queue and apply.
    // Re-assert the bound here so a tampered pending capability cannot
    // become the live capability without a fresh queue.
    require!(
        new_capability <= FULL_CAPABILITY,
        SigilError::InvalidCapability
    );

    // Round 2 F-RP3-2 fix (audit 2026-05-19): re-bind digest check.
    //
    // When the queue persisted a cosign_session != Pubkey::default(), it
    // was bound to a specific (cosign_session, agent, new_capability,
    // spending_limit_usd, cooldown_seconds) tuple. Any tamper of any
    // field between queue and apply (e.g. a future discriminator-collision
    // attack on the pending PDA, or a stale slot replay) would produce a
    // digest mismatch and a hard reject — identical to the apply-pending-
    // policy TA-09 binding.
    //
    // `cosign_session == Pubkey::default()` = non-elevated queue (no
    // cosign was required) — skip the re-bind check.
    if pending_cosign_session != Pubkey::default() {
        let recomputed = compute_agent_perms_cosign_digest(&AgentPermsCosignDigestFields {
            cosign_session: &pending_cosign_session,
            agent: &agent,
            new_capability,
            spending_limit_usd,
            cooldown_seconds: pending_cooldown_seconds,
        });
        require!(
            recomputed == pending_cosign_digest,
            SigilError::ErrCosignRequired
        );
    }

    // Find agent entry and update capability + spending limit
    let vault = &mut ctx.accounts.vault;
    let entry = vault
        .agents
        .iter_mut()
        .find(|a| a.pubkey == agent)
        .ok_or(error!(SigilError::UnauthorizedAgent))?;
    let old_spending_limit = entry.spending_limit_usd;
    entry.capability = new_capability;
    entry.spending_limit_usd = spending_limit_usd;

    // Manage overlay slot when spending limit changes
    // (lifted verbatim from update_agent_permissions.rs:66-81)
    // TA-06 (Phase 3): also apply per-agent cooldown_seconds onto the slot.
    if let Ok(mut overlay) = ctx.accounts.agent_spend_overlay.load_mut() {
        let has_slot = overlay.find_agent_slot(&agent).is_some();

        if spending_limit_usd > 0 && !has_slot {
            // Need a slot but don't have one — claim it
            require!(
                overlay.claim_slot(&agent).is_some(),
                SigilError::OverlaySlotExhausted
            );
        } else if spending_limit_usd == 0 && old_spending_limit > 0 && has_slot {
            // No longer need a slot — release it
            if let Some(idx) = overlay.find_agent_slot(&agent) {
                overlay.release_slot(idx);
            }
        }

        // TA-06 (Phase 3): apply cooldown_seconds onto the agent's slot if
        // present. If the slot was just released above (spending_limit→0),
        // skip cooldown update — there's no slot to write into. The next
        // re-registration / spending_limit-raise will claim a fresh slot
        // with cooldown_seconds = 0 (cleared by `release_slot`).
        if let Some(idx) = overlay.find_agent_slot(&agent) {
            overlay.set_cooldown_seconds(idx, pending_cooldown_seconds)?;
        }
    }

    // H-1 close (audit 2026-05-21): recompute TA-19 policy_preview_digest.
    //
    // The mutations above (entry.capability + entry.spending_limit_usd)
    // both feed `agent_set_hash` at canonical position 21 of the digest.
    // Per the F-2 lesson from set_observe_only.rs:89-93, ANY mutation of
    // a field included in policy_preview_digest MUST recompute the stored
    // digest + bump policy_version (OCC). Prior to this fix, off-chain
    // monitors reading `policy.policy_preview_digest` as the source of
    // truth would see persistent legitimate divergence after every
    // permissions apply. Snapshot the new agent_set_hash AFTER the
    // entry.capability / entry.spending_limit_usd writes above so it
    // reflects the post-apply state.
    let new_agent_set_hash = compute_agent_set_hash(&vault.agents);
    let vault_observe_only = vault.observe_only;
    let vault_key = vault.key();
    let policy = &mut ctx.accounts.policy;
    let recomputed_digest = compute_policy_preview_digest(&PolicyPreviewFields {
        daily_spending_cap_usd: policy.daily_spending_cap_usd,
        max_transaction_size_usd: policy.max_transaction_size_usd,
        max_slippage_bps: policy.max_slippage_bps,
        developer_fee_rate: policy.developer_fee_rate,
        protocol_mode: policy.protocol_mode,
        protocols: &policy.protocols,
        destination_mode: policy.destination_mode,
        allowed_destinations: &policy.allowed_destinations,
        timelock_duration: policy.timelock_duration,
        session_expiry_seconds: policy.session_expiry_seconds,
        observe_only: vault_observe_only,
        has_post_assertions: policy.has_post_assertions,
        created_at_slot: policy.created_at_slot,
        operating_hours: policy.operating_hours,
        auto_promote_grays: policy.auto_promote_grays,
        auto_revoke_threshold: policy.auto_revoke_threshold,
        stable_balance_floor: policy.stable_balance_floor,
        per_recipient_daily_cap_usd: policy.per_recipient_daily_cap_usd,
        cosign_required: policy.cosign_required,
        agent_set_hash: new_agent_set_hash,
        // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey bound at
        // canonical position 22 — apply_agent_permissions_update never
        // mutates it, so pass-through from live policy keeps the re-bind
        // digest matching the queue-time digest.
        cosign_session_pubkey: policy.cosign_session_pubkey,
    });
    policy.policy_preview_digest = recomputed_digest;
    // Bump policy version — permission changes affect security posture.
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    // M-6 close (audit 2026-05-21) — append disc=20 audit entry AFTER
    // policy_version bump, BEFORE `emit!` (ISC-144 ordering). Subject =
    // agent pubkey so off-chain monitors can correlate this entry with
    // the earlier `queue_agent_permissions_update` audit signal.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_AGENT_PERMS_APPLY,
            agent,
            0,
            0,
            clock.unix_timestamp,
            &ctx.accounts.slot_hashes_sysvar.to_account_info(),
        )?;
        let mut log = ctx.accounts.audit_log_success.load_mut()?;
        // §RP-1 I-2: defense-in-depth guard against future seeds drift.
        require_keys_eq!(log.vault, vault_key, SigilError::ZeroCopyVaultMismatch);
        log.append(entry);
    }

    emit!(AgentPermissionsChangeApplied {
        vault: vault_key,
        agent,
        applied_at: clock.unix_timestamp,
    });

    Ok(())
}
