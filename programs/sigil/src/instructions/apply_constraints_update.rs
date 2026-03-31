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

    #[account(
        mut,
        has_one = vault @ SigilError::InvalidConstraintsPda,
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.bump,
    )]
    pub constraints: Account<'info, InstructionConstraints>,

    #[account(
        mut,
        has_one = vault @ SigilError::InvalidPendingConstraintsPda,
        seeds = [b"pending_constraints", vault.key().as_ref()],
        bump = pending_constraints.bump,
        close = owner,
    )]
    pub pending_constraints: Account<'info, PendingConstraintsUpdate>,
}

pub fn handler(ctx: Context<ApplyConstraintsUpdate>) -> Result<()> {
    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending_constraints;

    // Timelock must have expired
    require!(
        pending.is_ready(clock.unix_timestamp),
        SigilError::TimelockNotExpired
    );

    // Overwrite constraint entries and strict_mode
    let constraints = &mut ctx.accounts.constraints;
    constraints.entries = pending.entries.clone();
    constraints.strict_mode = pending.strict_mode;

    emit!(ConstraintsChangeApplied {
        vault: ctx.accounts.vault.key(),
        applied_at: clock.unix_timestamp,
    });

    Ok(())
}
