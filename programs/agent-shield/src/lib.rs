#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod oracle;
pub mod state;

#[cfg(feature = "certora")]
mod certora;

use instructions::*;

declare_id!("4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL");

#[allow(clippy::too_many_arguments)]
#[program]
pub mod agent_shield {
    use super::*;

    /// Initialize the protocol-level oracle registry.
    /// Only called once. The authority becomes the registry admin.
    pub fn initialize_oracle_registry(
        ctx: Context<InitializeOracleRegistry>,
        entries: Vec<state::OracleEntry>,
    ) -> Result<()> {
        instructions::initialize_oracle_registry::handler(ctx, entries)
    }

    /// Add or remove entries from the oracle registry.
    /// Only the registry authority can call this.
    pub fn update_oracle_registry(
        ctx: Context<UpdateOracleRegistry>,
        entries_to_add: Vec<state::OracleEntry>,
        mints_to_remove: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::update_oracle_registry::handler(ctx, entries_to_add, mints_to_remove)
    }

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
            timelock_duration,
            allowed_destinations,
        )
    }

    /// Deposit SPL tokens into the vault's PDA-controlled token account.
    /// Only the owner can call this.
    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        instructions::deposit_funds::handler(ctx, amount)
    }

    /// Register an agent's signing key to this vault.
    /// Only the owner can call this. One agent per vault.
    pub fn register_agent(ctx: Context<RegisterAgent>, agent: Pubkey) -> Result<()> {
        instructions::register_agent::handler(ctx, agent)
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
            timelock_duration,
            allowed_destinations,
        )
    }

    /// Core permission check. Called by the agent before a DeFi action.
    /// Validates against policy constraints + oracle registry.
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
    /// Revokes delegation, collects fees, closes the SessionAuthority PDA.
    pub fn finalize_session(ctx: Context<FinalizeSession>, success: bool) -> Result<()> {
        instructions::finalize_session::handler(ctx, success)
    }

    /// Kill switch. Immediately freezes the vault.
    /// Only the owner can call this.
    pub fn revoke_agent(ctx: Context<RevokeAgent>) -> Result<()> {
        instructions::revoke_agent::handler(ctx)
    }

    /// Reactivate a frozen vault. Optionally rotate the agent key.
    pub fn reactivate_vault(
        ctx: Context<ReactivateVault>,
        new_agent: Option<Pubkey>,
    ) -> Result<()> {
        instructions::reactivate_vault::handler(ctx, new_agent)
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

    /// Transfer tokens from the vault to an allowed destination.
    /// Only the agent can call this.
    pub fn agent_transfer(ctx: Context<AgentTransfer>, amount: u64) -> Result<()> {
        instructions::agent_transfer::handler(ctx, amount)
    }
}
