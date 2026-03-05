use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_spl::token::{self, Revoke, Token, TokenAccount};

use anchor_lang::accounts::account_loader::AccountLoader;

use crate::errors::PhalnxError;
use crate::events::{DelegationRevoked, SessionFinalized};
use crate::state::{PositionEffect, *};

#[derive(Accounts)]
pub struct FinalizeSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// Session rent is returned to the session's agent (who paid for it).
    /// Seeds include token_mint for per-token concurrent sessions.
    #[account(
        mut,
        has_one = vault @ PhalnxError::InvalidSession,
        seeds = [
            b"session",
            vault.key().as_ref(),
            session.agent.as_ref(),
            session.authorized_token.as_ref(),
        ],
        bump = session.bump,
        close = session_rent_recipient,
    )]
    pub session: Account<'info, SessionAuthority>,

    /// CHECK: Set to session.agent at runtime; receives rent from closed session.
    #[account(mut)]
    pub session_rent_recipient: UncheckedAccount<'info>,

    /// Policy config for cap checking during non-stablecoin swap finalization
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Zero-copy SpendTracker for recording non-stablecoin swap value
    #[account(
        mut,
        seeds = [b"tracker", vault.key().as_ref()],
        bump,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Vault's PDA token account for the session's token
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    /// Vault's stablecoin ATA for non-stablecoin→stablecoin swap verification.
    /// Required when session.output_mint != Pubkey::default().
    #[account(mut)]
    pub output_stablecoin_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<FinalizeSession>, success: bool) -> Result<()> {
    // 0. Reject CPI calls — only top-level transaction instructions allowed.
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        PhalnxError::CpiCallNotAllowed
    );

    let session = &ctx.accounts.session;
    let clock = Clock::get()?;

    let is_expired = session.is_expired(clock.slot);

    // Rent recipient must be the session's agent
    require!(
        ctx.accounts.session_rent_recipient.key() == session.agent,
        PhalnxError::InvalidSession
    );

    // Non-expired sessions can only be finalized by the session's agent.
    // Expired sessions can be cleaned up by anyone (permissionless crank).
    if !is_expired {
        require!(
            ctx.accounts.payer.key() == session.agent,
            PhalnxError::UnauthorizedAgent
        );
        require!(session.authorized, PhalnxError::SessionNotAuthorized);
    }

    // Expired sessions are always treated as failed
    let success = if is_expired { false } else { success };

    // Extract session data before we lose access
    let session_agent = session.agent;
    let session_amount = session.authorized_amount;
    let session_action_type = session.action_type;
    let session_delegated = session.delegated;
    let session_developer_fee = session.developer_fee;
    let session_output_mint = session.output_mint;
    let session_balance_before = session.stablecoin_balance_before;
    let session_delegation_token_account = session.delegation_token_account;

    let vault = &mut ctx.accounts.vault;

    // Extract vault PDA seeds data upfront
    let owner_key = vault.owner;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        owner_key.as_ref(),
        vault_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    // Security fix (Finding C): Validate vault_token_account matches session
    if session_delegated {
        // H1: vault_token_account MUST be provided when session was delegated.
        // Without this, passing None silently skips revocation and the agent
        // retains SPL token delegation authority.
        require!(
            ctx.accounts.vault_token_account.is_some(),
            PhalnxError::InvalidTokenAccount
        );
        if let Some(ref vault_token) = ctx.accounts.vault_token_account {
            require!(
                vault_token.key() == session_delegation_token_account,
                PhalnxError::InvalidTokenAccount
            );
        }
    }

    // Revoke delegation
    if session_delegated {
        if let Some(vault_token) = ctx.accounts.vault_token_account.as_ref() {
            let revoke_accounts = Revoke {
                source: vault_token.to_account_info(),
                authority: vault.to_account_info(),
            };
            let revoke_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                revoke_accounts,
                &binding,
            );
            token::revoke(revoke_ctx)?;

            emit!(DelegationRevoked {
                vault: vault.key(),
                token_account: vault_token.key(),
                timestamp: clock.unix_timestamp,
            });
        }
    }

    // Stablecoin balance verification for non-stablecoin→stablecoin swaps
    if session_output_mint != Pubkey::default() && success {
        let stablecoin_account = ctx
            .accounts
            .output_stablecoin_account
            .as_ref()
            .ok_or(error!(PhalnxError::InvalidTokenAccount))?;
        require!(
            stablecoin_account.owner == vault.key(),
            PhalnxError::InvalidTokenAccount
        );
        require!(
            stablecoin_account.mint == session_output_mint,
            PhalnxError::InvalidTokenAccount
        );
        require!(
            stablecoin_account.amount > session_balance_before,
            PhalnxError::NonTrackedSwapMustReturnStablecoin
        );

        // Track stablecoin delta: how much USD the non-stablecoin swap produced
        let stablecoin_delta = stablecoin_account
            .amount
            .checked_sub(session_balance_before)
            .ok_or(PhalnxError::Overflow)?;

        // Single-transaction USD limit
        let policy = &ctx.accounts.policy;
        require!(
            stablecoin_delta <= policy.max_transaction_size_usd,
            PhalnxError::TransactionTooLarge
        );

        // Rolling 24h cap check
        let mut tracker = ctx.accounts.tracker.load_mut()?;
        let rolling_usd = tracker.get_rolling_24h_usd(&clock);
        let new_total = rolling_usd
            .checked_add(stablecoin_delta)
            .ok_or(PhalnxError::Overflow)?;
        require!(
            new_total <= policy.daily_spending_cap_usd,
            PhalnxError::DailyCapExceeded
        );

        // Record spend in tracker
        tracker.record_spend(&clock, stablecoin_delta)?;
        drop(tracker);
    }

    // Update vault stats on success (fees already collected in validate)
    if success && !is_expired {
        vault.total_transactions = vault
            .total_transactions
            .checked_add(1)
            .ok_or(PhalnxError::Overflow)?;

        // Only add to total_volume for spending actions
        if session_action_type.is_spending() {
            vault.total_volume = vault
                .total_volume
                .checked_add(session_amount)
                .ok_or(PhalnxError::Overflow)?;
        }

        if session_developer_fee > 0 {
            vault.total_fees_collected = vault
                .total_fees_collected
                .checked_add(session_developer_fee)
                .ok_or(PhalnxError::Overflow)?;
        }

        // Update position count based on position effect
        match session_action_type.position_effect() {
            PositionEffect::Increment => {
                vault.open_positions = vault
                    .open_positions
                    .checked_add(1)
                    .ok_or(PhalnxError::Overflow)?;
            }
            PositionEffect::Decrement => {
                vault.open_positions = vault
                    .open_positions
                    .checked_sub(1)
                    .ok_or(PhalnxError::Overflow)?;
            }
            PositionEffect::None => {}
        }
    }

    emit!(SessionFinalized {
        vault: vault.key(),
        agent: session_agent,
        success,
        is_expired,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
