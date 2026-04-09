use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentUnpausedEvent;
use crate::state::*;

#[derive(Accounts)]
pub struct UnpauseAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
}

pub fn handler(ctx: Context<UnpauseAgent>, agent_to_unpause: Pubkey) -> Result<()> {
    crate::reject_cpi!();

    let vault = &mut ctx.accounts.vault;

    // Works on Active or Frozen vaults (not Closed)
    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // Find the agent entry
    let agent_entry = vault
        .agents
        .iter_mut()
        .find(|a| a.pubkey == agent_to_unpause)
        .ok_or(error!(SigilError::UnauthorizedAgent))?;

    // Must be paused
    require!(agent_entry.paused, SigilError::AgentNotPaused);

    agent_entry.paused = false;

    let clock = Clock::get()?;
    emit!(AgentUnpausedEvent {
        vault: vault.key(),
        agent: agent_to_unpause,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
