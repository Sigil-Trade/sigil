use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::CloseConstraintsCancelled;
use crate::state::*;

#[derive(Accounts)]
pub struct CancelCloseConstraints<'info> {
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
        constraint = pending_close_constraints.vault == vault.key(),
        seeds = [b"pending_close_constraints", vault.key().as_ref()],
        bump = pending_close_constraints.bump,
        close = owner,
    )]
    pub pending_close_constraints: Account<'info, PendingCloseConstraints>,
}

pub fn handler(ctx: Context<CancelCloseConstraints>) -> Result<()> {
    crate::reject_cpi!();

    emit!(CloseConstraintsCancelled {
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}
