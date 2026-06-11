use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentRegistered;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::operator_grant::{
    classify_operator_grant_tier, operator_grant_is_instant_eligible, OperatorGrantTier,
};
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

    // F-Q6 (2026-06-02): the cosign gate AND the OPERATOR-grant tier rule are
    // unified BELOW — after the status + capability validation — so the tier
    // decision sees a validated `capability` and `owner_type`. See the tiered
    // block following the `capability <= FULL_CAPABILITY` check.

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
    // F-Q6 (2026-06-02) — OPERATOR-grant authorization tiering. An OPERATOR
    // grant may be INSTANT here only if the vault carries >= 2 authorization
    // factors AND no grant delay is configured; otherwise it MUST route
    // through `queue_agent_grant` → `apply_agent_grant` (the time-delay is the
    // missing 2nd factor). Observer/Disabled grants (capability <
    // CAPABILITY_OPERATOR) cannot move funds and keep the interim cosign gate.
    //
    // owner_type validity is asserted first (ISC-33 / Council C-2): the field
    // is program-set to {0,1}; anything else is corrupted authority state and
    // is rejected rather than interpreted.
    require!(
        vault.owner_type <= OWNER_TYPE_MULTISIG,
        SigilError::InvalidOwnerType
    );
    // F-Q6 ordering (2026-06-03): the agent-validity checks run BEFORE the
    // OPERATOR tier gate so a bad agent (default / owner / duplicate /
    // over-count) surfaces its SPECIFIC diagnostic (InvalidAgentKey /
    // AgentIsOwner / AgentAlreadyRegistered / MaxAgentsReached) instead of
    // being shadowed by ErrOperatorGrantRequiresTimelock (6107). All are
    // reverts — reordering changes only WHICH error surfaces, not which inputs
    // are rejected; the tier gate below still fires for a VALID single-key
    // OPERATOR.
    require!(!vault.is_agent(&agent), SigilError::AgentAlreadyRegistered);
    require!(
        vault.agent_count() < MAX_AGENTS_PER_VAULT,
        SigilError::MaxAgentsReached
    );
    require!(agent != Pubkey::default(), SigilError::InvalidAgentKey);
    require!(agent != vault.owner, SigilError::AgentIsOwner);
    if capability >= CAPABILITY_OPERATOR {
        let tier = classify_operator_grant_tier(
            vault.owner_type,
            ctx.accounts.policy.cosign_required,
            &ctx.accounts.policy.cosign_session_pubkey,
        );
        // Instant only with >= 2 factors at zero configured delay. SingleKey
        // (1 factor) is always floored → never instant; a configured delay
        // routes even cosign/multisig through the queue path. This closes the
        // phished single-owner-key instant-OPERATOR vector.
        require!(
            operator_grant_is_instant_eligible(
                tier,
                ctx.accounts.policy.operator_grant_delay_seconds
            ),
            SigilError::ErrOperatorGrantRequiresTimelock
        );
        // C-1: a cosign-bound instant grant MUST carry a signer matching the
        // BOUND `cosign_session_pubkey` (not merely "any non-owner signer" — a
        // leaked owner key + a throwaway 2nd key would pass that weaker gate).
        // `classify_operator_grant_tier` only returns CosignBound when the
        // pubkey is non-default, so the match target is guaranteed bound.
        // Mirrors the apply-time re-bind at `apply_agent_grant.rs` (H-1).
        if tier == OperatorGrantTier::CosignBound {
            let cosign_session_pubkey = ctx.accounts.policy.cosign_session_pubkey;
            let cosign_ok = ctx
                .remaining_accounts
                .iter()
                .any(|ai| ai.is_signer && ai.key() == cosign_session_pubkey);
            require!(cosign_ok, SigilError::ErrCosignRequired);
        }
        // Multisig: no extra inline signer — the multisig's threshold already
        // approved off-chain, and `has_one = owner` binds the signer to the
        // recorded multisig owner. [V1 REACHABILITY NOTE: a keyless Squads
        // vault PDA cannot satisfy `owner: Signer` + `reject_cpi!()`, so this
        // arm is not reachable until a multisig-callable owner-op path exists.
        // It is correct, fail-safe, and forward-compatible; an attacker also
        // cannot reach it (no key to sign as the PDA owner). See the project
        // notes for the pre-existing multisig-invocation gap.]
    } else if ctx.accounts.policy.cosign_required {
        // M-2 (audit 2026-06-11): identity-pinned cosign gate. When a cosign
        // session pubkey is bound, the second factor must be THAT exact key
        // (not any throwaway signer); unbound vaults fall back to the prior
        // any-non-owner-signer check (no brick). Uniform with the other cosign
        // lanes and the apply-lane behaviour.
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = has_bound_cosigner(
            ctx.remaining_accounts,
            &owner_key,
            &ctx.accounts.policy.cosign_session_pubkey,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

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
        // F-Q6: operator_grant_delay_seconds bound at canonical digest position 22.
        operator_grant_delay_seconds: policy.operator_grant_delay_seconds,
        // M-1 (audit 2026-06-11): bind per-protocol caps (positions 23-24).
        has_protocol_caps: policy.has_protocol_caps,
        protocol_caps: &policy.protocol_caps,
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

/// M-2 (audit 2026-06-11): identity-pinned cosign gate with an unbound-safe
/// fallback. Returns true iff the `cosign_required` gate is satisfied:
///   - BOUND (`cosign_session_pubkey != default`): a signer in
///     `remaining_accounts` must match that EXACT pubkey — a true second factor
///     (a leaked owner key + any throwaway keypair no longer passes; this
///     closes the C-1 weakness in the queue/initiate/withdraw cosign lanes).
///   - UNBOUND (`cosign_session_pubkey == default`): falls back to
///     `has_non_owner_signer`. Preserves back-compat for vaults that set
///     `cosign_required = true` but never bound a session pubkey, so the upgrade
///     does NOT brick them — a strict match against the all-zero default pubkey
///     would be unsatisfiable (a zero-key signer is unreachable). Mirrors the
///     canonical apply-lane behaviour at `apply_agent_grant` / `apply_pending_policy`.
pub(crate) fn has_bound_cosigner(
    accounts: &[AccountInfo<'_>],
    owner_key: &Pubkey,
    cosign_session_pubkey: &Pubkey,
) -> bool {
    if *cosign_session_pubkey != Pubkey::default() {
        accounts
            .iter()
            .any(|ai| ai.is_signer && ai.key() == *cosign_session_pubkey)
    } else {
        has_non_owner_signer(accounts, owner_key)
    }
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

    // ── M-2 (audit 2026-06-11): has_bound_cosigner identity-pin + fallback ──

    /// M-2: BOUND cosign_session_pubkey — a signer matching that EXACT key
    /// satisfies the gate.
    #[test]
    fn bound_cosigner_matching_signer_passes() {
        let owner = key_n(1);
        let bound = key_n(2);
        let mut lp = 0u64;
        let mut d: [u8; 0] = [];
        let info = make_info(&bound, true, &mut lp, &mut d, &bound);
        let remaining = vec![info];
        assert!(has_bound_cosigner(&remaining, &owner, &bound));
    }

    /// M-2: BOUND — a DIFFERENT (throwaway) signer does NOT satisfy the gate.
    /// This is the C-1 weakness the identity-pin closes.
    #[test]
    fn bound_cosigner_wrong_signer_fails() {
        let owner = key_n(1);
        let bound = key_n(2);
        let throwaway = key_n(3);
        let mut lp = 0u64;
        let mut d: [u8; 0] = [];
        let info = make_info(&throwaway, true, &mut lp, &mut d, &throwaway);
        let remaining = vec![info];
        assert!(
            !has_bound_cosigner(&remaining, &owner, &bound),
            "a throwaway signer != bound cosigner MUST NOT satisfy the gate"
        );
    }

    /// M-2: BOUND — a non-signing reference to the bound key does NOT satisfy.
    #[test]
    fn bound_cosigner_non_signer_fails() {
        let owner = key_n(1);
        let bound = key_n(2);
        let mut lp = 0u64;
        let mut d: [u8; 0] = [];
        let info = make_info(&bound, false, &mut lp, &mut d, &bound);
        let remaining = vec![info];
        assert!(!has_bound_cosigner(&remaining, &owner, &bound));
    }

    /// M-2: UNBOUND (default pubkey) — falls back to any-non-owner-signer, so a
    /// distinct signer passes. The no-brick guarantee for vaults that set
    /// cosign_required=true without binding a session pubkey.
    #[test]
    fn unbound_cosigner_falls_back_to_any_signer() {
        let owner = key_n(1);
        let cosigner = key_n(2);
        let default_pk = Pubkey::default();
        let mut lp = 0u64;
        let mut d: [u8; 0] = [];
        let info = make_info(&cosigner, true, &mut lp, &mut d, &cosigner);
        let remaining = vec![info];
        assert!(
            has_bound_cosigner(&remaining, &owner, &default_pk),
            "unbound gate must fall back to any non-owner signer (no brick)"
        );
    }

    /// M-2: UNBOUND + empty remaining_accounts → still rejects (fallback is the
    /// same has_non_owner_signer check).
    #[test]
    fn unbound_cosigner_empty_fails() {
        let owner = key_n(1);
        let default_pk = Pubkey::default();
        let remaining: Vec<AccountInfo> = vec![];
        assert!(!has_bound_cosigner(&remaining, &owner, &default_pk));
    }
}
