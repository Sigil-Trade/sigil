use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::InstructionConstraintsCreated;
use crate::state::*;

#[derive(Accounts)]
pub struct CreateInstructionConstraints<'info> {
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
        init,
        payer = owner,
        space = InstructionConstraints::SIZE,
        seeds = [b"constraints", vault.key().as_ref()],
        bump,
    )]
    pub constraints: Account<'info, InstructionConstraints>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateInstructionConstraints>,
    entries: Vec<ConstraintEntry>,
) -> Result<()> {
    InstructionConstraints::validate_entries(&entries)?;

    let constraints = &mut ctx.accounts.constraints;
    constraints.vault = ctx.accounts.vault.key();
    constraints.entries = entries;
    constraints.bump = ctx.bumps.constraints;

    // Set has_constraints flag on policy
    ctx.accounts.policy.has_constraints = true;

    emit!(InstructionConstraintsCreated {
        vault: ctx.accounts.vault.key(),
        entries_count: constraints.entries.len() as u8,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
