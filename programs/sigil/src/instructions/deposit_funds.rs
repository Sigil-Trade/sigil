use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::SigilError;
use crate::events::FundsDeposited;
use crate::state::*;

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    pub mint: Account<'info, Mint>,

    /// Owner's token account to transfer from
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    /// Vault's PDA-controlled token account
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // Transfer tokens from owner to vault PDA token account
    let cpi_accounts = Transfer {
        from: ctx.accounts.owner_token_account.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    // P&L tracking: increment lifetime deposit counter for stablecoin mints only.
    if is_stablecoin_mint(&ctx.accounts.mint.key()) {
        vault.total_deposited_usd = vault
            .total_deposited_usd
            .checked_add(amount)
            .ok_or(error!(SigilError::Overflow))?;
    }

    let clock = Clock::get()?;
    emit!(FundsDeposited {
        vault: vault.key(),
        token_mint: ctx.accounts.mint.key(),
        amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
