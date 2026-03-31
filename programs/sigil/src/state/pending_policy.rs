use super::{MAX_ALLOWED_DESTINATIONS, MAX_ALLOWED_PROTOCOLS};
use anchor_lang::prelude::*;

/// Queued policy update that becomes executable after a timelock period.
/// Created by `queue_policy_update`, applied by `apply_pending_policy`,
/// or cancelled by `cancel_pending_policy`.
///
/// PDA seeds: `[b"pending_policy", vault.key().as_ref()]`
#[account]
pub struct PendingPolicyUpdate {
    /// Associated vault pubkey
    pub vault: Pubkey,

    /// Unix timestamp when this update was queued
    pub queued_at: i64,

    /// Unix timestamp when this update becomes executable
    pub executes_at: i64,

    // All policy fields as Option<T> — only non-None fields are applied
    pub daily_spending_cap_usd: Option<u64>,
    pub max_transaction_amount_usd: Option<u64>,
    pub protocol_mode: Option<u8>,
    pub protocols: Option<Vec<Pubkey>>,
    pub max_leverage_bps: Option<u16>,
    pub can_open_positions: Option<bool>,
    pub max_concurrent_positions: Option<u8>,
    pub developer_fee_rate: Option<u16>,
    pub max_slippage_bps: Option<u16>,
    pub timelock_duration: Option<u64>,
    pub allowed_destinations: Option<Vec<Pubkey>>,
    pub session_expiry_slots: Option<u64>,
    pub has_protocol_caps: Option<bool>,
    pub protocol_caps: Option<Vec<u64>>,

    /// Bump seed for PDA
    pub bump: u8,
}

impl PendingPolicyUpdate {
    /// Worst-case size with all Option fields populated at max capacity.
    pub const SIZE: usize = 8
        + 32
        + 8
        + 8
        + (1 + 8) // daily_spending_cap_usd
        + (1 + 8) // max_transaction_amount_usd
        + (1 + 1) // protocol_mode
        + (1 + 4 + 32 * MAX_ALLOWED_PROTOCOLS) // protocols
        + (1 + 2) // max_leverage_bps
        + (1 + 1) // can_open_positions
        + (1 + 1) // max_concurrent_positions
        + (1 + 2) // developer_fee_rate
        + (1 + 2) // max_slippage_bps
        + (1 + 8) // timelock_duration
        + (1 + 4 + 32 * MAX_ALLOWED_DESTINATIONS) // allowed_destinations
        + (1 + 8) // session_expiry_slots
        + (1 + 1) // has_protocol_caps
        + (1 + 4 + 8 * MAX_ALLOWED_PROTOCOLS) // protocol_caps
        + 1; // bump

    /// Returns true if the timelock period has expired and the update
    /// can be applied.
    pub fn is_ready(&self, current_timestamp: i64) -> bool {
        current_timestamp >= self.executes_at
    }
}
