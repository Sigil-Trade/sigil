use anchor_lang::accounts::account_loader::AccountLoader;
use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentRevoked;
use crate::state::*;

#[derive(Accounts)]
pub struct RevokeAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// Agent spend overlay — release slot on revocation.
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,
}

pub fn handler(ctx: Context<RevokeAgent>, agent_to_remove: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );
    require!(
        vault.is_agent(&agent_to_remove),
        SigilError::UnauthorizedAgent
    );

    // Release overlay slot before removing agent from vault
    if let Ok(mut overlay) = ctx.accounts.agent_spend_overlay.load_mut() {
        if let Some(slot_idx) = overlay.find_agent_slot(&agent_to_remove) {
            overlay.release_slot(slot_idx);
        }
    }

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
