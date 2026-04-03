use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentPermissionsChangeCancelled;
use crate::state::*;

#[derive(Accounts)]
pub struct CancelAgentPermissionsUpdate<'info> {
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
        constraint = pending_agent_perms.vault == vault.key(),
        seeds = [
            b"pending_agent_perms",
            vault.key().as_ref(),
            pending_agent_perms.agent.as_ref(),
        ],
        bump = pending_agent_perms.bump,
        close = owner,
    )]
    pub pending_agent_perms: Account<'info, PendingAgentPermissionsUpdate>,
}

pub fn handler(ctx: Context<CancelAgentPermissionsUpdate>) -> Result<()> {
    emit!(AgentPermissionsChangeCancelled {
        vault: ctx.accounts.vault.key(),
        agent: ctx.accounts.pending_agent_perms.agent,
    });

    Ok(())
}
