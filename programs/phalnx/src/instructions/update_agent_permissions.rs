use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::AgentPermissionsUpdated;
use crate::state::*;

#[derive(Accounts)]
pub struct UpdateAgentPermissions<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = vault.owner == owner.key() @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", vault.owner.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        constraint = policy.vault == vault.key(),
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,
}

pub fn handler(
    ctx: Context<UpdateAgentPermissions>,
    agent: Pubkey,
    new_permissions: u64,
) -> Result<()> {
    let policy = &ctx.accounts.policy;

    // Timelock guard: direct permission updates only allowed without timelock.
    // For timelocked vaults, use revoke_agent + register_agent instead.
    require!(policy.timelock_duration == 0, PhalnxError::TimelockActive);

    require!(
        new_permissions & !FULL_PERMISSIONS == 0,
        PhalnxError::InvalidPermissions
    );

    let vault = &mut ctx.accounts.vault;
    let entry = vault
        .agents
        .iter_mut()
        .find(|a| a.pubkey == agent)
        .ok_or(error!(PhalnxError::UnauthorizedAgent))?;
    let old_permissions = entry.permissions;
    entry.permissions = new_permissions;

    emit!(AgentPermissionsUpdated {
        vault: vault.key(),
        agent,
        old_permissions,
        new_permissions,
    });

    Ok(())
}
