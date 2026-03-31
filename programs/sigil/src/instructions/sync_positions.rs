use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::PositionsSynced;
use crate::state::AgentVault;

#[derive(Accounts)]
pub struct SyncPositions<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = vault.is_owner(&owner.key())
            @ SigilError::UnauthorizedOwner,
        seeds = [
            b"vault",
            vault.owner.as_ref(),
            vault.vault_id.to_le_bytes().as_ref(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
}

pub fn handler(ctx: Context<SyncPositions>, actual_positions: u8) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let old = vault.open_positions;
    vault.open_positions = actual_positions;

    emit!(PositionsSynced {
        vault: vault.key(),
        old_count: old,
        new_count: actual_positions,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
