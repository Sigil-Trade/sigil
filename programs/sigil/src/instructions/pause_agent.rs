use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentPausedEvent;
use crate::state::*;

#[derive(Accounts)]
pub struct PauseAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
}

pub fn handler(ctx: Context<PauseAgent>, agent_to_pause: Pubkey) -> Result<()> {
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
        .find(|a| a.pubkey == agent_to_pause)
        .ok_or(error!(SigilError::UnauthorizedAgent))?;

    // Must not already be paused
    require!(!agent_entry.paused, SigilError::AgentAlreadyPaused);

    agent_entry.paused = true;

    let clock = Clock::get()?;
    emit!(AgentPausedEvent {
        vault: vault.key(),
        agent: agent_to_pause,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
