use super::{MAX_ALLOWED_DESTINATIONS, MAX_ALLOWED_PROTOCOLS};
use anchor_lang::prelude::*;

/// Protocol access control mode: all protocols allowed
pub const PROTOCOL_MODE_ALL: u8 = 0;
/// Protocol access control mode: only protocols in list allowed
pub const PROTOCOL_MODE_ALLOWLIST: u8 = 1;
/// Protocol access control mode: all except protocols in list
pub const PROTOCOL_MODE_DENYLIST: u8 = 2;

#[account]
pub struct PolicyConfig {
    /// Associated vault pubkey
    pub vault: Pubkey,

    /// Maximum aggregate spend per rolling 24h period in USD (6 decimals).
    /// $500 = 500_000_000. This is the primary spending cap.
    pub daily_spending_cap_usd: u64,

    /// Maximum single transaction size in USD (6 decimals).
    pub max_transaction_size_usd: u64,

    /// Protocol access control mode:
    ///   0 = all allowed (protocols list ignored)
    ///   1 = allowlist (only protocols in list)
    ///   2 = denylist (all except protocols in list)
    pub protocol_mode: u8,

    /// Protocol pubkeys for allowlist/denylist.
    /// Bounded to MAX_ALLOWED_PROTOCOLS entries.
    pub protocols: Vec<Pubkey>,

    /// Maximum leverage multiplier in basis points (e.g., 10000 = 100x)
    /// Set to 0 to disallow leveraged positions entirely
    pub max_leverage_bps: u16,

    /// Whether the agent can open new positions (vs only close existing)
    pub can_open_positions: bool,

    /// Maximum number of concurrent open positions
    pub max_concurrent_positions: u8,

    /// Developer fee rate (rate / 1,000,000). Applied to every finalized
    /// transaction. Max MAX_DEVELOPER_FEE_RATE (500 = 5 BPS).
    pub developer_fee_rate: u16,

    /// Maximum slippage tolerance for Jupiter swaps in basis points.
    /// 0 = reject all swaps (vault owner must explicitly configure).
    /// Enforced on-chain via instruction introspection of Jupiter data.
    pub max_slippage_bps: u16,

    /// Timelock duration in seconds for policy changes. 0 = no timelock.
    pub timelock_duration: u64,

    /// Allowed destination addresses for agent transfers.
    /// Empty = any destination allowed. Bounded to MAX_ALLOWED_DESTINATIONS.
    pub allowed_destinations: Vec<Pubkey>,

    /// Whether instruction constraints PDA exists for this vault.
    /// Set true by create_instruction_constraints, false by close_instruction_constraints.
    pub has_constraints: bool,

    /// Bump seed for PDA
    pub bump: u8,
}

impl PolicyConfig {
    /// Account discriminator (8) + vault (32) + daily_cap_usd (8) +
    /// max_tx_usd (8) + protocol_mode (1) +
    /// protocols vec (4 + 32 * MAX) +
    /// max_leverage (2) + can_open (1) + max_positions (1) +
    /// developer_fee_rate (2) + max_slippage_bps (2) + timelock_duration (8) +
    /// allowed_destinations vec (4 + 32 * MAX) + has_constraints (1) + bump (1)
    pub const SIZE: usize = 8
        + 32
        + 8
        + 8
        + 1
        + (4 + 32 * MAX_ALLOWED_PROTOCOLS)
        + 2
        + 1
        + 1
        + 2
        + 2 // max_slippage_bps
        + 8
        + (4 + 32 * MAX_ALLOWED_DESTINATIONS)
        + 1 // has_constraints
        + 1;

    /// Check if a protocol is allowed based on the protocol mode.
    pub fn is_protocol_allowed(&self, program_id: &Pubkey) -> bool {
        match self.protocol_mode {
            PROTOCOL_MODE_ALL => true,
            PROTOCOL_MODE_ALLOWLIST => self.protocols.contains(program_id),
            PROTOCOL_MODE_DENYLIST => !self.protocols.contains(program_id),
            _ => false, // invalid mode = deny all
        }
    }

    pub fn is_leverage_within_limit(&self, leverage_bps: u16) -> bool {
        leverage_bps <= self.max_leverage_bps
    }

    /// Check if a destination is allowed for agent transfers.
    /// Empty allowlist = any destination allowed.
    pub fn is_destination_allowed(&self, destination_owner: &Pubkey) -> bool {
        self.allowed_destinations.is_empty()
            || self.allowed_destinations.contains(destination_owner)
    }
}
