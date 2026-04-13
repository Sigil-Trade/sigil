use anchor_lang::prelude::*;

#[account]
pub struct SessionAuthority {
    /// Associated vault
    pub vault: Pubkey,

    /// The agent who initiated this session
    pub agent: Pubkey,

    /// Whether this session has been authorized by the permission check
    pub authorized: bool,

    /// Authorized action details (for verification in finalize)
    pub authorized_amount: u64,
    pub authorized_token: Pubkey,
    pub authorized_protocol: Pubkey,

    /// Whether the matched constraint entry classifies this as spending.
    /// Derived from amount > 0 in validate_and_authorize.
    pub is_spending: bool,

    /// Position effect from matched constraint entry (0=None, 1=Increment, 2=Decrement).
    pub position_effect: u8,

    /// Slot-based expiry: session is valid until this slot
    pub expires_at_slot: u64,

    /// Whether token delegation was set up (approve CPI)
    pub delegated: bool,

    /// The vault's token account that was delegated to the agent
    /// (only meaningful when delegated == true)
    pub delegation_token_account: Pubkey,

    /// Protocol fee collected during validate (for event logging in finalize)
    pub protocol_fee: u64,

    /// Developer fee collected during validate (for event logging in finalize)
    pub developer_fee: u64,

    /// Stablecoin mint for outcome-based spending detection.
    /// For stablecoin input: set to authorized_token (the stablecoin being spent).
    /// For non-stablecoin input: set to the expected stablecoin output mint.
    /// Pubkey::default() for non-spending actions (no outcome check needed).
    pub output_mint: Pubkey,

    /// Snapshot of the relevant stablecoin account balance before the swap.
    /// For stablecoin input: vault_token_account.amount (taken before fee collection).
    /// For non-stablecoin input: output_stablecoin_account.amount.
    /// 0 for non-spending actions.
    pub stablecoin_balance_before: u64,

    /// Bump seed for PDA
    pub bump: u8,

    /// Phase B2: Snapshots of target account bytes captured in validate_and_authorize
    /// before DeFi instruction executes. Index i corresponds to PostAssertionEntry i.
    /// Used by delta assertion modes (1=MaxDecrease, 2=MaxIncrease, 3=NoChange).
    pub assertion_snapshots: [[u8; 32]; 4],

    /// Phase B2: Actual value_len captured for each snapshot.
    /// 0 = no snapshot captured (mode 0 entries). Non-zero = snapshot was captured.
    /// finalize_session cross-checks snapshot_lens[i] == entry.value_len.
    pub snapshot_lens: [u8; 4],
}

impl SessionAuthority {
    /// discriminator (8) + vault (32) + agent (32) + authorized (1) +
    /// amount (8) + token (32) + protocol (32) + is_spending (1) + position_effect (1) +
    /// expires (8) + delegated (1) + delegation_token_account (32) +
    /// protocol_fee (8) + developer_fee (8) +
    /// output_mint (32) + stablecoin_balance_before (8) + bump (1) +
    /// assertion_snapshots (128) + snapshot_lens (4)
    pub const SIZE: usize =
        8 + 32 + 32 + 1 + 8 + 32 + 32 + 1 + 1 + 8 + 1 + 32 + 8 + 8 + 32 + 8 + 1 + 128 + 4;

    pub fn is_expired(&self, current_slot: u64) -> bool {
        current_slot > self.expires_at_slot
    }

    pub fn is_valid(&self, current_slot: u64) -> bool {
        self.authorized && !self.is_expired(current_slot)
    }

    /// Calculate the expiry slot from a given current slot and expiry window
    pub fn calculate_expiry(current_slot: u64, expiry_slots: u64) -> u64 {
        // Saturating add to prevent overflow
        current_slot.saturating_add(expiry_slots)
    }
}
