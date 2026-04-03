use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentRegistered;
use crate::state::*;

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// Agent spend overlay — per-agent tracking slot.
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump = agent_spend_overlay.load()?.bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,
}

pub fn handler(
    ctx: Context<RegisterAgent>,
    agent: Pubkey,
    permissions: u64,
    spending_limit_usd: u64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );
    require!(
        permissions & !FULL_PERMISSIONS == 0,
        SigilError::InvalidPermissions
    );
    require!(!vault.is_agent(&agent), SigilError::AgentAlreadyRegistered);
    require!(
        vault.agent_count() < MAX_AGENTS_PER_VAULT,
        SigilError::MaxAgentsReached
    );
    require!(agent != Pubkey::default(), SigilError::InvalidAgentKey);
    require!(agent != vault.owner, SigilError::AgentIsOwner);

    vault.agents.push(AgentEntry {
        pubkey: agent,
        permissions,
        spending_limit_usd,
        paused: false,
    });

    // Claim a slot in the overlay for per-agent tracking.
    // Fail-closed: if spending_limit_usd > 0 but no slot available,
    // reject registration to guarantee per-agent limits are enforced.
    if let Ok(mut overlay) = ctx.accounts.agent_spend_overlay.load_mut() {
        if overlay.find_agent_slot(&agent).is_none() {
            match overlay.claim_slot(&agent) {
                Some(_) => {} // slot claimed successfully
                None => {
                    if spending_limit_usd > 0 {
                        // Remove the agent we just pushed — no slot to enforce limit
                        vault.agents.retain(|a| a.pubkey != agent);
                        return Err(error!(SigilError::OverlaySlotExhausted));
                    }
                    // spending_limit_usd == 0: no per-agent limit needed, continue
                }
            }
        }
    }

    let clock = Clock::get()?;
    emit!(AgentRegistered {
        vault: vault.key(),
        agent,
        permissions,
        spending_limit_usd,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
