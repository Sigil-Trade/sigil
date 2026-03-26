use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, Instruction};
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::token::{self, Approve, Mint, Token, TokenAccount, Transfer};

use crate::errors::PhalnxError;
use crate::events::{ActionAuthorized, FeesCollected};
use crate::state::*;

use super::integrations::{generic_constraints, jupiter};
use crate::state::PositionEffect;

#[derive(Accounts)]
#[instruction(action_type: ActionType, token_mint: Pubkey)]
pub struct ValidateAndAuthorize<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        constraint = vault.is_agent(&agent.key()) @ PhalnxError::UnauthorizedAgent,
        seeds = [b"vault", vault.owner.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Zero-copy SpendTracker
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

    /// Ephemeral session PDA — `init` ensures no double-authorization.
    /// Seeds include token_mint for per-token concurrent sessions.
    #[account(
        init,
        payer = agent,
        space = SessionAuthority::SIZE,
        seeds = [
            b"session",
            vault.key().as_ref(),
            agent.key().as_ref(),
            token_mint.as_ref(),
        ],
        bump,
    )]
    pub session: Account<'info, SessionAuthority>,

    /// Vault's PDA-owned token account for the spend token
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key()
            @ PhalnxError::InvalidTokenAccount,
        constraint = vault_token_account.mint == token_mint_account.key()
            @ PhalnxError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The token mint being spent — constrained to match token_mint arg
    #[account(
        constraint = token_mint_account.key() == token_mint
            @ PhalnxError::InvalidTokenAccount,
    )]
    pub token_mint_account: Account<'info, Mint>,

    /// Protocol treasury token account (needed when protocol_fee > 0)
    #[account(mut)]
    pub protocol_treasury_token_account: Option<Account<'info, TokenAccount>>,

    /// Developer fee destination token account (needed when developer_fee > 0)
    #[account(mut)]
    pub fee_destination_token_account: Option<Account<'info, TokenAccount>>,

    /// Vault's stablecoin ATA to snapshot (for non-stablecoin input spending).
    /// Required when input token is NOT a stablecoin (output verification in finalize).
    #[account(mut)]
    pub output_stablecoin_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// Instructions sysvar for verifying DeFi instruction program_id
    /// and protocol slippage enforcement.
    /// CHECK: address constrained to sysvar::instructions::ID
    #[account(
        address = anchor_lang::solana_program::sysvar::instructions::ID
    )]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<ValidateAndAuthorize>,
    action_type: ActionType,
    token_mint: Pubkey,
    amount: u64,
    target_protocol: Pubkey,
    leverage_bps: Option<u16>,
) -> Result<()> {
    // 0. Reject CPI calls — only top-level transaction instructions allowed.
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        PhalnxError::CpiCallNotAllowed
    );

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;
    let clock = Clock::get()?;
    let vault_key = vault.key();
    let is_spending = action_type.is_spending();
    let is_stablecoin_input = is_stablecoin_mint(&token_mint);

    // Load constraints PDA deterministically — agent CANNOT omit this
    let loaded_constraints: Option<InstructionConstraints> = if !ctx.remaining_accounts.is_empty() {
        let info = &ctx.remaining_accounts[0];
        require!(info.owner == &crate::ID, PhalnxError::InvalidConstraintsPda);
        let data = info.try_borrow_data()?;
        let constraints = InstructionConstraints::try_deserialize(&mut &data[..])?;
        // Use stored bump for O(1) PDA verification instead of find_program_address (~1,500 CU)
        let constraints_pda = Pubkey::create_program_address(
            &[b"constraints", vault_key.as_ref(), &[constraints.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(PhalnxError::InvalidConstraintsPda))?;
        require_keys_eq!(
            info.key(),
            constraints_pda,
            PhalnxError::InvalidConstraintsPda
        );
        require_keys_eq!(
            constraints.vault,
            vault_key,
            PhalnxError::InvalidConstraintsPda
        );
        Some(constraints)
    } else {
        // No constraints PDA passed — verify none are configured
        require!(!policy.has_constraints, PhalnxError::InvalidConstraintsPda);
        None
    };

    // 1. Vault must be active
    require!(vault.is_active(), PhalnxError::VaultNotActive);

    // 1a-pre. Agent must not be paused
    require!(
        !vault.is_agent_paused(&ctx.accounts.agent.key()),
        PhalnxError::AgentPaused
    );

    // 1a. Agent must have permission for this action type
    require!(
        vault.has_permission(&ctx.accounts.agent.key(), &action_type),
        PhalnxError::InsufficientPermissions
    );

    // 1b. Escrow actions use standalone instructions, not the composition flow
    require!(!action_type.is_escrow_action(), PhalnxError::InvalidSession);

    // 1c. Amount validation: spending requires amount > 0,
    //     non-spending requires amount == 0
    if is_spending {
        require!(amount > 0, PhalnxError::TransactionTooLarge);
    } else {
        require!(amount == 0, PhalnxError::InvalidNonSpendingAmount);
    }

    // 2. Protocol must be allowed (mode-based check) — ALL actions
    require!(
        policy.is_protocol_allowed(&target_protocol),
        PhalnxError::ProtocolNotAllowed
    );

    // --- Stablecoin-only spending path ---
    let mut output_mint = Pubkey::default();
    let mut stablecoin_balance_before: u64 = 0;
    let (protocol_fee, developer_fee) = if is_spending {
        if is_stablecoin_input {
            // Snapshot stablecoin balance BEFORE fees or spending.
            // Finalize uses this to compute actual spending delta.
            stablecoin_balance_before = ctx.accounts.vault_token_account.amount;
            output_mint = token_mint;

            // Cap checks and spend recording deferred to finalize_session
            // where actual stablecoin balance delta is measured (outcome-based).

            // Calculate fees (ceiling division — guarantees non-zero fee on any non-zero spending)
            let dev_fee_rate = policy.developer_fee_rate;
            let p_fee = ceil_fee(amount, PROTOCOL_FEE_RATE as u64)?;
            let d_fee = ceil_fee(amount, dev_fee_rate as u64)?;

            (p_fee, d_fee)
        } else {
            // Non-stablecoin input: snapshot stablecoin balance, verify at finalize.
            // No cap check or fees here — USD tracked when stablecoin flows in finalize.
            let stablecoin_acct = ctx
                .accounts
                .output_stablecoin_account
                .as_ref()
                .ok_or(error!(PhalnxError::InvalidTokenAccount))?;

            // Verify the stablecoin account belongs to the vault
            require!(
                stablecoin_acct.owner == vault_key,
                PhalnxError::InvalidTokenAccount
            );
            // Verify it's actually a stablecoin mint
            require!(
                is_stablecoin_mint(&stablecoin_acct.mint),
                PhalnxError::UnsupportedToken
            );

            output_mint = stablecoin_acct.mint;
            stablecoin_balance_before = stablecoin_acct.amount;

            // No fees here — cap check deferred to finalize_session when stablecoin delta is known
            (0u64, 0u64)
        }
    } else {
        // Non-spending: no fees, no spend tracking
        (0u64, 0u64)
    };

    // Shared across spending and non-spending scan paths
    let ix_sysvar = ctx.accounts.instructions_sysvar.to_account_info();
    let current_idx = load_current_index_checked(&ix_sysvar)
        .map_err(|_| error!(PhalnxError::MissingFinalizeInstruction))?;
    let current_idx_usize = current_idx as usize;
    let spl_token_id = ctx.accounts.token_program.key();
    let compute_budget_id = Pubkey::new_from_array([
        3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187,
        197, 247, 18, 107, 44, 67, 155, 58, 64, 0, 0, 0,
    ]);
    let finalize_hash = FINALIZE_SESSION_DISCRIMINATOR;

    // ── Shared instruction scan helper ──────────────────────────────
    // Extracted from spending + non-spending paths to eliminate ~55 lines
    // of duplicated security checks. See ON-CHAIN-IMPLEMENTATION-PLAN Step 10.
    enum ScanAction {
        FoundFinalize,
        Infrastructure,
        PassedSharedChecks,
    }

    fn scan_instruction_shared(
        ix: &Instruction,
        spl_token_id: &Pubkey,
        compute_budget_id: &Pubkey,
        finalize_hash: &[u8; 8],
        policy: &PolicyConfig,
        loaded_constraints: &Option<InstructionConstraints>,
    ) -> anchor_lang::Result<ScanAction> {
        // Stop at finalize_session
        if ix.program_id == crate::ID && ix.data.len() >= 8 && ix.data[..8] == *finalize_hash {
            return Ok(ScanAction::FoundFinalize);
        }

        // Block ALL top-level SPL Token Transfer/TransferChecked/Approve
        if ix.program_id == *spl_token_id && !ix.data.is_empty() {
            if ix.data[0] == 4 {
                return Err(error!(PhalnxError::UnauthorizedTokenApproval));
            }
            if ix.data[0] == 3 || ix.data[0] == 12 {
                return Err(error!(PhalnxError::UnauthorizedTokenTransfer));
            }
        }

        // Block Token-2022 Transfer/Approve/TransferChecked/TransferCheckedWithFee
        if ix.program_id == TOKEN_2022_PROGRAM_ID && !ix.data.is_empty() {
            if ix.data[0] == 4 {
                return Err(error!(PhalnxError::UnauthorizedTokenApproval));
            }
            if ix.data[0] == 3 || ix.data[0] == 12 || ix.data[0] == 26 {
                return Err(error!(PhalnxError::UnauthorizedTokenTransfer));
            }
        }

        // Whitelist infrastructure programs (no policy check needed)
        if ix.program_id == *compute_budget_id
            || ix.program_id == anchor_lang::solana_program::system_program::ID
        {
            return Ok(ScanAction::Infrastructure);
        }

        // Protocol allowlist
        require!(
            policy.is_protocol_allowed(&ix.program_id),
            PhalnxError::ProtocolNotAllowed
        );

        // Generic instruction constraints (OR across entries)
        if let Some(ref constraints) = loaded_constraints {
            let matched = generic_constraints::verify_against_entries(
                &constraints.entries,
                &ix.program_id,
                &ix.data,
                &ix.accounts,
            )?;
            if !matched && constraints.strict_mode {
                return Err(error!(PhalnxError::UnconstrainedProgramBlocked));
            }
        }

        Ok(ScanAction::PassedSharedChecks)
    }

    // 6. Instruction scan — validates all instructions between validate and finalize.
    // Shared checks (scan_instruction_shared): SPL/Token-2022 blocking, infrastructure
    // whitelist, protocol allowlist, generic constraints.
    // Spending-only checks (inline): recognized DeFi, ProtocolMismatch, defi_ix_count, Jupiter slippage.
    if is_spending {
        let mut defi_ix_count: u8 = 0;
        let mut found_finalize = false;
        let mut scan_idx = current_idx_usize.saturating_add(1);

        while let Ok(ix) = load_instruction_at_checked(scan_idx, &ix_sysvar) {
            match scan_instruction_shared(
                &ix,
                &spl_token_id,
                &compute_budget_id,
                &finalize_hash,
                policy,
                &loaded_constraints,
            )? {
                ScanAction::FoundFinalize => {
                    found_finalize = true;
                    break;
                }
                ScanAction::Infrastructure => {
                    scan_idx = scan_idx.saturating_add(1);
                    continue;
                }
                ScanAction::PassedSharedChecks => {
                    // === SPENDING-ONLY CHECKS (must remain inline) ===

                    // Recognized DeFi: protocol mismatch + defi_ix_count
                    let is_recognized_defi = ix.program_id == JUPITER_PROGRAM
                        || ix.program_id == FLASH_TRADE_PROGRAM
                        || ix.program_id == JUPITER_LEND_PROGRAM
                        || ix.program_id == JUPITER_EARN_PROGRAM
                        || ix.program_id == JUPITER_BORROW_PROGRAM;

                    if is_recognized_defi {
                        require!(
                            ix.program_id == target_protocol,
                            PhalnxError::ProtocolMismatch
                        );
                        defi_ix_count = defi_ix_count.saturating_add(1);
                    }

                    // Slippage verification on Jupiter V6 swaps
                    if ix.program_id == JUPITER_PROGRAM {
                        jupiter::verify_jupiter_slippage(&ix.data, policy.max_slippage_bps)?;
                    }
                }
            }
            scan_idx = scan_idx.saturating_add(1);
        }

        // DeFi instruction count enforcement
        if is_stablecoin_input {
            require!(defi_ix_count <= 1, PhalnxError::TooManyDeFiInstructions);
        } else {
            require!(defi_ix_count == 1, PhalnxError::TooManyDeFiInstructions);
        }

        require!(found_finalize, PhalnxError::MissingFinalizeInstruction);
    }

    // 6b. Non-spending instruction scan — validates all instructions between
    // validate and finalize using shared checks only (no spending-specific logic).
    if !is_spending {
        let mut found_finalize = false;
        let mut idx = current_idx_usize.saturating_add(1);

        while let Ok(ix) = load_instruction_at_checked(idx, &ix_sysvar) {
            match scan_instruction_shared(
                &ix,
                &spl_token_id,
                &compute_budget_id,
                &finalize_hash,
                policy,
                &loaded_constraints,
            )? {
                ScanAction::FoundFinalize => {
                    found_finalize = true;
                    break;
                }
                ScanAction::Infrastructure => {
                    idx = idx.saturating_add(1);
                    continue;
                }
                ScanAction::PassedSharedChecks => {
                    // Non-spending has no additional checks beyond shared ones.
                }
            }
            idx = idx.saturating_add(1);
        }

        require!(found_finalize, PhalnxError::MissingFinalizeInstruction);
    }

    // 7. Leverage check (for perp actions) — ALL actions
    // DESIGN DECISION: leverage_bps is self-declared by the agent (via SDK).
    // The program checks it against policy.max_leverage_bps but does NOT
    // read actual position state from Flash Trade or other protocols.
    //
    // Rationale:
    // - Protocol-agnostic: no coupling to Flash Trade account layout
    // - CPI depth: reading position state consumes CPI budget
    // - Outcome-based: finalize_session measures actual stablecoin delta
    // - Advisory only: agent can under-declare or pass None to skip this check.
    //   Spending caps (finalize_session) are the real enforcement, not leverage_bps.
    //
    // Found by: Persona test (Perps Developer "Jake")
    // Decision: By design. Not a bug.
    if let Some(lev) = leverage_bps {
        require!(
            policy.is_leverage_within_limit(lev),
            PhalnxError::LeverageTooHigh
        );
    }

    // 8. Position effect checks
    match action_type.position_effect() {
        PositionEffect::Increment => {
            require!(
                policy.can_open_positions,
                PhalnxError::PositionOpeningDisallowed
            );
            require!(
                vault.open_positions < policy.max_concurrent_positions,
                PhalnxError::TooManyPositions
            );
        }
        PositionEffect::Decrement => {
            require!(vault.open_positions > 0, PhalnxError::NoPositionsToClose);
        }
        PositionEffect::None => {}
    }

    // Extract vault PDA seeds data upfront
    let owner_key = vault.owner;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let vault_fee_destination = vault.fee_destination;
    let dev_fee_rate = policy.developer_fee_rate;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        owner_key.as_ref(),
        vault_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    // 10. Collect fees and delegate (spending + stablecoin input only)
    if is_spending {
        let delegation_amount = amount
            .checked_sub(protocol_fee)
            .ok_or(PhalnxError::Overflow)?
            .checked_sub(developer_fee)
            .ok_or(PhalnxError::Overflow)?;

        // Transfer protocol fee
        if protocol_fee > 0 {
            let treasury_token = ctx
                .accounts
                .protocol_treasury_token_account
                .as_ref()
                .ok_or(error!(PhalnxError::InvalidProtocolTreasury))?;
            require!(
                treasury_token.owner == PROTOCOL_TREASURY,
                PhalnxError::InvalidProtocolTreasury
            );
            require!(
                treasury_token.mint == token_mint,
                PhalnxError::InvalidProtocolTreasury
            );

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: treasury_token.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                &binding,
            );
            token::transfer(cpi_ctx, protocol_fee)?;
        }

        // Transfer developer fee
        if developer_fee > 0 {
            let fee_dest = ctx
                .accounts
                .fee_destination_token_account
                .as_ref()
                .ok_or(error!(PhalnxError::InvalidFeeDestination))?;
            require!(
                fee_dest.owner == vault_fee_destination,
                PhalnxError::InvalidFeeDestination
            );
            require!(
                fee_dest.mint == token_mint,
                PhalnxError::InvalidFeeDestination
            );

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: fee_dest.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                &binding,
            );
            token::transfer(cpi_ctx, developer_fee)?;
        }

        if protocol_fee > 0 || developer_fee > 0 {
            emit!(FeesCollected {
                vault: vault_key,
                token_mint,
                protocol_fee_amount: protocol_fee,
                developer_fee_amount: developer_fee,
                protocol_fee_rate: PROTOCOL_FEE_RATE,
                developer_fee_rate: dev_fee_rate,
                transaction_amount: amount,
                protocol_treasury: PROTOCOL_TREASURY,
                developer_fee_destination: vault_fee_destination,
                cumulative_developer_fees: vault.total_fees_collected.saturating_add(developer_fee),
                timestamp: clock.unix_timestamp,
            });
        }

        // CPI: approve agent as delegate on vault's token account
        let cpi_accounts = Approve {
            to: ctx.accounts.vault_token_account.to_account_info(),
            delegate: ctx.accounts.agent.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &binding,
        );
        token::approve(cpi_ctx, delegation_amount)?;
    }

    // Create session PDA
    let session = &mut ctx.accounts.session;
    session.vault = vault_key;
    session.agent = ctx.accounts.agent.key();
    session.authorized = true;
    session.authorized_amount = amount;
    session.authorized_token = token_mint;
    session.authorized_protocol = target_protocol;
    session.action_type = action_type;
    session.expires_at_slot =
        SessionAuthority::calculate_expiry(clock.slot, policy.effective_session_expiry_slots());
    session.delegation_token_account = ctx.accounts.vault_token_account.key();
    session.protocol_fee = protocol_fee;
    session.developer_fee = developer_fee;
    session.delegated = is_spending;
    session.output_mint = output_mint;
    session.stablecoin_balance_before = stablecoin_balance_before;
    session.bump = ctx.bumps.session;

    emit!(ActionAuthorized {
        vault: vault_key,
        agent: ctx.accounts.agent.key(),
        action_type,
        token_mint,
        amount,
        usd_amount: amount, // Declared input amount (USD for stablecoin input, raw for non-stablecoin)
        protocol: target_protocol,
        rolling_spend_usd_after: 0, // DEPRECATED: use SessionFinalized.actual_spend_usd
        daily_cap_usd: policy.daily_spending_cap_usd,
        delegated: is_spending,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
