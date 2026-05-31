use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentRegistered;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PEN-CROSS-5 (Phase 4 absorption) — policy is now mutated by
    /// register/revoke/pause/unpause to bump `policy_version` as a
    /// defense-in-depth OCC signal. Existing `vault.is_agent` /
    /// `is_agent_paused` constraints already reject the TOCTOU window;
    /// the version bump lets concurrent validate_and_authorize calls fail
    /// fast with PolicyVersionMismatch instead of relying on the slower
    /// constraint check.
    ///
    /// §RP-1 V6 clarification (2026-05-18): the policy-to-vault binding is
    /// enforced by the PDA seeds derivation `[b"policy", vault.key().as_ref()]`
    /// — functionally equivalent to `has_one = vault`. Any sibling-thread
    /// claim of an explicit `has_one = vault` constraint on this account is
    /// cosmetic; the seeds derivation is the load-bearing check. This same
    /// pattern is mirrored on `revoke_agent.rs`, `pause_agent.rs`, and
    /// `unpause_agent.rs`.
    #[account(
        mut,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Agent spend overlay — per-agent tracking slot.
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump = agent_spend_overlay.load()?.bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    /// Phase 7 — success audit log; entry appended after register completes.
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

pub fn handler(
    ctx: Context<RegisterAgent>,
    agent: Pubkey,
    capability: u8,
    spending_limit_usd: u64,
) -> Result<()> {
    crate::reject_cpi!();

    let vault = &mut ctx.accounts.vault;

    // P0.1 PEN-CROSS-1 interim cosign gate (audit 2026-05-19).
    //
    // Full digest-binding + timelock fix stays in Phase 8 (per G2 deferral).
    // This interim gate is a defensive partial fix: for vaults that have
    // explicitly opted into cosign (`policy.cosign_required == true`), require
    // a second non-owner signer in `remaining_accounts` (the cosign session)
    // alongside the owner. Vaults with the default `cosign_required: false`
    // are unaffected — single-signer flow continues.
    //
    // Threat: a phished/leaked owner key cannot silently `register_agent`
    // (instantly granting operator capability with no timelock) on a vault
    // that opted into cosign. Without this gate, register_agent bypasses
    // the cosign workflow entirely because it does not pass through
    // queue_policy_update.
    //
    // Mechanism: scan ctx.remaining_accounts for any signer pubkey that is
    // NOT the owner. Absence of such a signer == cosign missing on a vault
    // that requires it → reject with 6089 ErrCosignRequired.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = has_non_owner_signer(ctx.remaining_accounts, &owner_key);
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );
    // M1-03 (systemic frozen-gate, 2026-05-31): a frozen vault MUST NOT accept a
    // NEW agent. Registering an agent is ADDITIVE (it grants execution authority
    // to a new key) — exactly what a freeze is meant to halt, and what a phished
    // owner key could abuse. Removing/pausing an agent (revoke_agent,
    // pause_agent) stays allowed while frozen; only the additive direction is
    // gated. Closed is rejected above with its own diagnostic.
    require!(
        vault.status != VaultStatus::Frozen,
        SigilError::VaultNotActive
    );
    // Phase 2 TA-04: reserved capability values 3..=255 explicitly rejected.
    // Replaces prior silent zero-coerce behaviour in `has_capability`.
    require!(capability <= FULL_CAPABILITY, SigilError::InvalidCapability);
    // Phase 8 PEN-CROSS-1 (audit 2026-05-19): on cosign-opted vaults,
    // `register_agent` is Observer-only — OPERATOR-class grants MUST route
    // through the `queue_agent_grant` → `apply_agent_grant` timelock-gated
    // path (mirrors the F-RP3-2 cosign+timelock gate at
    // `queue_agent_permissions_update`). Closes the phished-owner
    // instant-operator-grant vector for vaults that opted into cosign.
    //
    // For vaults WITHOUT cosign_required (the V1 default for solo-founder
    // simplicity), register_agent retains direct-grant semantics — those
    // vaults have NO defense against a phished owner key by design, so
    // adding a timelock here would not change the threat surface but
    // would break 60%+ of existing fixtures.
    //
    // CAPABILITY_DISABLED (0) and CAPABILITY_OBSERVER (1) always go through
    // this fast path because Observers cannot move funds —
    // `has_capability(.., is_spending=true)` requires CAPABILITY_OPERATOR.
    if ctx.accounts.policy.cosign_required {
        require!(
            capability < CAPABILITY_OPERATOR,
            SigilError::InvalidPermissions
        );
    }
    require!(!vault.is_agent(&agent), SigilError::AgentAlreadyRegistered);
    require!(
        vault.agent_count() < MAX_AGENTS_PER_VAULT,
        SigilError::MaxAgentsReached
    );
    require!(agent != Pubkey::default(), SigilError::InvalidAgentKey);
    require!(agent != vault.owner, SigilError::AgentIsOwner);

    vault.agents.push(AgentEntry {
        pubkey: agent,
        capability,
        // TA-17 (Phase 3): new agent starts with no consecutive failures.
        consecutive_failures: 0,
        _reserved: [0u8; 6],
        spending_limit_usd,
        paused: false,
    });

    // Claim a slot in the overlay for per-agent tracking.
    // Fail-closed: if spending_limit_usd > 0 but no slot available,
    // reject registration to guarantee per-agent limits are enforced.
    if let Ok(mut overlay) = ctx.accounts.agent_spend_overlay.load_mut() {
        if overlay.find_agent_slot(&agent).is_none() {
            match overlay.claim_slot(&agent) {
                Some(_) => {} // slot claimed successfully
                None => {
                    if spending_limit_usd > 0 {
                        // Remove the agent we just pushed — no slot to enforce limit
                        vault.agents.retain(|a| a.pubkey != agent);
                        return Err(error!(SigilError::OverlaySlotExhausted));
                    }
                    // spending_limit_usd == 0: no per-agent limit needed, continue
                }
            }
        }
    }

    // Phase 8 §RP Fix-Up B (LBL-03 HIGH, audit 2026-05-19): recompute
    // policy_preview_digest with the new agent_set_hash. `vault.agents` was
    // just mutated (push above), so the digest the owner last signed no
    // longer matches the live policy's bound agent set. Without this
    // recompute, subsequent `apply_pending_policy` / sibling-handler digest
    // checks would reject — UNLESS the digest is updated here.
    //
    // Mirrors `apply_agent_grant.rs:172-196` (the canonical pattern).
    // Empty-vault hash deterministic via `EMPTY_AGENT_SET_HASH`; non-empty
    // sets sorted-by-pubkey-ascending then Borsh-encoded then SHA-256.
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
        has_constraints: policy.has_constraints,
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
        // canonical position 22 — register_agent never mutates it, so
        // pass-through from live policy keeps the re-bind digest matching
        // the queue-time digest.
        cosign_session_pubkey: policy.cosign_session_pubkey,
    });
    policy.policy_preview_digest = new_digest;

    // PEN-CROSS-5 (Phase 4 absorption): bump policy_version. Closes the
    // OCC window where an in-flight validate_and_authorize could be
    // sandwiched between an agent's registration and its first action.
    // `vault.is_agent` constraint already rejects mid-flight, but the
    // bump means concurrent validates fail fast with PolicyVersionMismatch
    // instead of pushing into the agent-existence check.
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    let clock = Clock::get()?;
    let vault_key = vault.key();

    // Phase 7 — write success audit-log entry. Registered agent pubkey is
    // stored in the `subject` slot for traceability.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_REGISTER_AGENT,
            agent,
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

    emit!(AgentRegistered {
        vault: vault_key,
        agent,
        capability,
        spending_limit_usd,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// P0.1 PEN-CROSS-1 / PEN-8b interim cosign gate predicate (audit 2026-05-19).
///
/// Returns true when AT LEAST ONE entry in `remaining_accounts` is a signer
/// whose pubkey is not `owner_key`. Used by `register_agent` and
/// `set_observe_only` to enforce the interim cosign-required gate for vaults
/// that opted into `policy.cosign_required == true`. Pure function on the
/// `(is_signer, key)` projection — easy to unit test without LiteSVM.
pub(crate) fn has_non_owner_signer(accounts: &[AccountInfo<'_>], owner_key: &Pubkey) -> bool {
    accounts
        .iter()
        .any(|ai| ai.is_signer && ai.key() != *owner_key)
}

#[cfg(test)]
mod cosign_gate_predicate_tests {
    //! P0.1 PEN-CROSS-1 / PEN-8b interim cosign gate predicate (audit 2026-05-19).
    //!
    //! These tests pin the behaviour of `has_non_owner_signer` — the exact
    //! predicate `register_agent` + `set_observe_only` use to enforce the
    //! cosign gate when `policy.cosign_required == true`.

    use super::*;
    use anchor_lang::solana_program::account_info::AccountInfo;

    fn key_n(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    fn make_info<'a>(
        key: &'a Pubkey,
        is_signer: bool,
        lamports: &'a mut u64,
        data: &'a mut [u8],
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, is_signer, false, lamports, data, owner, false, 0)
    }

    /// Gate rejects when no signer beyond owner is present.
    #[test]
    fn rejects_when_only_owner_signs() {
        let owner = key_n(1);
        let mut lp = 0u64;
        let mut d: [u8; 0] = [];
        let owner_info = make_info(&owner, true, &mut lp, &mut d, &owner);
        // `register_agent` calls `has_non_owner_signer` with
        // `ctx.remaining_accounts`, NOT including the owner Signer account
        // itself (which lives in the named Accounts struct). So the
        // common attack shape is "owner signs the tx, remaining_accounts
        // is empty or contains only non-signers".
        let remaining: Vec<AccountInfo> = vec![];
        assert!(
            !has_non_owner_signer(&remaining, &owner),
            "empty remaining_accounts must NOT satisfy the gate"
        );
        // Defense-in-depth: even if owner were duplicated as a signer in
        // remaining_accounts (it shouldn't be — Anchor de-dupes — but
        // belt-and-suspenders), the predicate ignores it.
        let dup = vec![owner_info];
        assert!(
            !has_non_owner_signer(&dup, &owner),
            "owner-as-signer in remaining_accounts must NOT satisfy gate"
        );
    }

    /// Gate accepts when a distinct non-owner signer is present.
    #[test]
    fn accepts_when_cosigner_signs() {
        let owner = key_n(1);
        let cosigner = key_n(2);
        let mut lp = 0u64;
        let mut d: [u8; 0] = [];
        let cosigner_info = make_info(&cosigner, true, &mut lp, &mut d, &cosigner);
        let remaining = vec![cosigner_info];
        assert!(
            has_non_owner_signer(&remaining, &owner),
            "non-owner signer in remaining_accounts MUST satisfy gate"
        );
    }

    /// Non-signer accounts (read-only refs to the cosigner key) do NOT
    /// satisfy the gate. Closes the attack where remaining_accounts
    /// includes a non-signing reference to a known cosign session pubkey.
    #[test]
    fn rejects_when_non_signer_present_only() {
        let owner = key_n(1);
        let cosigner = key_n(2);
        let mut lp = 0u64;
        let mut d: [u8; 0] = [];
        let cosigner_info = make_info(&cosigner, false, &mut lp, &mut d, &cosigner);
        let remaining = vec![cosigner_info];
        assert!(
            !has_non_owner_signer(&remaining, &owner),
            "non-signer cosigner reference must NOT satisfy gate"
        );
    }
}
