use anchor_lang::accounts::account_loader::AccountLoader;
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

    /// Agent spend overlay — per-agent tracking slot.
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,
}

pub fn handler(
    ctx: Context<UpdateAgentPermissions>,
    agent: Pubkey,
    new_permissions: u64,
    spending_limit_usd: u64,
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
    let old_spending_limit = entry.spending_limit_usd;
    entry.permissions = new_permissions;
    entry.spending_limit_usd = spending_limit_usd;

    // Manage overlay slot when spending limit changes
    if let Ok(mut overlay) = ctx.accounts.agent_spend_overlay.load_mut() {
        let has_slot = overlay.find_agent_slot(&agent).is_some();

        if spending_limit_usd > 0 && !has_slot {
            // Need a slot but don't have one — claim it
            require!(
                overlay.claim_slot(&agent).is_some(),
                PhalnxError::OverlaySlotExhausted
            );
        } else if spending_limit_usd == 0 && old_spending_limit > 0 && has_slot {
            // No longer need a slot — release it
            if let Some(idx) = overlay.find_agent_slot(&agent) {
                overlay.release_slot(idx);
            }
        }
    }

    emit!(AgentPermissionsUpdated {
        vault: vault.key(),
        agent,
        old_permissions,
        new_permissions,
    });

    Ok(())
}
