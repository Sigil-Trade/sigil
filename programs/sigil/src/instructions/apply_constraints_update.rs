use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::ConstraintsChangeApplied;
use crate::state::*;

#[derive(Accounts)]
pub struct ApplyConstraintsUpdate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PolicyConfig — needed to bump policy_version on constraint changes.
    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        mut,
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.load()?.bump,
    )]
    pub constraints: AccountLoader<'info, InstructionConstraints>,

    #[account(
        mut,
        seeds = [b"pending_constraints", vault.key().as_ref()],
        bump = pending_constraints.load()?.bump,
        close = owner,
    )]
    pub pending_constraints: AccountLoader<'info, PendingConstraintsUpdate>,
}

pub fn handler(ctx: Context<ApplyConstraintsUpdate>) -> Result<()> {
    crate::reject_cpi!();

    let clock = Clock::get()?;
    let vault_key = ctx.accounts.vault.key();

    // Read pending: verify vault + timelock, extract scalar fields
    let (new_entry_count, new_strict_mode) = {
        let pending = ctx.accounts.pending_constraints.load()?;
        require!(
            pending.vault == vault_key.to_bytes(),
            SigilError::InvalidPendingConstraintsPda
        );
        require!(
            pending.is_ready(clock.unix_timestamp),
            SigilError::TimelockNotExpired
        );
        (pending.entry_count, pending.strict_mode)
    };

    // Direct raw byte copy between account data buffers to avoid 35KB stack allocation.
    // Both accounts are zero-copy with identical entries layout at the same offset.
    // entries starts at byte offset 8 (disc) + 32 (vault) = 40 in both structs.
    //
    // NOTE: No re-validation of entries here. Entries were validated during queue_constraints_update.
    // If a program upgrade changes validation rules between queue and apply, previously-queued
    // entries are applied unchanged. This is a known tradeoff in timelocked update systems —
    // the alternative (re-validation on apply) would add ~50K CU and could reject entries that
    // were valid when the owner queued them, breaking the timelock contract.
    {
        let pending_info = ctx.accounts.pending_constraints.to_account_info();
        let constraints_info = ctx.accounts.constraints.to_account_info();
        let pending_data = pending_info.try_borrow_data()?;
        let mut constraints_data = constraints_info.try_borrow_mut_data()?;

        let entries_offset = 8 + 32; // discriminator + vault
        let entries_size = core::mem::size_of::<constraints::ConstraintEntryZC>()
            * constraints::MAX_CONSTRAINT_ENTRIES;

        constraints_data[entries_offset..entries_offset + entries_size]
            .copy_from_slice(&pending_data[entries_offset..entries_offset + entries_size]);
    }

    // Set scalar fields via load_mut
    {
        let mut constraints = ctx.accounts.constraints.load_mut()?;
        require!(
            constraints.vault == vault_key.to_bytes(),
            SigilError::InvalidConstraintsPda
        );
        constraints.entry_count = new_entry_count;
        constraints.strict_mode = new_strict_mode;
    }

    // Bump policy version — constraint changes affect security posture
    let policy = &mut ctx.accounts.policy;
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    // Collect discriminator formats from the freshly-applied entries for the event.
    // Read from constraints (not pending — pending is closed by Anchor after this handler).
    let discriminator_formats = {
        let constraints = ctx.accounts.constraints.load()?;
        let count = constraints.entry_count as usize;
        (0..count)
            .map(|i| constraints.entries[i].discriminator_format)
            .collect::<Vec<u8>>()
    };

    emit!(ConstraintsChangeApplied {
        vault: vault_key,
        discriminator_formats,
        applied_at: clock.unix_timestamp,
    });

    Ok(())
}
