use super::{MAX_ALLOWED_DESTINATIONS, MAX_ALLOWED_PROTOCOLS, SESSION_EXPIRY_SLOTS};
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
    /// Set true by create_instruction_constraints, false by apply_close_constraints.
    pub has_constraints: bool,

    /// Whether a pending policy update PDA exists for this vault.
    /// Set true by queue_policy_update, false by apply/cancel_pending_policy.
    pub has_pending_policy: bool,

    /// Whether per-protocol spend caps are configured.
    /// Requires protocol_mode == ALLOWLIST and protocol_caps.len() == protocols.len().
    pub has_protocol_caps: bool,

    /// Per-protocol daily spending caps in USD (6 decimals).
    /// Index-aligned with `protocols`. Only enforced when `has_protocol_caps = true`.
    /// A value of 0 means no per-protocol limit (global cap still applies).
    pub protocol_caps: Vec<u64>,

    /// Configurable session expiry in slots. 0 = use default (SESSION_EXPIRY_SLOTS = 20).
    /// Valid range when non-zero: 10-450 slots.
    pub session_expiry_slots: u64,

    /// Bump seed for PDA
    pub bump: u8,

    /// Policy version counter for OCC (optimistic concurrency control).
    /// Incremented on every apply_pending_policy and apply_constraints_update.
    /// Agents include expected_policy_version in validate_and_authorize;
    /// program rejects if version changed since the agent's RPC read.
    pub policy_version: u64,

    /// Whether native PostExecutionAssertions are configured for this vault.
    /// When true, finalize_session requires the assertions PDA in remaining_accounts.
    /// 0 = no assertions, non-zero = assertions required.
    pub has_post_assertions: u8,
}

impl PolicyConfig {
    /// Account discriminator (8) + vault (32) + daily_cap_usd (8) +
    /// max_tx_usd (8) + protocol_mode (1) +
    /// protocols vec (4 + 32 * MAX) +
    /// developer_fee_rate (2) + max_slippage_bps (2) + timelock_duration (8) +
    /// allowed_destinations vec (4 + 32 * MAX) + has_constraints (1) +
    /// has_pending_policy (1) + has_protocol_caps (1) +
    /// protocol_caps vec (4 + 8 * MAX) + session_expiry_slots (8) + bump (1) +
    /// policy_version (8) + has_post_assertions (1)
    pub const SIZE: usize = 8
        + 32
        + 8
        + 8
        + 1
        + (4 + 32 * MAX_ALLOWED_PROTOCOLS)
        + 2
        + 2 // max_slippage_bps
        + 8
        + (4 + 32 * MAX_ALLOWED_DESTINATIONS)
        + 1 // has_constraints
        + 1 // has_pending_policy
        + 1 // has_protocol_caps
        + (4 + 8 * MAX_ALLOWED_PROTOCOLS) // protocol_caps
        + 8 // session_expiry_slots
        + 1 // bump
        + 8 // policy_version
        + 1; // has_post_assertions

    /// Check if a protocol is allowed based on the protocol mode.
    pub fn is_protocol_allowed(&self, program_id: &Pubkey) -> bool {
        match self.protocol_mode {
            PROTOCOL_MODE_ALL => true,
            PROTOCOL_MODE_ALLOWLIST => self.protocols.contains(program_id),
            PROTOCOL_MODE_DENYLIST => !self.protocols.contains(program_id),
            _ => false, // invalid mode = deny all
        }
    }

    /// Check if a destination is allowed for agent transfers.
    /// Empty allowlist = any destination allowed.
    pub fn is_destination_allowed(&self, destination_owner: &Pubkey) -> bool {
        self.allowed_destinations.is_empty()
            || self.allowed_destinations.contains(destination_owner)
    }

    /// Get the per-protocol daily cap for a given protocol.
    /// Returns None if caps disabled, or Some(cap) where 0 means unlimited.
    pub fn get_protocol_cap(&self, protocol: &Pubkey) -> Option<u64> {
        if !self.has_protocol_caps {
            return None;
        }
        self.protocols
            .iter()
            .position(|p| p == protocol)
            .map(|i| self.protocol_caps.get(i).copied().unwrap_or(0))
    }

    /// Returns the effective session expiry in slots.
    /// 0 = use default (SESSION_EXPIRY_SLOTS = 20).
    pub fn effective_session_expiry_slots(&self) -> u64 {
        if self.session_expiry_slots == 0 {
            SESSION_EXPIRY_SLOTS
        } else {
            self.session_expiry_slots
        }
    }
}
