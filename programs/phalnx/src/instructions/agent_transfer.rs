use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::PhalnxError;
use crate::events::{AgentSpendLimitChecked, AgentTransferExecuted, FeesCollected};
use crate::state::*;

use super::utils::stablecoin_to_usd;

#[derive(Accounts)]
pub struct AgentTransfer<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        mut,
        constraint = vault.is_agent(&agent.key()) @ PhalnxError::UnauthorizedAgent,
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

    /// Zero-copy AgentSpendOverlay — per-agent rolling spend
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    /// Vault's PDA-owned token account (source)
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key()
            @ PhalnxError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Token mint account for decimals validation
    #[account(
        constraint = token_mint_account.key()
            == vault_token_account.mint
            @ PhalnxError::InvalidTokenAccount,
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
}

pub fn handler(ctx: Context<AgentTransfer>, amount: u64) -> Result<()> {
    // 0. Reject CPI calls — only top-level transaction instructions allowed.
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        PhalnxError::CpiCallNotAllowed
    );

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;
    let clock = Clock::get()?;

    // 1. Vault must be active
    require!(vault.is_active(), PhalnxError::VaultNotActive);

    // 1a-pre. Agent must not be paused
    require!(
        !vault.is_agent_paused(&ctx.accounts.agent.key()),
        PhalnxError::AgentPaused
    );

    // 1a. Agent must have Transfer permission (single lookup replaces has_permission + get_agent)
    let agent_key = ctx.accounts.agent.key();
    let agent_entry = vault
        .get_agent(&agent_key)
        .ok_or(error!(PhalnxError::UnauthorizedAgent))?;
    require!(
        agent_entry.permissions & (1u64 << ActionType::Transfer.permission_bit()) != 0,
        PhalnxError::InsufficientPermissions
    );

    // 2. Amount must be positive
    require!(amount > 0, PhalnxError::TransactionTooLarge);

    let token_mint = ctx.accounts.vault_token_account.mint;

    // 3. Token must be a stablecoin (stablecoin-only enforcement)
    require!(
        is_stablecoin_mint(&token_mint),
        PhalnxError::UnsupportedToken
    );

    // 4. Destination must be allowed
    require!(
        policy.is_destination_allowed(&ctx.accounts.destination_token_account.owner),
        PhalnxError::DestinationNotAllowed
    );

    // 5. Mint consistency
    require!(
        ctx.accounts.destination_token_account.mint == token_mint,
        PhalnxError::InvalidTokenAccount
    );

    // 6. Get token decimals from validated mint account
    let token_decimals = ctx.accounts.token_mint_account.decimals;

    // 7. Convert stablecoin to USD (1:1)
    let usd_amount = stablecoin_to_usd(amount, token_decimals)?;

    // 8. Single tx USD check
    require!(
        usd_amount <= policy.max_transaction_size_usd,
        PhalnxError::TransactionTooLarge
    );

    // 9. Rolling 24h USD check
    let mut tracker = ctx.accounts.tracker.load_mut()?;
    let rolling_usd = tracker.get_rolling_24h_usd(&clock);
    let new_total_usd = rolling_usd
        .checked_add(usd_amount)
        .ok_or(PhalnxError::Overflow)?;
    require!(
        new_total_usd <= policy.daily_spending_cap_usd,
        PhalnxError::SpendingCapExceeded
    );

    // --- Per-agent cap check via contribution overlay ---
    let mut overlay = ctx.accounts.agent_spend_overlay.load_mut()?;
    if let Some(agent_slot) = overlay.find_agent_slot(&agent_key) {
        if agent_entry.spending_limit_usd > 0 {
            let agent_rolling = overlay.get_agent_rolling_24h_usd(&clock, agent_slot);
            let new_agent_spend = agent_rolling
                .checked_add(usd_amount)
                .ok_or(PhalnxError::Overflow)?;
            require!(
                new_agent_spend <= agent_entry.spending_limit_usd,
                PhalnxError::AgentSpendLimitExceeded
            );
            emit!(AgentSpendLimitChecked {
                vault: vault.key(),
                agent: agent_key,
                agent_rolling_spend: agent_rolling,
                spending_limit_usd: agent_entry.spending_limit_usd,
                amount: usd_amount,
                timestamp: clock.unix_timestamp,
            });
        }
        overlay.record_agent_contribution(&clock, agent_slot, usd_amount)?;
    } else if agent_entry.spending_limit_usd > 0 {
        return Err(error!(PhalnxError::AgentSlotNotFound));
    }
    drop(overlay);

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

    // Calculate fees (ceiling division — guarantees non-zero fee on any non-zero spending)
    let protocol_fee = ceil_fee(amount, PROTOCOL_FEE_RATE as u64)?;
    let developer_fee = ceil_fee(amount, developer_fee_rate as u64)?;

    let net_amount = amount
        .checked_sub(protocol_fee)
        .ok_or(PhalnxError::Overflow)?
        .checked_sub(developer_fee)
        .ok_or(PhalnxError::Overflow)?;

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
            .ok_or(error!(PhalnxError::InvalidProtocolTreasury))?;
        require!(
            treasury_token.owner == PROTOCOL_TREASURY,
            PhalnxError::InvalidProtocolTreasury
        );
        require!(
            treasury_token.mint == token_mint,
            PhalnxError::InvalidProtocolTreasury
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
            .ok_or(error!(PhalnxError::InvalidFeeDestination))?;
        require!(
            fee_dest.owner == vault_fee_destination,
            PhalnxError::InvalidFeeDestination
        );
        require!(
            fee_dest.mint == token_mint,
            PhalnxError::InvalidFeeDestination
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
        .ok_or(PhalnxError::Overflow)?;
    vault.total_volume = vault
        .total_volume
        .checked_add(amount)
        .ok_or(PhalnxError::Overflow)?;
    if developer_fee > 0 {
        vault.total_fees_collected = vault
            .total_fees_collected
            .checked_add(developer_fee)
            .ok_or(PhalnxError::Overflow)?;
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
