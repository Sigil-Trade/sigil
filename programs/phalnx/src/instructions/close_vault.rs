use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::VaultClosed;
use crate::state::*;

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        close = owner,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
        close = owner,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Zero-copy SpendTracker — close returns rent to owner
    #[account(
        mut,
        seeds = [b"tracker", vault.key().as_ref()],
        bump,
        close = owner,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CloseVault>) -> Result<()> {
    let vault = &ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        PhalnxError::VaultAlreadyClosed
    );
    require!(vault.open_positions == 0, PhalnxError::OpenPositionsExist);

    let clock = Clock::get()?;
    emit!(VaultClosed {
        vault: vault.key(),
        owner: ctx.accounts.owner.key(),
        timestamp: clock.unix_timestamp,
    });

    // Anchor `close = owner` handles the actual closing and rent reclamation

    Ok(())
}
