use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::AgentRevoked;
use crate::state::*;

#[derive(Accounts)]
pub struct RevokeAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
}

pub fn handler(ctx: Context<RevokeAgent>, agent_to_remove: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        PhalnxError::VaultAlreadyClosed
    );
    require!(
        vault.is_agent(&agent_to_remove),
        PhalnxError::UnauthorizedAgent
    );

    vault.agents.retain(|a| a.pubkey != agent_to_remove);

    // Freeze if no agents remain
    if vault.agents.is_empty() {
        vault.status = VaultStatus::Frozen;
    }

    let clock = Clock::get()?;
    emit!(AgentRevoked {
        vault: vault.key(),
        agent: agent_to_remove,
        remaining_agents: vault.agent_count() as u8,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
