use anchor_lang::prelude::*;
use anchor_spl::token::{self, Approve, Mint, Token, TokenAccount};

use crate::errors::AgentShieldError;
use crate::events::ActionAuthorized;
use crate::state::*;

use super::utils::convert_to_usd;

#[derive(Accounts)]
#[instruction(action_type: ActionType, token_mint: Pubkey)]
pub struct ValidateAndAuthorize<'info> {
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

    /// Protocol-level oracle registry (shared across all vaults)
    #[account(
        seeds = [b"oracle_registry"],
        bump = oracle_registry.bump,
    )]
    pub oracle_registry: Account<'info, OracleRegistry>,

    /// Ephemeral session PDA — `init` ensures no double-authorization.
    /// Seeds include token_mint for per-token concurrent sessions.
    #[account(
        init,
        payer = agent,
        space = SessionAuthority::SIZE,
        seeds = [
            b"session",
            vault.key().as_ref(),
            agent.key().as_ref(),
            token_mint.as_ref(),
        ],
        bump,
    )]
    pub session: Account<'info, SessionAuthority>,

    /// Vault's PDA-owned token account for the spend token
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key()
            @ AgentShieldError::InvalidTokenAccount,
        constraint = vault_token_account.mint == token_mint_account.key()
            @ AgentShieldError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The token mint being spent
    pub token_mint_account: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // Oracle feed (Pyth/Switchboard) passed via remaining_accounts[0]
    // for oracle-priced tokens
}

pub fn handler(
    ctx: Context<ValidateAndAuthorize>,
    action_type: ActionType,
    token_mint: Pubkey,
    amount: u64,
    target_protocol: Pubkey,
    leverage_bps: Option<u16>,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;
    let registry = &ctx.accounts.oracle_registry;
    let clock = Clock::get()?;

    // 1. Vault must be active
    require!(vault.is_active(), AgentShieldError::VaultNotActive);

    // 1b. Amount must be positive
    require!(amount > 0, AgentShieldError::TransactionTooLarge);

    // 2. Token must be in the oracle registry
    let oracle_entry = registry
        .find_entry(&token_mint)
        .ok_or(error!(AgentShieldError::TokenNotRegistered))?;

    // 3. Protocol must be allowed (mode-based check)
    require!(
        policy.is_protocol_allowed(&target_protocol),
        AgentShieldError::ProtocolNotAllowed
    );

    // 4. USD CONVERSION — using registry entry + mint decimals
    let token_decimals = ctx.accounts.token_mint_account.decimals;
    let (usd_amount, oracle_price, oracle_source) = convert_to_usd(
        oracle_entry.is_stablecoin,
        &oracle_entry.oracle_feed,
        &oracle_entry.fallback_feed,
        token_decimals,
        amount,
        ctx.remaining_accounts,
        &clock,
    )?;

    // 5. Single tx USD check
    require!(
        usd_amount <= policy.max_transaction_size_usd,
        AgentShieldError::TransactionTooLarge
    );

    // 6. Rolling 24h USD check (aggregate across all tokens)
    let mut tracker = ctx.accounts.tracker.load_mut()?;
    let rolling_usd = tracker.get_rolling_24h_usd(&clock);
    let new_total_usd = rolling_usd
        .checked_add(usd_amount)
        .ok_or(AgentShieldError::Overflow)?;
    require!(
        new_total_usd <= policy.daily_spending_cap_usd,
        AgentShieldError::DailyCapExceeded
    );

    // 7. Leverage check (for perp actions)
    if let Some(lev) = leverage_bps {
        require!(
            policy.is_leverage_within_limit(lev),
            AgentShieldError::LeverageTooHigh
        );
    }

    // 8. Position opening checks
    if action_type == ActionType::OpenPosition {
        require!(
            policy.can_open_positions,
            AgentShieldError::PositionOpeningDisallowed
        );
        require!(
            vault.open_positions < policy.max_concurrent_positions,
            AgentShieldError::TooManyPositions
        );
    }

    // All checks passed — record spend
    tracker.record_spend(&clock, usd_amount)?;
    // Drop the mutable borrow before using ctx.accounts
    drop(tracker);

    // Create session PDA
    let session = &mut ctx.accounts.session;
    session.vault = vault.key();
    session.agent = ctx.accounts.agent.key();
    session.authorized = true;
    session.authorized_amount = amount;
    session.authorized_token = token_mint;
    session.authorized_protocol = target_protocol;
    session.action_type = action_type;
    session.expires_at_slot = SessionAuthority::calculate_expiry(clock.slot);
    session.delegation_token_account = ctx.accounts.vault_token_account.key();
    session.bump = ctx.bumps.session;

    // CPI: approve agent as delegate on vault's token account
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

    let cpi_accounts = Approve {
        to: ctx.accounts.vault_token_account.to_account_info(),
        delegate: ctx.accounts.agent.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &binding,
    );
    token::approve(cpi_ctx, amount)?;
    session.delegated = true;

    emit!(ActionAuthorized {
        vault: vault.key(),
        agent: ctx.accounts.agent.key(),
        action_type,
        token_mint,
        amount,
        usd_amount,
        protocol: target_protocol,
        rolling_spend_usd_after: new_total_usd,
        daily_cap_usd: policy.daily_spending_cap_usd,
        delegated: true,
        oracle_price,
        oracle_source,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
