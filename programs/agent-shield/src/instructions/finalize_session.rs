use anchor_lang::prelude::*;
use anchor_spl::token::{self, Revoke, Token, TokenAccount, Transfer};

use crate::errors::AgentShieldError;
use crate::events::{DelegationRevoked, FeesCollected, SessionFinalized};
use crate::state::*;

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

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Session rent is returned to the session's agent (who paid for it).
    /// Seeds include token_mint for per-token concurrent sessions.
    #[account(
        mut,
        has_one = vault @ AgentShieldError::InvalidSession,
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

    /// Vault's PDA token account for the session's token
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    /// Developer fee destination token account
    #[account(mut)]
    pub fee_destination_token_account: Option<Account<'info, TokenAccount>>,

    /// Protocol treasury token account
    #[account(mut)]
    pub protocol_treasury_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<FinalizeSession>, success: bool) -> Result<()> {
    let session = &ctx.accounts.session;
    let clock = Clock::get()?;

    let is_expired = session.is_expired(clock.slot);

    // Rent recipient must be the session's agent
    require!(
        ctx.accounts.session_rent_recipient.key() == session.agent,
        AgentShieldError::InvalidSession
    );

    // Non-expired sessions can only be finalized by the session's agent.
    // Expired sessions can be cleaned up by anyone (permissionless crank).
    if !is_expired {
        require!(
            ctx.accounts.payer.key() == session.agent,
            AgentShieldError::UnauthorizedAgent
        );
        require!(session.authorized, AgentShieldError::SessionNotAuthorized);
    }

    // Expired sessions are always treated as failed
    let success = if is_expired { false } else { success };

    // Extract session data before we lose access
    let session_agent = session.agent;
    let session_amount = session.authorized_amount;
    let session_token = session.authorized_token;
    let session_action_type = session.action_type;
    let session_delegated = session.delegated;

    let vault = &mut ctx.accounts.vault;
    let developer_fee_rate = ctx.accounts.policy.developer_fee_rate;

    // Extract vault PDA seeds data upfront
    let owner_key = vault.owner;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let vault_fee_destination = vault.fee_destination;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        owner_key.as_ref(),
        vault_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    // Revoke delegation FIRST (before any fee transfers)
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

    // Collect fees if success and not expired
    if success && !is_expired {
        // Calculate protocol fee (always applied)
        let protocol_fee = session_amount
            .checked_mul(PROTOCOL_FEE_RATE as u64)
            .ok_or(AgentShieldError::Overflow)?
            .checked_div(FEE_RATE_DENOMINATOR)
            .ok_or(AgentShieldError::Overflow)?;

        // Calculate developer fee
        let developer_fee = session_amount
            .checked_mul(developer_fee_rate as u64)
            .ok_or(AgentShieldError::Overflow)?
            .checked_div(FEE_RATE_DENOMINATOR)
            .ok_or(AgentShieldError::Overflow)?;

        let has_any_fee = protocol_fee > 0 || developer_fee > 0;

        if has_any_fee {
            let vault_token = ctx
                .accounts
                .vault_token_account
                .as_ref()
                .ok_or(error!(AgentShieldError::InvalidFeeDestination))?;

            // Validate vault token account
            require!(
                vault_token.owner == vault.key(),
                AgentShieldError::InvalidFeeDestination
            );
            require!(
                vault_token.mint == session_token,
                AgentShieldError::InvalidFeeDestination
            );

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
                    treasury_token.mint == session_token,
                    AgentShieldError::InvalidProtocolTreasury
                );

                let cpi_accounts = Transfer {
                    from: vault_token.to_account_info(),
                    to: treasury_token.to_account_info(),
                    authority: vault.to_account_info(),
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
                    fee_dest.mint == session_token,
                    AgentShieldError::InvalidFeeDestination
                );

                let cpi_accounts = Transfer {
                    from: vault_token.to_account_info(),
                    to: fee_dest.to_account_info(),
                    authority: vault.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    &binding,
                );
                token::transfer(cpi_ctx, developer_fee)?;

                vault.total_fees_collected = vault
                    .total_fees_collected
                    .checked_add(developer_fee)
                    .ok_or(AgentShieldError::Overflow)?;
            }

            emit!(FeesCollected {
                vault: vault.key(),
                token_mint: session_token,
                protocol_fee_amount: protocol_fee,
                developer_fee_amount: developer_fee,
                protocol_fee_rate: PROTOCOL_FEE_RATE,
                developer_fee_rate,
                transaction_amount: session_amount,
                protocol_treasury: PROTOCOL_TREASURY,
                developer_fee_destination: vault_fee_destination,
                cumulative_developer_fees: vault.total_fees_collected,
                timestamp: clock.unix_timestamp,
            });
        }
    }

    // Update vault stats on success
    if success && !is_expired {
        vault.total_transactions = vault
            .total_transactions
            .checked_add(1)
            .ok_or(AgentShieldError::Overflow)?;
        vault.total_volume = vault
            .total_volume
            .checked_add(session_amount)
            .ok_or(AgentShieldError::Overflow)?;

        // Update position count for perpetual actions
        match session_action_type {
            ActionType::OpenPosition => {
                vault.open_positions = vault
                    .open_positions
                    .checked_add(1)
                    .ok_or(AgentShieldError::Overflow)?;
            }
            ActionType::ClosePosition => {
                vault.open_positions = vault
                    .open_positions
                    .checked_sub(1)
                    .ok_or(AgentShieldError::Overflow)?;
            }
            _ => {}
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
