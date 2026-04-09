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
        seeds = [b"pending_constraints", vault.key().as_ref()],
        bump = pending_constraints.load()?.bump,
        close = owner,
    )]
    pub pending_constraints: AccountLoader<'info, PendingConstraintsUpdate>,
}

pub fn handler(ctx: Context<CancelConstraintsUpdate>) -> Result<()> {
    crate::reject_cpi!();

    // Verify vault matches (replaces has_one = vault)
    {
        let pending = ctx.accounts.pending_constraints.load()?;
        require!(
            pending.vault == ctx.accounts.vault.key().to_bytes(),
            SigilError::InvalidPendingConstraintsPda
        );
    }

    emit!(ConstraintsChangeCancelled {
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}
