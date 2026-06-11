use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentGrantApplied;
use crate::state::assertions::ct_eq_32;
use crate::state::pending_agent_grant::compute_pending_agent_grant_digest;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

/// Phase 8 PEN-CROSS-1 (Council ISC-58..65) — apply a queued OPERATOR-class grant.
///
/// After `queue_agent_grant` populated the `PendingAgentGrant` PDA and the
/// timelock window (`min_delay_seconds`, default =
/// `PendingAgentGrant::DEFAULT_MIN_DELAY = 172_800s = 48h`, raised from 30
/// min in Phase 8 §RP Fix-Up B / PEN-02a CRITICAL) has elapsed, the owner
/// calls this handler to land the grant. The handler:
///   1. Asserts `now - queued_at >= min_delay_seconds` (timelock check).
///   2. Re-validates the agent invariants (in case `vault.agents` mutated
///      between queue and apply — e.g. another agent registered, push the
///      count up).
///   3. Pushes the new agent into `vault.agents` AND claims an
///      AgentSpendOverlay slot when `spending_limit_usd > 0`.
///   4. Re-derives the policy preview digest with the NEW `agent_set_hash`
///      (PEN-CROSS-1 binding) and persists it.
///   5. Bumps `policy.policy_version` (mirrors register_agent OCC pattern).
///   6. Writes audit-log entry (disc=18) + emits `AgentGrantApplied` event.
///   7. Closes the pending PDA, returning rent to the owner.
///
/// H-1 close (audit 2026-05-25): cosign IS re-checked at apply when
/// `policy.cosign_required == true`. This defends against the joint-key
/// compromise + cosign-rotation scenario:
///   1. Attacker compromises owner+cosigner keys for a 6h window.
///   2. Attacker queues PendingAgentGrant with valid cosign attestation
///      from the compromised cosigner. M-5 seals the queue-time content
///      digest; CH-1 seals the queue-time slot.
///   3. Legitimate owner detects breach within the 48h timelock and
///      ROTATES the cosigner via `queue_policy_update` +
///      `apply_pending_policy` (changing `policy.cosign_session_pubkey`
///      to a new key the attacker doesn't control).
///   4. Attacker tries to apply the pre-signed apply tx at slot
///      ≥ queued_at_slot + 432_000 (~48h, timelock matured).
///   5. Pre-H-1: apply succeeded because cosign was a queue-only gate.
///   6. Post-H-1: apply REJECTS because the LIVE policy's
///      `cosign_session_pubkey` no longer matches the attacker's stale
///      pre-signed cosigner attestation.
///
/// The rebind mirrors the NH-1 pattern in `reactivate_vault.rs:187-233`:
///   - `cosign_session_pubkey != Pubkey::default()` → exact match required
///     on a signer in `remaining_accounts`.
///   - `cosign_session_pubkey == Pubkey::default()` (cosign_required=true
///     but no specific binding) → any non-owner signer counts (default-on
///     safety, same as NH-1).
///   - `cosign_required == false` → no apply-time gate (V1 design;
///     queue-time owner sig was the sole authorization).
///
/// Cancel still mirrors queue (cosign_required + cosign sig). Owner who
/// detects a phished queue should call `cancel_agent_grant` during the
/// 48h observation window; if cancel itself is blocked (e.g. owner key
/// only without cosigner), the new apply-time check is the secondary
/// defense.
#[derive(Accounts)]
pub struct ApplyAgentGrant<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// Policy is mutated (policy_version bump + policy_preview_digest recompute).
    #[account(
        mut,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// PendingAgentGrant PDA. `close = owner` returns rent to the signer
    /// (mirrors register_agent rent payer). `has_one = vault` binds the PDA
    /// to this vault explicitly (defense-in-depth alongside seed derivation).
    #[account(
        mut,
        has_one = vault @ SigilError::ZeroCopyVaultMismatch,
        seeds = [b"pending_agent_grant", vault.key().as_ref()],
        bump = pending.bump,
        close = owner,
    )]
    pub pending: Account<'info, PendingAgentGrant>,

    /// Agent spend overlay — per-agent tracking slot. Same seeds as
    /// register_agent so the apply path lands in the same overlay.
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump = agent_spend_overlay.load()?.bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    /// Phase 7 — success audit log; entry appended after state mutation.
    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// CHECK: Phase 7 — slot_hashes sysvar; address-pinned.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ApplyAgentGrant>) -> Result<()> {
    crate::reject_cpi!();

    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending;

    // 0. CH-1 close (Bucket-3 audit 2026-05-23): F-10 freshness — bounds the
    // slot delta between queue and apply using the WIDER
    // `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN = 700_000` (~78h) ceiling.
    // The narrower 216_000-slot (~24h) `MAX_APPLY_AGE_SLOTS` used by the
    // non-admin pending PDAs would reject a legitimate apply that lands
    // AFTER the 48h timelock matures — see state/mod.rs rationale.
    //
    // This check FRONT-RUNS the timelock check below so a stale-slot
    // attack surfaces with `QueuedUpdateExpired` (the diagnostic answer)
    // rather than `TimelockNotExpired`. Defends against the
    // Drift-April-2026 durable-nonce pre-signing class: a compromised
    // owner key pre-signs queue+apply in the same slot, queues NOW, and
    // tries to replay the pre-signed apply weeks/months later. The
    // slot-based ceiling forces a re-queue (with fresh signatures) any
    // time the apply lands beyond the ~78h window.
    // F-4 close (audit 2026-05-25): use checked_sub instead of saturating_sub
    // so an impossible-in-prod clock-backward anomaly surfaces as `Overflow`
    // rather than silently rounding to 0 and passing the freshness check.
    // Matches the sibling `unix_timestamp.checked_sub(...)` pattern below.
    let slot_delta = clock
        .slot
        .checked_sub(pending.queued_at_slot)
        .ok_or(error!(SigilError::Overflow))?;
    require!(
        slot_delta < crate::state::MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN,
        SigilError::QueuedUpdateExpired,
    );

    // 1. Timelock check — `>=` boundary matches the rest of the program's
    // timelock surface (PendingPolicyUpdate, PendingAgentPermissionsUpdate,
    // PendingOwnershipTransfer). Checked i64 sub guards against rare devnet
    // clock-backward anomalies.
    let elapsed = clock
        .unix_timestamp
        .checked_sub(pending.queued_at)
        .ok_or(error!(SigilError::Overflow))?;
    require!(
        elapsed >= pending.min_delay_seconds as i64,
        SigilError::TimelockNotExpired,
    );

    // 1.25. H-1 close (audit 2026-05-25): re-bind cosign at apply time.
    //
    // If the policy requires cosign, the apply tx MUST include a signer
    // matching the LIVE `policy.cosign_session_pubkey` in
    // `remaining_accounts`. This catches the joint-compromise +
    // cosign-rotation attack: attacker queues with cosign attestation
    // from compromised cosigner key A; legitimate owner rotates to key B
    // via `queue_policy_update`; attacker's pre-signed apply at the OLD
    // session fails the live-policy strict match.
    //
    // Behavior matrix (mirrors NH-1 default-on safety at
    // `reactivate_vault.rs:198-209`):
    //   1. `cosign_required == false` → no gate (V1 default; queue-time
    //      owner sig is the sole authorization).
    //   2. `cosign_required == true && cosign_session_pubkey !=
    //      Pubkey::default()` → exact pubkey match required on a signer
    //      in `remaining_accounts`.
    //   3. `cosign_required == true && cosign_session_pubkey ==
    //      Pubkey::default()` → any non-owner signer counts (cosign
    //      enforcement opted-in but specific key not yet bound).
    //   4. None of the above match → reject with `ErrCosignRequired`.
    //
    // This runs BEFORE M-5 digest recompute (cheap pubkey check fails
    // fast before the sha256) and AFTER F-10 + timelock (so the
    // diagnostic error on a stale apply surfaces as `QueuedUpdateExpired`
    // / `TimelockNotExpired` rather than `ErrCosignRequired`).
    {
        let policy = &ctx.accounts.policy;
        if policy.cosign_required {
            let cosign_session_pubkey = policy.cosign_session_pubkey;
            let owner_key = ctx.accounts.owner.key();
            let cosign_ok = if cosign_session_pubkey != Pubkey::default() {
                // Bound to a specific pubkey — match exactly.
                ctx.remaining_accounts
                    .iter()
                    .any(|ai| ai.key() == cosign_session_pubkey && ai.is_signer)
            } else {
                // Default policy — any non-owner signer counts.
                crate::instructions::register_agent::has_non_owner_signer(
                    ctx.remaining_accounts,
                    &owner_key,
                )
            };
            require!(cosign_ok, SigilError::ErrCosignRequired);
        }
    }

    // 1.5. M-5 close (Bucket 2, Phase 10 PEN-CROSS-3): re-assert the
    // pending content digest BEFORE any mutation of `vault.agents`. The
    // digest was sealed by `queue_agent_grant` over the owner-attested
    // (vault, agent, capability, spending_limit_usd, queued_at,
    // min_delay_seconds) tuple; if a future discriminator-collision bug
    // or a same-seed CPI overwrite mutated those fields between queue
    // and apply (e.g. flipping `agent` to an attacker pubkey or raising
    // `capability` to FULL_CAPABILITY), the recomputed digest diverges
    // and we reject with `ErrPendingAgentGrantDigestMismatch`. Constant-
    // time compare via `ct_eq_32` to deny timing side-channels.
    //
    // Note: timelock + cosign at queue-time are the primary
    // authorizations; this digest check is defense-in-depth, closing
    // the discriminator-collision class identified in the Bucket 2
    // pen-test (PEN-CROSS-3).
    let recomputed = compute_pending_agent_grant_digest(pending);
    require!(
        ct_eq_32(&recomputed, &pending.pending_content_digest),
        SigilError::ErrPendingAgentGrantDigestMismatch
    );

    // Snapshot pending fields BEFORE the mutate so the audit-log entry +
    // event payload have the queue-time values even after pending closes.
    let agent = pending.agent;
    let capability = pending.capability;
    let spending_limit_usd = pending.spending_limit_usd;
    let queued_at = pending.queued_at;

    let vault_key = ctx.accounts.vault.key();

    // 2. Re-validate agent invariants at apply (defense-in-depth — vault.agents
    // may have changed between queue and apply via register_agent/revoke_agent).
    //
    // Phase 8 §RP Fix-Up B (LBL-06 HIGH, audit 2026-05-19): tightened from
    // `!= Closed` to `== Active`. A frozen vault must NOT be able to absorb
    // an apply that was queued in a prior Active window — the freeze
    // explicitly terminates agent-set mutations. Owner must reactivate
    // first (5-min cooldown gives them observation time) before applying
    // the grant.
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.status == VaultStatus::Active,
        SigilError::VaultNotActive
    );
    require!(!vault.is_agent(&agent), SigilError::AgentAlreadyRegistered);
    require!(
        vault.agent_count() < MAX_AGENTS_PER_VAULT,
        SigilError::MaxAgentsReached
    );
    // Re-assert capability bound — pending PDA tamper between queue & apply
    // would land here even if the queue value was valid. Forward-secure.
    require!(
        capability >= CAPABILITY_OPERATOR && capability <= FULL_CAPABILITY,
        SigilError::InvalidPermissions
    );

    // 3. Push into vault.agents — same shape as register_agent.
    vault.agents.push(AgentEntry {
        pubkey: agent,
        capability,
        // TA-17 (Phase 3): new agent starts with no consecutive failures.
        consecutive_failures: 0,
        _reserved: [0u8; 6],
        spending_limit_usd,
        paused: false,
    });

    // 4. Claim an overlay slot. Fail-closed: if spending_limit_usd > 0 but
    // no slot available, REJECT the apply (cannot enforce the per-agent
    // limit). Mirrors register_agent's contract.
    if let Ok(mut overlay) = ctx.accounts.agent_spend_overlay.load_mut() {
        if overlay.find_agent_slot(&agent).is_none() {
            match overlay.claim_slot(&agent) {
                Some(_) => {}
                None => {
                    if spending_limit_usd > 0 {
                        // Pop the agent we just pushed — symmetric with
                        // register_agent.rs:135 retain().
                        vault.agents.retain(|a| a.pubkey != agent);
                        return Err(error!(SigilError::OverlaySlotExhausted));
                    }
                }
            }
        }
    }

    // 5. Re-derive policy_preview_digest with the NEW agent_set_hash and
    // persist. The owner-signed digest at vault creation (or last queue/
    // apply policy update) bound the THEN-current agent set; after this
    // mutation it diverges, so future apply_pending_policy / sibling
    // handler digest checks would reject — UNLESS we update the stored
    // digest here too. Bump policy_version OCC counter to match.
    let policy = &mut ctx.accounts.policy;
    let new_agent_set_hash = compute_agent_set_hash(&vault.agents);
    let new_digest = compute_policy_preview_digest(&PolicyPreviewFields {
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
        observe_only: vault.observe_only,
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
        // canonical position 22 — apply_agent_grant never mutates it, so
        // pass-through from live policy keeps the re-bind digest matching
        // the queue-time digest. NOTE: this file is owned by another
        // subagent in the D-5 batch; the orchestrator will harmonize on
        // merge — the one-line struct-field addition here is the minimum
        // needed for the new `PolicyPreviewFields` shape to type-check.
        cosign_session_pubkey: policy.cosign_session_pubkey,
        // F-Q6: operator_grant_delay_seconds bound at canonical digest position 22.
        operator_grant_delay_seconds: policy.operator_grant_delay_seconds,
        // M-1 (audit 2026-06-11): bind per-protocol caps (positions 23-24).
        has_protocol_caps: policy.has_protocol_caps,
        protocol_caps: &policy.protocol_caps,
    });
    policy.policy_preview_digest = new_digest;
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    // 6. Phase 7 — audit-log entry BEFORE `emit!` (ISC-144 ordering).
    // Subject = agent pubkey for off-chain correlation with the
    // earlier queue_agent_grant (disc=17) entry.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_AGENT_GRANT_APPLY,
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

    emit!(AgentGrantApplied {
        vault: vault_key,
        agent,
        capability,
        spending_limit_usd,
        queued_at,
        applied_at: clock.unix_timestamp,
        new_policy_version: policy.policy_version,
    });

    Ok(())
}
