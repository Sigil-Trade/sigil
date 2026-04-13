use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, Instruction};
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::token::{self, Approve, Mint, Token, TokenAccount, Transfer};

use crate::errors::SigilError;
use crate::events::{ActionAuthorized, FeesCollected};
use crate::state::*;

use super::integrations::{generic_constraints, jupiter};
use crate::state::PositionEffect;

#[derive(Accounts)]
#[instruction(token_mint: Pubkey)]
pub struct ValidateAndAuthorize<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        mut,
        constraint = vault.is_agent(&agent.key()) @ SigilError::UnauthorizedAgent,
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
        bump = tracker.load()?.bump,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Zero-copy AgentSpendOverlay — per-agent rolling spend
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump = agent_spend_overlay.load()?.bump,
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
            @ SigilError::InvalidTokenAccount,
        constraint = vault_token_account.mint == token_mint_account.key()
            @ SigilError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The token mint being spent — constrained to match token_mint arg
    #[account(
        constraint = token_mint_account.key() == token_mint
            @ SigilError::InvalidTokenAccount,
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
    token_mint: Pubkey,
    amount: u64,
    target_protocol: Pubkey,
    expected_policy_version: u64,
) -> Result<()> {
    // 0. Reject CPI calls — only top-level transaction instructions allowed.
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        SigilError::CpiCallNotAllowed
    );

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;
    let clock = Clock::get()?;

    // TOCTOU fix: reject if policy changed since agent's off-chain RPC read.
    require!(
        policy.policy_version == expected_policy_version,
        SigilError::PolicyVersionMismatch
    );
    let vault_key = vault.key();
    // Spending classification: amount > 0 = spending, amount == 0 = non-spending.
    let is_spending = amount > 0;
    let is_stablecoin_input = is_stablecoin_mint(&token_mint);

    // Load zero-copy constraints PDA from remaining_accounts.
    // We hold the borrowed account data alive for the scan duration so we can
    // reference the zero-copy struct without copying 35KB onto the stack.
    let _constraints_data_borrow;
    let loaded_constraints: Option<&InstructionConstraints> = if !ctx.remaining_accounts.is_empty()
    {
        let info = &ctx.remaining_accounts[0];
        require!(info.owner == &crate::ID, SigilError::InvalidConstraintsPda);
        _constraints_data_borrow = info.try_borrow_data()?;
        let data = &*_constraints_data_borrow;
        // Verify account data is large enough for the zero-copy struct
        let struct_size = core::mem::size_of::<InstructionConstraints>();
        require!(
            data.len() >= 8 + struct_size,
            SigilError::InvalidConstraintsPda
        );
        // SAFETY: InstructionConstraints is #[account(zero_copy)] = #[repr(C)] + Pod.
        // The 8-byte Anchor discriminator precedes the struct data.
        let constraints: &InstructionConstraints = bytemuck::from_bytes(&data[8..8 + struct_size]);

        // Use stored bump for O(1) PDA verification
        let constraints_pda = Pubkey::create_program_address(
            &[b"constraints", vault_key.as_ref(), &[constraints.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(SigilError::InvalidConstraintsPda))?;
        require_keys_eq!(
            info.key(),
            constraints_pda,
            SigilError::InvalidConstraintsPda
        );
        require!(
            constraints.vault == vault_key.to_bytes(),
            SigilError::InvalidConstraintsPda
        );
        Some(constraints)
    } else {
        // No constraints PDA passed — verify none are configured
        require!(!policy.has_constraints, SigilError::InvalidConstraintsPda);
        None
    };

    // 1. Vault must be active
    require!(vault.is_active(), SigilError::VaultNotActive);

    // 1a-pre. Agent must not be paused
    require!(
        !vault.is_agent_paused(&ctx.accounts.agent.key()),
        SigilError::AgentPaused
    );

    // 1a. Agent must have capability for the spending level
    require!(
        vault.has_capability(&ctx.accounts.agent.key(), is_spending),
        SigilError::InsufficientPermissions
    );

    // 2. Protocol must be allowed (mode-based check) — ALL actions
    require!(
        policy.is_protocol_allowed(&target_protocol),
        SigilError::ProtocolNotAllowed
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
                .ok_or(error!(SigilError::InvalidTokenAccount))?;

            // Verify the stablecoin account belongs to the vault
            require!(
                stablecoin_acct.owner == vault_key,
                SigilError::InvalidTokenAccount
            );
            // Verify it's actually a stablecoin mint
            require!(
                is_stablecoin_mint(&stablecoin_acct.mint),
                SigilError::UnsupportedToken
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
        .map_err(|_| error!(SigilError::MissingFinalizeInstruction))?;
    let current_idx_usize = current_idx as usize;

    let spl_token_id = ctx.accounts.token_program.key();
    let compute_budget_id = Pubkey::new_from_array([
        3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187,
        197, 247, 18, 107, 44, 67, 155, 58, 64, 0, 0, 0,
    ]);

    // 5a. Backward instruction scan (Phase B2 security fix):
    // Reject any non-infrastructure instructions BEFORE validate_and_authorize.
    // Prevents DeFi-before-validate ordering attack where an agent places the
    // DeFi instruction first to make snapshot capture post-modification state.
    for pre_idx in 0..current_idx_usize {
        if let Ok(ix) = load_instruction_at_checked(pre_idx, &ix_sysvar) {
            require!(
                ix.program_id == compute_budget_id
                    || ix.program_id == anchor_lang::solana_program::system_program::ID,
                SigilError::UnauthorizedPreValidateInstruction
            );
        }
    }
    let finalize_hash = FINALIZE_SESSION_DISCRIMINATOR;

    // ── Shared instruction scan helper ──────────────────────────────
    // Extracted from spending + non-spending paths to eliminate ~55 lines
    // of duplicated security checks. See ON-CHAIN-IMPLEMENTATION-PLAN Step 10.
    enum ScanAction {
        FoundFinalize,
        Infrastructure,
        /// Passed shared checks. Contains the index of the matched constraint entry (if any).
        PassedSharedChecks {
            matched_entry_idx: Option<usize>,
        },
    }

    fn scan_instruction_shared(
        ix: &Instruction,
        spl_token_id: &Pubkey,
        compute_budget_id: &Pubkey,
        finalize_hash: &[u8; 8],
        policy: &PolicyConfig,
        loaded_constraints: &Option<&InstructionConstraints>,
    ) -> anchor_lang::Result<ScanAction> {
        // Stop at finalize_session
        if ix.program_id == crate::ID && ix.data.len() >= 8 && ix.data[..8] == *finalize_hash {
            return Ok(ScanAction::FoundFinalize);
        }

        // Block dangerous top-level SPL Token instructions.
        if ix.program_id == *spl_token_id && !ix.data.is_empty() {
            match ix.data[0] {
                4 | 13 => return Err(error!(SigilError::UnauthorizedTokenApproval)),
                3 | 12 => return Err(error!(SigilError::UnauthorizedTokenTransfer)),
                6 | 8 | 9 | 15 => return Err(error!(SigilError::UnauthorizedTokenTransfer)),
                _ => {}
            }
        }

        // Token-2022: same blocked set + disc 26 (TransferCheckedWithFee)
        if ix.program_id == TOKEN_2022_PROGRAM_ID && !ix.data.is_empty() {
            match ix.data[0] {
                4 | 13 => return Err(error!(SigilError::UnauthorizedTokenApproval)),
                3 | 12 | 26 => return Err(error!(SigilError::UnauthorizedTokenTransfer)),
                6 | 8 | 9 | 15 => return Err(error!(SigilError::UnauthorizedTokenTransfer)),
                _ => {}
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
            SigilError::ProtocolNotAllowed
        );

        // Generic instruction constraints (OR across entries, zero-copy)
        let matched_entry_idx = if let Some(constraints) = loaded_constraints {
            let matched = generic_constraints::verify_against_entries_zc(
                constraints,
                &ix.program_id,
                &ix.data,
                &ix.accounts,
            )?;
            if matched.is_none() && constraints.strict_mode != 0 {
                return Err(error!(SigilError::UnconstrainedProgramBlocked));
            }
            matched
        } else {
            None
        };

        Ok(ScanAction::PassedSharedChecks { matched_entry_idx })
    }

    // 6. Instruction scan — validates all instructions between validate and finalize.
    // Shared checks (scan_instruction_shared): SPL/Token-2022 blocking, infrastructure
    // whitelist, protocol allowlist, generic constraints.
    // Spending-only checks (inline): recognized DeFi, ProtocolMismatch, defi_ix_count, Jupiter slippage.
    // Track position effect from matched DeFi constraint entry (default: None = 0).
    let mut defi_position_effect: u8 = 0;

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
                ScanAction::PassedSharedChecks { matched_entry_idx } => {
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
                            SigilError::ProtocolMismatch
                        );
                        defi_ix_count = defi_ix_count.saturating_add(1);

                        // Capture position effect from matched constraint entry
                        if let Some(idx) = matched_entry_idx {
                            if let Some(constraints) = loaded_constraints {
                                defi_position_effect = constraints.entries[idx].position_effect;
                            }
                        }
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
            require!(defi_ix_count <= 1, SigilError::TooManyDeFiInstructions);
        } else {
            require!(defi_ix_count == 1, SigilError::TooManyDeFiInstructions);
        }

        require!(found_finalize, SigilError::MissingFinalizeInstruction);
    }

    // 6b. Non-spending instruction scan
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
                ScanAction::PassedSharedChecks { matched_entry_idx } => {
                    // Capture position effect for non-spending DeFi instructions too
                    if let Some(entry_idx) = matched_entry_idx {
                        if let Some(constraints) = loaded_constraints {
                            defi_position_effect = constraints.entries[entry_idx].position_effect;
                        }
                    }
                }
            }
            idx = idx.saturating_add(1);
        }

        require!(found_finalize, SigilError::MissingFinalizeInstruction);
    }

    // 7. Position effect checks — derived from matched constraint entry
    let position_effect = match defi_position_effect {
        1 => PositionEffect::Increment,
        2 => PositionEffect::Decrement,
        _ => PositionEffect::None,
    };
    match position_effect {
        PositionEffect::Increment => {
            require!(
                policy.can_open_positions,
                SigilError::PositionOpeningDisallowed
            );
            require!(
                vault.open_positions < policy.max_concurrent_positions,
                SigilError::TooManyPositions
            );
        }
        PositionEffect::Decrement => {
            require!(vault.open_positions > 0, SigilError::NoPositionsToClose);
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
            .ok_or(SigilError::Overflow)?
            .checked_sub(developer_fee)
            .ok_or(SigilError::Overflow)?;

        // Transfer protocol fee
        if protocol_fee > 0 {
            let treasury_token = ctx
                .accounts
                .protocol_treasury_token_account
                .as_ref()
                .ok_or(error!(SigilError::InvalidProtocolTreasury))?;
            require!(
                treasury_token.owner == PROTOCOL_TREASURY,
                SigilError::InvalidProtocolTreasury
            );
            require!(
                treasury_token.mint == token_mint,
                SigilError::InvalidProtocolTreasury
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
                .ok_or(error!(SigilError::InvalidFeeDestination))?;
            require!(
                fee_dest.owner == vault_fee_destination,
                SigilError::InvalidFeeDestination
            );
            require!(
                fee_dest.mint == token_mint,
                SigilError::InvalidFeeDestination
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
    session.is_spending = is_spending;
    session.position_effect = defi_position_effect;
    session.expires_at_slot =
        SessionAuthority::calculate_expiry(clock.slot, policy.effective_session_expiry_slots());
    session.delegation_token_account = ctx.accounts.vault_token_account.key();
    session.protocol_fee = protocol_fee;
    session.developer_fee = developer_fee;
    session.delegated = is_spending;
    session.output_mint = output_mint;
    session.stablecoin_balance_before = stablecoin_balance_before;
    session.bump = ctx.bumps.session;
    // Initialize snapshot fields to zero (default for non-delta sessions)
    session.assertion_snapshots = [[0u8; 32]; 4];
    session.snapshot_lens = [0u8; 4];

    // ── Phase B2: Snapshot capture for delta assertions ─────────────────
    // If the vault has post-assertions with delta modes (1-3), capture target
    // account bytes BEFORE the DeFi instruction executes.
    if policy.has_post_assertions != 0 {
        // Find PostExecutionAssertions PDA via derivation (audit H3: single call)
        let (assertions_pda_expected, _) =
            Pubkey::find_program_address(&[b"post_assertions", vault_key.as_ref()], &crate::ID);

        // PDA-based lookup (not positional — security audit H2 fix)
        let assertions_info = ctx
            .remaining_accounts
            .iter()
            .find(|a| a.key() == assertions_pda_expected);

        if let Some(assertions_info) = assertions_info {
            require!(
                assertions_info.owner == &crate::ID,
                SigilError::PostAssertionFailed
            );
            let assertions_data = assertions_info.try_borrow_data()?;
            let struct_size = core::mem::size_of::<PostExecutionAssertions>();
            require!(
                assertions_data.len() >= 8 + struct_size,
                SigilError::PostAssertionFailed
            );
            let assertions: &PostExecutionAssertions =
                bytemuck::from_bytes(&assertions_data[8..8 + struct_size]);
            require!(
                assertions.vault == vault_key.to_bytes(),
                SigilError::PostAssertionFailed
            );

            let count = assertions.entry_count as usize;
            for i in 0..count {
                let entry = &assertions.entries[i];
                // Only snapshot for delta modes (1=MaxDecrease, 2=MaxIncrease, 3=NoChange)
                if entry.assertion_mode == 0 {
                    continue;
                }
                // Hard-fail if delta assertion exists but we can't snapshot (security audit C1)
                let target_pubkey = Pubkey::new_from_array(entry.target_account);
                let target = ctx
                    .remaining_accounts
                    .iter()
                    .find(|a| a.key() == target_pubkey);
                require!(target.is_some(), SigilError::PostAssertionFailed);
                let target = target.unwrap();
                let target_data = target.try_borrow_data()?;

                let offset = entry.offset as usize;
                let len = entry.value_len as usize;
                let end = offset
                    .checked_add(len)
                    .ok_or(error!(SigilError::PostAssertionFailed))?;
                require!(end <= target_data.len(), SigilError::PostAssertionFailed);

                // Capture snapshot
                session.assertion_snapshots[i][..len].copy_from_slice(&target_data[offset..end]);
                session.snapshot_lens[i] = entry.value_len;
            }
        }
        // Note: if assertions PDA not provided but policy says assertions exist,
        // finalize_session will hard-fail (existing B1 defense at finalize line 508).
    }

    emit!(ActionAuthorized {
        vault: vault_key,
        agent: ctx.accounts.agent.key(),
        is_spending,
        token_mint,
        amount,
        usd_amount: amount,
        protocol: target_protocol,
        rolling_spend_usd_after: 0,
        daily_cap_usd: policy.daily_spending_cap_usd,
        delegated: is_spending,
        timestamp: clock.unix_timestamp,
    });

    // H-1: Track active sessions for close_vault guard
    {
        let vault = &mut ctx.accounts.vault;
        vault.active_sessions = vault
            .active_sessions
            .checked_add(1)
            .ok_or(SigilError::Overflow)?;
    }

    Ok(())
}
