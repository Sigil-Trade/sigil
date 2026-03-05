use anchor_lang::prelude::*;

use crate::errors::AgentShieldError;
use crate::events::OracleAuthorityProposed;
use crate::state::*;

#[derive(Accounts)]
pub struct ProposeOracleAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"oracle_registry"],
        bump,
    )]
    pub oracle_registry: AccountLoader<'info, OracleRegistry>,
}

pub fn handler(ctx: Context<ProposeOracleAuthority>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        AgentShieldError::InvalidAuthorityKey
    );

    let mut registry = ctx.accounts.oracle_registry.load_mut()?;

    // Only current authority can propose
    require!(
        registry.authority == ctx.accounts.authority.key(),
        AgentShieldError::UnauthorizedRegistryAdmin
    );

    registry.pending_authority = new_authority;

    emit!(OracleAuthorityProposed {
        current_authority: registry.authority,
        proposed_authority: new_authority,
    });

    Ok(())
}
