//! TA-17 (Phase 3 pre-execution guard #7): record a policy-violation
//! failure for an agent, auto-revoking on threshold trip.
//!
//! ## Why this is a separate instruction
//!
//! Solana's atomic-or-none execution model means a transaction that
//! errors mid-validate rolls back all state mutations. So an agent that
//! attempts a seal and fails due to a policy gate (e.g. cooldown,
//! operating-hours, mint pin) cannot increment its own failure counter
//! in the same transaction — the counter mutation would be reverted
//! alongside the failure.
//!
//! This ix is the explicit reporting path. The agent's middleware (or
//! the vault owner's off-chain monitor) calls it after observing a
//! failed seal. The reported code is range-filtered to ensure only
//! genuine policy-violation rejects (6074-6091) count — external
//! causes (CU exhaustion, network, auth errors) do NOT increment.
//!
//! Successful validate_and_authorize on the same agent RESETS the
//! counter to 0 (cf. validate_and_authorize.rs trailing block) — so
//! transient failures don't accumulate forever; only sustained
//! misbehavior trips the threshold.
//!
//! ## Auth
//!
//! Owner-only. The agent cannot self-report (would be trivially
//! circumventable: an attacker controlling the agent never reports its
//! own violations). The owner OR an owner-designated indexer reports.
//!
//! ## Threshold trip
//!
//! When `agent.consecutive_failures >= policy.auto_revoke_threshold`,
//! the handler:
//!   1. Sets `agent.capability = CAPABILITY_DISABLED`.
//!   2. Emits `AgentAutoRevoked` event.
//!   3. Bumps `policy.policy_version` (OCC).
//!
//! Subsequent validate_and_authorize calls reject with
//! `ErrAutoRevoked` (6081).

use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentAutoRevoked;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct RecordAgentViolation<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
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

    /// M-8 (audit 2026-05-21) — success audit log; entry appended ONLY
    /// when the failure counter trips `auto_revoke_threshold` and the
    /// agent is forcibly disabled. Non-trip increments don't write here
    /// (policy state is unchanged in that branch).
    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// CHECK: M-8 — slot_hashes sysvar; address-pinned so the framework
    /// rejects any mismatched sysvar pubkey before the handler runs.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<RecordAgentViolation>, agent: Pubkey, error_code: u32) -> Result<()> {
    crate::reject_cpi!();

    let vault = &mut ctx.accounts.vault;
    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // Filter the reported code by NUMERIC RANGE — string match would be
    // brittle. 6074-6091 = on-chain policy-violation codes (TA-03/05/06/
    // 07/08/09/17 + reserved for Phase 4+5 post-exec). External codes
    // (sysvar-scan 6062 SysvarScanBoundExceeded, async-fulfillment 6063
    // AsyncFulfillmentNotPermitted, auth 6000-6082) do NOT count.
    require!(
        is_policy_violation_code(error_code),
        SigilError::InvalidPermissions
    );

    let threshold = ctx.accounts.policy.auto_revoke_threshold;
    require!(
        (AUTO_REVOKE_THRESHOLD_MIN..=AUTO_REVOKE_THRESHOLD_MAX).contains(&threshold),
        SigilError::InvalidPermissions
    );

    // Capture vault key BEFORE taking &mut on agents (avoids re-borrow).
    let vault_key = vault.key();

    let entry = vault
        .agents
        .iter_mut()
        .find(|a| a.pubkey == agent)
        .ok_or(error!(SigilError::UnauthorizedAgent))?;

    // RAV-1 close (Phase 6-9 re-audit 2026-05-21): early-exit on already-
    // disabled agent. Without this guard, a buggy off-chain monitor that
    // polls and re-reports the same disabled-agent error N times would:
    //   (1) overwrite the 128-slot circular audit_log_success buffer with
    //       N duplicate disc=22 entries, erasing legitimate earlier history
    //       (the audit log is the on-chain forensic record);
    //   (2) spam policy_version increments, forcing in-flight
    //       validate_and_authorize calls to re-fetch unnecessarily;
    //   (3) emit N identical AgentAutoRevoked events.
    // The terminal CAPABILITY_DISABLED state is absorbing — once tripped,
    // the only legitimate next action on this agent is reactivate (which
    // resets consecutive_failures via re-registration). Reject re-reports
    // explicitly so callers immediately see the no-op rather than silently
    // corrupting on-chain history. Surfaced by M-8 audit-log addition.
    require!(
        entry.capability != CAPABILITY_DISABLED,
        SigilError::ErrAutoRevoked
    );

    // Increment with checked arithmetic — saturate at u8::MAX rather
    // than wrap; the threshold trip happens far below saturation anyway.
    entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);

    // Threshold trip → auto-revoke.
    let tripped = entry.consecutive_failures >= threshold;
    let failures_at_trip = entry.consecutive_failures;
    if tripped {
        entry.capability = CAPABILITY_DISABLED;
    }

    if tripped {
        // H-2 close (audit 2026-05-21): recompute TA-19 policy_preview_digest.
        //
        // The mutation above (entry.capability = CAPABILITY_DISABLED) feeds
        // `agent_set_hash` at canonical position 21 of the digest. Per the
        // F-2 lesson from set_observe_only.rs:89-93, ANY mutation of a field
        // included in policy_preview_digest MUST recompute the stored digest
        // + bump policy_version (OCC). Prior to this fix, the most-important-
        // to-log handler (auto-revoke trip) had the stalest digest — off-
        // chain monitors reading `policy.policy_preview_digest` would see
        // persistent legitimate divergence after every TA-17 trip.
        let new_agent_set_hash = compute_agent_set_hash(&vault.agents);
        let vault_observe_only = vault.observe_only;
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
            // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey bound
            // at canonical position 22 — record_agent_violation never
            // mutates it, so pass-through from live policy keeps the
            // re-bind digest matching the queue-time digest.
            cosign_session_pubkey: policy.cosign_session_pubkey,
            // F-Q6: operator_grant_delay_seconds bound at canonical digest position 22.
            operator_grant_delay_seconds: policy.operator_grant_delay_seconds,
            // M-1 (audit 2026-06-11): bind per-protocol caps (positions 23-24).
            has_protocol_caps: policy.has_protocol_caps,
            protocol_caps: &policy.protocol_caps,
        });
        policy.policy_preview_digest = recomputed_digest;
        // OCC: bump policy_version so external monitors see the change.
        policy.policy_version = policy
            .policy_version
            .checked_add(1)
            .ok_or(error!(SigilError::Overflow))?;

        let clock = Clock::get()?;

        // M-8 close (audit 2026-05-21) — append disc=22 audit entry AFTER
        // policy_preview_digest recompute + policy_version bump, BEFORE
        // the `AgentAutoRevoked` emit (ISC-144 ordering). Subject = agent
        // pubkey for correlation with disc=12 manual revoke entries.
        // Non-trip increments take the false branch and write NO entry —
        // their policy state is unchanged.
        {
            let entry = build_audit_entry(
                AUDIT_DISC_AGENT_AUTO_REVOKED,
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

        emit!(AgentAutoRevoked {
            vault: vault_key,
            agent,
            threshold,
            consecutive_failures: failures_at_trip,
            timestamp: clock.unix_timestamp,
        });
    }

    Ok(())
}
