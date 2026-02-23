use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::AgentShieldError;
use crate::events::{AgentTransferExecuted, FeesCollected};
use crate::state::*;

use super::utils::convert_to_usd;

#[derive(Accounts)]
pub struct AgentTransfer<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        mut,
        constraint = vault.is_agent(&agent.key()) @ AgentShieldError::UnauthorizedAgent,
        seeds = [b"vault", vault.owner.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Zero-copy SpendTracker
    #[account(
        mut,
        seeds = [b"tracker", vault.key().as_ref()],
        bump,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Protocol-level oracle registry
    #[account(
        seeds = [b"oracle_registry"],
        bump = oracle_registry.bump,
    )]
    pub oracle_registry: Account<'info, OracleRegistry>,

    /// Vault's PDA-owned token account (source)
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key()
            @ AgentShieldError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Token mint account for decimals validation
    #[account(
        constraint = token_mint_account.key()
            == vault_token_account.mint
            @ AgentShieldError::InvalidTokenAccount,
    )]
    pub token_mint_account: Account<'info, Mint>,

    /// Destination token account (must be in allowed destinations)
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,

    /// Developer fee destination token account
    #[account(mut)]
    pub fee_destination_token_account: Option<Account<'info, TokenAccount>>,

    /// Protocol treasury token account
    #[account(mut)]
    pub protocol_treasury_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    // Oracle feed (Pyth/Switchboard) via remaining_accounts[0]
}

pub fn handler(ctx: Context<AgentTransfer>, amount: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;
    let registry = &ctx.accounts.oracle_registry;
    let clock = Clock::get()?;

    // 1. Vault must be active
    require!(vault.is_active(), AgentShieldError::VaultNotActive);

    // 2. Amount must be positive
    require!(amount > 0, AgentShieldError::TransactionTooLarge);

    let token_mint = ctx.accounts.vault_token_account.mint;

    // 3. Token must be in the oracle registry
    let oracle_entry = registry
        .find_entry(&token_mint)
        .ok_or(error!(AgentShieldError::TokenNotRegistered))?;

    // 4. Destination must be allowed
    require!(
        policy.is_destination_allowed(&ctx.accounts.destination_token_account.owner),
        AgentShieldError::DestinationNotAllowed
    );

    // 5. Mint consistency
    require!(
        ctx.accounts.destination_token_account.mint == token_mint,
        AgentShieldError::InvalidTokenAccount
    );

    // 6. Get token decimals from validated mint account
    let token_decimals = ctx.accounts.token_mint_account.decimals;

    // 7. Convert to USD
    let (usd_amount, _oracle_price, _oracle_source) = convert_to_usd(
        oracle_entry.is_stablecoin,
        &oracle_entry.oracle_feed,
        &oracle_entry.fallback_feed,
        token_decimals,
        amount,
        ctx.remaining_accounts,
        &clock,
    )?;

    // 8. Single tx USD check
    require!(
        usd_amount <= policy.max_transaction_size_usd,
        AgentShieldError::TransactionTooLarge
    );

    // 9. Rolling 24h USD check
    let mut tracker = ctx.accounts.tracker.load_mut()?;
    let rolling_usd = tracker.get_rolling_24h_usd(&clock);
    let new_total_usd = rolling_usd
        .checked_add(usd_amount)
        .ok_or(AgentShieldError::Overflow)?;
    require!(
        new_total_usd <= policy.daily_spending_cap_usd,
        AgentShieldError::DailyCapExceeded
    );

    // Record spend
    tracker.record_spend(&clock, usd_amount)?;
    drop(tracker);

    // Build vault PDA signer seeds
    let owner_key = vault.owner;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let vault_fee_destination = vault.fee_destination;
    let developer_fee_rate = policy.developer_fee_rate;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        owner_key.as_ref(),
        vault_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    // Calculate fees
    let protocol_fee = amount
        .checked_mul(PROTOCOL_FEE_RATE as u64)
        .ok_or(AgentShieldError::Overflow)?
        .checked_div(FEE_RATE_DENOMINATOR)
        .ok_or(AgentShieldError::Overflow)?;

    let developer_fee = amount
        .checked_mul(developer_fee_rate as u64)
        .ok_or(AgentShieldError::Overflow)?
        .checked_div(FEE_RATE_DENOMINATOR)
        .ok_or(AgentShieldError::Overflow)?;

    let net_amount = amount
        .checked_sub(protocol_fee)
        .ok_or(AgentShieldError::Overflow)?
        .checked_sub(developer_fee)
        .ok_or(AgentShieldError::Overflow)?;

    // Transfer net amount to destination
    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.destination_token_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &binding,
    );
    token::transfer(cpi_ctx, net_amount)?;

    // Transfer protocol fee
    if protocol_fee > 0 {
        let treasury_token = ctx
            .accounts
            .protocol_treasury_token_account
            .as_ref()
            .ok_or(error!(AgentShieldError::InvalidProtocolTreasury))?;
        require!(
            treasury_token.owner == PROTOCOL_TREASURY,
            AgentShieldError::InvalidProtocolTreasury
        );
        require!(
            treasury_token.mint == token_mint,
            AgentShieldError::InvalidProtocolTreasury
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: treasury_token.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &binding,
        );
        token::transfer(cpi_ctx, protocol_fee)?;
    }

    // Transfer developer fee
    if developer_fee > 0 {
        let fee_dest = ctx
            .accounts
            .fee_destination_token_account
            .as_ref()
            .ok_or(error!(AgentShieldError::InvalidFeeDestination))?;
        require!(
            fee_dest.owner == vault_fee_destination,
            AgentShieldError::InvalidFeeDestination
        );
        require!(
            fee_dest.mint == token_mint,
            AgentShieldError::InvalidFeeDestination
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: fee_dest.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &binding,
        );
        token::transfer(cpi_ctx, developer_fee)?;
    }

    // Update vault stats
    let vault = &mut ctx.accounts.vault;
    vault.total_transactions = vault
        .total_transactions
        .checked_add(1)
        .ok_or(AgentShieldError::Overflow)?;
    vault.total_volume = vault
        .total_volume
        .checked_add(amount)
        .ok_or(AgentShieldError::Overflow)?;
    if developer_fee > 0 {
        vault.total_fees_collected = vault
            .total_fees_collected
            .checked_add(developer_fee)
            .ok_or(AgentShieldError::Overflow)?;
    }

    // Emit fee event if fees were collected
    if protocol_fee > 0 || developer_fee > 0 {
        emit!(FeesCollected {
            vault: vault.key(),
            token_mint,
            protocol_fee_amount: protocol_fee,
            developer_fee_amount: developer_fee,
            protocol_fee_rate: PROTOCOL_FEE_RATE,
            developer_fee_rate,
            transaction_amount: amount,
            protocol_treasury: PROTOCOL_TREASURY,
            developer_fee_destination: vault_fee_destination,
            cumulative_developer_fees: vault.total_fees_collected,
            timestamp: clock.unix_timestamp,
        });
    }

    emit!(AgentTransferExecuted {
        vault: vault.key(),
        destination: ctx.accounts.destination_token_account.owner,
        amount,
        mint: token_mint,
    });

    Ok(())
}
