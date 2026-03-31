use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::PolicyUpdated;
use crate::state::*;

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
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
    session_expiry_slots: Option<u64>,
    has_protocol_caps: Option<bool>,
    protocol_caps: Option<Vec<u64>>,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    let policy = &mut ctx.accounts.policy;

    // When timelock > 0, immediate updates are blocked
    require!(policy.timelock_duration == 0, SigilError::TimelockActive);

    if let Some(cap) = daily_spending_cap_usd {
        policy.daily_spending_cap_usd = cap;
    }
    if let Some(max_tx) = max_transaction_size_usd {
        policy.max_transaction_size_usd = max_tx;
    }
    if let Some(mode) = protocol_mode {
        require!(
            mode <= PROTOCOL_MODE_DENYLIST,
            SigilError::InvalidProtocolMode
        );
        policy.protocol_mode = mode;
    }
    if let Some(protos) = protocols {
        require!(
            protos.len() <= MAX_ALLOWED_PROTOCOLS,
            SigilError::TooManyAllowedProtocols
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
            SigilError::DeveloperFeeTooHigh
        );
        policy.developer_fee_rate = fee_rate;
    }
    if let Some(slippage) = max_slippage_bps {
        require!(
            slippage <= MAX_SLIPPAGE_BPS,
            SigilError::SlippageBpsTooHigh
        );
        policy.max_slippage_bps = slippage;
    }
    if let Some(tl) = timelock_duration {
        policy.timelock_duration = tl;
    }
    if let Some(destinations) = allowed_destinations {
        require!(
            destinations.len() <= MAX_ALLOWED_DESTINATIONS,
            SigilError::TooManyDestinations
        );
        policy.allowed_destinations = destinations;
    }
    if let Some(expiry) = session_expiry_slots {
        if expiry > 0 {
            require!(
                (10..=450).contains(&expiry),
                SigilError::InvalidSessionExpiry
            );
        }
        policy.session_expiry_slots = expiry;
    }
    if let Some(caps) = protocol_caps {
        policy.protocol_caps = caps;
    }
    if let Some(hpc) = has_protocol_caps {
        policy.has_protocol_caps = hpc;
    }

    // Validate consistency: if has_protocol_caps is true, mode must be ALLOWLIST
    // and protocol_caps.len() must match protocols.len()
    if policy.has_protocol_caps {
        require!(
            policy.protocol_mode == PROTOCOL_MODE_ALLOWLIST,
            SigilError::ProtocolCapsMismatch
        );
        require!(
            policy.protocol_caps.len() == policy.protocols.len(),
            SigilError::ProtocolCapsMismatch
        );
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
