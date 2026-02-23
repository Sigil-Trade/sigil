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
    pub oracle_registry: Account<'info, OracleRegistry>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeOracleRegistry>, entries: Vec<OracleEntry>) -> Result<()> {
    require!(
        entries.len() <= MAX_ORACLE_ENTRIES,
        AgentShieldError::OracleRegistryFull
    );

    let registry = &mut ctx.accounts.oracle_registry;
    registry.authority = ctx.accounts.authority.key();
    registry.entries = entries;
    registry.bump = ctx.bumps.oracle_registry;

    emit!(OracleRegistryInitialized {
        authority: registry.authority,
        entry_count: registry.entries.len() as u16,
    });

    Ok(())
}
