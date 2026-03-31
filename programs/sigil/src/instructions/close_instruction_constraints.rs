use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::InstructionConstraintsClosed;
use crate::state::*;

#[derive(Accounts)]
pub struct CloseInstructionConstraints<'info> {
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
        SigilError::TimelockActive
    );

    // Clear the has_constraints flag so validate_and_authorize skips constraint checks
    ctx.accounts.policy.has_constraints = false;

    emit!(InstructionConstraintsClosed {
        vault: ctx.accounts.vault.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    // If caller provides PendingConstraintsUpdate in remaining_accounts, close it too
    if let Some(pending_info) = ctx.remaining_accounts.first() {
        // Verify it's the correct PDA
        let (expected_pda, _) = Pubkey::find_program_address(
            &[b"pending_constraints", ctx.accounts.vault.key().as_ref()],
            ctx.program_id,
        );
        if pending_info.key() == expected_pda && pending_info.lamports() > 0 {
            // Transfer lamports to owner (close the account)
            let owner_info = ctx.accounts.owner.to_account_info();
            let dest_lamports = owner_info.lamports();
            **owner_info.try_borrow_mut_lamports()? = dest_lamports
                .checked_add(pending_info.lamports())
                .ok_or(error!(SigilError::Overflow))?;
            **pending_info.try_borrow_mut_lamports()? = 0;
            // Zero the data to mark account as closed
            pending_info.assign(&anchor_lang::system_program::ID);
            pending_info.resize(0)?;
        }
    }

    Ok(())
}
