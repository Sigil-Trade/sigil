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
    pub permissions: u64,
    pub spending_limit_usd: u64,
    pub timestamp: i64,
}

#[event]
pub struct AgentSpendLimitChecked {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub agent_rolling_spend: u64,
    pub spending_limit_usd: u64,
    pub amount: u64,
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
    pub max_slippage_bps: u16,
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
    /// DEPRECATED (v5): Always 0 since outcome-based spending.
    /// Actual rolling spend is in SessionFinalized.actual_spend_usd.
    /// Retained for IDL backward compatibility.
    pub rolling_spend_usd_after: u64,
    pub daily_cap_usd: u64,
    pub delegated: bool,
    pub timestamp: i64,
}

#[event]
pub struct SessionFinalized {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub success: bool,
    pub is_expired: bool,
    pub timestamp: i64,
    /// Actual stablecoin spend measured by balance delta (0 for non-spending actions).
    /// For stablecoin-input: outflow minus fees. For non-stablecoin-input: stablecoin gain.
    pub actual_spend_usd: u64,
    /// Vault stablecoin balance after this transaction (0 for non-spending).
    pub balance_after_usd: u64,
    /// ActionType as u8 for downstream classification (permission_bit() value, 0-20).
    pub action_type: u8,
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
    pub remaining_agents: u8,
    pub timestamp: i64,
}

#[event]
pub struct VaultReactivated {
    pub vault: Pubkey,
    pub new_agent: Option<Pubkey>,
    pub new_agent_permissions: Option<u64>,
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
pub struct AgentPermissionsUpdated {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub old_permissions: u64,
    pub new_permissions: u64,
}

#[event]
pub struct PositionsSynced {
    pub vault: Pubkey,
    pub old_count: u8,
    pub new_count: u8,
    pub timestamp: i64,
}

#[event]
pub struct InstructionConstraintsCreated {
    pub vault: Pubkey,
    pub entries_count: u8,
    pub strict_mode: bool,
    pub timestamp: i64,
}

#[event]
pub struct InstructionConstraintsUpdated {
    pub vault: Pubkey,
    pub entries_count: u8,
    pub strict_mode: bool,
    pub timestamp: i64,
}

#[event]
pub struct InstructionConstraintsClosed {
    pub vault: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ConstraintsChangeQueued {
    pub vault: Pubkey,
    pub executes_at: i64,
}

#[event]
pub struct ConstraintsChangeApplied {
    pub vault: Pubkey,
    pub applied_at: i64,
}

#[event]
pub struct ConstraintsChangeCancelled {
    pub vault: Pubkey,
}

#[event]
pub struct EscrowCreated {
    pub source_vault: Pubkey,
    pub destination_vault: Pubkey,
    pub escrow_id: u64,
    pub amount: u64,
    pub token_mint: Pubkey,
    pub expires_at: i64,
    pub condition_hash: [u8; 32],
}

#[event]
pub struct EscrowSettled {
    pub source_vault: Pubkey,
    pub destination_vault: Pubkey,
    pub escrow_id: u64,
    pub amount: u64,
    pub settled_by: Pubkey,
}

#[event]
pub struct EscrowRefunded {
    pub source_vault: Pubkey,
    pub destination_vault: Pubkey,
    pub escrow_id: u64,
    pub amount: u64,
    pub refunded_by: Pubkey,
}

#[event]
pub struct VaultFrozen {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub agents_preserved: u8,
    pub timestamp: i64,
}

#[event]
pub struct AgentPausedEvent {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AgentUnpausedEvent {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub timestamp: i64,
}
