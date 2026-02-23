use super::VaultStatus;
use anchor_lang::prelude::*;

#[account]
pub struct AgentVault {
    /// The owner who created this vault (has full authority)
    pub owner: Pubkey,

    /// The registered agent's signing key (Pubkey::default() if not yet registered)
    pub agent: Pubkey,

    /// Developer fee destination — IMMUTABLE after initialization.
    /// Prevents a compromised owner from redirecting fees.
    pub fee_destination: Pubkey,

    /// Unique vault identifier (allows one owner to have multiple vaults)
    pub vault_id: u64,

    /// Vault status: Active, Frozen, or Closed
    pub status: VaultStatus,

    /// Bump seed for PDA derivation
    pub bump: u8,

    /// Unix timestamp of vault creation
    pub created_at: i64,

    /// Total number of agent transactions executed through this vault
    pub total_transactions: u64,

    /// Total volume processed in token base units
    pub total_volume: u64,

    /// Number of currently open positions (for perps tracking)
    pub open_positions: u8,

    /// Cumulative developer fees collected from this vault (token base units)
    pub total_fees_collected: u64,
}

impl AgentVault {
    /// Account discriminator (8) + owner (32) + agent (32) +
    /// fee_destination (32) + vault_id (8) + status (1) + bump (1) +
    /// created_at (8) + total_transactions (8) + total_volume (8) +
    /// open_positions (1) + total_fees_collected (8)
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 1 + 8;

    pub fn is_active(&self) -> bool {
        self.status == VaultStatus::Active
    }

    pub fn has_agent(&self) -> bool {
        self.agent != Pubkey::default()
    }

    pub fn is_agent(&self, signer: &Pubkey) -> bool {
        self.agent == *signer
    }

    pub fn is_owner(&self, signer: &Pubkey) -> bool {
        self.owner == *signer
    }
}
