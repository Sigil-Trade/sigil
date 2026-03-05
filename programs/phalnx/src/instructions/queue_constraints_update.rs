use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::ConstraintsChangeQueued;
use crate::state::*;

#[derive(Accounts)]
pub struct QueueConstraintsUpdate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        has_one = vault @ PhalnxError::InvalidConstraintsPda,
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.bump,
    )]
    pub constraints: Account<'info, InstructionConstraints>,

    #[account(
        init,
        payer = owner,
        space = PendingConstraintsUpdate::SIZE,
        seeds = [b"pending_constraints", vault.key().as_ref()],
        bump,
    )]
    pub pending_constraints: Account<'info, PendingConstraintsUpdate>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<QueueConstraintsUpdate>, entries: Vec<ConstraintEntry>) -> Result<()> {
    let policy = &ctx.accounts.policy;

    // Timelock must be configured to use queue
    require!(
        policy.timelock_duration > 0,
        PhalnxError::NoTimelockConfigured
    );

    InstructionConstraints::validate_entries(&entries)?;

    let clock = Clock::get()?;
    let executes_at = clock
        .unix_timestamp
        .checked_add(policy.timelock_duration as i64)
        .ok_or(PhalnxError::Overflow)?;

    let pending = &mut ctx.accounts.pending_constraints;
    pending.vault = ctx.accounts.vault.key();
    pending.entries = entries;
    pending.queued_at = clock.unix_timestamp;
    pending.executes_at = executes_at;
    pending.bump = ctx.bumps.pending_constraints;

    emit!(ConstraintsChangeQueued {
        vault: ctx.accounts.vault.key(),
        executes_at,
    });

    Ok(())
}
