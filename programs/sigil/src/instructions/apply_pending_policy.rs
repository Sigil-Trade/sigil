use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::PolicyChangeApplied;
use crate::state::*;

#[derive(Accounts)]
pub struct ApplyPendingPolicy<'info> {
    #[account(mut)]
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

    #[account(
        mut,
        has_one = vault,
        seeds = [b"pending_policy", vault.key().as_ref()],
        bump = pending_policy.bump,
        close = owner,
    )]
    pub pending_policy: Account<'info, PendingPolicyUpdate>,
}

pub fn handler(ctx: Context<ApplyPendingPolicy>) -> Result<()> {
    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending_policy;

    // Timelock must have expired
    require!(
        pending.is_ready(clock.unix_timestamp),
        SigilError::TimelockNotExpired
    );

    let policy = &mut ctx.accounts.policy;

    // Apply each non-None field
    if let Some(cap) = pending.daily_spending_cap_usd {
        policy.daily_spending_cap_usd = cap;
    }
    if let Some(max_tx) = pending.max_transaction_amount_usd {
        policy.max_transaction_size_usd = max_tx;
    }
    if let Some(mode) = pending.protocol_mode {
        policy.protocol_mode = mode;
    }
    if let Some(ref protos) = pending.protocols {
        policy.protocols = protos.clone();
    }
    if let Some(leverage) = pending.max_leverage_bps {
        policy.max_leverage_bps = leverage;
    }
    if let Some(can_open) = pending.can_open_positions {
        policy.can_open_positions = can_open;
    }
    if let Some(max_pos) = pending.max_concurrent_positions {
        policy.max_concurrent_positions = max_pos;
    }
    if let Some(fee_rate) = pending.developer_fee_rate {
        policy.developer_fee_rate = fee_rate;
    }
    if let Some(slippage) = pending.max_slippage_bps {
        policy.max_slippage_bps = slippage;
    }
    if let Some(tl) = pending.timelock_duration {
        require!(tl >= MIN_TIMELOCK_DURATION, SigilError::TimelockTooShort);
        policy.timelock_duration = tl;
    }
    if let Some(ref destinations) = pending.allowed_destinations {
        policy.allowed_destinations = destinations.clone();
    }
    if let Some(expiry) = pending.session_expiry_slots {
        policy.session_expiry_slots = expiry;
    }
    if let Some(hpc) = pending.has_protocol_caps {
        policy.has_protocol_caps = hpc;
    }
    if let Some(ref caps) = pending.protocol_caps {
        policy.protocol_caps = caps.clone();
    }

    policy.has_pending_policy = false;

    // Bump policy version — agents will detect this via PolicyVersionMismatch
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    emit!(PolicyChangeApplied {
        vault: ctx.accounts.vault.key(),
        applied_at: clock.unix_timestamp,
    });

    Ok(())
}
