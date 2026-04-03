use super::{VaultStatus, MAX_AGENTS_PER_VAULT};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct AgentEntry {
    pub pubkey: Pubkey,          // 32 bytes
    pub permissions: u64,        // 8 bytes
    pub spending_limit_usd: u64, // 8 bytes — 0 = no per-agent limit
    pub paused: bool,            // 1 byte  — owner-controlled suspension
}
// Total: 49 bytes per entry

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

    /// Number of currently open positions (for perps tracking).
    /// DESIGN DECISION: Counter-only. Does not store per-position details
    /// (entry price, size, liquidation price). Individual position data is
    /// protocol-specific (Flash Trade vs Drift vs Jupiter perps have different
    /// layouts). The SDK reads position details via RPC. sync_positions
    /// corrects counter drift from auto-liquidation.
    /// Found by: Persona test (Perps Developer "Jake")
    pub open_positions: u8,

    /// Number of active (unsettled/unrefunded) escrow deposits from this vault
    pub active_escrow_count: u8,

    /// Cumulative developer fees collected from this vault (token base units)
    pub total_fees_collected: u64,

    /// Cumulative stablecoin deposits in base units (USDC/USDT, 6 decimals).
    /// Incremented in deposit_funds for stablecoin mints only.
    /// Used for P&L: current_balance - total_deposited_usd + total_withdrawn_usd.
    /// Cumulative gross — never decremented. Informational only, never authorization input.
    pub total_deposited_usd: u64,

    /// Cumulative stablecoin withdrawals in base units (USDC/USDT, 6 decimals).
    /// Incremented in withdraw_funds for stablecoin mints only.
    pub total_withdrawn_usd: u64,

    /// Cumulative failed + expired session count.
    /// Incremented in finalize_session when success=false OR is_expired=true.
    /// Used for success rate: total_transactions / (total_transactions + total_failed_transactions).
    /// Informational only — never used in authorization decisions.
    pub total_failed_transactions: u64,

    /// Number of active (not yet finalized) sessions for this vault.
    /// Incremented in validate_and_authorize, decremented in finalize_session.
    /// close_vault requires this to be 0.
    pub active_sessions: u8,
}

// ARCHITECTURE DECISION: No on-chain viewer/delegate role
//
// The program has two roles: owner (full authority) and agent (execute within policy).
// There is no "viewer" or "delegate" role because:
//   1. All Solana account data is publicly readable via RPC.
//   2. Read-only access control is a dashboard/API concern, not on-chain.
//   3. Adding viewer entries would bloat account size with zero security benefit.
//   4. Delegate roles are handled by Squads V4 externally if the owner is a multisig.
//
// Found by: Persona test (Treasury Manager "David")
// Decision: By design. Dashboard RBAC handles this.

impl AgentVault {
    /// Account discriminator (8) + owner (32) + vault_id (8) +
    /// agents vec prefix (4) + agents data (49 * 10) +
    /// fee_destination (32) + status (1) + bump (1) +
    /// created_at (8) + total_transactions (8) + total_volume (8) +
    /// open_positions (1) + active_escrow_count (1) + total_fees_collected (8) +
    /// total_deposited_usd (8) + total_withdrawn_usd (8) + total_failed_transactions (8) +
    /// active_sessions (1)
    pub const SIZE: usize = 8
        + 32
        + 8
        + 4
        + (49 * MAX_AGENTS_PER_VAULT)
        + 32
        + 1
        + 1
        + 8
        + 8
        + 8
        + 1
        + 1
        + 8
        + 8
        + 8
        + 8
        + 1;
    // = 635

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

    pub fn is_agent_paused(&self, signer: &Pubkey) -> bool {
        self.get_agent(signer).map(|a| a.paused).unwrap_or(false)
    }
}

use super::ActionType;
