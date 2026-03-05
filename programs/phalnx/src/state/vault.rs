use super::{VaultStatus, MAX_AGENTS_PER_VAULT};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct AgentEntry {
    pub pubkey: Pubkey,   // 32 bytes
    pub permissions: u64, // 8 bytes
}
// Total: 40 bytes per entry

#[account]
pub struct AgentVault {
    /// The owner who created this vault (has full authority)
    pub owner: Pubkey,

    /// Unique vault identifier (allows one owner to have multiple vaults)
    pub vault_id: u64,

    /// Registered agents with per-agent permission bitmasks (max 10)
    pub agents: Vec<AgentEntry>,

    /// Developer fee destination — IMMUTABLE after initialization.
    /// Prevents a compromised owner from redirecting fees.
    pub fee_destination: Pubkey,

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
    /// Account discriminator (8) + owner (32) + vault_id (8) +
    /// agents vec prefix (4) + agents data (40 * 10) +
    /// fee_destination (32) + status (1) + bump (1) +
    /// created_at (8) + total_transactions (8) + total_volume (8) +
    /// open_positions (1) + total_fees_collected (8)
    pub const SIZE: usize =
        8 + 32 + 8 + 4 + (40 * MAX_AGENTS_PER_VAULT) + 32 + 1 + 1 + 8 + 8 + 8 + 1 + 8;
    // = 519

    pub fn is_active(&self) -> bool {
        self.status == VaultStatus::Active
    }

    pub fn has_agent(&self) -> bool {
        !self.agents.is_empty()
    }

    pub fn is_agent(&self, signer: &Pubkey) -> bool {
        self.agents.iter().any(|a| a.pubkey == *signer)
    }

    pub fn get_agent(&self, signer: &Pubkey) -> Option<&AgentEntry> {
        self.agents.iter().find(|a| a.pubkey == *signer)
    }

    pub fn has_permission(&self, signer: &Pubkey, action_type: &ActionType) -> bool {
        self.get_agent(signer)
            .map(|a| a.permissions & (1u64 << action_type.permission_bit()) != 0)
            .unwrap_or(false)
    }

    pub fn agent_count(&self) -> usize {
        self.agents.len()
    }

    pub fn is_owner(&self, signer: &Pubkey) -> bool {
        self.owner == *signer
    }
}

use super::ActionType;
