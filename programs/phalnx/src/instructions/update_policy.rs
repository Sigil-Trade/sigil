use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::PolicyUpdated;
use crate::state::*;

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ PhalnxError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<UpdatePolicy>,
    daily_spending_cap_usd: Option<u64>,
    max_transaction_size_usd: Option<u64>,
    protocol_mode: Option<u8>,
    protocols: Option<Vec<Pubkey>>,
    max_leverage_bps: Option<u16>,
    can_open_positions: Option<bool>,
    max_concurrent_positions: Option<u8>,
    developer_fee_rate: Option<u16>,
    max_slippage_bps: Option<u16>,
    timelock_duration: Option<u64>,
    allowed_destinations: Option<Vec<Pubkey>>,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(
        vault.status != VaultStatus::Closed,
        PhalnxError::VaultAlreadyClosed
    );

    let policy = &mut ctx.accounts.policy;

    // When timelock > 0, immediate updates are blocked
    require!(policy.timelock_duration == 0, PhalnxError::TimelockActive);

    if let Some(cap) = daily_spending_cap_usd {
        policy.daily_spending_cap_usd = cap;
    }
    if let Some(max_tx) = max_transaction_size_usd {
        policy.max_transaction_size_usd = max_tx;
    }
    if let Some(mode) = protocol_mode {
        require!(
            mode <= PROTOCOL_MODE_DENYLIST,
            PhalnxError::InvalidProtocolMode
        );
        policy.protocol_mode = mode;
    }
    if let Some(protos) = protocols {
        require!(
            protos.len() <= MAX_ALLOWED_PROTOCOLS,
            PhalnxError::TooManyAllowedProtocols
        );
        policy.protocols = protos;
    }
    if let Some(leverage) = max_leverage_bps {
        policy.max_leverage_bps = leverage;
    }
    if let Some(can_open) = can_open_positions {
        policy.can_open_positions = can_open;
    }
    if let Some(max_pos) = max_concurrent_positions {
        policy.max_concurrent_positions = max_pos;
    }
    if let Some(fee_rate) = developer_fee_rate {
        require!(
            fee_rate <= MAX_DEVELOPER_FEE_RATE,
            PhalnxError::DeveloperFeeTooHigh
        );
        policy.developer_fee_rate = fee_rate;
    }
    if let Some(slippage) = max_slippage_bps {
        require!(
            slippage <= MAX_SLIPPAGE_BPS,
            PhalnxError::SlippageBpsTooHigh
        );
        policy.max_slippage_bps = slippage;
    }
    if let Some(tl) = timelock_duration {
        policy.timelock_duration = tl;
    }
    if let Some(destinations) = allowed_destinations {
        require!(
            destinations.len() <= MAX_ALLOWED_DESTINATIONS,
            PhalnxError::TooManyDestinations
        );
        policy.allowed_destinations = destinations;
    }

    let clock = Clock::get()?;
    emit!(PolicyUpdated {
        vault: vault.key(),
        daily_cap_usd: policy.daily_spending_cap_usd,
        max_transaction_size_usd: policy.max_transaction_size_usd,
        protocol_mode: policy.protocol_mode,
        protocols_count: policy.protocols.len() as u8,
        max_leverage_bps: policy.max_leverage_bps,
        developer_fee_rate: policy.developer_fee_rate,
        max_slippage_bps: policy.max_slippage_bps,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
