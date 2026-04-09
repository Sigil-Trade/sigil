use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::CloseConstraintsQueued;
use crate::state::*;

#[derive(Accounts)]
pub struct QueueCloseConstraints<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
        constraint = policy.has_constraints @ SigilError::InvalidConstraintsPda,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Verify constraints PDA exists (proves there's something to close).
    #[account(
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.load()?.bump,
    )]
    pub constraints: AccountLoader<'info, InstructionConstraints>,

    #[account(
        init,
        payer = owner,
        space = PendingCloseConstraints::SIZE,
        seeds = [b"pending_close_constraints", vault.key().as_ref()],
        bump,
    )]
    pub pending_close_constraints: Account<'info, PendingCloseConstraints>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<QueueCloseConstraints>) -> Result<()> {
    crate::reject_cpi!();

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;

    // Verify constraints belongs to this vault (replaces has_one = vault)
    {
        let c = ctx.accounts.constraints.load()?;
        require!(
            c.vault == vault.key().to_bytes(),
            SigilError::InvalidConstraintsPda
        );
    }

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // Timelock must be configured (always true now with MIN_TIMELOCK_DURATION)
    require!(
        policy.timelock_duration > 0,
        SigilError::NoTimelockConfigured
    );

    let clock = Clock::get()?;
    let pending = &mut ctx.accounts.pending_close_constraints;
    pending.vault = vault.key();
    pending.queued_at = clock.unix_timestamp;
    pending.executes_at = clock
        .unix_timestamp
        .checked_add(policy.timelock_duration as i64)
        .ok_or(error!(SigilError::Overflow))?;
    pending.bump = ctx.bumps.pending_close_constraints;

    emit!(CloseConstraintsQueued {
        vault: vault.key(),
        executes_at: pending.executes_at,
    });

    Ok(())
}
