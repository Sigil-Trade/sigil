use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::VaultReactivated;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

#[derive(Accounts)]
pub struct ReactivateVault<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// Round 2 F-RP3-1 fix (audit 2026-05-19): policy is now mutated by
    /// `reactivate_vault` to:
    ///   1. Read `cosign_required` for the interim cosign gate (the previous
    ///      handler granted FULL_CAPABILITY to a fresh agent with NO cosign
    ///      gate on a cosign-opted-in vault — phished-owner instant operator
    ///      grant via freeze→reactivate(attacker, FULL_CAPABILITY)).
    ///   2. Bump `policy_version` after the agent push so any in-flight
    ///      validate_and_authorize fails fast with PolicyVersionMismatch
    ///      rather than relying on the slower vault.is_agent constraint.
    ///
    /// Policy-to-vault binding via PDA seeds — same pattern as
    /// `register_agent.rs:35-40`.
    #[account(
        mut,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Phase 7 — success audit log; entry appended after status flip.
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
    ctx: Context<ReactivateVault>,
    new_agent: Option<Pubkey>,
    new_agent_capability: Option<u8>,
) -> Result<()> {
    crate::reject_cpi!();

    // Round 2 §RP-1 F-RP3-1 fix (audit 2026-05-19): status check fires
    // FIRST so callers operating on a non-frozen vault receive the more
    // diagnostic `VaultNotFrozen` (6021) rather than the misleading
    // `ErrCosignRequired` (6089) that the cosign gate would surface. The
    // cosign gate is still load-bearing for the phished-owner scenario
    // (freeze→reactivate(attacker, FULL_CAPABILITY)) — it just runs
    // SECOND so the error-code priority matches operator expectations.

    // 1. Status check FIRST — diagnostic priority. Read-only borrow so
    // the subsequent cosign-gate check on `ctx.accounts.policy` does not
    // conflict with a mutable borrow.
    require!(
        ctx.accounts.vault.status == VaultStatus::Frozen,
        SigilError::VaultNotFrozen
    );

    // 2. Interim cosign gate (Round 2 F-RP3-1). The previous handler
    // granted FULL_CAPABILITY to a fresh agent on a frozen vault with
    // NO cosign gate — a phished owner could chain `freeze_vault` →
    // `reactivate_vault(attacker, FULL_CAPABILITY)` in one tx and
    // silently install operator capability on a vault that has opted
    // into cosign. Mirrors `register_agent.rs:91-95` and
    // `set_observe_only.rs`. Vaults with the default
    // `cosign_required: false` are unaffected.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_non_owner_signer(
            ctx.remaining_accounts,
            &owner_key,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    // 2.5 Phase 8 C28 — 5-minute observation cooldown.
    //
    // The cooldown protects against fat-finger unfreeze + brief panic-then-
    // reactivate workflows. Owner freezes, observes for 5 min, then can
    // reactivate. UX safety net — see T-19 in THREAT_MODEL_V2.md for the
    // close+reinit adversarial bypass acknowledgement (V1.1 mitigation
    // deferred per L-2 no-additional-rent-cost preference).
    //
    // Reads the new `frozen_at_timestamp` field added in Phase 8 Batch 1
    // (AgentVault APPEND-ONLY +9 bytes). Existing post-freeze vaults that
    // were frozen before this field landed will have 0 → fail the < 300
    // window check trivially (clock - 0 >> 300), so the cooldown never
    // fires retroactively.
    //
    // Phase 8 §RP Fix-Up B (SFH-04 MED, audit 2026-05-19): defense-in-depth
    // assert that `frozen_at_timestamp > 0` BEFORE the cooldown check. The
    // current handler ordering (status check FIRST → cooldown SECOND) makes
    // this redundant — a vault in Frozen state always has
    // `frozen_at_timestamp > 0` because `freeze_internal` writes both atomically.
    // But a future refactor that re-orders the cooldown check above the
    // status check would let a pre-freeze vault (frozen_at = 0) pass the
    // cooldown trivially (clock - 0 = clock >> 300 for any non-genesis
    // clock). The explicit assert pins the invariant at compile-time of
    // reviewer attention. `VaultNotFrozen` (6021) is the canonical signal
    // for "this vault was never frozen / frozen_at unset".
    require!(
        ctx.accounts.vault.frozen_at_timestamp > 0,
        SigilError::VaultNotFrozen
    );
    const REACTIVATE_COOLDOWN_SECONDS: i64 = 300;
    let now_pre_mut = Clock::get()?.unix_timestamp;
    let frozen_at = ctx.accounts.vault.frozen_at_timestamp;
    let elapsed = now_pre_mut.saturating_sub(frozen_at);
    require!(
        elapsed >= REACTIVATE_COOLDOWN_SECONDS,
        SigilError::ErrReactivateCooldownActive
    );

    let vault = &mut ctx.accounts.vault;

    // 3. Validate mutual presence of new_agent and new_agent_capability
    require!(
        new_agent.is_some() == new_agent_capability.is_some(),
        SigilError::InvalidPermissions
    );

    // 4. Optionally assign new agent
    if let Some(agent_key) = new_agent {
        let capability = new_agent_capability.unwrap();
        require!(agent_key != Pubkey::default(), SigilError::InvalidAgentKey);
        require!(agent_key != vault.owner, SigilError::AgentIsOwner);
        require!(
            capability <= FULL_CAPABILITY,
            SigilError::InvalidPermissions
        );
        require!(
            vault.agent_count() < MAX_AGENTS_PER_VAULT,
            SigilError::MaxAgentsReached
        );
        require!(
            !vault.is_agent(&agent_key),
            SigilError::AgentAlreadyRegistered
        );

        // D-5 close (audit 2026-05-19, F-RP3-1): the FULL_CAPABILITY
        // reactivate-cosign gate.
        //
        // THREAT: a phished owner key could otherwise chain
        //   `freeze_vault → reactivate_vault(new_agent=ATTACKER, FULL_CAPABILITY)`
        // in a single transaction. The earlier `policy.cosign_required`
        // gate at the top of this handler catches that for vaults that
        // opted into TA-09 cosign — but NOT for vaults whose owners want
        // to keep the low-friction `cosign_required: false` posture while
        // still defending against the freeze→reactivate FULL escalation.
        //
        // DEFENSE: when the new agent is being grafted at FULL_CAPABILITY,
        // AND the owner has opted in via `policy.cosign_session_pubkey !=
        // Pubkey::default()`, require an `is_signer == true` entry in
        // `remaining_accounts` whose key equals the bound pubkey. The
        // pubkey itself is TA-19-bound (canonical position 22) so a
        // tampered SDK cannot silently flip the gate between owner
        // approval and on-chain landing.
        //
        // Defaults preserved: vaults with `cosign_session_pubkey ==
        // Pubkey::default()` retain today's behavior — no gate fires on
        // the reactivate path. The gate is strictly opt-in via
        // `queue_policy_update`.
        //
        // OPERATOR (and lower) capability is NOT gated here — only the
        // FULL_CAPABILITY escalation is. Owners who want broader
        // reactivate-time cosign should additionally enable
        // `cosign_required` (the broader gate at the top of the handler).
        if capability == FULL_CAPABILITY {
            // NH-1 close (Bucket 2 re-audit 2026-05-21): the FULL_CAPABILITY
            // grant on the reactivate path is the highest-impact operation
            // a phished owner can be tricked into authorizing in a single
            // transaction. Default-on safety requires the gate to fire
            // REGARDLESS of whether `cosign_session_pubkey` has been
            // configured — otherwise a freshly-initialized vault (with
            // `cosign_session_pubkey == Pubkey::default()`) provides ZERO
            // protection against a single-signature freeze→reactivate
            // phishing attack.
            //
            // Behavior matrix (intentional):
            //   1. `cosign_session_pubkey != Pubkey::default()` AND a
            //      signer in `remaining_accounts` matches → OK.
            //   2. `cosign_session_pubkey == Pubkey::default()` AND any
            //      non-owner signer present in `remaining_accounts` → OK
            //      (defaults-on: a second human approver defeats single-
            //      signature phishing without forcing the owner to
            //      pre-configure a specific cosign key).
            //   3. Either: no matching/non-owner signer present → reject
            //      with `ErrReactivateCosignRequiredForFullCapability`
            //      (6114) so the rejection is distinct from the broader
            //      `cosign_required` flow at the top of the handler.
            //
            // Owners who want STRONG binding (specific key only) configure
            // `cosign_session_pubkey` via `queue_policy_update`. Owners
            // who want the default (any second signer) just need to
            // include a non-owner signer in the reactivate tx.
            let cosign_session_pubkey = ctx.accounts.policy.cosign_session_pubkey;
            let owner_key = ctx.accounts.owner.key();
            let cosign_ok = if cosign_session_pubkey != Pubkey::default() {
                // Bound to a specific pubkey — match exactly.
                ctx.remaining_accounts
                    .iter()
                    .any(|ai| ai.key == &cosign_session_pubkey && ai.is_signer)
            } else {
                // Default policy — any non-owner signer counts.
                crate::instructions::register_agent::has_non_owner_signer(
                    ctx.remaining_accounts,
                    &owner_key,
                )
            };
            require!(
                cosign_ok,
                SigilError::ErrReactivateCosignRequiredForFullCapability
            );
        }

        vault.agents.push(AgentEntry {
            pubkey: agent_key,
            capability,
            consecutive_failures: 0, // TA-17 (Phase 3): fresh counter on reactivation
            _reserved: [0u8; 6],
            spending_limit_usd: 0, // reactivation agent starts with no per-agent limit
            paused: false,
        });
    }

    // 5. Guard against soft-lock: cannot activate with no agents
    require!(!vault.agents.is_empty(), SigilError::NoAgentRegistered);

    // M-9 close (audit 2026-05-21, defense-in-depth): mirror F-11 from
    // set_observe_only.rs:80-84 — an Active vault MUST have at least one
    // populated allowlist (protocols or destinations). Reactivate cannot
    // mutate these allowlists, so this check is bullet-proofing against
    // future code changes that might enable allowlist mutation on the
    // reactivate path (e.g., a follow-up that lets owners trim allowlists
    // during freeze). Today the invariant is preserved by virtue of the
    // freeze handler not touching policy.protocols / policy.allowed_destinations,
    // but enforcement here makes the invariant load-bearing on the path.
    {
        let policy = &ctx.accounts.policy;
        require!(
            !policy.protocols.is_empty() || !policy.allowed_destinations.is_empty(),
            SigilError::ActiveVaultRequiresAllowlist
        );
    }

    // 6. Mutate status only after all checks pass
    vault.status = VaultStatus::Active;

    let clock = Clock::get()?;
    let vault_key = vault.key();

    // Phase 8 §RP Fix-Up B (LBL-03 HIGH, audit 2026-05-19): recompute
    // policy_preview_digest with the new agent_set_hash. `vault.agents`
    // may have been mutated above (when `new_agent.is_some()`); even when
    // no agent was added, recompute unconditionally so the digest is
    // re-bound to the post-reactivate live state. Mirrors
    // `apply_agent_grant.rs:172-196` canonical pattern.
    //
    // Round 2 F-RP3-1 fix (audit 2026-05-19): bump policy_version.
    // Permission posture changes when a new agent is grafted onto the
    // vault during reactivate — bumping the version ensures any in-flight
    // validate_and_authorize fails fast with PolicyVersionMismatch
    // (defense in depth) rather than relying on the slower
    // vault.is_agent constraint.
    {
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
            // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey bound
            // at canonical position 22 — reactivate_vault never mutates
            // it, so pass-through from live policy keeps the re-bind
            // digest matching the queue-time digest.
            cosign_session_pubkey: policy.cosign_session_pubkey,
        });
        policy.policy_preview_digest = new_digest;
        policy.policy_version = policy
            .policy_version
            .checked_add(1)
            .ok_or(error!(SigilError::Overflow))?;
    }

    // Phase 7 — write success audit-log entry AFTER state mutation.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_REACTIVATE,
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

    emit!(VaultReactivated {
        vault: vault_key,
        new_agent,
        new_agent_capability,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
