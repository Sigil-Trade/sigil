use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::PolicyChangeCancelled;
use crate::state::*;

#[derive(Accounts)]
pub struct CancelPendingPolicy<'info> {
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
        seeds = [b"pending_policy", vault.key().as_ref()],
        bump = pending_policy.bump,
        close = owner,
    )]
    pub pending_policy: Account<'info, PendingPolicyUpdate>,
}

pub fn handler(ctx: Context<CancelPendingPolicy>) -> Result<()> {
    emit!(PolicyChangeCancelled {
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}
