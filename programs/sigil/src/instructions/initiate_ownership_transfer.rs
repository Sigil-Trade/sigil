use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::OwnershipTransferInitiated;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;

/// Phase 8 — C26 ownership transfer (initiate path).
///
/// Owner queues a `PendingOwnershipTransfer` PDA bound to the vault. The
/// transfer requires a mandatory 48h timelock window before
/// `accept_ownership_transfer` (Batch 3) or
/// `accept_ownership_transfer_multisig` (Batch 4) can land. During the
/// window, the owner can `cancel_ownership_transfer` to abort.
///
/// Security gates (in order, with Council ISC labels):
///   * vault.is_active           → reject when frozen / closed   (ISC-130)
///   * new_owner blocklist       → reject sysvar/program/default (ISC-128)
///   * policy.cosign_required    → require non-owner signer      (ISC-129)
///   * pending PDA `init`        → reject double-queue            (ISC-30, 6103)
///
/// Council ISC-144 — event emission is INTERLEAVED with audit-log persistence:
/// we persist the audit entry FIRST (state-of-record), then `emit!` AFTER, so
/// a downstream regression that breaks `emit!` cannot leave the on-chain log
/// stale relative to the event stream.
#[derive(Accounts)]
#[instruction(new_owner: Pubkey, is_multisig_target: bool)]
pub struct InitiateOwnershipTransfer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PolicyConfig is read-only here — `cosign_required` is the only field
    /// consulted (ISC-129 interim cosign gate).
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// PendingOwnershipTransfer PDA. `init` ⇒ ISC-30 / 6103 path: a second
    /// initiate without an intervening `cancel_ownership_transfer` fails
    /// hard because Anchor sees the account is already initialised.
    #[account(
        init,
        payer = owner,
        space = PendingOwnershipTransfer::SIZE,
        seeds = [b"pending_owner", vault.key().as_ref()],
        bump,
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

pub fn handler(
    ctx: Context<InitiateOwnershipTransfer>,
    new_owner: Pubkey,
    is_multisig_target: bool,
) -> Result<()> {
    crate::reject_cpi!();

    // 1. Council ISC-130 — reject when frozen / closed. Status check FIRST
    //    so the operator sees `VaultNotActive` (the diagnostic answer) rather
    //    than `ErrCosignRequired` from the gate below. Read-only borrow.
    require!(
        ctx.accounts.vault.status == VaultStatus::Active,
        SigilError::VaultNotActive,
    );

    // 2. Council ISC-128 — new_owner blocklist. Closes the foot-gun where a
    //    phished owner signs a transfer to a non-signing address that would
    //    permanently brick the vault. The list pins the most-likely confused
    //    pubkeys (default Pubkey, this program's own ID, SystemProgram,
    //    SPL-Token, the clock sysvar). Forward-only — adding to the list is
    //    non-breaking; removing requires audit sign-off.
    require_keys_neq!(
        new_owner,
        Pubkey::default(),
        SigilError::ErrInvalidOwnershipTarget,
    );
    require_keys_neq!(new_owner, crate::ID, SigilError::ErrInvalidOwnershipTarget,);
    require_keys_neq!(
        new_owner,
        anchor_lang::system_program::ID,
        SigilError::ErrInvalidOwnershipTarget,
    );
    require_keys_neq!(
        new_owner,
        anchor_spl::token::ID,
        SigilError::ErrInvalidOwnershipTarget,
    );
    require_keys_neq!(
        new_owner,
        anchor_lang::solana_program::sysvar::clock::id(),
        SigilError::ErrInvalidOwnershipTarget,
    );
    require_keys_neq!(
        new_owner,
        anchor_lang::solana_program::sysvar::slot_hashes::id(),
        SigilError::ErrInvalidOwnershipTarget,
    );
    require_keys_neq!(
        new_owner,
        anchor_lang::solana_program::sysvar::rent::id(),
        SigilError::ErrInvalidOwnershipTarget,
    );

    // 3. Council ISC-129 — interim cosign gate. Mirrors the PEN-CROSS-1 fix
    //    used by `register_agent`, `reactivate_vault`, `unpause_agent`, and
    //    `set_observe_only`: ownership transfer is at least as elevated as
    //    any of those mutations and MUST require a second factor on cosign-
    //    opted-in vaults. Vaults with the default `cosign_required: false`
    //    are unaffected — single-signer flow continues.
    //
    //    A phished owner key + cosign-opted-in vault otherwise lets the
    //    attacker race: initiate → wait 48h → accept(attacker). The cosign
    //    gate ensures the second factor signs the initiate.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_non_owner_signer(
            ctx.remaining_accounts,
            &owner_key,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);

        // Phase 8 §RP Fix-Up B (LBL-02 HIGH, audit 2026-05-19): cosigner cannot
        // be the new_owner. A phished-key cosign workflow where the second
        // signer IS the queued recipient lets the attacker bootstrap the
        // ownership transfer by signing as both "cosigner" and "incoming
        // owner" — defeating the threshold-of-two property the cosign gate
        // exists to provide. Iterate remaining_accounts and reject when any
        // non-owner signer's pubkey equals the new_owner argument.
        //
        // The owner-as-signer slot is filtered explicitly so a legitimate
        // remaining_accounts that contains the owner (defensive belt-and-
        // suspenders pattern) doesn't trigger the check.
        for ai in ctx.remaining_accounts.iter() {
            if ai.is_signer && ai.key() != owner_key {
                require_keys_neq!(*ai.key, new_owner, SigilError::ErrInvalidOwnershipTarget,);
            }
        }
    }

    // 4. Populate PDA. Anchor `init` already zero-initialised the buffer so
    //    `_padding` stays [0u8; 6]. `min_delay_seconds` is the documented
    //    default; an owner-configurable override hook lives in Batch 4+
    //    (and will need the same digest-binding the cosign workflow uses).
    let clock = Clock::get()?;
    let vault_key = ctx.accounts.vault.key();
    let owner_key = ctx.accounts.owner.key();

    {
        let pending = &mut ctx.accounts.pending;
        pending.vault = vault_key;
        pending.current_owner = owner_key;
        pending.new_owner = new_owner;
        pending.queued_at = clock.unix_timestamp;
        pending.min_delay_seconds = PendingOwnershipTransfer::DEFAULT_MIN_DELAY;
        pending.is_multisig_target = is_multisig_target;
        pending.bump = ctx.bumps.pending;
        // CH-1 close (Bucket-3 audit 2026-05-23): capture slot at queue
        // time. Paired with `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN` at the
        // accept_ownership_transfer{,_multisig} handlers to bound the
        // pre-sign + replay window (Drift-April-2026 durable-nonce class).
        // PendingOwnershipTransfer has NO M-5 content digest, so the slot
        // is NOT digest-bound here — defense rests on the 48h timelock
        // (primary) + slot freshness ceiling (supplementary).
        pending.queued_at_slot = clock.slot;
    }

    // 5. Phase 7 — write success audit-log entry BEFORE the `emit!` call so
    //    on-chain state-of-record is durable even if a downstream regression
    //    breaks event emission (ISC-144 ordering). `subject` slot stores
    //    `new_owner` so off-chain monitors get the routing target in the
    //    audit row without a second account fetch.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_OWNERSHIP_INITIATE,
            new_owner,
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

    emit!(OwnershipTransferInitiated {
        vault: vault_key,
        current_owner: owner_key,
        new_owner,
        queued_at: clock.unix_timestamp,
        is_multisig_target,
    });

    Ok(())
}
