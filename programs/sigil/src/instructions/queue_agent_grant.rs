use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentGrantQueued;
use crate::state::pending_agent_grant::compute_pending_agent_grant_digest;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::operator_grant::{classify_operator_grant_tier, effective_operator_grant_delay};

/// Phase 8 PEN-CROSS-1 (Council ISC-58..65) — queue an OPERATOR-class agent grant.
///
/// `register_agent` (Batch 6) hard-rejects `capability == CAPABILITY_OPERATOR`.
/// This handler is the ONLY path by which a vault gains a new OPERATOR-class
/// agent, and it requires:
///   (1) `capability >= CAPABILITY_OPERATOR` (mirror image of register_agent reject)
///   (2) `policy.cosign_required == true` → non-owner signer in remaining_accounts
///   (3) `pending_agent_grant` PDA does NOT already exist (Anchor `init` enforced)
///   (4) `agent` not already a registered agent on the vault
///   (5) `vault.status != Closed` and `vault.agent_count() < MAX_AGENTS_PER_VAULT`
///
/// On success: PendingAgentGrant PDA written + audit-log entry (disc=17) +
/// `AgentGrantQueued` event. The agent is NOT yet inserted into `vault.agents`
/// — that happens at `apply_agent_grant` after the timelock elapses.
///
/// Cosign mechanism mirrors `register_agent` Phase 8 interim gate: scan
/// `remaining_accounts` for any non-owner signer. Same predicate
/// (`has_non_owner_signer`) used by `register_agent`, `set_observe_only`,
/// `initiate_ownership_transfer`. Single-signer flow continues for vaults
/// with the default `cosign_required: false`.
#[derive(Accounts)]
pub struct QueueAgentGrant<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PolicyConfig is read-only here — only `cosign_required` is consulted.
    /// PDA seeds derivation [b"policy", vault.key()] is the load-bearing
    /// vault binding; cosmetic `has_one = vault` is unnecessary (§RP-1 V6).
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// PendingAgentGrant PDA. `init` ⇒ duplicate-queue rejects via Anchor's
    /// "account already in use" path (mirrors PendingOwnershipTransfer's
    /// double-init guard).
    #[account(
        init,
        payer = owner,
        space = PendingAgentGrant::SIZE,
        seeds = [b"pending_agent_grant", vault.key().as_ref()],
        bump,
    )]
    pub pending: Account<'info, PendingAgentGrant>,

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

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<QueueAgentGrant>,
    agent: Pubkey,
    capability: u8,
    spending_limit_usd: u64,
) -> Result<()> {
    crate::reject_cpi!();

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;

    // 1. Vault status — reject anything other than Active (Phase 8 §RP
    //    Fix-Up B / LBL-06 HIGH, audit 2026-05-19). The prior `!= Closed`
    //    check admitted a Frozen vault here, letting a phished owner key
    //    queue an OPERATOR-class grant on a frozen vault that would land
    //    once the vault is reactivated (timelock independent of the
    //    freeze→reactivate cooldown). Tightening to `== Active` closes
    //    the bypass while still allowing the legitimate flow:
    //    Active → queue → apply. Owners who want to grant agents on a
    //    frozen vault must reactivate first; the 5-min reactivate
    //    cooldown (C28 / F-RP3-1) gives them an observation window.
    require!(
        vault.status == VaultStatus::Active,
        SigilError::VaultNotActive
    );

    // 2. Capability validation — this handler is the QUEUE path for
    // OPERATOR-class grants. Reject:
    //   - reserved values (3..=255) — same TA-04 contract as register_agent
    //   - non-OPERATOR (0 = Disabled, 1 = Observer) — those go through the
    //     fast `register_agent` path
    require!(capability <= FULL_CAPABILITY, SigilError::InvalidCapability);
    require!(
        capability >= CAPABILITY_OPERATOR,
        SigilError::InvalidPermissions
    );

    // 3. Agent invariants — mirror register_agent's reject checks so we
    // reject early at queue rather than after timelock elapses.
    require!(agent != Pubkey::default(), SigilError::InvalidAgentKey);
    require!(agent != vault.owner, SigilError::AgentIsOwner);
    require!(!vault.is_agent(&agent), SigilError::AgentAlreadyRegistered);
    require!(
        vault.agent_count() < MAX_AGENTS_PER_VAULT,
        SigilError::MaxAgentsReached
    );

    // 4. Cosign gate (Phase 8 PEN-CROSS-1 interim) — mirrors register_agent's
    // cosign check. The whole POINT of the queue path is that elevated grants
    // require timelock + cosign on cosign-opted-in vaults; without the cosign
    // gate here, a phished owner key could queue then wait the timelock and
    // apply the OPERATOR grant unilaterally.
    if policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_non_owner_signer(
            ctx.remaining_accounts,
            &owner_key,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    // 4.5. F-Q6 (2026-06-02) — owner_type validity (ISC-33 / Council C-2) +
    // tier-derived effective delay (H-1). Computed at QUEUE time and stored in
    // `pending.min_delay_seconds`; `apply_agent_grant` reads ONLY the pending
    // value (never live policy), so a post-queue policy change cannot shorten
    // an in-flight grant's timelock.
    require!(
        vault.owner_type <= OWNER_TYPE_MULTISIG,
        SigilError::InvalidOwnerType
    );
    let effective_delay = effective_operator_grant_delay(
        classify_operator_grant_tier(
            vault.owner_type,
            policy.cosign_required,
            &policy.cosign_session_pubkey,
        ),
        policy.operator_grant_delay_seconds,
    );

    // 5. Populate pending PDA.
    //
    // F-Q6 (2026-06-02): `min_delay_seconds` is the TIER-DERIVED effective
    // delay, replacing the prior hard `DEFAULT_MIN_DELAY` (48h). Single-key
    // vaults are floored at `SINGLE_KEY_OPERATOR_DELAY_FLOOR` (10 min — the
    // missing 2nd factor); cosign/multisig use the owner-configured
    // `operator_grant_delay_seconds` (default 0). The value is bounded to
    // `MAX_OPERATOR_GRANT_DELAY` at the `queue_policy_update` write site, so
    // the `as i64` casts below cannot overflow.
    let clock = Clock::get()?;
    let vault_key = vault.key();
    {
        let pending = &mut ctx.accounts.pending;
        pending.vault = vault_key;
        pending.agent = agent;
        pending.capability = capability;
        pending.spending_limit_usd = spending_limit_usd;
        pending.queued_at = clock.unix_timestamp;
        pending.min_delay_seconds = effective_delay;
        pending.bump = ctx.bumps.pending;
        // CH-1 close (Bucket-3 audit 2026-05-23): capture slot at queue
        // time alongside `queued_at` unix-timestamp. Paired with
        // `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN` at apply to bound the
        // pre-sign + replay window (Drift-April-2026 durable-nonce class).
        // MUST be set BEFORE the digest recompute below so the digest
        // binds the slot — a tampered slot then fails the apply-time
        // recompute with `ErrPendingAgentGrantDigestMismatch`.
        pending.queued_at_slot = clock.slot;

        // M-5 close (Bucket 2, Phase 10 PEN-CROSS-3): bind the pending
        // content digest AFTER all content fields are populated. The
        // canonical encoding covers (vault, agent, capability,
        // spending_limit_usd, queued_at, min_delay_seconds, queued_at_slot)
        // — the full owner-attested grant tuple. Any later mutation
        // (including a discriminator-collision overwrite that flips
        // `agent` to an attacker pubkey or raises `capability` to
        // FULL_CAPABILITY) will diverge the apply-time recompute and
        // reject. The canonical encoder does NOT include
        // `pending_content_digest` itself, so the prior value of that
        // field is irrelevant to the digest input — and Anchor's `init`
        // zero-initializes the entire account data slab before this
        // handler runs, so `pending_content_digest` is already [0u8; 32]
        // here.
        // CH-1 close (Bucket-3 audit 2026-05-23): canonical encoder now
        // covers `queued_at_slot` (position 7); set above before this
        // line so the digest binds the new field.
        pending.pending_content_digest = compute_pending_agent_grant_digest(pending);
    }

    // 6. Phase 7 — audit-log entry BEFORE `emit!` (ISC-144 ordering). Subject
    // = agent pubkey so off-chain monitors can correlate the queued grant
    // with downstream `apply_agent_grant` (disc=18) entries.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_AGENT_GRANT_QUEUE,
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

    // F-Q6 (2026-06-02): emit the EFFECTIVE (tier-derived) timelock window in
    // the event payload so off-chain monitors surface the correct "executes
    // at" countdown. `effective_delay` is bounded to MAX_OPERATOR_GRANT_DELAY
    // (48h) so the i64 cast + checked_add cannot overflow in practice; the
    // checked_add is retained as defense-in-depth.
    let executes_at = clock
        .unix_timestamp
        .checked_add(effective_delay as i64)
        .ok_or(error!(SigilError::Overflow))?;

    emit!(AgentGrantQueued {
        vault: vault_key,
        agent,
        capability,
        spending_limit_usd,
        queued_at: clock.unix_timestamp,
        executes_at,
    });

    Ok(())
}
