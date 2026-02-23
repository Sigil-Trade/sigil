use anchor_lang::prelude::*;

use crate::errors::AgentShieldError;
use crate::events::VaultReactivated;
use crate::state::*;

#[derive(Accounts)]
pub struct ReactivateVault<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ AgentShieldError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
}

pub fn handler(ctx: Context<ReactivateVault>, new_agent: Option<Pubkey>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    // 1. Check frozen
    require!(
        vault.status == VaultStatus::Frozen,
        AgentShieldError::VaultNotFrozen
    );

    // 2. Optionally assign new agent
    if let Some(agent_key) = new_agent {
        require!(
            agent_key != Pubkey::default(),
            AgentShieldError::InvalidAgentKey
        );
        require!(agent_key != vault.owner, AgentShieldError::AgentIsOwner);
        vault.agent = agent_key;
    }

    // 3. Guard against soft-lock: cannot activate with no usable agent
    require!(
        vault.agent != Pubkey::default(),
        AgentShieldError::NoAgentRegistered
    );

    // 4. Mutate status only after all checks pass
    vault.status = VaultStatus::Active;

    let clock = Clock::get()?;
    emit!(VaultReactivated {
        vault: vault.key(),
        new_agent,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
