use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::PhalnxError;
use crate::events::FundsWithdrawn;
use crate::state::*;

#[derive(Accounts)]
pub struct WithdrawFunds<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    pub mint: Account<'info, Mint>,

    /// Vault's PDA-controlled token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Owner's token account to receive funds
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawFunds>, amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        PhalnxError::VaultAlreadyClosed
    );
    require!(
        ctx.accounts.vault_token_account.amount >= amount,
        PhalnxError::InsufficientBalance
    );

    // PDA signer seeds
    let owner_key = vault.owner;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = [vault.bump];
    let signer_seeds = [
        b"vault" as &[u8],
        owner_key.as_ref(),
        vault_id_bytes.as_ref(),
        bump.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.owner_token_account.to_account_info(),
        authority: vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &binding,
    );
    token::transfer(cpi_ctx, amount)?;

    // P&L tracking: increment lifetime withdrawal counter for stablecoin mints only.
    if is_stablecoin_mint(&ctx.accounts.mint.key()) {
        vault.total_withdrawn_usd = vault
            .total_withdrawn_usd
            .checked_add(amount)
            .ok_or(error!(PhalnxError::Overflow))?;
    }

    let clock = Clock::get()?;
    emit!(FundsWithdrawn {
        vault: vault.key(),
        token_mint: ctx.accounts.mint.key(),
        amount,
        destination: ctx.accounts.owner.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
