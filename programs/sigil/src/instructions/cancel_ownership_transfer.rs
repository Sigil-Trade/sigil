use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::OwnershipTransferCancelled;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;

/// Phase 8 — C26 ownership transfer (cancel path).
///
/// The current owner aborts an in-flight `PendingOwnershipTransfer`. Rent
/// returns to the current owner (the signer). The vault's owner field is
/// NOT mutated; this is the "discard pending" path.
///
/// D4 — symmetric with `initiate_ownership_transfer` on cosign: if the
/// vault has `policy.cosign_required == true`, cancel also requires a
/// non-owner signer in `remaining_accounts`. Rationale: a phished owner key
/// could otherwise CANCEL a legitimate owner-initiated transfer to a
/// hardware-wallet upgrade target, then re-initiate to an attacker target.
/// Symmetric cosign closes that bypass.
///
/// Note on `has_one = owner` semantics: the vault constraint binds the
/// signer to `vault.owner` (the CURRENT owner at handler entry — which
/// must match `pending.current_owner` after initiate). A defense-in-depth
/// `require_keys_eq!(current_owner.key(), pending.current_owner, ...)`
/// adds a second binding so a stale pending PDA from a prior ownership
/// chain cannot be cancelled by the freshly-installed owner (that vault
/// would have closed the pending atomically in `accept_ownership_transfer`,
/// but defense in depth).
#[derive(Accounts)]
pub struct CancelOwnershipTransfer<'info> {
    #[account(mut)]
    pub current_owner: Signer<'info>,

    /// Vault binding via PDA seeds (Phase 8 LBL-01): the seeds use
    /// `vault.vault_authority` (immutable, set at init), NOT the signer key.
    /// The handler-level `require_keys_eq!(current_owner.key(),
    /// pending.current_owner)` below is now the LOAD-BEARING signer-binding
    /// check (pre-LBL-01 the seed derivation incidentally enforced this when
    /// the seed-key was `current_owner.key()`).
    #[account(
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PolicyConfig is read-only here — `cosign_required` is the only field
    /// consulted (D4 symmetric cosign gate).
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// PendingOwnershipTransfer PDA. `close = current_owner` returns rent to
    /// the signer. `has_one = vault` defense-in-depth binds the PDA to this
    /// vault explicitly.
    #[account(
        mut,
        has_one = vault @ SigilError::ZeroCopyVaultMismatch,
        seeds = [b"pending_owner", vault.key().as_ref()],
        bump = pending.bump,
        close = current_owner,
    )]
    pub pending: Account<'info, PendingOwnershipTransfer>,

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

pub fn handler(ctx: Context<CancelOwnershipTransfer>) -> Result<()> {
    crate::reject_cpi!();

    // Phase 8 §RP Fix-Up B (PEN-04 HIGH, audit 2026-05-19): require the
    // vault to be Active. A frozen vault MUST NOT permit cancel because
    // freeze should NOT be a vehicle to abort a legitimate ownership
    // transfer queued by the owner — `freeze_vault` (Fix-Up B SFH-02) is
    // the canonical cancel path on freeze. Allowing cancel from Frozen
    // would let a phished owner key freeze the vault and use the freeze
    // window to cancel a legitimate transfer (e.g., to a hardware wallet
    // the owner is migrating to), then re-queue to an attacker target
    // once reactivated. Mirrors the `queue_agent_grant` / `apply_agent_grant`
    // tightening (LBL-06).
    require!(
        ctx.accounts.vault.status == VaultStatus::Active,
        SigilError::VaultNotActive,
    );

    // Defense-in-depth: bind the signer to the queued owner at queue time.
    // `has_one = current_owner` (via the field naming workaround below)
    // binds to vault.owner, which MUST equal pending.current_owner unless
    // the vault has changed owner mid-flight (impossible inside this batch
    // — only `accept_ownership_transfer` mutates `vault.owner`, and it
    // closes the pending PDA atomically).
    require_keys_eq!(
        ctx.accounts.current_owner.key(),
        ctx.accounts.pending.current_owner,
        SigilError::UnauthorizedOwner,
    );

    // D4 — symmetric cosign gate. Same predicate as the initiate side so a
    // phished owner cannot cancel a legitimate transfer.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.current_owner.key();
        let has_cosigner = crate::instructions::register_agent::has_non_owner_signer(
            ctx.remaining_accounts,
            &owner_key,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    let clock = Clock::get()?;
    let vault_key = ctx.accounts.vault.key();
    let current_owner_key = ctx.accounts.current_owner.key();
    let cancelled_new_owner = ctx.accounts.pending.new_owner;

    // Phase 7 — audit-log entry BEFORE `emit!` (ISC-144 ordering). `subject`
    // slot stores the CANCELLED new_owner so off-chain monitors can correlate
    // initiate ↔ cancel by subject pubkey across the disc=7/disc=9 pair.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_OWNERSHIP_CANCEL,
            cancelled_new_owner,
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

    emit!(OwnershipTransferCancelled {
        vault: vault_key,
        current_owner: current_owner_key,
        cancelled_new_owner,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
