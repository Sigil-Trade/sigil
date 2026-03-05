use anchor_lang::prelude::*;

use crate::errors::AgentShieldError;
use crate::events::OracleRegistryInitialized;
use crate::state::*;

#[derive(Accounts)]
pub struct InitializeOracleRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = OracleRegistry::SIZE,
        seeds = [b"oracle_registry"],
        bump,
    )]
    pub oracle_registry: AccountLoader<'info, OracleRegistry>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeOracleRegistry>, entries: Vec<OracleEntry>) -> Result<()> {
    require!(
        entries.len() <= MAX_ORACLE_ENTRIES,
        AgentShieldError::OracleRegistryFull
    );

    let mut registry = ctx.accounts.oracle_registry.load_init()?;
    registry.authority = ctx.accounts.authority.key();
    registry.pending_authority = Pubkey::default();
    registry.bump = ctx.bumps.oracle_registry;
    registry.count = entries.len() as u16;

    for (i, entry) in entries.iter().enumerate() {
        registry.entries[i] = OracleEntryZC::from(entry);
    }

    emit!(OracleRegistryInitialized {
        authority: registry.authority,
        entry_count: registry.count,
    });

    Ok(())
}
