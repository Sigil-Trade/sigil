use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::token::{self, Revoke, Token, TokenAccount};

use anchor_lang::accounts::account_loader::AccountLoader;

use crate::errors::SigilError;
use crate::events::{AgentSpendLimitChecked, DelegationRevoked, SessionFinalized};
use crate::state::{PositionEffect, *};

#[derive(Accounts)]
pub struct FinalizeSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// Session rent is returned to the session's agent (who paid for it).
    /// Seeds include token_mint for per-token concurrent sessions.
    #[account(
        mut,
        has_one = vault @ SigilError::InvalidSession,
        seeds = [
            b"session",
            vault.key().as_ref(),
            session.agent.as_ref(),
            session.authorized_token.as_ref(),
        ],
        bump = session.bump,
        close = session_rent_recipient,
    )]
    pub session: Account<'info, SessionAuthority>,

    /// CHECK: Set to session.agent at runtime; receives rent from closed session.
    #[account(mut)]
    pub session_rent_recipient: UncheckedAccount<'info>,

    /// Policy config for outcome-based cap checking during finalization
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Zero-copy SpendTracker for recording non-stablecoin swap value
    #[account(
        mut,
        seeds = [b"tracker", vault.key().as_ref()],
        bump,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Zero-copy AgentSpendOverlay — per-agent rolling spend
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    /// Vault's PDA token account for the session's token
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    /// Vault's stablecoin ATA for outcome-based spending verification.
    /// Required when session.output_mint != Pubkey::default() (all spending).
    #[account(mut)]
    pub output_stablecoin_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// Instructions sysvar for post-finalize instruction verification.
    /// CHECK: address constrained to sysvar::instructions::ID
    #[account(
        address = anchor_lang::solana_program::sysvar::instructions::ID
    )]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<FinalizeSession>) -> Result<()> {
    // 0. Reject CPI calls — only top-level transaction instructions allowed.
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        SigilError::CpiCallNotAllowed
    );

    let session = &ctx.accounts.session;
    let clock = Clock::get()?;

    let is_expired = session.is_expired(clock.slot);

    // Rent recipient must be the session's agent
    require!(
        ctx.accounts.session_rent_recipient.key() == session.agent,
        SigilError::InvalidSession
    );

    // Non-expired sessions can only be finalized by the session's agent.
    // Expired sessions can be cleaned up by anyone (permissionless crank).
    if !is_expired {
        require!(
            ctx.accounts.payer.key() == session.agent,
            SigilError::UnauthorizedAgent
        );
        require!(session.authorized, SigilError::SessionNotAuthorized);
    }

    // Extract session data before we lose access
    let session_agent = session.agent;
    let session_action_type = session.action_type;
    let session_delegated = session.delegated;
    let session_developer_fee = session.developer_fee;
    let session_output_mint = session.output_mint;
    let session_balance_before = session.stablecoin_balance_before;
    let session_delegation_token_account = session.delegation_token_account;
    let session_authorized_amount = session.authorized_amount;
    let session_authorized_protocol = session.authorized_protocol;
    let session_authorized_token = session.authorized_token;
    let session_protocol_fee = session.protocol_fee;

    let vault_key = ctx.accounts.vault.key();
    let vault = &mut ctx.accounts.vault;

    // Extract vault PDA seeds data upfront
    let owner_key = vault.owner;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        owner_key.as_ref(),
        vault_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    // Security fix (Finding C): Validate vault_token_account matches session
    if session_delegated {
        // H1: vault_token_account MUST be provided when session was delegated.
        // Without this, passing None silently skips revocation and the agent
        // retains SPL token delegation authority.
        let vault_token = ctx
            .accounts
            .vault_token_account
            .as_ref()
            .ok_or(error!(SigilError::InvalidTokenAccount))?;
        require!(
            vault_token.key() == session_delegation_token_account,
            SigilError::InvalidTokenAccount
        );
    }

    // Revoke delegation
    if session_delegated {
        if let Some(vault_token) = ctx.accounts.vault_token_account.as_ref() {
            let revoke_accounts = Revoke {
                source: vault_token.to_account_info(),
                authority: vault.to_account_info(),
            };
            let revoke_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                revoke_accounts,
                &binding,
            );
            token::revoke(revoke_ctx)?;

            emit!(DelegationRevoked {
                vault: vault_key,
                token_account: vault_token.key(),
                timestamp: clock.unix_timestamp,
            });
        }
    }

    // P&L tracking: track actual spend and balance for enriched SessionFinalized event
    let mut actual_spend_tracked: u64 = 0;
    let mut balance_after_tracked: u64 = 0;

    // --- Outcome-based spending verification (ALL non-expired spending transactions) ---
    // Measures actual stablecoin balance delta to determine real spending.
    // Caps and spend recording use the measured reality, not declared intent.
    // Expired sessions skip: crank callers don't pass optional token accounts.
    let run_outcome_check = !is_expired && session_output_mint != Pubkey::default();
    if run_outcome_check {
        let is_stablecoin_input = is_stablecoin_mint(&session_authorized_token);

        let stablecoin_current = if is_stablecoin_input {
            // Stablecoin input (e.g., swap USDC→SOL): read vault_token_account
            let acct = ctx
                .accounts
                .vault_token_account
                .as_ref()
                .ok_or(error!(SigilError::InvalidTokenAccount))?;
            acct.amount
        } else {
            // Non-stablecoin input (e.g., swap SOL→USDC): read output_stablecoin_account
            let stablecoin_account = ctx
                .accounts
                .output_stablecoin_account
                .as_ref()
                .ok_or(error!(SigilError::InvalidTokenAccount))?;
            require!(
                stablecoin_account.owner == vault_key,
                SigilError::InvalidTokenAccount
            );
            require!(
                stablecoin_account.mint == session_output_mint,
                SigilError::InvalidTokenAccount
            );
            stablecoin_account.amount
        };

        // P&L: set balance_after once — covers both branches (M-5 fix)
        balance_after_tracked = stablecoin_current;

        // CPI balance audit: verify vault balance didn't decrease more than authorized.
        // Catches compromised DeFi programs that CPI burn/transfer vault tokens via
        // the agent's SPL delegation. stablecoin_balance_before is snapshotted BEFORE
        // fees are collected, so the maximum legitimate decrease is the full
        // authorized_amount (fees + delegation combined).
        if is_stablecoin_input && session_delegated && stablecoin_current < session_balance_before {
            let actual_decrease = session_balance_before
                .saturating_sub(stablecoin_current);
            require!(
                actual_decrease <= session_authorized_amount,
                SigilError::UnexpectedBalanceDecrease
            );
        }

        if is_stablecoin_input {
            // Stablecoin input: measure how much LEFT the vault
            // total_decrease = snapshot - current (includes fees + DeFi spend)
            let total_decrease = session_balance_before.saturating_sub(stablecoin_current);

            // Fees already collected in validate_and_authorize via CPI transfers.
            // actual_spend = total_decrease - fees (only the DeFi portion)
            let fees_collected = session_protocol_fee
                .checked_add(session_developer_fee)
                .ok_or(SigilError::Overflow)?;
            let actual_spend = total_decrease.saturating_sub(fees_collected);
            actual_spend_tracked = actual_spend;

            if actual_spend > 0 {
                // Per-transaction limit
                let policy = &ctx.accounts.policy;
                require!(
                    actual_spend <= policy.max_transaction_size_usd,
                    SigilError::TransactionTooLarge
                );

                // Rolling 24h cap
                let mut tracker = ctx.accounts.tracker.load_mut()?;
                let rolling_usd = tracker.get_rolling_24h_usd(&clock);
                let new_total = rolling_usd
                    .checked_add(actual_spend)
                    .ok_or(SigilError::Overflow)?;
                require!(
                    new_total <= policy.daily_spending_cap_usd,
                    SigilError::SpendingCapExceeded
                );

                // Per-agent cap
                let agent_entry = vault
                    .get_agent(&session_agent)
                    .ok_or(error!(SigilError::UnauthorizedAgent))?;
                let mut overlay = ctx.accounts.agent_spend_overlay.load_mut()?;
                if let Some(agent_slot) = overlay.find_agent_slot(&session_agent) {
                    if agent_entry.spending_limit_usd > 0 {
                        let agent_rolling = overlay.get_agent_rolling_24h_usd(&clock, agent_slot);
                        let new_agent = agent_rolling
                            .checked_add(actual_spend)
                            .ok_or(SigilError::Overflow)?;
                        require!(
                            new_agent <= agent_entry.spending_limit_usd,
                            SigilError::AgentSpendLimitExceeded
                        );
                        emit!(AgentSpendLimitChecked {
                            vault: vault_key,
                            agent: session_agent,
                            agent_rolling_spend: agent_rolling,
                            spending_limit_usd: agent_entry.spending_limit_usd,
                            amount: actual_spend,
                            timestamp: clock.unix_timestamp,
                        });
                    }
                    overlay.record_agent_contribution(&clock, agent_slot, actual_spend)?;
                    overlay.lifetime_spend[agent_slot] = overlay.lifetime_spend[agent_slot]
                        .checked_add(actual_spend)
                        .ok_or(SigilError::Overflow)?;
                    overlay.lifetime_tx_count[agent_slot] = overlay.lifetime_tx_count[agent_slot]
                        .checked_add(1)
                        .ok_or(SigilError::Overflow)?;
                } else if agent_entry.spending_limit_usd > 0 {
                    return Err(error!(SigilError::AgentSlotNotFound));
                }
                drop(overlay);

                // Per-protocol cap
                if let Some(proto_cap) = policy.get_protocol_cap(&session_authorized_protocol) {
                    if proto_cap > 0 {
                        let proto_spend =
                            tracker.get_protocol_spend(&clock, &session_authorized_protocol);
                        let new_proto = proto_spend
                            .checked_add(actual_spend)
                            .ok_or(SigilError::Overflow)?;
                        require!(new_proto <= proto_cap, SigilError::ProtocolCapExceeded);
                    }
                }

                // Record spend
                tracker.record_spend(&clock, actual_spend)?;
                if policy.has_protocol_caps {
                    tracker.record_protocol_spend(
                        &clock,
                        &session_authorized_protocol,
                        actual_spend,
                    )?;
                }
                drop(tracker);
            }
        } else {
            // Non-stablecoin input: stablecoins should INCREASE (or at least not decrease)
            require!(
                stablecoin_current > session_balance_before,
                SigilError::NonTrackedSwapMustReturnStablecoin
            );

            let stablecoin_delta = stablecoin_current
                .checked_sub(session_balance_before)
                .ok_or(SigilError::Overflow)?;
            actual_spend_tracked = stablecoin_delta;

            // Per-transaction limit
            let policy = &ctx.accounts.policy;
            require!(
                stablecoin_delta <= policy.max_transaction_size_usd,
                SigilError::TransactionTooLarge
            );

            // Rolling 24h cap
            let mut tracker = ctx.accounts.tracker.load_mut()?;
            let rolling_usd = tracker.get_rolling_24h_usd(&clock);
            let new_total = rolling_usd
                .checked_add(stablecoin_delta)
                .ok_or(SigilError::Overflow)?;
            require!(
                new_total <= policy.daily_spending_cap_usd,
                SigilError::SpendingCapExceeded
            );

            // Per-agent cap
            let agent_entry = vault
                .get_agent(&session_agent)
                .ok_or(error!(SigilError::UnauthorizedAgent))?;
            let mut overlay = ctx.accounts.agent_spend_overlay.load_mut()?;
            if let Some(agent_slot) = overlay.find_agent_slot(&session_agent) {
                if agent_entry.spending_limit_usd > 0 {
                    let agent_rolling = overlay.get_agent_rolling_24h_usd(&clock, agent_slot);
                    let new_agent = agent_rolling
                        .checked_add(stablecoin_delta)
                        .ok_or(SigilError::Overflow)?;
                    require!(
                        new_agent <= agent_entry.spending_limit_usd,
                        SigilError::AgentSpendLimitExceeded
                    );
                    emit!(AgentSpendLimitChecked {
                        vault: vault_key,
                        agent: session_agent,
                        agent_rolling_spend: agent_rolling,
                        spending_limit_usd: agent_entry.spending_limit_usd,
                        amount: stablecoin_delta,
                        timestamp: clock.unix_timestamp,
                    });
                }
                overlay.record_agent_contribution(&clock, agent_slot, stablecoin_delta)?;
                overlay.lifetime_spend[agent_slot] = overlay.lifetime_spend[agent_slot]
                    .checked_add(stablecoin_delta)
                    .ok_or(SigilError::Overflow)?;
                overlay.lifetime_tx_count[agent_slot] = overlay.lifetime_tx_count[agent_slot]
                    .checked_add(1)
                    .ok_or(SigilError::Overflow)?;
            } else if agent_entry.spending_limit_usd > 0 {
                return Err(error!(SigilError::AgentSlotNotFound));
            }
            drop(overlay);

            // Per-protocol cap
            if let Some(proto_cap) = policy.get_protocol_cap(&session_authorized_protocol) {
                if proto_cap > 0 {
                    let proto_spend =
                        tracker.get_protocol_spend(&clock, &session_authorized_protocol);
                    let new_proto = proto_spend
                        .checked_add(stablecoin_delta)
                        .ok_or(SigilError::Overflow)?;
                    require!(new_proto <= proto_cap, SigilError::ProtocolCapExceeded);
                }
            }

            // Record spend
            tracker.record_spend(&clock, stablecoin_delta)?;
            if policy.has_protocol_caps {
                tracker.record_protocol_spend(
                    &clock,
                    &session_authorized_protocol,
                    stablecoin_delta,
                )?;
            }
            drop(tracker);
        }
    }

    // --- Fee-to-cap fallback (OUTSIDE run_outcome_check) ---
    // When no DeFi spend occurred (actual_spend_tracked == 0) but fees were collected
    // in validate_and_authorize, charge those fees to the spending cap. This prevents
    // fee drain attacks where an agent repeatedly calls validate+finalize with no DeFi
    // instruction to extract fees without cap enforcement.
    // Runs unconditionally — covers both expired sessions and zero-DeFi-spend sessions.
    let fees_collected_total = session_protocol_fee
        .checked_add(session_developer_fee)
        .ok_or(SigilError::Overflow)?;

    if actual_spend_tracked == 0 && fees_collected_total > 0 {
        let policy = &ctx.accounts.policy;
        let mut tracker = ctx.accounts.tracker.load_mut()?;
        let rolling_usd = tracker.get_rolling_24h_usd(&clock);
        let new_total = rolling_usd
            .checked_add(fees_collected_total)
            .ok_or(SigilError::Overflow)?;
        require!(
            new_total <= policy.daily_spending_cap_usd,
            SigilError::SpendingCapExceeded
        );
        tracker.record_spend(&clock, fees_collected_total)?;
        drop(tracker);
    }

    // Always track fees that were transferred in validate (regardless of expiry or outcome).
    // Fees are CPI-transferred in validate_and_authorize — accounting must match reality.
    if session_developer_fee > 0 {
        vault.total_fees_collected = vault
            .total_fees_collected
            .checked_add(session_developer_fee)
            .ok_or(SigilError::Overflow)?;
    }

    // Update vault stats (non-expired sessions only)
    if !is_expired {
        vault.total_transactions = vault
            .total_transactions
            .checked_add(1)
            .ok_or(SigilError::Overflow)?;

        // Only add to total_volume for spending actions (actual measured spend,
        // not declared — matches WRAP-ARCHITECTURE-PLAN.md:427-431)
        if session_action_type.is_spending() {
            vault.total_volume = vault
                .total_volume
                .checked_add(actual_spend_tracked)
                .ok_or(SigilError::Overflow)?;
        }

        // Update position count — only when actual DeFi execution occurred.
        // For spending actions, gate on actual_spend > 0 to prevent counter inflation
        // from no-op sessions. Non-spending actions (ClosePosition, etc.) always update.
        let should_update_positions =
            !session_action_type.is_spending() || actual_spend_tracked > 0;
        if should_update_positions {
            match session_action_type.position_effect() {
                PositionEffect::Increment => {
                    vault.open_positions = vault
                        .open_positions
                        .checked_add(1)
                        .ok_or(SigilError::Overflow)?;
                }
                PositionEffect::Decrement => {
                    vault.open_positions = vault
                        .open_positions
                        .checked_sub(1)
                        .ok_or(SigilError::Overflow)?;
                }
                PositionEffect::None => {}
            }
        }
    }

    // Analytics: count expired sessions for success rate metric.
    if is_expired {
        vault.total_failed_transactions = vault
            .total_failed_transactions
            .checked_add(1)
            .ok_or(SigilError::Overflow)?;
    }

    emit!(SessionFinalized {
        vault: vault_key,
        agent: session_agent,
        success: !is_expired,
        is_expired,
        timestamp: clock.unix_timestamp,
        actual_spend_usd: actual_spend_tracked,
        balance_after_usd: balance_after_tracked,
        action_type: session_action_type.permission_bit(),
    });

    // --- Post-finalize instruction scan (defense-in-depth) ---
    // Ensures no unauthorized instructions execute after the security
    // window closes. Revocation already prevents token theft, but this
    // catches any future regression where revocation order changes.
    let ix_sysvar_info = ctx.accounts.instructions_sysvar.to_account_info();
    let current_ix_index = load_current_index_checked(&ix_sysvar_info)
        .map_err(|_| error!(SigilError::UnauthorizedPostFinalizeInstruction))?
        as usize;

    // Hardcoded ComputeBudget program ID — matches validate_and_authorize.rs:248-251
    let compute_budget_id = Pubkey::new_from_array([
        3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187,
        197, 247, 18, 107, 44, 67, 155, 58, 64, 0, 0, 0,
    ]);
    let system_id = anchor_lang::solana_program::system_program::ID;

    // Unbounded scan: check ALL remaining instructions after finalize.
    // The loop terminates when load_instruction_at_checked returns Err (end of tx).
    // Using an unbounded scan instead of a fixed 20-instruction window ensures
    // coverage at any transaction size, including SIMD-0296's proposed 4,096 bytes.
    let mut post_idx = current_ix_index.saturating_add(1);
    while let Ok(ix) = load_instruction_at_checked(post_idx, &ix_sysvar_info) {
        require!(
            ix.program_id == compute_budget_id || ix.program_id == system_id,
            SigilError::UnauthorizedPostFinalizeInstruction
        );
        post_idx = post_idx.saturating_add(1);
    }

    Ok(())
}
