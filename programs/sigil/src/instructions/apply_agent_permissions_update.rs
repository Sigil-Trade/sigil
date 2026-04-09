use anchor_lang::accounts::account_loader::AccountLoader;
use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentPermissionsChangeApplied;
use crate::state::*;

#[derive(Accounts)]
pub struct ApplyAgentPermissionsUpdate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = vault.owner == owner.key() @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.owner.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

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

    /// Agent spend overlay — per-agent tracking slot.
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump = agent_spend_overlay.load()?.bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,
}

pub fn handler(ctx: Context<ApplyAgentPermissionsUpdate>) -> Result<()> {
    crate::reject_cpi!();

    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending_agent_perms;

    // Timelock must have expired
    require!(
        pending.is_ready(clock.unix_timestamp),
        SigilError::TimelockNotExpired
    );

    let agent = pending.agent;
    let new_permissions = pending.new_permissions;
    let spending_limit_usd = pending.spending_limit_usd;

    // Find agent entry and update permissions + spending limit
    let vault = &mut ctx.accounts.vault;
    let entry = vault
        .agents
        .iter_mut()
        .find(|a| a.pubkey == agent)
        .ok_or(error!(SigilError::UnauthorizedAgent))?;
    let old_spending_limit = entry.spending_limit_usd;
    entry.permissions = new_permissions;
    entry.spending_limit_usd = spending_limit_usd;

    // Manage overlay slot when spending limit changes
    // (lifted verbatim from update_agent_permissions.rs:66-81)
    if let Ok(mut overlay) = ctx.accounts.agent_spend_overlay.load_mut() {
        let has_slot = overlay.find_agent_slot(&agent).is_some();

        if spending_limit_usd > 0 && !has_slot {
            // Need a slot but don't have one — claim it
            require!(
                overlay.claim_slot(&agent).is_some(),
                SigilError::OverlaySlotExhausted
            );
        } else if spending_limit_usd == 0 && old_spending_limit > 0 && has_slot {
            // No longer need a slot — release it
            if let Some(idx) = overlay.find_agent_slot(&agent) {
                overlay.release_slot(idx);
            }
        }
    }

    // Bump policy version — permission changes affect security posture
    let policy = &mut ctx.accounts.policy;
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    emit!(AgentPermissionsChangeApplied {
        vault: vault.key(),
        agent,
        applied_at: clock.unix_timestamp,
    });

    Ok(())
}
