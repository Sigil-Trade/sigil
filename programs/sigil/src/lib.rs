#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

#[cfg(feature = "certora")]
mod certora;

use instructions::*;
use state::post_assertions::PostAssertionEntry;

declare_id!("4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL");

#[allow(clippy::too_many_arguments)]
#[program]
pub mod sigil {
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
        developer_fee_rate: u16,
        max_slippage_bps: u16,
        timelock_duration: u64,
        allowed_destinations: Vec<Pubkey>,
        protocol_caps: Vec<u64>,
    ) -> Result<()> {
        instructions::initialize_vault::handler(
            ctx,
            vault_id,
            daily_spending_cap_usd,
            max_transaction_size_usd,
            protocol_mode,
            protocols,
            developer_fee_rate,
            max_slippage_bps,
            timelock_duration,
            allowed_destinations,
            protocol_caps,
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
        capability: u8,
        spending_limit_usd: u64,
    ) -> Result<()> {
        instructions::register_agent::handler(ctx, agent, capability, spending_limit_usd)
    }

    // update_policy DELETED — all policy changes now route through
    // queue_policy_update → apply_pending_policy with mandatory timelock.

    /// Core permission check. Called by the agent before a DeFi action.
    /// Validates against policy constraints, stablecoin-only enforcement,
    /// and protocol slippage verification.
    /// Creates a SessionAuthority PDA, delegates tokens to agent.
    pub fn validate_and_authorize(
        ctx: Context<ValidateAndAuthorize>,
        token_mint: Pubkey,
        amount: u64,
        target_protocol: Pubkey,
        expected_policy_version: u64,
    ) -> Result<()> {
        instructions::validate_and_authorize::handler(
            ctx,
            token_mint,
            amount,
            target_protocol,
            expected_policy_version,
        )
    }

    /// Finalize a session after the DeFi action completes.
    /// Revokes delegation, closes SessionAuthority PDA.
    pub fn finalize_session(ctx: Context<FinalizeSession>) -> Result<()> {
        instructions::finalize_session::handler(ctx)
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
        new_agent_capability: Option<u8>,
    ) -> Result<()> {
        instructions::reactivate_vault::handler(ctx, new_agent, new_agent_capability)
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
        developer_fee_rate: Option<u16>,
        max_slippage_bps: Option<u16>,
        timelock_duration: Option<u64>,
        allowed_destinations: Option<Vec<Pubkey>>,
        session_expiry_slots: Option<u64>,
        has_protocol_caps: Option<bool>,
        protocol_caps: Option<Vec<u64>>,
    ) -> Result<()> {
        instructions::queue_policy_update::handler(
            ctx,
            daily_spending_cap_usd,
            max_transaction_amount_usd,
            protocol_mode,
            protocols,
            developer_fee_rate,
            max_slippage_bps,
            timelock_duration,
            allowed_destinations,
            session_expiry_slots,
            has_protocol_caps,
            protocol_caps,
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

    /// Allocate the InstructionConstraints PDA at 10,240 bytes (CPI limit).
    /// Must be followed by extend_pda calls + create_instruction_constraints
    /// in the same atomic transaction to reach full SIZE.
    pub fn allocate_constraints_pda(ctx: Context<AllocateConstraintsPda>) -> Result<()> {
        instructions::allocate_constraints_pda::handler(ctx)
    }

    /// Allocate the PendingConstraintsUpdate PDA at 10,240 bytes (CPI limit).
    /// Must be followed by extend_pda calls + queue_constraints_update
    /// in the same atomic transaction.
    pub fn allocate_pending_constraints_pda(
        ctx: Context<AllocatePendingConstraintsPda>,
    ) -> Result<()> {
        instructions::allocate_pending_constraints_pda::handler(ctx)
    }

    /// Grow a program-owned PDA by up to 10,240 bytes per call.
    /// Used to extend constraints/pending PDAs to full SIZE before population.
    pub fn extend_pda(ctx: Context<ExtendPda>, target_size: u32) -> Result<()> {
        instructions::extend_pda::handler(ctx, target_size)
    }

    /// Populate a pre-allocated InstructionConstraints PDA with entries.
    /// Only the owner can call this. PDA must be at full SIZE.
    pub fn create_instruction_constraints(
        ctx: Context<CreateInstructionConstraints>,
        entries: Vec<state::ConstraintEntry>,
        strict_mode: bool,
    ) -> Result<()> {
        instructions::create_instruction_constraints::handler(ctx, entries, strict_mode)
    }

    // close_instruction_constraints DELETED — use queue_close_constraints → apply_close_constraints.
    // update_instruction_constraints DELETED — use queue_constraints_update → apply_constraints_update.

    /// Queue a constraints update when timelock is active.
    pub fn queue_constraints_update(
        ctx: Context<QueueConstraintsUpdate>,
        entries: Vec<state::ConstraintEntry>,
        strict_mode: bool,
    ) -> Result<()> {
        instructions::queue_constraints_update::handler(ctx, entries, strict_mode)
    }

    /// Apply a queued constraints update after the timelock expires.
    pub fn apply_constraints_update(ctx: Context<ApplyConstraintsUpdate>) -> Result<()> {
        instructions::apply_constraints_update::handler(ctx)
    }

    /// Cancel a queued constraints update.
    pub fn cancel_constraints_update(ctx: Context<CancelConstraintsUpdate>) -> Result<()> {
        instructions::cancel_constraints_update::handler(ctx)
    }

    /// Queue a constraint closure. Timelock-gated.
    pub fn queue_close_constraints(ctx: Context<QueueCloseConstraints>) -> Result<()> {
        instructions::queue_close_constraints::handler(ctx)
    }

    /// Apply a queued constraint closure after timelock expires.
    /// Closes the constraints PDA, clears policy.has_constraints, bumps policy_version.
    pub fn apply_close_constraints(ctx: Context<ApplyCloseConstraints>) -> Result<()> {
        instructions::apply_close_constraints::handler(ctx)
    }

    /// Cancel a queued constraint closure.
    pub fn cancel_close_constraints(ctx: Context<CancelCloseConstraints>) -> Result<()> {
        instructions::cancel_close_constraints::handler(ctx)
    }

    // ─── Post-Execution Assertions (Phase B) ─────────────────────────────────

    /// Create post-execution assertions for a vault.
    /// Assertions check account data bytes AFTER DeFi instructions execute.
    pub fn create_post_assertions(
        ctx: Context<CreatePostAssertions>,
        entries: Vec<PostAssertionEntry>,
    ) -> Result<()> {
        instructions::create_post_assertions::handler(ctx, entries)
    }

    /// Close post-execution assertions for a vault. Returns rent to owner.
    pub fn close_post_assertions(ctx: Context<ClosePostAssertions>) -> Result<()> {
        instructions::close_post_assertions::handler(ctx)
    }

    /// Transfer tokens from the vault to an allowed destination.
    /// Only the agent can call this. Stablecoin-only.
    pub fn agent_transfer(
        ctx: Context<AgentTransfer>,
        amount: u64,
        expected_policy_version: u64,
    ) -> Result<()> {
        instructions::agent_transfer::handler(ctx, amount, expected_policy_version)
    }

    // update_agent_permissions DELETED — use queue_agent_permissions_update → apply_agent_permissions_update.

    /// Queue an agent permissions update. Timelock-gated.
    /// Per-agent PDA allows concurrent pending updates for different agents.
    pub fn queue_agent_permissions_update(
        ctx: Context<QueueAgentPermissionsUpdate>,
        agent: Pubkey,
        new_capability: u8,
        spending_limit_usd: u64,
    ) -> Result<()> {
        instructions::queue_agent_permissions_update::handler(
            ctx,
            agent,
            new_capability,
            spending_limit_usd,
        )
    }

    /// Apply a queued agent permissions update after timelock expires.
    pub fn apply_agent_permissions_update(ctx: Context<ApplyAgentPermissionsUpdate>) -> Result<()> {
        instructions::apply_agent_permissions_update::handler(ctx)
    }

    /// Cancel a queued agent permissions update.
    pub fn cancel_agent_permissions_update(
        ctx: Context<CancelAgentPermissionsUpdate>,
    ) -> Result<()> {
        instructions::cancel_agent_permissions_update::handler(ctx)
    }

    // sync_positions instruction DELETED — position counter system removed per council decision
    // (9-1 vote, 2026-04-19). See Plans/we-need-to-plan-serialized-summit.md.

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

    /// Freeze the vault immediately. Preserves all agent entries.
    /// Only the owner can call this. Use reactivate_vault to unfreeze.
    pub fn freeze_vault(ctx: Context<FreezeVault>) -> Result<()> {
        instructions::freeze_vault::handler(ctx)
    }

    /// Pause a specific agent. Blocks all agent actions while preserving config.
    /// Only the owner can call this.
    pub fn pause_agent(ctx: Context<PauseAgent>, agent_to_pause: Pubkey) -> Result<()> {
        instructions::pause_agent::handler(ctx, agent_to_pause)
    }

    /// Unpause a paused agent. Restores ability to execute actions.
    /// Only the owner can call this.
    pub fn unpause_agent(ctx: Context<UnpauseAgent>, agent_to_unpause: Pubkey) -> Result<()> {
        instructions::unpause_agent::handler(ctx, agent_to_unpause)
    }
}
