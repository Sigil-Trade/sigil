use anchor_lang::prelude::*;

use crate::errors::AgentShieldError;
use crate::events::OracleAuthorityTransferred;
use crate::state::*;

#[derive(Accounts)]
pub struct AcceptOracleAuthority<'info> {
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"oracle_registry"],
        bump,
    )]
    pub oracle_registry: AccountLoader<'info, OracleRegistry>,
}

pub fn handler(ctx: Context<AcceptOracleAuthority>) -> Result<()> {
    let mut registry = ctx.accounts.oracle_registry.load_mut()?;

    // Must have a pending authority
    require!(
        registry.pending_authority != Pubkey::default(),
        AgentShieldError::NoPendingAuthority
    );

    // Signer must be the pending authority
    require!(
        registry.pending_authority == ctx.accounts.new_authority.key(),
        AgentShieldError::NoPendingAuthority
    );

    let previous = registry.authority;
    let new = registry.pending_authority;

    registry.authority = new;
    registry.pending_authority = Pubkey::default();

    emit!(OracleAuthorityTransferred {
        previous_authority: previous,
        new_authority: new,
    });

    Ok(())
}
