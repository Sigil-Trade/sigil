use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::ConstraintsChangeCancelled;
use crate::state::*;

#[derive(Accounts)]
pub struct CancelConstraintsUpdate<'info> {
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
        has_one = vault @ SigilError::InvalidPendingConstraintsPda,
        seeds = [b"pending_constraints", vault.key().as_ref()],
        bump = pending_constraints.bump,
        close = owner,
    )]
    pub pending_constraints: Account<'info, PendingConstraintsUpdate>,
}

pub fn handler(ctx: Context<CancelConstraintsUpdate>) -> Result<()> {
    emit!(ConstraintsChangeCancelled {
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}
