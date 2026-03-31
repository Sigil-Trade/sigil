use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::InstructionConstraintsUpdated;
use crate::state::*;

#[derive(Accounts)]
pub struct UpdateInstructionConstraints<'info> {
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
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        mut,
        has_one = vault @ SigilError::InvalidConstraintsPda,
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.bump,
    )]
    pub constraints: Account<'info, InstructionConstraints>,
}

pub fn handler(
    ctx: Context<UpdateInstructionConstraints>,
    entries: Vec<ConstraintEntry>,
    strict_mode: bool,
) -> Result<()> {
    // Timelock guard: direct updates only allowed without timelock.
    // For timelocked vaults, use queue_constraints_update / apply_constraints_update.
    require!(
        ctx.accounts.policy.timelock_duration == 0,
        SigilError::TimelockActive
    );

    InstructionConstraints::validate_entries(&entries)?;

    let constraints = &mut ctx.accounts.constraints;
    constraints.entries = entries;
    constraints.strict_mode = strict_mode;

    emit!(InstructionConstraintsUpdated {
        vault: ctx.accounts.vault.key(),
        entries_count: constraints.entries.len() as u8,
        strict_mode,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
