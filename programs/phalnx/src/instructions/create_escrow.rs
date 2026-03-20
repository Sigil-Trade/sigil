use anchor_lang::accounts::account_loader::AccountLoader;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::PhalnxError;
use crate::events::{AgentSpendLimitChecked, EscrowCreated, FeesCollected};
use crate::state::*;

use super::utils::stablecoin_to_usd;

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        mut,
        constraint = source_vault.is_agent(&agent.key()) @ PhalnxError::UnauthorizedAgent,
        constraint = source_vault.is_active() @ PhalnxError::VaultNotActive,
        seeds = [b"vault", source_vault.owner.as_ref(), source_vault.vault_id.to_le_bytes().as_ref()],
        bump = source_vault.bump,
    )]
    pub source_vault: Account<'info, AgentVault>,

    #[account(
        constraint = policy.vault == source_vault.key() @ PhalnxError::InvalidEscrowVault,
        seeds = [b"policy", source_vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        mut,
        seeds = [b"tracker", source_vault.key().as_ref()],
        bump,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Zero-copy AgentSpendOverlay — per-agent rolling spend
    #[account(
        mut,
        seeds = [b"agent_spend", source_vault.key().as_ref(), &[0u8]],
        bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    #[account(
        constraint = destination_vault.is_active() @ PhalnxError::VaultNotActive,
        constraint = destination_vault.key() != source_vault.key() @ PhalnxError::InvalidEscrowVault,
        seeds = [b"vault", destination_vault.owner.as_ref(), destination_vault.vault_id.to_le_bytes().as_ref()],
        bump = destination_vault.bump,
    )]
    pub destination_vault: Box<Account<'info, AgentVault>>,

    #[account(
        init,
        payer = agent,
        space = EscrowDeposit::SIZE,
        seeds = [b"escrow", source_vault.key().as_ref(), destination_vault.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, EscrowDeposit>,

    /// Source vault's token account (vault PDA is authority)
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = source_vault,
    )]
    pub source_vault_ata: Account<'info, TokenAccount>,

    /// Escrow-owned ATA — init_if_needed because escrow PDA is created in same ix
    #[account(
        init_if_needed,
        payer = agent,
        associated_token::mint = token_mint,
        associated_token::authority = escrow,
    )]
    pub escrow_ata: Account<'info, TokenAccount>,

    /// Protocol treasury token account (needed when protocol_fee > 0)
    #[account(mut)]
    pub protocol_treasury_ata: Option<Account<'info, TokenAccount>>,

    /// Developer fee destination token account (needed when developer_fee > 0)
    #[account(mut)]
    pub fee_destination_ata: Option<Account<'info, TokenAccount>>,

    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handler(
    ctx: Context<CreateEscrow>,
    escrow_id: u64,
    amount: u64,
    expires_at: i64,
    condition_hash: [u8; 32],
) -> Result<()> {
    // 0. CPI guard
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        PhalnxError::CpiCallNotAllowed
    );

    let source_vault = &ctx.accounts.source_vault;
    let policy = &ctx.accounts.policy;
    let clock = Clock::get()?;

    // 0b. Agent must not be paused
    require!(
        !source_vault.is_agent_paused(&ctx.accounts.agent.key()),
        PhalnxError::AgentPaused
    );

    // 1. Permission check
    require!(
        source_vault.has_permission(&ctx.accounts.agent.key(), &ActionType::CreateEscrow),
        PhalnxError::InsufficientPermissions
    );

    // 2. Stablecoin-only
    let token_mint_key = ctx.accounts.token_mint.key();
    require!(
        is_stablecoin_mint(&token_mint_key),
        PhalnxError::UnsupportedToken
    );

    // 3. Amount must be positive
    require!(amount > 0, PhalnxError::InsufficientBalance);

    // 4-5. Validate expiry: must be in the future and within max duration
    require!(
        expires_at > clock.unix_timestamp
            && expires_at <= clock.unix_timestamp.saturating_add(MAX_ESCROW_DURATION),
        PhalnxError::EscrowDurationExceeded
    );

    // 6. Cap check — record spending in tracker
    let token_decimals = ctx.accounts.token_mint.decimals;
    let usd_amount = stablecoin_to_usd(amount, token_decimals)?;

    // Single tx USD check
    require!(
        usd_amount <= policy.max_transaction_size_usd,
        PhalnxError::TransactionTooLarge
    );

    // Rolling 24h USD check
    let mut tracker = ctx.accounts.tracker.load_mut()?;
    let rolling_usd = tracker.get_rolling_24h_usd(&clock);
    let new_total_usd = rolling_usd
        .checked_add(usd_amount)
        .ok_or(PhalnxError::Overflow)?;
    require!(
        new_total_usd <= policy.daily_spending_cap_usd,
        PhalnxError::SpendingCapExceeded
    );
    tracker.record_spend(&clock, usd_amount)?;
    drop(tracker);

    // 6b. Per-agent cap check via contribution overlay
    let agent_key = ctx.accounts.agent.key();
    let agent_entry = source_vault
        .get_agent(&agent_key)
        .ok_or(error!(PhalnxError::UnauthorizedAgent))?;
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
                vault: source_vault.key(),
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

    // 7. Fee calculation (ceiling division — guarantees non-zero fee on any non-zero spending)
    let dev_fee_rate = policy.developer_fee_rate;
    let protocol_fee = ceil_fee(amount, PROTOCOL_FEE_RATE as u64)?;
    let developer_fee = ceil_fee(amount, dev_fee_rate as u64)?;
    let net_amount = amount
        .checked_sub(protocol_fee)
        .ok_or(PhalnxError::Overflow)?
        .checked_sub(developer_fee)
        .ok_or(PhalnxError::Overflow)?;

    // Build vault PDA signer seeds
    let owner_key = source_vault.owner;
    let vault_id_bytes = source_vault.vault_id.to_le_bytes();
    let vault_bump = source_vault.bump;
    let vault_fee_destination = source_vault.fee_destination;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        owner_key.as_ref(),
        vault_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    // 8. Transfer protocol fee
    if protocol_fee > 0 {
        let treasury_token = ctx
            .accounts
            .protocol_treasury_ata
            .as_ref()
            .ok_or(error!(PhalnxError::InvalidProtocolTreasury))?;
        require!(
            treasury_token.owner == PROTOCOL_TREASURY,
            PhalnxError::InvalidProtocolTreasury
        );
        require!(
            treasury_token.mint == token_mint_key,
            PhalnxError::InvalidProtocolTreasury
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.source_vault_ata.to_account_info(),
            to: treasury_token.to_account_info(),
            authority: ctx.accounts.source_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &binding,
        );
        token::transfer(cpi_ctx, protocol_fee)?;
    }

    // 9. Transfer developer fee
    if developer_fee > 0 {
        let fee_dest = ctx
            .accounts
            .fee_destination_ata
            .as_ref()
            .ok_or(error!(PhalnxError::InvalidFeeDestination))?;
        require!(
            fee_dest.owner == vault_fee_destination,
            PhalnxError::InvalidFeeDestination
        );
        require!(
            fee_dest.mint == token_mint_key,
            PhalnxError::InvalidFeeDestination
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.source_vault_ata.to_account_info(),
            to: fee_dest.to_account_info(),
            authority: ctx.accounts.source_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &binding,
        );
        token::transfer(cpi_ctx, developer_fee)?;
    }

    // Emit fee event
    if protocol_fee > 0 || developer_fee > 0 {
        emit!(FeesCollected {
            vault: source_vault.key(),
            token_mint: token_mint_key,
            protocol_fee_amount: protocol_fee,
            developer_fee_amount: developer_fee,
            protocol_fee_rate: PROTOCOL_FEE_RATE,
            developer_fee_rate: dev_fee_rate,
            transaction_amount: amount,
            protocol_treasury: PROTOCOL_TREASURY,
            developer_fee_destination: vault_fee_destination,
            cumulative_developer_fees: source_vault
                .total_fees_collected
                .saturating_add(developer_fee),
            timestamp: clock.unix_timestamp,
        });
    }

    // 10. Transfer net amount from source vault ATA → escrow ATA
    if net_amount > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.source_vault_ata.to_account_info(),
            to: ctx.accounts.escrow_ata.to_account_info(),
            authority: ctx.accounts.source_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &binding,
        );
        token::transfer(cpi_ctx, net_amount)?;
    }

    // 11. Init escrow PDA
    let escrow = &mut ctx.accounts.escrow;
    escrow.source_vault = source_vault.key();
    escrow.destination_vault = ctx.accounts.destination_vault.key();
    escrow.escrow_id = escrow_id;
    escrow.amount = net_amount;
    escrow.token_mint = token_mint_key;
    escrow.created_at = clock.unix_timestamp;
    escrow.expires_at = expires_at;
    escrow.status = EscrowStatus::Active;
    escrow.condition_hash = condition_hash;
    escrow.bump = ctx.bumps.escrow;

    // 12. Update vault stats
    let source_vault = &mut ctx.accounts.source_vault;
    source_vault.active_escrow_count = source_vault
        .active_escrow_count
        .checked_add(1)
        .ok_or(error!(PhalnxError::Overflow))?;
    source_vault.total_transactions = source_vault
        .total_transactions
        .checked_add(1)
        .ok_or(PhalnxError::Overflow)?;
    source_vault.total_volume = source_vault
        .total_volume
        .checked_add(amount)
        .ok_or(PhalnxError::Overflow)?;
    if developer_fee > 0 {
        source_vault.total_fees_collected = source_vault
            .total_fees_collected
            .checked_add(developer_fee)
            .ok_or(PhalnxError::Overflow)?;
    }

    // 13. Emit event
    emit!(EscrowCreated {
        source_vault: source_vault.key(),
        destination_vault: ctx.accounts.destination_vault.key(),
        escrow_id,
        amount: net_amount,
        token_mint: token_mint_key,
        expires_at,
        condition_hash,
    });

    Ok(())
}
