use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::AgentRegistered;
use crate::state::*;

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
}

pub fn handler(ctx: Context<RegisterAgent>, agent: Pubkey, permissions: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        PhalnxError::VaultAlreadyClosed
    );
    require!(
        permissions & !FULL_PERMISSIONS == 0,
        PhalnxError::InvalidPermissions
    );
    require!(!vault.is_agent(&agent), PhalnxError::AgentAlreadyRegistered);
    require!(
        vault.agent_count() < MAX_AGENTS_PER_VAULT,
        PhalnxError::MaxAgentsReached
    );
    require!(agent != Pubkey::default(), PhalnxError::InvalidAgentKey);
    require!(agent != vault.owner, PhalnxError::AgentIsOwner);

    vault.agents.push(AgentEntry {
        pubkey: agent,
        permissions,
    });

    let clock = Clock::get()?;
    emit!(AgentRegistered {
        vault: vault.key(),
        agent,
        permissions,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
