use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::state::*;

/// Phase 8 Batch 4 — Squads V4 multisig ownership-accept.
///
/// **DISABLED in V1 (audit 2026-06-11, finding H-1).**
///
/// Transferring Sigil vault ownership to a Squads V4 multisig is
/// architecturally incompatible with Sigil's top-level-only (`reject_cpi!`)
/// security model. A Squads multisig acts on an external program ONLY by CPI
/// from its `vault_transaction_execute` (the multisig vault PDA signs via
/// `invoke_signed`, at stack height >= 2). But EVERY Sigil owner instruction —
/// including this accept AND the post-transfer owner operations
/// (`withdraw_funds` / `freeze_vault` / `queue_policy_update` / …) — begins
/// with `reject_cpi!()`, which requires top-level execution (stack height == 1).
/// So a Squads-multisig owner could neither complete this accept nor operate
/// the vault afterward.
///
/// The prior implementation was also unsound: its `multisig_pda.owner ==
/// SQUADS_V4_PROGRAM_ID` check was inverted — a Squads vault PDA is
/// System-owned (and so FAILED the check), while unsignable Squads STATE
/// accounts PASSED it. That let an unsignable account be written as
/// `vault.owner`, permanently BRICKING the vault (tier-1 liveness loss).
///
/// V1 therefore disables the path entirely:
///   * `initiate_ownership_transfer` rejects `is_multisig_target = true`
///     (`ErrMultisigCustodyUnsupported`), so no multisig-target pending can be
///     armed; and
///   * this handler rejects unconditionally (defense-in-depth for any pending
///     created before this fix).
///
/// Multisig custody is deferred to a future release with a proper design
/// (CPI-aware owner instructions that verify the Squads caller, or a
/// Sigil-native M-of-N owner model) plus a re-audit. The `#[derive(Accounts)]`
/// struct is retained unchanged so the instruction's IDL account shape is
/// stable; the handler reads no account before rejecting.
#[derive(Accounts)]
pub struct AcceptOwnershipTransferMultisig<'info> {
    /// CHECK: retained for IDL/account-shape stability only. The handler rejects
    /// (multisig custody disabled in V1) before reading any account.
    #[account(mut)]
    pub multisig_pda: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// `has_one = vault` + the close target are retained for IDL stability. The
    /// close never runs because the handler returns `Err` before any Anchor
    /// post-handler step executes.
    #[account(
        mut,
        has_one = vault @ SigilError::ZeroCopyVaultMismatch,
        seeds = [b"pending_owner", vault.key().as_ref()],
        bump = pending.bump,
        close = multisig_pda,
    )]
    pub pending: Account<'info, PendingOwnershipTransfer>,

    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// CHECK: slot_hashes sysvar; address-pinned.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<AcceptOwnershipTransferMultisig>) -> Result<()> {
    crate::reject_cpi!();
    // DISABLED in V1 — see the struct doc above. Squads multisig custody is
    // architecturally incompatible with Sigil's top-level-only model, so this
    // path rejects unconditionally rather than mutating ownership.
    Err(error!(SigilError::ErrMultisigCustodyUnsupported))
}
