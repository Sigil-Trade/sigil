use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::VaultFrozen;
use crate::state::*;

#[derive(Accounts)]
pub struct FreezeVault<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
}

pub fn handler(ctx: Context<FreezeVault>) -> Result<()> {
    crate::reject_cpi!();

    let vault = &mut ctx.accounts.vault;

    // Only active vaults can be frozen
    require!(vault.is_active(), SigilError::VaultNotActive);

    vault.status = VaultStatus::Frozen;

    let clock = Clock::get()?;
    emit!(VaultFrozen {
        vault: vault.key(),
        owner: ctx.accounts.owner.key(),
        agents_preserved: vault.agent_count() as u8,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
