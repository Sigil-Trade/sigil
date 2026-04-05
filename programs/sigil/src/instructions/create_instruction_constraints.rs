use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::InstructionConstraintsCreated;
use crate::state::constraints::pack_entries;
use crate::state::*;

#[derive(Accounts)]
pub struct CreateInstructionConstraints<'info> {
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
    pub constraints: AccountLoader<'info, InstructionConstraints>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateInstructionConstraints>,
    entries: Vec<ConstraintEntry>,
    strict_mode: bool,
) -> Result<()> {
    InstructionConstraints::validate_entries(&entries)?;

    let entry_count = entries.len() as u8;

    {
        let mut constraints = ctx.accounts.constraints.load_init()?;
        constraints.vault = ctx.accounts.vault.key().to_bytes();
        constraints.strict_mode = strict_mode as u8;
        constraints.bump = ctx.bumps.constraints;

        let mut count = 0u8;
        pack_entries(&entries, &mut constraints.entries, &mut count)?;
        constraints.entry_count = count;
    }

    // Set has_constraints flag on policy (borrow dropped above)
    ctx.accounts.policy.has_constraints = true;

    emit!(InstructionConstraintsCreated {
        vault: ctx.accounts.vault.key(),
        entries_count: entry_count,
        strict_mode,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
