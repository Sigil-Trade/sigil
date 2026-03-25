use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::events::VaultCreated;
use crate::state::*;

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = AgentVault::SIZE,
        seeds = [b"vault", owner.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        init,
        payer = owner,
        space = PolicyConfig::SIZE,
        seeds = [b"policy", vault.key().as_ref()],
        bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Zero-copy SpendTracker
    #[account(
        init,
        payer = owner,
        space = SpendTracker::SIZE,
        seeds = [b"tracker", vault.key().as_ref()],
        bump,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Agent spend overlay — per-agent contribution tracking
    #[account(
        init,
        payer = owner,
        space = AgentSpendOverlay::SIZE,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    /// CHECK: This is the fee destination wallet; validated by the caller/SDK.
    pub fee_destination: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<InitializeVault>,
    vault_id: u64,
    daily_spending_cap_usd: u64,
    max_transaction_size_usd: u64,
    protocol_mode: u8,
    protocols: Vec<Pubkey>,
    max_leverage_bps: u16,
    max_concurrent_positions: u8,
    developer_fee_rate: u16,
    max_slippage_bps: u16,
    timelock_duration: u64,
    allowed_destinations: Vec<Pubkey>,
    protocol_caps: Vec<u64>,
) -> Result<()> {
    // Validate protocol_mode
    require!(
        protocol_mode <= PROTOCOL_MODE_DENYLIST,
        PhalnxError::InvalidProtocolMode
    );
    require!(
        protocols.len() <= MAX_ALLOWED_PROTOCOLS,
        PhalnxError::TooManyAllowedProtocols
    );
    require!(
        developer_fee_rate <= MAX_DEVELOPER_FEE_RATE,
        PhalnxError::DeveloperFeeTooHigh
    );
    require!(
        max_slippage_bps <= MAX_SLIPPAGE_BPS,
        PhalnxError::SlippageBpsTooHigh
    );
    require!(
        ctx.accounts.fee_destination.key() != Pubkey::default(),
        PhalnxError::InvalidFeeDestination
    );
    require!(
        allowed_destinations.len() <= MAX_ALLOWED_DESTINATIONS,
        PhalnxError::TooManyDestinations
    );

    // Validate per-protocol caps
    if !protocol_caps.is_empty() {
        require!(
            protocol_mode == PROTOCOL_MODE_ALLOWLIST,
            PhalnxError::ProtocolCapsMismatch
        );
        require!(
            protocol_caps.len() == protocols.len(),
            PhalnxError::ProtocolCapsMismatch
        );
    }

    let clock = Clock::get()?;

    // Initialize vault
    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.agents = Vec::new();
    vault.fee_destination = ctx.accounts.fee_destination.key();
    vault.vault_id = vault_id;
    vault.status = VaultStatus::Active;
    vault.bump = ctx.bumps.vault;
    vault.created_at = clock.unix_timestamp;
    vault.total_transactions = 0;
    vault.total_volume = 0;
    vault.open_positions = 0;
    vault.total_fees_collected = 0;
    vault.total_deposited_usd = 0;
    vault.total_withdrawn_usd = 0;
    vault.total_failed_transactions = 0;

    // Initialize policy
    let policy = &mut ctx.accounts.policy;
    policy.vault = vault.key();
    policy.daily_spending_cap_usd = daily_spending_cap_usd;
    policy.max_transaction_size_usd = max_transaction_size_usd;
    policy.protocol_mode = protocol_mode;
    policy.protocols = protocols;
    policy.max_leverage_bps = max_leverage_bps;
    policy.can_open_positions = true;
    policy.max_concurrent_positions = max_concurrent_positions;
    policy.developer_fee_rate = developer_fee_rate;
    policy.max_slippage_bps = max_slippage_bps;
    policy.timelock_duration = timelock_duration;
    policy.allowed_destinations = allowed_destinations;
    policy.has_constraints = false;
    policy.has_protocol_caps = !protocol_caps.is_empty();
    policy.protocol_caps = protocol_caps;
    policy.session_expiry_slots = 0;
    policy.bump = ctx.bumps.policy;

    // Initialize zero-copy tracker (buckets + protocol_counters zero-initialized by allocator)
    let mut tracker = ctx.accounts.tracker.load_init()?;
    tracker.vault = vault.key();
    tracker.bump = ctx.bumps.tracker;

    // Initialize agent spend overlay
    let mut overlay = ctx.accounts.agent_spend_overlay.load_init()?;
    overlay.vault = vault.key();
    overlay.bump = ctx.bumps.agent_spend_overlay;

    emit!(VaultCreated {
        vault: vault.key(),
        owner: ctx.accounts.owner.key(),
        vault_id,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
