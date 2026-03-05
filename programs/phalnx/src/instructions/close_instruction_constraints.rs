use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::InstructionConstraintsClosed;
use crate::state::*;

#[derive(Accounts)]
pub struct CloseInstructionConstraints<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.bump,
        close = owner,
    )]
    pub constraints: Account<'info, InstructionConstraints>,
}

pub fn handler(ctx: Context<CloseInstructionConstraints>) -> Result<()> {
    // Removing constraints loosens security — require no timelock (instant changes only)
    require!(
        ctx.accounts.policy.timelock_duration == 0,
        PhalnxError::TimelockActive
    );

    // Clear the has_constraints flag so validate_and_authorize skips constraint checks
    ctx.accounts.policy.has_constraints = false;

    emit!(InstructionConstraintsClosed {
        vault: ctx.accounts.vault.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
