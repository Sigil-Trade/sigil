use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::PolicyChangeQueued;
use crate::state::*;

#[derive(Accounts)]
pub struct QueuePolicyUpdate<'info> {
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
        init,
        payer = owner,
        space = PendingPolicyUpdate::SIZE,
        seeds = [b"pending_policy", vault.key().as_ref()],
        bump,
    )]
    pub pending_policy: Account<'info, PendingPolicyUpdate>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<QueuePolicyUpdate>,
    daily_spending_cap_usd: Option<u64>,
    max_transaction_amount_usd: Option<u64>,
    protocol_mode: Option<u8>,
    protocols: Option<Vec<Pubkey>>,
    developer_fee_rate: Option<u16>,
    max_slippage_bps: Option<u16>,
    timelock_duration: Option<u64>,
    allowed_destinations: Option<Vec<Pubkey>>,
    session_expiry_slots: Option<u64>,
    has_protocol_caps: Option<bool>,
    protocol_caps: Option<Vec<u64>>,
) -> Result<()> {
    crate::reject_cpi!();

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // Timelock must be configured to use queue
    require!(
        policy.timelock_duration > 0,
        SigilError::NoTimelockConfigured
    );

    // Validate bounded vectors if provided
    if let Some(ref mode) = protocol_mode {
        require!(
            *mode <= PROTOCOL_MODE_DENYLIST,
            SigilError::InvalidProtocolMode
        );
    }
    if let Some(ref protos) = protocols {
        require!(
            protos.len() <= MAX_ALLOWED_PROTOCOLS,
            SigilError::TooManyAllowedProtocols
        );
    }
    if let Some(ref fee_rate) = developer_fee_rate {
        require!(
            *fee_rate <= MAX_DEVELOPER_FEE_RATE,
            SigilError::DeveloperFeeTooHigh
        );
    }
    if let Some(ref slippage) = max_slippage_bps {
        require!(
            *slippage <= MAX_SLIPPAGE_BPS,
            SigilError::SlippageBpsTooHigh
        );
    }
    if let Some(ref destinations) = allowed_destinations {
        require!(
            destinations.len() <= MAX_ALLOWED_DESTINATIONS,
            SigilError::TooManyDestinations
        );
    }
    if let Some(ref tl) = timelock_duration {
        require!(*tl >= MIN_TIMELOCK_DURATION, SigilError::TimelockTooShort);
    }
    if let Some(ref expiry) = session_expiry_slots {
        if *expiry > 0 {
            require!(
                *expiry >= 10 && *expiry <= 450,
                SigilError::InvalidSessionExpiry
            );
        }
    }

    // Validate per-protocol caps consistency against resulting policy state
    {
        let effective_hpc = has_protocol_caps.unwrap_or(policy.has_protocol_caps);
        if effective_hpc {
            let effective_mode = protocol_mode.unwrap_or(policy.protocol_mode);
            require!(
                effective_mode == PROTOCOL_MODE_ALLOWLIST,
                SigilError::ProtocolCapsMismatch
            );
            let effective_protos_len = protocols
                .as_ref()
                .map_or(policy.protocols.len(), |p| p.len());
            let effective_caps_len = protocol_caps
                .as_ref()
                .map_or(policy.protocol_caps.len(), |c| c.len());
            require!(
                effective_caps_len == effective_protos_len,
                SigilError::ProtocolCapsMismatch
            );
        }
    }

    let clock = Clock::get()?;
    let executes_at = clock
        .unix_timestamp
        .checked_add(policy.timelock_duration as i64)
        .ok_or(SigilError::Overflow)?;

    let pending = &mut ctx.accounts.pending_policy;
    pending.vault = vault.key();
    pending.queued_at = clock.unix_timestamp;
    pending.executes_at = executes_at;
    pending.daily_spending_cap_usd = daily_spending_cap_usd;
    pending.max_transaction_amount_usd = max_transaction_amount_usd;
    pending.protocol_mode = protocol_mode;
    pending.protocols = protocols;
    pending.developer_fee_rate = developer_fee_rate;
    pending.max_slippage_bps = max_slippage_bps;
    pending.timelock_duration = timelock_duration;
    pending.allowed_destinations = allowed_destinations;
    pending.session_expiry_slots = session_expiry_slots;
    pending.has_protocol_caps = has_protocol_caps;
    pending.protocol_caps = protocol_caps;
    pending.bump = ctx.bumps.pending_policy;

    ctx.accounts.policy.has_pending_policy = true;

    emit!(PolicyChangeQueued {
        vault: vault.key(),
        executes_at,
    });

    Ok(())
}
