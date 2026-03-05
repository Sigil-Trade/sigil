#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

#[cfg(feature = "certora")]
mod certora;

use instructions::*;

declare_id!("4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL");

#[allow(clippy::too_many_arguments)]
#[program]
pub mod phalnx {
    use super::*;

    /// Initialize a new agent vault with policy configuration.
    /// Only the owner can call this. Creates vault PDA, policy PDA,
    /// and zero-copy spend tracker PDA.
    pub fn initialize_vault(
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
    ) -> Result<()> {
        instructions::initialize_vault::handler(
            ctx,
            vault_id,
            daily_spending_cap_usd,
            max_transaction_size_usd,
            protocol_mode,
            protocols,
            max_leverage_bps,
            max_concurrent_positions,
            developer_fee_rate,
            max_slippage_bps,
            timelock_duration,
            allowed_destinations,
        )
    }

    /// Deposit SPL tokens into the vault's PDA-controlled token account.
    /// Only the owner can call this.
    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        instructions::deposit_funds::handler(ctx, amount)
    }

    /// Register an agent's signing key to this vault with per-agent permissions.
    /// Only the owner can call this. Up to 10 agents per vault.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent: Pubkey,
        permissions: u64,
    ) -> Result<()> {
        instructions::register_agent::handler(ctx, agent, permissions)
    }

    /// Update the policy configuration for a vault.
    /// Only the owner can call this. Blocked when timelock > 0.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        daily_spending_cap_usd: Option<u64>,
        max_transaction_size_usd: Option<u64>,
        protocol_mode: Option<u8>,
        protocols: Option<Vec<Pubkey>>,
        max_leverage_bps: Option<u16>,
        can_open_positions: Option<bool>,
        max_concurrent_positions: Option<u8>,
        developer_fee_rate: Option<u16>,
        max_slippage_bps: Option<u16>,
        timelock_duration: Option<u64>,
        allowed_destinations: Option<Vec<Pubkey>>,
    ) -> Result<()> {
        instructions::update_policy::handler(
            ctx,
            daily_spending_cap_usd,
            max_transaction_size_usd,
            protocol_mode,
            protocols,
            max_leverage_bps,
            can_open_positions,
            max_concurrent_positions,
            developer_fee_rate,
            max_slippage_bps,
            timelock_duration,
            allowed_destinations,
        )
    }

    /// Core permission check. Called by the agent before a DeFi action.
    /// Validates against policy constraints, stablecoin-only enforcement,
    /// and protocol slippage verification.
    /// Creates a SessionAuthority PDA, delegates tokens to agent.
    pub fn validate_and_authorize(
        ctx: Context<ValidateAndAuthorize>,
        action_type: state::ActionType,
        token_mint: Pubkey,
        amount: u64,
        target_protocol: Pubkey,
        leverage_bps: Option<u16>,
    ) -> Result<()> {
        instructions::validate_and_authorize::handler(
            ctx,
            action_type,
            token_mint,
            amount,
            target_protocol,
            leverage_bps,
        )
    }

    /// Finalize a session after the DeFi action completes.
    /// Revokes delegation and closes the SessionAuthority PDA.
    pub fn finalize_session(ctx: Context<FinalizeSession>, success: bool) -> Result<()> {
        instructions::finalize_session::handler(ctx, success)
    }

    /// Revoke a specific agent from the vault.
    /// Only the owner can call this. Freezes vault if last agent is removed.
    pub fn revoke_agent(ctx: Context<RevokeAgent>, agent_to_remove: Pubkey) -> Result<()> {
        instructions::revoke_agent::handler(ctx, agent_to_remove)
    }

    /// Reactivate a frozen vault. Optionally add a new agent with permissions.
    pub fn reactivate_vault(
        ctx: Context<ReactivateVault>,
        new_agent: Option<Pubkey>,
        new_agent_permissions: Option<u64>,
    ) -> Result<()> {
        instructions::reactivate_vault::handler(ctx, new_agent, new_agent_permissions)
    }

    /// Withdraw tokens from the vault back to the owner.
    pub fn withdraw_funds(ctx: Context<WithdrawFunds>, amount: u64) -> Result<()> {
        instructions::withdraw_funds::handler(ctx, amount)
    }

    /// Close the vault entirely. Reclaims rent from all PDAs.
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        instructions::close_vault::handler(ctx)
    }

    /// Queue a policy update when timelock is active.
    pub fn queue_policy_update(
        ctx: Context<QueuePolicyUpdate>,
        daily_spending_cap_usd: Option<u64>,
        max_transaction_amount_usd: Option<u64>,
        protocol_mode: Option<u8>,
        protocols: Option<Vec<Pubkey>>,
        max_leverage_bps: Option<u16>,
        can_open_positions: Option<bool>,
        max_concurrent_positions: Option<u8>,
        developer_fee_rate: Option<u16>,
        max_slippage_bps: Option<u16>,
        timelock_duration: Option<u64>,
        allowed_destinations: Option<Vec<Pubkey>>,
    ) -> Result<()> {
        instructions::queue_policy_update::handler(
            ctx,
            daily_spending_cap_usd,
            max_transaction_amount_usd,
            protocol_mode,
            protocols,
            max_leverage_bps,
            can_open_positions,
            max_concurrent_positions,
            developer_fee_rate,
            max_slippage_bps,
            timelock_duration,
            allowed_destinations,
        )
    }

    /// Apply a queued policy update after the timelock expires.
    pub fn apply_pending_policy(ctx: Context<ApplyPendingPolicy>) -> Result<()> {
        instructions::apply_pending_policy::handler(ctx)
    }

    /// Cancel a queued policy update.
    pub fn cancel_pending_policy(ctx: Context<CancelPendingPolicy>) -> Result<()> {
        instructions::cancel_pending_policy::handler(ctx)
    }

    /// Create instruction constraints for the vault.
    /// Only the owner can call this. No timelock check (additive change).
    pub fn create_instruction_constraints(
        ctx: Context<CreateInstructionConstraints>,
        entries: Vec<state::ConstraintEntry>,
    ) -> Result<()> {
        instructions::create_instruction_constraints::handler(ctx, entries)
    }

    /// Close instruction constraints for the vault.
    /// Only the owner can call this. Blocked when timelock > 0 (removing constraints loosens security).
    pub fn close_instruction_constraints(ctx: Context<CloseInstructionConstraints>) -> Result<()> {
        instructions::close_instruction_constraints::handler(ctx)
    }

    /// Update instruction constraints for the vault.
    /// Only the owner can call this. Blocked when timelock > 0.
    pub fn update_instruction_constraints(
        ctx: Context<UpdateInstructionConstraints>,
        entries: Vec<state::ConstraintEntry>,
    ) -> Result<()> {
        instructions::update_instruction_constraints::handler(ctx, entries)
    }

    /// Queue a constraints update when timelock is active.
    pub fn queue_constraints_update(
        ctx: Context<QueueConstraintsUpdate>,
        entries: Vec<state::ConstraintEntry>,
    ) -> Result<()> {
        instructions::queue_constraints_update::handler(ctx, entries)
    }

    /// Apply a queued constraints update after the timelock expires.
    pub fn apply_constraints_update(ctx: Context<ApplyConstraintsUpdate>) -> Result<()> {
        instructions::apply_constraints_update::handler(ctx)
    }

    /// Cancel a queued constraints update.
    pub fn cancel_constraints_update(ctx: Context<CancelConstraintsUpdate>) -> Result<()> {
        instructions::cancel_constraints_update::handler(ctx)
    }

    /// Transfer tokens from the vault to an allowed destination.
    /// Only the agent can call this. Stablecoin-only.
    pub fn agent_transfer(ctx: Context<AgentTransfer>, amount: u64) -> Result<()> {
        instructions::agent_transfer::handler(ctx, amount)
    }

    /// Update an agent's permission bitmask.
    /// Only the owner can call this. Blocked when timelock is active.
    pub fn update_agent_permissions(
        ctx: Context<UpdateAgentPermissions>,
        agent: Pubkey,
        new_permissions: u64,
    ) -> Result<()> {
        instructions::update_agent_permissions::handler(ctx, agent, new_permissions)
    }

    /// Sync the vault's open position counter with the actual state.
    pub fn sync_positions(ctx: Context<SyncPositions>, actual_positions: u8) -> Result<()> {
        instructions::sync_positions::handler(ctx, actual_positions)
    }

    /// Create an escrow deposit between two vaults.
    /// Agent-initiated, stablecoin-only, fees deducted upfront, cap-checked.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        escrow_id: u64,
        amount: u64,
        expires_at: i64,
        condition_hash: [u8; 32],
    ) -> Result<()> {
        instructions::create_escrow::handler(ctx, escrow_id, amount, expires_at, condition_hash)
    }

    /// Settle an escrow — destination vault's agent claims funds before expiry.
    /// For conditional escrows, proof must match the SHA-256 condition hash.
    pub fn settle_escrow(ctx: Context<SettleEscrow>, proof: Vec<u8>) -> Result<()> {
        instructions::settle_escrow::handler(ctx, proof)
    }

    /// Refund an escrow — source vault's agent or owner reclaims funds after expiry.
    /// Cap charge is NOT reversed (prevents cap-washing attacks).
    pub fn refund_escrow(ctx: Context<RefundEscrow>) -> Result<()> {
        instructions::refund_escrow::handler(ctx)
    }

    /// Close a settled/refunded escrow PDA — owner reclaims rent.
    pub fn close_settled_escrow(ctx: Context<CloseSettledEscrow>, escrow_id: u64) -> Result<()> {
        instructions::close_settled_escrow::handler(ctx, escrow_id)
    }
}
