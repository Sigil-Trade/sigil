use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::{GraylistEntered, PolicyChangeApplied};
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::cosign_digest::{compute_cosign_digest, CosignDigestFields};
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

// P0.2 PEN-7 defense-in-depth ratchet check (audit 2026-05-19).
//
// TA-19 binds 21 policy fields by canonical position into the
// owner-signed digest (see utils/policy_digest.rs). Every existing site
// that mutates one of those fields recomputes the digest. The risk
// targeted by PEN-7 is FUTURE silent bypass: a refactor introduces a
// 22nd field that is policy-owned but never added to the digest input
// (PolicyPreviewFields). The owner would sign the pre-existing 21-field
// digest, the pending apply would re-validate that same 21-field digest
// successfully, and the new field would silently update without owner
// attestation.
//
// Defense: pin the count of digest-bound fields at compile time. Any new
// field added to PolicyPreviewFields without explicitly updating
// EXPECTED_DIGEST_FIELD_COUNT breaks `cargo build`. The developer is then
// forced to either (a) add the field to the digest encoding and bump the
// count, OR (b) document why the field is intentionally excluded (as
// destination_graylist is — see policy_digest.rs §"The graylist itself").
//
// Phase 8 PEN-CROSS-1 (audit 2026-05-19): bumped from 20 → 21 to bind
// `agent_set_hash` into the canonical digest. Closes the silent-
// insertion class where `register_agent(capability=OPERATOR)` could
// silently grant an attacker operator-class on a cosign-opted-in vault
// without diverging the digest.
//
// D-5 (audit 2026-05-19, F-RP3-1): bumped from 21 → 22 to bind
// `cosign_session_pubkey` into the canonical digest. Closes the
// silent-replacement vector where a tampered SDK could flip the
// owner's chosen reactivate-time cosigner pubkey between approval and
// on-chain landing, neutralizing the reactivate-cosign gate.
//
// The actual `const _: () = assert!(...)` enforcement lives near
// `PolicyPreviewFields` in `utils/policy_digest.rs`. This constant
// is re-asserted here at the apply-time site as a load-bearing reminder.
#[allow(dead_code)]
// M1-04: was 22; has_constraints removed (digest-version bump).
// F-Q6 (2026-06-02): 21 → 22, binds operator_grant_delay_seconds.
const EXPECTED_DIGEST_FIELD_COUNT: usize = 22;
const _: () = assert!(
    EXPECTED_DIGEST_FIELD_COUNT == crate::utils::policy_digest::POLICY_PREVIEW_FIELD_COUNT,
    "P0.2 PEN-7: PolicyPreviewFields count diverged from TA-19 binding. \
     Either add the new field to the digest encoding in \
     utils/policy_digest.rs::compute_policy_preview_digest + bump \
     POLICY_PREVIEW_FIELD_COUNT, OR document why the new field is \
     intentionally excluded (see graylist precedent). Silent diverge = \
     audit bypass."
);

#[derive(Accounts)]
pub struct ApplyPendingPolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
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

    #[account(
        mut,
        has_one = vault,
        seeds = [b"pending_policy", vault.key().as_ref()],
        bump = pending_policy.bump,
        close = owner,
    )]
    pub pending_policy: Account<'info, PendingPolicyUpdate>,

    /// Phase 7 — success audit log; entry appended after policy applied.
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

pub fn handler(ctx: Context<ApplyPendingPolicy>) -> Result<()> {
    crate::reject_cpi!();

    // M1-03 (systemic frozen-gate, 2026-05-31): a queued policy update MUST NOT
    // apply to a frozen/closed vault. freeze_vault does not pause this timelock,
    // so without this gate an attacker-staged change (e.g. a cap-raise queued
    // before the owner froze in suspicion of compromise) would land the moment
    // the timelock elapses, defeating "freeze halts all churn". Applying a
    // staged change is ADDITIVE — gated. The owner's deliberate reactivate_vault
    // is the only path back to applying staged updates. Mirrors apply_agent_grant.
    require!(
        ctx.accounts.vault.status == VaultStatus::Active,
        SigilError::VaultNotActive
    );

    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending_policy;

    // Timelock must have expired
    require!(
        pending.is_ready(clock.unix_timestamp),
        SigilError::TimelockNotExpired
    );

    // F-10 audit fix: slot-bounded freshness check defends against durable-nonce
    // pre-signing attacks (Drift Protocol April 2026 $285M analog). Limits the
    // time between queue and apply to MAX_APPLY_AGE_SLOTS — beyond that, the
    // queued update is stale and must be re-queued by the owner.
    require!(
        clock.slot.saturating_sub(pending.queued_at_slot) < MAX_APPLY_AGE_SLOTS,
        SigilError::QueuedUpdateExpired,
    );

    // TA-09 (Phase 3): if pending was bound to a cosign, re-validate the
    // cosign_digest against the persisted pending args + recorded session
    // pubkey. Defense-in-depth — queue already validated the cosign
    // signed, but a rogue program with the same account discriminator
    // could have rewritten the pending args between queue and apply.
    // The re-computed digest catches any such mutation.
    //
    // [0u8; 32] + Pubkey::default() == "no cosign required" (non-elevated
    // queue). For non-elevated pending, this check is a no-op.
    let zero_digest = [0u8; 32];
    let no_cosign =
        pending.cosign_digest == zero_digest && pending.cosign_session == Pubkey::default();
    if !no_cosign {
        // Round 2 B4 F-1 fix (audit 2026-05-19): re-bind digest now
        // includes 5 new elevation triggers. See compute_cosign_digest
        // header for rationale.
        let recomputed_cosign = compute_cosign_digest(&CosignDigestFields {
            cosign_session: &pending.cosign_session,
            daily_spending_cap_usd: pending.daily_spending_cap_usd,
            max_transaction_amount_usd: pending.max_transaction_amount_usd,
            allowed_destinations: pending.allowed_destinations.as_deref(),
            protocols: pending.protocols.as_deref(),
            stable_balance_floor: pending.stable_balance_floor,
            per_recipient_daily_cap_usd: pending.per_recipient_daily_cap_usd,
            has_protocol_caps: pending.has_protocol_caps,
            protocol_caps: pending.protocol_caps.as_deref(),
            cosign_required: pending.cosign_required,
        });
        require!(
            recomputed_cosign == pending.cosign_digest,
            SigilError::ErrCosignRequired
        );
    }

    let policy = &mut ctx.accounts.policy;

    // Apply each non-None field
    if let Some(cap) = pending.daily_spending_cap_usd {
        policy.daily_spending_cap_usd = cap;
    }
    if let Some(max_tx) = pending.max_transaction_amount_usd {
        policy.max_transaction_size_usd = max_tx;
    }
    if let Some(mode) = pending.protocol_mode {
        policy.protocol_mode = mode;
    }
    if let Some(ref protos) = pending.protocols {
        policy.protocols = protos.clone();
    }
    if let Some(fee_rate) = pending.developer_fee_rate {
        policy.developer_fee_rate = fee_rate;
    }
    if let Some(slippage) = pending.max_slippage_bps {
        policy.max_slippage_bps = slippage;
    }
    if let Some(tl) = pending.timelock_duration {
        require!(tl >= MIN_TIMELOCK_DURATION, SigilError::TimelockTooShort);
        policy.timelock_duration = tl;
    }
    if let Some(ref destinations) = pending.allowed_destinations {
        // TA-07 (Phase 3): for each destination that is NEW (not in the
        // pre-update allowedDestinations), add it to the graylist with
        // unlock_unix = now + GRAYLIST_FRICTION_SECONDS — UNLESS the owner
        // has opted into `auto_promote_grays` (digest-bound choice).
        //
        // If `auto_promote_grays` is true, the new destination still enters
        // the audit trail (event), but `unlock_unix = clock.unix_timestamp`
        // (effective immediately). This preserves the owner's choice while
        // keeping a uniform code path.
        //
        // Graylist bound: ≤MAX_ALLOWED_DESTINATIONS (10) entries. Hit the
        // bound and we reject with ErrGraylistFull — the queue/apply pair
        // is atomic so this rejects the whole update.
        let now = clock.unix_timestamp;
        let unlock = if policy.auto_promote_grays {
            now
        } else {
            now.checked_add(GRAYLIST_FRICTION_SECONDS)
                .ok_or(error!(SigilError::Overflow))?
        };
        for d in destinations.iter() {
            if !policy.allowed_destinations.contains(d) {
                // Newly added destination — enter / refresh graylist.
                // Find existing entry first (idempotent overwrite).
                let mut found = false;
                for entry in policy.destination_graylist.iter_mut() {
                    if entry.destination == *d {
                        entry.unlock_unix = unlock;
                        found = true;
                        break;
                    }
                }
                if !found {
                    require!(
                        policy.destination_graylist.len() < MAX_ALLOWED_DESTINATIONS,
                        SigilError::ErrGraylistFull
                    );
                    policy.destination_graylist.push(DestinationGraylistEntry {
                        destination: *d,
                        unlock_unix: unlock,
                    });
                }
                emit!(GraylistEntered {
                    vault: ctx.accounts.vault.key(),
                    destination: *d,
                    unlock_unix: unlock,
                    auto_promoted: policy.auto_promote_grays,
                    timestamp: now,
                });
            }
        }
        // Now copy the destinations themselves.
        policy.allowed_destinations = destinations.clone();
    }
    if let Some(expiry) = pending.session_expiry_seconds {
        policy.session_expiry_seconds = expiry;
    }
    if let Some(hpc) = pending.has_protocol_caps {
        policy.has_protocol_caps = hpc;
    }
    if let Some(ref caps) = pending.protocol_caps {
        policy.protocol_caps = caps.clone();
    }
    if let Some(mode) = pending.destination_mode {
        // Phase 2 Option A: re-validate at apply time. OPEN_WITH_CAP deleted.
        require!(
            mode == DESTINATION_MODE_RESTRICTED,
            SigilError::InvalidDestinationMode
        );
        policy.destination_mode = mode;
    }
    if let Some(hours) = pending.operating_hours {
        // TA-05 (Phase 3): re-validate the bitmask shape at apply time.
        // Defense-in-depth — queue already gates the same invariant but
        // an apply-time check defends against pending-PDA tampering.
        require!(
            hours & !OPERATING_HOURS_VALID_MASK == 0,
            SigilError::ErrOutsideOperatingHours
        );
        policy.operating_hours = hours;
    }
    // TA-12 (Phase 5): apply optional stable_balance_floor update.
    // The new value is recomputed into the second-pass TA-19 digest
    // below so a tampered pending PDA that lowered the floor between
    // queue and apply produces a digest mismatch.
    if let Some(floor) = pending.stable_balance_floor {
        policy.stable_balance_floor = floor;
    }
    // TA-14 (Phase 5): apply optional per_recipient_daily_cap_usd update.
    // Second-pass TA-19 digest below covers this field at position 19.
    if let Some(cap) = pending.per_recipient_daily_cap_usd {
        policy.per_recipient_daily_cap_usd = cap;
    }
    // F-Q6 (2026-06-02): apply optional operator_grant_delay_seconds update.
    // The second-pass TA-19 digest below reads the live (post-merge) value at
    // canonical position 22, so a tampered pending PDA that altered it between
    // queue and apply produces a digest mismatch.
    if let Some(delay) = pending.operator_grant_delay_seconds {
        // Defense-in-depth (mirrors the timelock_duration / operating_hours
        // re-validation above): re-assert the 48h bound at apply so a tampered
        // pending PDA cannot install an out-of-range delay even if the TA-19
        // digest binding were ever weakened. Primary gate: queue_policy_update.
        require!(
            delay <= crate::utils::operator_grant::MAX_OPERATOR_GRANT_DELAY,
            SigilError::ErrOperatorGrantDelayTooLong
        );
        policy.operator_grant_delay_seconds = delay;
    }
    // G6 (audit 2026-05-18 cosign opt-in): apply optional cosign_required
    // update. The queue handler classified the toggle:
    //   - false→true (enable) is non-elevated (safety improvement).
    //   - true→false (disable) IS elevated and was gated by cosign at queue.
    // The second-pass TA-19 digest below recomputes over the merged
    // policy state and binds cosign_required at canonical position 20,
    // so a tampered pending PDA that flipped the queued value between
    // queue and apply produces a digest mismatch.
    //
    // Round 2 MED-#2 fix (audit 2026-05-19): apply-time cosigner re-bind
    // for the disable transition. When this apply DISABLES cosign on a
    // previously-cosign-required vault, require a current cosigner
    // signature — NOT just the queue-time digest match. Defends against
    // the owner-key-leaked-between-queue-and-apply chain: a phished
    // owner can otherwise submit
    //   [apply_pending_policy(cosign_required=false), <any-cosign-gated-ix>]
    // in a single tx, neutralizing cosign mid-atomic. The cosigner
    // authorized "disable cosign" at queue, but did NOT pre-authorize
    // "...AND drain funds / register attacker agent / flip observe-only
    // off" in the same atomic action. Pinning a live cosigner signature
    // here closes the chain at its source.
    //
    // Cosigner identity is bound to `pending.cosign_session` (already
    // validated against the digest above — `no_cosign` is false on this
    // path because the disable-cosign queue is elevated). Re-confirm the
    // signer is present in remaining_accounts at apply-time.
    //
    // Snapshot live cosign state BEFORE the merge so the transition
    // predicate reads the pre-apply value. Reading `policy.cosign_required`
    // after the write would always evaluate false on the disable path
    // and silently bypass the gate.
    let live_cosign_required = policy.cosign_required;
    if let Some(new_cosign) = pending.cosign_required {
        policy.cosign_required = new_cosign;
    }
    let disables_cosign = pending.cosign_required == Some(false) && live_cosign_required;
    if disables_cosign {
        let cosign_session = pending.cosign_session;
        require_keys_neq!(
            cosign_session,
            Pubkey::default(),
            SigilError::ErrCosignRequired
        );
        let cosign_present = ctx
            .remaining_accounts
            .iter()
            .any(|ai| ai.key == &cosign_session && ai.is_signer);
        require!(cosign_present, SigilError::ErrCosignRequired);
    }
    // D-5 (audit 2026-05-19, F-RP3-1): apply optional cosign_session_pubkey
    // update. None preserves the live value; Some(_) overwrites unconditionally
    // (default Pubkey::default() is a valid value meaning "gate disabled").
    // The second-pass TA-19 digest below binds the merged value at canonical
    // position 22, so a tampered pending PDA that flipped this between queue
    // and apply produces a digest mismatch and `PolicyPreviewMismatch`.
    if let Some(new_cosign_pubkey) = pending.cosign_session_pubkey {
        policy.cosign_session_pubkey = new_cosign_pubkey;
    }
    // F-Q6 / Council C-1 defense-in-depth (2026-06-03): re-assert the bound
    // cosigner is a DISTINCT 2nd factor at this apply write site too. The
    // queue_policy_update guard is the primary check; enforcing it here as well
    // removes the brittleness of single-site enforcement and neutralizes any
    // pre-guard self-cosign value carried forward. A bound cosigner == owner
    // would collapse C-1's "owner + cosigner" to ONE factor, letting the owner
    // key alone satisfy the cosign-bound INSTANT OPERATOR path in register_agent
    // / reactivate_vault. `Pubkey::default()` (gate disabled) is exempt.
    if policy.cosign_session_pubkey != Pubkey::default() {
        require_keys_neq!(
            policy.cosign_session_pubkey,
            ctx.accounts.owner.key(),
            SigilError::ErrCosignRequired
        );
    }

    // Phase 2 Option A: defense-in-depth — re-validate protocol_mode if pending overrode it.
    if let Some(mode) = pending.protocol_mode {
        require!(
            mode == PROTOCOL_MODE_ALLOWLIST,
            SigilError::InvalidProtocolMode
        );
    }

    // F-11 cross-check (§RP-2 bonus finding 2026-05-18): mirror the
    // initialize_vault + set_observe_only guard. An active (non-observe_only)
    // vault cannot have both allowlists empty post-merge, or it becomes silently
    // inert — accepts deposits but rejects every spending tx. The TA-19 digest
    // matches the owner's signed digest in this state, so without this gate the
    // owner-blind-sign path lets the vault land in the silently-inert state.
    require!(
        ctx.accounts.vault.observe_only
            || !policy.protocols.is_empty()
            || !policy.allowed_destinations.is_empty(),
        SigilError::ActiveVaultRequiresAllowlist
    );

    // Phase 2 TA-19: re-assert the digest of the now-merged live policy against
    // the owner-signed `pending.new_policy_preview_digest`. This is the second
    // defense — the first ran at `queue_policy_update`. If a rogue program
    // tampered with the pending PDA between queue and apply (e.g. discriminator
    // collision via a future zero-copy account type), the recomputed digest
    // diverges and we hard-reject.
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
        observe_only: ctx.accounts.vault.observe_only,
        has_post_assertions: policy.has_post_assertions,
        // PEN-CROSS-2: re-bind to live policy's immutable creation slot.
        created_at_slot: policy.created_at_slot,
        // TA-05 (Phase 3): operating_hours is policy-owned and bound by
        // TA-19. apply_pending_policy reads the live value after the
        // optional pending merge above, so the second-pass digest matches
        // the queue-time digest.
        operating_hours: policy.operating_hours,
        // TA-07/17 (Phase 3): also bound by TA-19. Read live (applied
        // values if pending overrode them).
        auto_promote_grays: policy.auto_promote_grays,
        auto_revoke_threshold: policy.auto_revoke_threshold,
        // TA-12 (Phase 5): stable_balance_floor is policy-owned and bound
        // by TA-19. apply_pending_policy reads live (applied) value so
        // the second-pass digest matches what queue_policy_update bound.
        stable_balance_floor: policy.stable_balance_floor,
        // TA-14 (Phase 5): per_recipient_daily_cap_usd is policy-owned and
        // bound by TA-19. Same pattern — read live (applied) value.
        per_recipient_daily_cap_usd: policy.per_recipient_daily_cap_usd,
        // G6 (audit 2026-05-18 cosign opt-in): cosign_required is policy-
        // owned and bound by TA-19 at canonical position 20. Read live
        // (post-merge) value so the second-pass digest matches whatever
        // the queue handler signed against.
        cosign_required: policy.cosign_required,
        // Phase 8 PEN-CROSS-1: agent_set_hash bound at canonical position
        // 21. apply_pending_policy never mutates `vault.agents` itself —
        // re-derive from the live vault so the second-pass digest matches
        // the queue-time digest (which the SDK computed against the same
        // live agent set).
        agent_set_hash: compute_agent_set_hash(&ctx.accounts.vault.agents),
        // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey bound at
        // canonical position 22. Read live (post-merge) value so the
        // second-pass digest matches whatever the queue handler signed
        // against.
        cosign_session_pubkey: policy.cosign_session_pubkey,
        // F-Q6 (2026-06-02): operator_grant_delay_seconds bound at canonical
        // digest position 22. apply_pending_policy does not mutate it in A1
        // (not yet a pending field) — read the live policy value so the
        // second-pass digest matches the queue-time digest.
        operator_grant_delay_seconds: policy.operator_grant_delay_seconds,
    });
    require!(
        recomputed_digest == pending.new_policy_preview_digest,
        SigilError::PolicyPreviewMismatch
    );
    // Persist the new digest into live policy for future reads.
    policy.policy_preview_digest = pending.new_policy_preview_digest;

    policy.has_pending_policy = false;

    // Bump policy version — agents will detect this via PolicyVersionMismatch
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    let vault_key = ctx.accounts.vault.key();

    // Phase 7 — write success audit-log entry AFTER policy state mutated +
    // version bumped.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_POLICY_APPLY,
            vault_key,
            0,
            0,
            clock.unix_timestamp,
            &ctx.accounts.slot_hashes_sysvar.to_account_info(),
        )?;
        let mut log = ctx.accounts.audit_log_success.load_mut()?;
        // §RP-1 I-2: defense-in-depth guard against future seeds drift.
        require_keys_eq!(
            log.vault,
            ctx.accounts.vault.key(),
            SigilError::ZeroCopyVaultMismatch
        );
        log.append(entry);
    }

    emit!(PolicyChangeApplied {
        vault: vault_key,
        applied_at: clock.unix_timestamp,
    });

    Ok(())
}
