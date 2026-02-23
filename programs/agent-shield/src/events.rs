use crate::state::ActionType;
use anchor_lang::prelude::*;

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub vault_id: u64,
    pub timestamp: i64,
}

#[event]
pub struct FundsDeposited {
    pub vault: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct AgentRegistered {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct PolicyUpdated {
    pub vault: Pubkey,
    pub daily_cap_usd: u64,
    pub max_transaction_size_usd: u64,
    pub protocol_mode: u8,
    pub protocols_count: u8,
    pub max_leverage_bps: u16,
    pub developer_fee_rate: u16,
    pub timestamp: i64,
}

#[event]
pub struct ActionAuthorized {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub action_type: ActionType,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub usd_amount: u64,
    pub protocol: Pubkey,
    pub rolling_spend_usd_after: u64,
    pub daily_cap_usd: u64,
    pub delegated: bool,
    pub oracle_price: Option<i128>,
    pub oracle_source: Option<u8>,
    pub timestamp: i64,
}

#[event]
pub struct SessionFinalized {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub success: bool,
    pub is_expired: bool,
    pub timestamp: i64,
}

#[event]
pub struct DelegationRevoked {
    pub vault: Pubkey,
    pub token_account: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AgentRevoked {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct VaultReactivated {
    pub vault: Pubkey,
    pub new_agent: Option<Pubkey>,
    pub timestamp: i64,
}

#[event]
pub struct FundsWithdrawn {
    pub vault: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeesCollected {
    pub vault: Pubkey,
    pub token_mint: Pubkey,
    pub protocol_fee_amount: u64,
    pub developer_fee_amount: u64,
    pub protocol_fee_rate: u16,
    pub developer_fee_rate: u16,
    pub transaction_amount: u64,
    pub protocol_treasury: Pubkey,
    pub developer_fee_destination: Pubkey,
    pub cumulative_developer_fees: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultClosed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct PolicyChangeQueued {
    pub vault: Pubkey,
    pub executes_at: i64,
}

#[event]
pub struct PolicyChangeApplied {
    pub vault: Pubkey,
    pub applied_at: i64,
}

#[event]
pub struct PolicyChangeCancelled {
    pub vault: Pubkey,
}

#[event]
pub struct AgentTransferExecuted {
    pub vault: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
}

#[event]
pub struct OracleRegistryInitialized {
    pub authority: Pubkey,
    pub entry_count: u16,
}

#[event]
pub struct OracleRegistryUpdated {
    pub added_count: u16,
    pub removed_count: u16,
    pub total_entries: u16,
}
