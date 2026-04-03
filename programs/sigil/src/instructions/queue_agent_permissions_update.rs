use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentPermissionsChangeQueued;
use crate::state::*;

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct QueueAgentPermissionsUpdate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        init,
        payer = owner,
        space = PendingAgentPermissionsUpdate::SIZE,
        seeds = [b"pending_agent_perms", vault.key().as_ref(), agent.as_ref()],
        bump,
    )]
    pub pending_agent_perms: Account<'info, PendingAgentPermissionsUpdate>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<QueueAgentPermissionsUpdate>,
    agent: Pubkey,
    new_permissions: u64,
    spending_limit_usd: u64,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // Timelock must be configured (always true now with MIN_TIMELOCK_DURATION)
    require!(
        policy.timelock_duration > 0,
        SigilError::NoTimelockConfigured
    );

    // Validate agent exists in vault
    require!(
        vault.agents.iter().any(|a| a.pubkey == agent),
        SigilError::UnauthorizedAgent
    );

    // Validate permissions bitmask
    require!(
        new_permissions & !FULL_PERMISSIONS == 0,
        SigilError::InvalidPermissions
    );

    let clock = Clock::get()?;
    let pending = &mut ctx.accounts.pending_agent_perms;
    pending.vault = vault.key();
    pending.agent = agent;
    pending.new_permissions = new_permissions;
    pending.spending_limit_usd = spending_limit_usd;
    pending.queued_at = clock.unix_timestamp;
    pending.executes_at = clock
        .unix_timestamp
        .checked_add(policy.timelock_duration as i64)
        .ok_or(error!(SigilError::Overflow))?;
    pending.bump = ctx.bumps.pending_agent_perms;

    emit!(AgentPermissionsChangeQueued {
        vault: vault.key(),
        agent,
        executes_at: pending.executes_at,
    });

    Ok(())
}
