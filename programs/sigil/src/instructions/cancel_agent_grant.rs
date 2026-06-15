use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentGrantCancelled;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;

/// Phase 8 §RP Fix-Up B (PEN-02b CRITICAL, audit 2026-05-19) — cancel a queued
/// OPERATOR-class agent grant during the timelock window.
///
/// Symmetric with `cancel_ownership_transfer` (the corresponding queue/cancel/
/// apply trio for ownership transfer). The owner aborts an in-flight
/// `PendingAgentGrant` PDA; rent returns to the owner. The vault's
/// `agents` Vec is NOT mutated — this is the "discard pending" path. The
/// agent that was queued never enters the vault.
///
/// ## Why this ix is mandatory
///
/// Without `cancel_agent_grant`, a phished owner key can:
///   1. Queue an OPERATOR-class grant via `queue_agent_grant(attacker, OPERATOR)`.
///   2. Wait the tier-derived effective delay stored in
///      `PendingAgentGrant.min_delay_seconds` (>=600s for a single-key vault,
///      else the configured `operator_grant_delay_seconds`; F-Q6).
///   3. Apply via `apply_agent_grant`, installing OPERATOR on the attacker.
///
/// That delay window exists so the owner can detect the queue (off-chain
/// monitor alerts on `AgentGrantQueued`) and react. The ONLY recovery
/// action is this cancel — without it, the owner's recourse is
/// `freeze_vault` (which is heavier-handed: it freezes all agent
/// activity, not just the pending grant).
///
/// ## Cosign symmetry
///
/// Same as `cancel_ownership_transfer` (D4 decision): when
/// `policy.cosign_required == true`, the cancel ALSO requires a non-owner
/// cosigner in `remaining_accounts`. Rationale: a phished owner key could
/// otherwise CANCEL a legitimate owner-initiated grant (e.g., a planned
/// hardware-wallet-cosigned operator install) and then re-queue to an
/// attacker target. Symmetric cosign closes that bypass.
///
/// ## Account binding
///
/// `has_one = owner` binds the signer to `vault.owner` (the current owner
/// at handler entry). The vault's PDA seed uses `vault.vault_authority`
/// (immutable per LBL-01) so the seed binding survives owner mutation;
/// `has_one` is the load-bearing authority check. The PendingAgentGrant
/// PDA's `has_one = vault` binds it explicitly to this vault.
#[derive(Accounts)]
pub struct CancelAgentGrant<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PolicyConfig is read-only here — only `cosign_required` is consulted
    /// (D4 symmetric cosign gate). PDA seeds derivation is the load-bearing
    /// vault binding; cosmetic `has_one = vault` is unnecessary (§RP-1 V6).
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// PendingAgentGrant PDA. `close = owner` returns rent to the signer.
    /// `has_one = vault` binds the PDA to this vault explicitly (the seed
    /// derivation already enforces this via `vault.key()`, but the constraint
    /// is defense-in-depth against future seeds drift — same pattern as the
    /// §RP-1 I-2 audit-log guard).
    #[account(
        mut,
        has_one = vault @ SigilError::ZeroCopyVaultMismatch,
        seeds = [b"pending_agent_grant", vault.key().as_ref()],
        bump = pending.bump,
        close = owner,
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

pub fn handler(ctx: Context<CancelAgentGrant>) -> Result<()> {
    crate::reject_cpi!();

    // D4 symmetric cosign gate (Phase 8 §RP Fix-Up B / PEN-02b). Mirrors
    // `cancel_ownership_transfer.rs:98-105`: on cosign-opted-in vaults, the
    // cancel ALSO requires a non-owner signer. A phished owner without the
    // cosigner cannot abort a legitimate grant — closing the cancel-and-
    // re-queue bypass. Single-signer flow continues for vaults with the
    // default `cosign_required: false`.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_bound_cosigner(
            ctx.remaining_accounts,
            &owner_key,
            &ctx.accounts.policy.cosign_session_pubkey,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    let clock = Clock::get()?;
    let vault_key = ctx.accounts.vault.key();
    let owner_key = ctx.accounts.owner.key();
    // Snapshot the queued agent BEFORE the pending PDA closes (close = owner
    // triggers on handler return, but the borrow rules forbid touching
    // `ctx.accounts.pending.agent` after the audit-log block below).
    let cancelled_agent = ctx.accounts.pending.agent;

    // Phase 7 — audit-log entry BEFORE `emit!` (ISC-144 ordering). Subject
    // = cancelled agent pubkey so off-chain monitors can correlate the
    // queue (disc=17) ↔ cancel (disc=19) pair by subject pubkey across the
    // ring buffer. Same pattern as `cancel_ownership_transfer` writing the
    // cancelled new_owner at disc=9.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_AGENT_GRANT_CANCEL,
            cancelled_agent,
            0,
            0,
            clock.unix_timestamp,
            &ctx.accounts.slot_hashes_sysvar.to_account_info(),
        )?;
        let mut log = ctx.accounts.audit_log_success.load_mut()?;
        // §RP-1 I-2: defense-in-depth guard against future seeds drift.
        require_keys_eq!(log.vault, vault_key, SigilError::ZeroCopyVaultMismatch,);
        log.append(entry);
    }

    emit!(AgentGrantCancelled {
        vault: vault_key,
        owner: owner_key,
        cancelled_agent,
        timestamp: clock.unix_timestamp,
    });

    // Anchor `close = owner` handles the actual closing + rent reclamation
    // when the handler returns Ok(()). No vault.agents mutation occurs —
    // the agent never entered the vault.
    Ok(())
}
