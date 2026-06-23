use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::ObserveOnlyChanged;
use crate::state::{AgentVault, PolicyConfig, VaultStatus};
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

/// F-12 audit fix: direct owner-only flip of `vault.observe_only`.
///
/// observe_only is part of the canonical policy_preview_digest encoding
/// (position 10). Any mutation MUST recompute the stored digest + bump
/// policy_version (OCC) — same invariant enforced by the four sibling
/// handlers covered by `tests/policy-digest-invariant.ts`.
///
/// User-approved Option (a): direct flip, no timelock. observe_only is a
/// low-stakes mutation surface — flipping it only enables/disables vault
/// execution. If owner key is compromised the attacker can do strictly worse
/// via the existing surfaces (freeze, withdraw, queue/apply policy update).
/// Mirrors `freeze_vault`'s simplicity.
///
/// F-11 consistency: cannot flip to active (observe_only=false) when both
/// the protocol and destination allowlists are empty — otherwise the vault
/// would land in a silently inert state. The opposite direction (active →
/// observe_only=true) is always allowed.
#[derive(Accounts)]
pub struct SetObserveOnly<'info> {
    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), &vault.vault_id.to_le_bytes()],
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

    pub owner: Signer<'info>,
}

pub fn handler(ctx: Context<SetObserveOnly>, new_value: bool) -> Result<()> {
    crate::reject_cpi!();
    let vault = &mut ctx.accounts.vault;
    let policy = &mut ctx.accounts.policy;

    // M1-03 (systemic frozen-gate, 2026-05-31): only the ADDITIVE direction is
    // gated, consistent with the cosign gate below. Flipping observe_only OFF
    // (new_value == false) makes the vault executable — that must not happen on a
    // frozen/closed vault (a phished owner key could re-arm execution during a
    // freeze). Flipping observe_only ON (making the vault inert) is DEFENSIVE and
    // stays allowed while frozen so the owner can further lock down mid-freeze.
    if !new_value {
        require!(
            vault.status == VaultStatus::Active,
            SigilError::VaultNotActive
        );
    }

    // P0.1 PEN-8b interim cosign gate (audit 2026-05-19).
    //
    // Only the dangerous direction is gated: flipping observe_only OFF
    // (new_value == false) makes the vault execute on agent calls. Flipping
    // ON is always safe — inert vault accepts no agent execution.
    //
    // Mechanism mirrors register_agent's gate: if the vault has opted into
    // cosign (`policy.cosign_required == true`), require a non-owner signer
    // in `remaining_accounts`. Vaults with the default `cosign_required:
    // false` are unaffected.
    //
    // Threat: phished owner key cannot silently flip an observation vault
    // into active execution without a co-signing session. The full
    // digest-binding + timelock fix stays in Phase 8.
    if !new_value && policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_bound_cosigner(
            ctx.remaining_accounts,
            &owner_key,
            // `policy` is already a `&mut` binding (used below at the F-11
            // allowlist check), so reborrow the pubkey through it rather than
            // re-borrowing `ctx.accounts.policy` immutably (which would conflict).
            &policy.cosign_session_pubkey,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    // F-11 consistency: cannot flip to active mode when both allowlists are
    // empty. observe_only=true never trips this check because inert is the
    // intended state for observation vaults.
    if !new_value {
        require!(
            !policy.protocols.is_empty() || !policy.allowed_destinations.is_empty(),
            SigilError::ActiveVaultRequiresAllowlist
        );
    }

    let old_value = vault.observe_only;
    vault.observe_only = new_value;

    // F-2 lesson (TA-19): any mutation of a field included in
    // policy_preview_digest MUST recompute the stored digest + bump
    // policy_version (OCC). observe_only is at position 11 of the canonical
    // digest encoding (was 10 pre PEN-CROSS-6; developer_fee_rate at position 4
    // shifted observe_only and downstream fields by 1).
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
        observe_only: vault.observe_only,
        has_post_assertions: policy.has_post_assertions,
        // PEN-CROSS-2: created_at_slot is immutable post-init.
        created_at_slot: policy.created_at_slot,
        // TA-05 (Phase 3): operating_hours is policy-owned and bound by TA-19.
        // set_observe_only never mutates operating_hours — read live policy.
        operating_hours: policy.operating_hours,
        // TA-07/17 (Phase 3): bound by TA-19, never mutated by this ix.
        auto_promote_grays: policy.auto_promote_grays,
        auto_revoke_threshold: policy.auto_revoke_threshold,
        // TA-12 (Phase 5): bound by TA-19, never mutated by this ix.
        stable_balance_floor: policy.stable_balance_floor,
        // TA-14 (Phase 5): bound by TA-19, never mutated by this ix.
        per_recipient_daily_cap_usd: policy.per_recipient_daily_cap_usd,
        // G6 (audit 2026-05-18 cosign opt-in): bound by TA-19 at canonical
        // position 20. set_observe_only never mutates cosign_required —
        // read live policy.
        cosign_required: policy.cosign_required,
        // Phase 8 PEN-CROSS-1: agent_set_hash bound at canonical position
        // 21. set_observe_only never mutates the agent set — re-derive
        // from live vault.
        agent_set_hash: compute_agent_set_hash(&vault.agents),
        // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey bound at
        // canonical position 22 — set_observe_only never mutates it, so
        // pass-through from live policy keeps the re-bind digest matching
        // the queue-time digest.
        cosign_session_pubkey: policy.cosign_session_pubkey,
        // F-Q6: operator_grant_delay_seconds bound at canonical digest position 22.
        operator_grant_delay_seconds: policy.operator_grant_delay_seconds,
        // M-1 (audit 2026-06-11): bind per-protocol caps (positions 23-24).
        has_protocol_caps: policy.has_protocol_caps,
        protocol_caps: &policy.protocol_caps,
        // Item 3 (2026-06-22): re-derive protocol_hashes from live policy
        // (this site never mutates it). Bound at canonical digest position 25.
        protocol_hashes: &policy.protocol_hashes,
    });
    policy.policy_preview_digest = recomputed_digest;
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(SigilError::Overflow)?;

    emit!(ObserveOnlyChanged {
        vault: vault.key(),
        old_value,
        new_value,
        new_policy_version: policy.policy_version,
        new_policy_preview_digest: recomputed_digest,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
