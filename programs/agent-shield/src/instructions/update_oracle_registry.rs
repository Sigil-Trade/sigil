use anchor_lang::prelude::*;

use crate::errors::AgentShieldError;
use crate::events::OracleRegistryUpdated;
use crate::state::*;

#[derive(Accounts)]
pub struct UpdateOracleRegistry<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"oracle_registry"],
        bump = oracle_registry.bump,
        constraint = oracle_registry.authority == authority.key()
            @ AgentShieldError::UnauthorizedRegistryAdmin,
    )]
    pub oracle_registry: Account<'info, OracleRegistry>,
}

pub fn handler(
    ctx: Context<UpdateOracleRegistry>,
    entries_to_add: Vec<OracleEntry>,
    mints_to_remove: Vec<Pubkey>,
) -> Result<()> {
    let registry = &mut ctx.accounts.oracle_registry;

    // Remove entries by mint
    let removed_count = mints_to_remove.len();
    registry
        .entries
        .retain(|e| !mints_to_remove.contains(&e.mint));

    // Add new entries (skip duplicates)
    let mut added_count: u16 = 0;
    for entry in entries_to_add {
        if registry.entries.iter().any(|e| e.mint == entry.mint) {
            // Update existing entry instead of adding duplicate
            if let Some(existing) = registry.entries.iter_mut().find(|e| e.mint == entry.mint) {
                existing.oracle_feed = entry.oracle_feed;
                existing.is_stablecoin = entry.is_stablecoin;
                existing.fallback_feed = entry.fallback_feed;
            }
        } else {
            require!(
                registry.entries.len() < MAX_ORACLE_ENTRIES,
                AgentShieldError::OracleRegistryFull
            );
            registry.entries.push(entry);
            added_count = added_count.saturating_add(1);
        }
    }

    emit!(OracleRegistryUpdated {
        added_count,
        removed_count: removed_count as u16,
        total_entries: registry.entries.len() as u16,
    });

    Ok(())
}
