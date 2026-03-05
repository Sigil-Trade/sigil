use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::VaultReactivated;
use crate::state::*;

#[derive(Accounts)]
pub struct ReactivateVault<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
}

pub fn handler(
    ctx: Context<ReactivateVault>,
    new_agent: Option<Pubkey>,
    new_agent_permissions: Option<u64>,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    // 1. Check frozen
    require!(
        vault.status == VaultStatus::Frozen,
        PhalnxError::VaultNotFrozen
    );

    // 2. Validate mutual presence of new_agent and new_agent_permissions
    require!(
        new_agent.is_some() == new_agent_permissions.is_some(),
        PhalnxError::InvalidPermissions
    );

    // 3. Optionally assign new agent
    if let Some(agent_key) = new_agent {
        let permissions = new_agent_permissions.unwrap();
        require!(agent_key != Pubkey::default(), PhalnxError::InvalidAgentKey);
        require!(agent_key != vault.owner, PhalnxError::AgentIsOwner);
        require!(
            permissions & !FULL_PERMISSIONS == 0,
            PhalnxError::InvalidPermissions
        );
        require!(
            vault.agent_count() < MAX_AGENTS_PER_VAULT,
            PhalnxError::MaxAgentsReached
        );
        require!(
            !vault.is_agent(&agent_key),
            PhalnxError::AgentAlreadyRegistered
        );
        vault.agents.push(AgentEntry {
            pubkey: agent_key,
            permissions,
        });
    }

    // 4. Guard against soft-lock: cannot activate with no agents
    require!(!vault.agents.is_empty(), PhalnxError::NoAgentRegistered);

    // 5. Mutate status only after all checks pass
    vault.status = VaultStatus::Active;

    let clock = Clock::get()?;
    emit!(VaultReactivated {
        vault: vault.key(),
        new_agent,
        new_agent_permissions,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
