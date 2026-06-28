use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{self, Revoke, Token, TokenAccount, Transfer};

use anchor_lang::accounts::account_loader::AccountLoader;

use crate::errors::SigilError;
// C-1 fix: FeesCollected is now emitted here (fees collected on the measured
// spend), relocated from validate_and_authorize.
use crate::events::{AgentSpendLimitChecked, DelegationRevoked, FeesCollected, SessionFinalized};
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::destination_check::enforce_finalize_completeness_from_sysvar;

#[derive(Accounts)]
pub struct FinalizeSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    /// C-1 fix: Boxed to keep `FinalizeSession::try_accounts` under the 4096-byte
    /// BPF stack frame after the C-1 relocation added the protocol-treasury +
    /// fee-destination token accounts to this struct. Box moves the deserialized
    /// account to the heap; handler access is unchanged (transparent auto-deref).
    pub vault: Box<Account<'info, AgentVault>>,

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
    /// C-1 fix: Boxed (see `vault`) to reclaim BPF stack-frame headroom for the
    /// relocated fee token accounts. `close` is unaffected by Box.
    pub session: Box<Account<'info, SessionAuthority>>,

    /// CHECK: Set to session.agent at runtime; receives rent from closed session.
    #[account(mut)]
    pub session_rent_recipient: UncheckedAccount<'info>,

    /// Policy config for outcome-based cap checking during finalization.
    /// Boxed to keep `try_accounts` under the 4096-byte BPF stack limit: PolicyConfig
    /// is ~1.3KB and the M1 output-ownership account pushed the FinalizeSession context
    /// 8 bytes over on stable Anchor (runtime "Access violation in stack frame").
    /// Boxing moves the deserialized account to the heap (transparent auto-deref in the
    /// handler) — no behavior change.
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, PolicyConfig>>,

    /// Zero-copy SpendTracker for recording non-stablecoin swap value
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

    /// Vault's PDA token account for the session's token.
    /// L2-1 (audit 2026-06-15): fail-fast that, when present, this ATA is owned
    /// by the vault PDA. The outcome path already re-reads the raw post-CPI
    /// owner field and asserts owner==vault, so this is defense-in-depth — but
    /// it rejects a substituted token account at account-resolution rather than
    /// deep in the handler.
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ SigilError::InvalidTokenAccount,
    )]
    /// C-1 fix: Boxed (see `vault`) to reclaim BPF stack-frame headroom.
    pub vault_token_account: Option<Box<Account<'info, TokenAccount>>>,

    /// Vault's stablecoin ATA for outcome-based spending verification.
    /// Required when session.output_mint != Pubkey::default() (all spending).
    /// C-1 fix: Boxed (see `vault`) to reclaim BPF stack-frame headroom.
    #[account(mut)]
    pub output_stablecoin_account: Option<Box<Account<'info, TokenAccount>>>,

    /// M1 output-ownership closure — the validate-pinned VAULT-OWNED account an
    /// acquiring (stablecoin-input) swap must have credited. finalize re-reads its
    /// raw post-CPI bytes and asserts owner==vault, mint==pinned, and balance
    /// strictly INCREASED. Owner is checked in the handler (like F-Q8 above), not
    /// as a struct constraint. Boxed to keep try_accounts under the 4096 BPF
    /// stack limit. Required whenever a stablecoin-input spend moves value.
    #[account(mut)]
    pub output_swap_account: Option<Box<Account<'info, TokenAccount>>>,

    /// C-1 fix: protocol treasury token account. RELOCATED here from
    /// validate_and_authorize — the protocol fee is now collected at finalize on
    /// the MEASURED spend (inside the caps), not upfront on the declared amount.
    /// Required (Some) only on a stablecoin-input spend with actual_spend > 0;
    /// None for non-spending / non-stablecoin-input / expired sessions. Boxed to
    /// keep `try_accounts` under the 4096-byte BPF stack frame.
    #[account(mut)]
    pub protocol_treasury_token_account: Option<Box<Account<'info, TokenAccount>>>,

    /// C-1 fix: developer fee destination token account (see above). Required
    /// only when the vault's developer_fee_rate > 0 on a stablecoin-input spend
    /// with actual_spend > 0. Boxed for the same stack-frame reason.
    #[account(mut)]
    pub fee_destination_token_account: Option<Box<Account<'info, TokenAccount>>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// Instructions sysvar for post-finalize instruction verification.
    /// CHECK: address constrained to sysvar::instructions::ID
    #[account(
        address = anchor_lang::solana_program::sysvar::instructions::ID
    )]
    pub instructions_sysvar: UncheckedAccount<'info>,

    /// Phase 7 — SUCCESS-path audit log. Written when the finalize completes
    /// the non-expired branch.
    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// Phase 7 — REJECTED-path audit log. Written when the finalize takes
    /// the expired branch (permissionless-crank cleanup). Audit #2 F-19
    /// keeps this separate from the success buffer so a crank-attacker
    /// cannot displace legitimate success history.
    #[account(
        mut,
        seeds = [b"audit_rejected", vault.key().as_ref()],
        bump = audit_log_rejected.load()?.bump,
    )]
    pub audit_log_rejected: AccountLoader<'info, AuditLogRejected>,

    /// CHECK: Phase 7 — slot_hashes sysvar; address-pinned.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes_sysvar: UncheckedAccount<'info>,
}

/// Require-measurable-outcome guard, extracted to its OWN frame
/// (`#[inline(never)]`) so its branch + the nested `enforce_output_ownership`
/// call do not inflate `finalize_session::handler`'s stack frame (near the
/// 4096-byte BPF limit on the post-assertion path; inlining it overflowed in the
/// release build, same as the F-Q1b completeness extraction). A spending session
/// (run_outcome_check) that measured no stablecoin movement (actual_spend == 0)
/// must still evidence a vault-owned acquiring output that INCREASED (M1), else
/// revert ErrUnmeasurableSpend. Exempt: non-spending / expired sessions.
#[inline(never)]
fn enforce_measurable_outcome<'info>(
    run_outcome_check: bool,
    actual_spend: u64,
    output_swap_account: &Option<Box<Account<'info, TokenAccount>>>,
    vault_key: &Pubkey,
    pinned_output_account: &Pubkey,
    pinned_output_mint: &Pubkey,
    output_balance_before: u64,
) -> Result<()> {
    if run_outcome_check && actual_spend == 0 {
        if *pinned_output_account != Pubkey::default() {
            // Acquiring swap declared — require its pinned vault-owned output to
            // have INCREASED in-tx (M1); enforce_output_ownership reverts
            // (ErrOutputNotVaultOwned 6112) if it did not.
            enforce_output_ownership(
                output_swap_account,
                vault_key,
                pinned_output_account,
                pinned_output_mint,
                output_balance_before,
            )?;
        } else {
            // No measurable stablecoin movement AND no declared acquisition → no
            // measurable vault outcome (async/CPI/data-mode/no-op). Reject.
            return Err(error!(SigilError::ErrUnmeasurableSpend));
        }
    }
    Ok(())
}

/// M1 output-ownership check, extracted to its OWN frame (`#[inline(never)]`)
/// so its byte-buffer locals do not inflate `finalize_session::handler`'s stack
/// frame, which is already near the 4096-byte BPF limit. Reads the pinned
/// acquired-output token account's raw post-CPI bytes (F19 pattern) and asserts:
/// the EXACT validate-pinned account, owner == vault, mint == the declared
/// acquired mint, and balance strictly INCREASED vs the validate snapshot.
/// GENERIC — no protocol knowledge; value-blind (no price/oracle).
#[inline(never)]
fn enforce_output_ownership<'info>(
    output_swap_account: &Option<Box<Account<'info, TokenAccount>>>,
    vault_key: &Pubkey,
    pinned_account: &Pubkey,
    pinned_mint: &Pubkey,
    balance_before: u64,
) -> Result<()> {
    // Resolve the declared account, and the AccountInfo, INSIDE this frame so
    // the handler's frame carries neither (it is already near the BPF limit).
    let swap_acct = output_swap_account
        .as_ref()
        .ok_or(error!(SigilError::ErrOutputNotVaultOwned))?;
    // Substitution defense: measure ONLY the account pinned at validate.
    require_keys_eq!(
        swap_acct.key(),
        *pinned_account,
        SigilError::ErrOutputNotVaultOwned
    );
    let swap_info = swap_acct.to_account_info();
    let data = swap_info.try_borrow_data()?;
    require!(data.len() >= 72, SigilError::ErrOutputNotVaultOwned);
    let mut buf = [0u8; 32];
    // owner (bytes 32..64) == vault
    buf.copy_from_slice(&data[32..64]);
    require!(
        Pubkey::new_from_array(buf) == *vault_key,
        SigilError::ErrOutputNotVaultOwned
    );
    // mint (bytes 0..32) == the declared acquired mint
    buf.copy_from_slice(&data[0..32]);
    require!(
        Pubkey::new_from_array(buf) == *pinned_mint,
        SigilError::ErrOutputNotVaultOwned
    );
    // amount (bytes 64..72) strictly increased vs the validate snapshot
    let mut amt = [0u8; 8];
    amt.copy_from_slice(&data[64..72]);
    require!(
        u64::from_le_bytes(amt) > balance_before,
        SigilError::ErrOutputNotVaultOwned
    );
    Ok(())
}

/// Post-Execution Assertions (Phase B1) check, extracted to its OWN frame
/// (`#[inline(never)]`) so the assertions bytemuck view, the loaded `Instruction`
/// (DeclarationConsistency), the legacy-mode `[u8;8]` buffers, the `target_data`
/// borrow, and — critically — the 256-byte snapshot arrays all live in THIS
/// callee frame instead of accumulating in `finalize_session::handler`'s frame,
/// which is at the 4096-byte BPF stack limit on this path. The snapshot arrays
/// are borrowed (passed by reference) straight off the session account, so no
/// copy lands in the handler frame either. Behavior is byte-for-byte identical to
/// the previously-inline block: same gates already applied at the call site
/// (`!is_expired && has_post_assertions != 0`), same PDA/owner/length/discriminator/
/// vault checks, same per-entry dispatch order, same errors, same
/// `PostAssertionChecked` events.
#[inline(never)]
fn enforce_post_execution_assertions(
    remaining: &[AccountInfo],
    ix_sysvar_info: &AccountInfo,
    vault_key: &Pubkey,
    session_snapshots: &[[u8; 32]; 8],
    session_snapshot_lens: &[u8; 8],
) -> Result<()> {
    // CRITICAL: hard-fail if assertions are configured but PDA is missing.
    // Soft guards would let agents bypass assertions by not passing the PDA.
    require!(!remaining.is_empty(), SigilError::PostAssertionFailed);

    // PDA-based lookup (not positional — security audit H2 fix)
    let (expected_assertions_pda, _) =
        Pubkey::find_program_address(&[b"post_assertions", vault_key.as_ref()], &crate::ID);
    let assertions_info = remaining
        .iter()
        .find(|a| a.key() == expected_assertions_pda);
    require!(assertions_info.is_some(), SigilError::PostAssertionFailed);
    let assertions_info = assertions_info.unwrap();

    // Hard-fail: PDA must be owned by this program
    require!(
        assertions_info.owner == &crate::ID,
        SigilError::PostAssertionFailed
    );

    let assertions_data = assertions_info.try_borrow_data()?;
    let struct_size = core::mem::size_of::<PostExecutionAssertions>();

    // Hard-fail: account must be large enough
    require!(
        assertions_data.len() >= 8 + struct_size,
        SigilError::PostAssertionFailed
    );

    // F-1 audit fix: verify Anchor discriminator before bytemuck cast.
    // Cashio/Crema lesson — owner + PDA derivation are insufficient when
    // multiple zero-copy types share byte layout. PDA derivation, owner,
    // length, and vault checks remain; the discriminator is the 4th
    // defense-in-depth check that prevents type-punning if a future
    // #[account(zero_copy)] type adopts a similar layout under crate::ID.
    require!(
        assertions_data[..8]
            == *<PostExecutionAssertions as anchor_lang::Discriminator>::DISCRIMINATOR,
        SigilError::PostAssertionFailed,
    );

    let assertions: &PostExecutionAssertions =
        bytemuck::from_bytes(&assertions_data[8..8 + struct_size]);

    // Verify PDA belongs to this vault
    require!(
        assertions.vault == vault_key.to_bytes(),
        SigilError::PostAssertionFailed
    );

    let clock_ts = Clock::get()?.unix_timestamp;
    let count = assertions.entry_count as usize;
    for i in 0..count {
        let entry = &assertions.entries[i];

        // Exhaustive match on assertion_mode — unknown modes hard-fail (security audit H3)
        let mode = crate::state::post_assertions::AssertionMode::try_from(entry.assertion_mode)
            .map_err(|_| error!(SigilError::InvalidConstraintConfig))?;

        // Phase 6 R-1..R-4 — dispatch each via #[inline(never)] helpers
        // to keep the handler's stack frame under the 4096-byte BPF cap.
        // Each helper allocates its own per-mode locals in a fresh frame
        // so the snapshot arrays / per-variant 32-byte locals don't
        // accumulate into the outer handler frame.
        match mode {
            crate::state::post_assertions::AssertionMode::MintDeltaCap => {
                crate::utils::post_assertion_helpers::verify_mint_delta_cap(
                    entry,
                    &session_snapshots[i],
                    session_snapshot_lens[i],
                    vault_key,
                    remaining,
                )?;
                emit!(crate::events::PostAssertionChecked {
                    vault: *vault_key,
                    entry_index: i as u8,
                    passed: true,
                    timestamp: clock_ts,
                });
                continue;
            }
            crate::state::post_assertions::AssertionMode::AtaAuthorityPin => {
                crate::utils::post_assertion_helpers::verify_ata_authority_pin(
                    entry, vault_key, remaining,
                )?;
                emit!(crate::events::PostAssertionChecked {
                    vault: *vault_key,
                    entry_index: i as u8,
                    passed: true,
                    timestamp: clock_ts,
                });
                continue;
            }
            crate::state::post_assertions::AssertionMode::OutputBalanceFloor => {
                crate::utils::post_assertion_helpers::verify_output_balance_floor(
                    entry,
                    &session_snapshots[i],
                    session_snapshot_lens[i],
                    vault_key,
                    remaining,
                )?;
                emit!(crate::events::PostAssertionChecked {
                    vault: *vault_key,
                    entry_index: i as u8,
                    passed: true,
                    timestamp: clock_ts,
                });
                continue;
            }
            crate::state::post_assertions::AssertionMode::DeclarationConsistency => {
                crate::utils::post_assertion_helpers::verify_declaration_consistency(
                    entry,
                    ix_sysvar_info,
                    remaining,
                )?;
                emit!(crate::events::PostAssertionChecked {
                    vault: *vault_key,
                    entry_index: i as u8,
                    passed: true,
                    timestamp: clock_ts,
                });
                continue;
            }
            // Legacy modes (0..3) fall through to the in-loop logic below.
            _ => {}
        }

        // Legacy modes (0..3) require the target_account to be loadable.
        let target_pubkey = Pubkey::new_from_array(entry.target_account);

        // Find the target account in remaining_accounts
        let target = remaining.iter().find(|a| a.key() == target_pubkey);
        require!(target.is_some(), SigilError::InvalidPostAssertionIndex);
        let target = target.unwrap();
        let target_data = target.try_borrow_data()?;

        let offset = entry.offset as usize;
        let len = entry.value_len as usize;
        let end = offset
            .checked_add(len)
            .ok_or(error!(SigilError::PostAssertionFailed))?;
        require!(end <= target_data.len(), SigilError::PostAssertionFailed);
        let actual = &target_data[offset..end];

        match mode {
            crate::state::post_assertions::AssertionMode::Absolute => {
                // Phase B1: check current value against expected_value
                let expected = &entry.expected_value[..len];
                let operator =
                    crate::state::assertions::ConstraintOperator::try_from(entry.operator)
                        .map_err(|_| error!(SigilError::InvalidConstraintOperator))?;

                // Phase B3 CrossFieldLte branch DELETED in Phase 1 Option A demolition.
                // Standard absolute comparison (B1) is now the sole path.
                // M1-04: bytes_match relocated to state::assertions (was
                // instructions::integrations::generic_constraints).
                let passed = crate::state::assertions::bytes_match(actual, &operator, expected);
                require!(passed, SigilError::PostAssertionFailed);
            }
            crate::state::post_assertions::AssertionMode::MaxDecrease => {
                // Phase B2: check (snapshot - current) ≤ expected_value
                // NOTE: If value increases, saturating sub = 0, check passes.
                require!(
                    session_snapshot_lens[i] == entry.value_len,
                    SigilError::SnapshotNotCaptured
                );
                let snapshot = &session_snapshots[i][..len];
                let expected = &entry.expected_value[..len];

                let mut snap_buf = [0u8; 8];
                let mut curr_buf = [0u8; 8];
                let mut exp_buf = [0u8; 8];
                snap_buf[..len].copy_from_slice(snapshot);
                curr_buf[..len].copy_from_slice(actual);
                exp_buf[..len].copy_from_slice(expected);
                let snap_val = u64::from_le_bytes(snap_buf);
                let curr_val = u64::from_le_bytes(curr_buf);
                let exp_val = u64::from_le_bytes(exp_buf);

                let delta = snap_val.saturating_sub(curr_val);
                require!(delta <= exp_val, SigilError::PostAssertionFailed);
            }
            crate::state::post_assertions::AssertionMode::MaxIncrease => {
                // Phase B2: check (current - snapshot) ≤ expected_value
                // NOTE: If value decreases, saturating sub = 0, check passes.
                require!(
                    session_snapshot_lens[i] == entry.value_len,
                    SigilError::SnapshotNotCaptured
                );
                let snapshot = &session_snapshots[i][..len];
                let expected = &entry.expected_value[..len];

                let mut snap_buf = [0u8; 8];
                let mut curr_buf = [0u8; 8];
                let mut exp_buf = [0u8; 8];
                snap_buf[..len].copy_from_slice(snapshot);
                curr_buf[..len].copy_from_slice(actual);
                exp_buf[..len].copy_from_slice(expected);
                let snap_val = u64::from_le_bytes(snap_buf);
                let curr_val = u64::from_le_bytes(curr_buf);
                let exp_val = u64::from_le_bytes(exp_buf);

                let delta = curr_val.saturating_sub(snap_val);
                require!(delta <= exp_val, SigilError::PostAssertionFailed);
            }
            crate::state::post_assertions::AssertionMode::NoChange => {
                // Phase B2: check current == snapshot (byte equality)
                require!(
                    session_snapshot_lens[i] == entry.value_len,
                    SigilError::SnapshotNotCaptured
                );
                let snapshot = &session_snapshots[i][..len];
                require!(actual == snapshot, SigilError::PostAssertionFailed);
            }
            crate::state::post_assertions::AssertionMode::MintDeltaCap
            | crate::state::post_assertions::AssertionMode::AtaAuthorityPin
            | crate::state::post_assertions::AssertionMode::OutputBalanceFloor
            | crate::state::post_assertions::AssertionMode::DeclarationConsistency => {
                // Handled above before the legacy target_data load.
                // These arms are unreachable but the exhaustive match
                // requires them. Force an error if execution reaches
                // here (would indicate a refactor bug in the
                // early-return path).
                return Err(error!(SigilError::PostAssertionFailed));
            }
        }

        emit!(crate::events::PostAssertionChecked {
            vault: *vault_key,
            entry_index: i as u8,
            passed: true,
            timestamp: clock_ts,
        });
    }
    Ok(())
}

/// C-1 fix: collect the protocol + developer fee on the MEASURED spend.
///
/// Extracted to its OWN frame (`#[inline(never)]`) so the two `CpiContext` /
/// `Transfer` locals and the per-fee account resolution do not inflate
/// `finalize_session::handler`'s stack frame, which is at the 4096-byte BPF
/// limit on the post-assertion path (same pattern as `enforce_output_ownership`).
///
/// Both transfers are VAULT-PDA-SIGNED (authority = vault PDA via `signer_seeds`),
/// NOT routed through the agent's SPL delegation — so the fee is independent of
/// the delegation amount and is bounded only by the cap accounting the caller
/// already performed on `net_value_out`. The fee source is the vault's stablecoin
/// ATA (`vault_token_ai`, the session token). Treasury + fee-destination accounts
/// are owner/mint-validated exactly as the previous validate-side collection did.
#[inline(never)]
fn transfer_measured_fees<'info>(
    protocol_fee: u64,
    developer_fee: u64,
    token_program_ai: &AccountInfo<'info>,
    vault_token_ai: &AccountInfo<'info>,
    vault_authority_ai: &AccountInfo<'info>,
    protocol_treasury: &Option<Box<Account<'info, TokenAccount>>>,
    fee_destination: &Option<Box<Account<'info, TokenAccount>>>,
    token_mint: &Pubkey,
    expected_fee_destination_owner: &Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if protocol_fee > 0 {
        let treasury = protocol_treasury
            .as_ref()
            .ok_or(error!(SigilError::InvalidProtocolTreasury))?;
        require!(
            treasury.owner == PROTOCOL_TREASURY,
            SigilError::InvalidProtocolTreasury
        );
        require!(
            treasury.mint == *token_mint,
            SigilError::InvalidProtocolTreasury
        );
        let cpi_accounts = Transfer {
            from: vault_token_ai.clone(),
            to: treasury.to_account_info(),
            authority: vault_authority_ai.clone(),
        };
        token::transfer(
            CpiContext::new_with_signer(token_program_ai.clone(), cpi_accounts, signer_seeds),
            protocol_fee,
        )?;
    }

    if developer_fee > 0 {
        let fee_dest = fee_destination
            .as_ref()
            .ok_or(error!(SigilError::InvalidFeeDestination))?;
        require!(
            fee_dest.owner == *expected_fee_destination_owner,
            SigilError::InvalidFeeDestination
        );
        require!(
            fee_dest.mint == *token_mint,
            SigilError::InvalidFeeDestination
        );
        let cpi_accounts = Transfer {
            from: vault_token_ai.clone(),
            to: fee_dest.to_account_info(),
            authority: vault_authority_ai.clone(),
        };
        token::transfer(
            CpiContext::new_with_signer(token_program_ai.clone(), cpi_accounts, signer_seeds),
            developer_fee,
        )?;
    }

    Ok(())
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

    // Wall-clock expiry check (F5-H1): unaffected by slot-time variance.
    let is_expired = session.is_expired(clock.unix_timestamp);

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
    // is_spending derived from authorized_amount > 0 (V2 Option A — field removed
    // from SessionAuthority; canonical source is now amount).
    let session_is_spending = session.authorized_amount > 0;
    let session_delegated = session.delegated;
    // C-1 fix: session.protocol_fee / session.developer_fee are no longer read —
    // fees are computed + collected at finalize on the measured spend, not
    // pre-charged at validate (both fields are now always 0).
    let session_output_mint = session.output_mint;
    let session_balance_before = session.stablecoin_balance_before;
    // F-Q8: the validate-pinned output stablecoin ATA (Pubkey::default() on
    // the stablecoin-input path, which uses vault_token_account instead).
    let session_output_stablecoin_account = session.output_stablecoin_account;
    // M1 output-ownership closure: validate-pinned acquired-output account, its
    // declared mint, and the pre-DeFi balance snapshot. Default/0 when the
    // session declared no swap output (a spend with no acquisition then reverts).
    let session_output_swap_account = session.output_swap_account;
    let session_output_swap_mint = session.output_swap_mint;
    let session_output_swap_balance_before = session.output_swap_balance_before;
    let session_delegation_token_account = session.delegation_token_account;
    let session_authorized_amount = session.authorized_amount;
    let session_authorized_protocol = session.authorized_protocol;
    let session_authorized_token = session.authorized_token;
    // Phase B2 snapshot data (assertion_snapshots [[u8;32];8] = 256 bytes,
    // snapshot_lens [u8;8]) is NO LONGER copied into a handler local — that
    // 256-byte copy lived in the handler frame for the whole function while
    // being read >900 lines later in the post-assertion block only. The
    // extracted `enforce_post_execution_assertions` helper now borrows both
    // arrays straight off the session account, keeping them out of this
    // handler's near-the-limit BPF stack frame.

    let vault_key = ctx.accounts.vault.key();
    let vault = &mut ctx.accounts.vault;

    // Extract vault PDA seeds data upfront — LBL-01: must use
    // vault.vault_authority (immutable PDA seed), NOT vault.owner (mutates on
    // ownership transfer). See full rationale in freeze_vault.rs:76-86.
    let vault_authority = vault.vault_authority;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    // C-1 fix: immutable fee-destination owner (set at vault creation) for the
    // finalize-side developer-fee transfer.
    let vault_fee_destination = vault.fee_destination;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        vault_authority.as_ref(),
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
    // L11-2 (audit 2026-06-15): track spend DIRECTION for the audit log. A
    // non-stablecoin-input swap returns stablecoins INTO the vault, so its
    // measured `actual_spend_tracked` is an INFLOW (logged as balance_delta_in);
    // a stablecoin-input spend leaves the vault (balance_delta_out). Set true in
    // the non-stablecoin branch below; stays false for stablecoin-input/expired.
    let mut spend_is_inflow: bool = false;
    let mut balance_after_tracked: u64 = 0;
    // C-1 fix: developer fee actually charged at finalize on the measured spend.
    // Used to advance vault.total_fees_collected (replaces the pre-charged
    // session_developer_fee, which is now always 0).
    let mut developer_fee_charged: u64 = 0;

    // --- Outcome-based spending verification (ALL non-expired spending transactions) ---
    // Measures actual stablecoin balance delta to determine real spending.
    // Caps and spend recording use the measured reality, not declared intent.
    // Expired sessions skip: crank callers don't pass optional token accounts.
    //
    // Round 2 F19 fix (2026-05-19): same root cause as H-2 — Anchor 0.32.1
    // does NOT auto-reload Account<TokenAccount> after CPI, so cached
    // `.amount` = stale pre-CPI value. The TA-12 floor check at lines
    // 654-689 already re-reads raw post-CPI bytes; the canonical spending
    // path (outcome-based caps) MUST do the same or all 6 spending caps
    // silently bypass on a compromised-CPI drain (cached snapshot makes
    // `actual_spend` look like 0 even though the real balance dropped).
    //
    // SPL TokenAccount layout (identical first 72 bytes for SPL +
    // Token-2022): 0..32 mint, 32..64 owner, 64..72 amount u64 LE.
    // Token-2022 ConfidentialTransfer extensions blocked at validate
    // time (Phase 1) so amount field is always ground-truth.
    let run_outcome_check = !is_expired && session_output_mint != Pubkey::default();
    if run_outcome_check {
        let is_stablecoin_input = is_stablecoin_mint(&session_authorized_token);

        let stablecoin_current = if is_stablecoin_input {
            // Stablecoin input (e.g., swap USDC→SOL): read vault_token_account
            // Raw post-CPI bytes parse (F19 fix — see header note above).
            let acct = ctx
                .accounts
                .vault_token_account
                .as_ref()
                .ok_or(error!(SigilError::InvalidTokenAccount))?;
            let info = acct.to_account_info();
            let data = info.try_borrow_data()?;
            require!(data.len() >= 72, SigilError::InvalidTokenAccount);
            let mut owner_bytes = [0u8; 32];
            owner_bytes.copy_from_slice(&data[32..64]);
            let owner_field = Pubkey::new_from_array(owner_bytes);
            let mut mint_bytes = [0u8; 32];
            mint_bytes.copy_from_slice(&data[0..32]);
            let mint_field = Pubkey::new_from_array(mint_bytes);
            require!(owner_field == vault_key, SigilError::InvalidTokenAccount);
            require!(
                mint_field == session_authorized_token,
                SigilError::InvalidTokenAccount
            );
            let mut amount_bytes = [0u8; 8];
            amount_bytes.copy_from_slice(&data[64..72]);
            u64::from_le_bytes(amount_bytes)
        } else {
            // Non-stablecoin input (e.g., swap SOL→USDC): read output_stablecoin_account
            // Raw post-CPI bytes parse (F19 fix — see header note above).
            let stablecoin_account = ctx
                .accounts
                .output_stablecoin_account
                .as_ref()
                .ok_or(error!(SigilError::InvalidTokenAccount))?;
            // F-Q8: the measured stablecoin ATA MUST be the exact account
            // pinned at validate. Without this a compromised agent could pass
            // a DIFFERENT vault-owned stablecoin ATA (whose owner+mint also
            // pass the checks below) to spoof the `current > before` return
            // check while the real proceeds went elsewhere.
            require_keys_eq!(
                stablecoin_account.key(),
                session_output_stablecoin_account,
                SigilError::InvalidTokenAccount
            );
            let info = stablecoin_account.to_account_info();
            let data = info.try_borrow_data()?;
            require!(data.len() >= 72, SigilError::InvalidTokenAccount);
            let mut owner_bytes = [0u8; 32];
            owner_bytes.copy_from_slice(&data[32..64]);
            let owner_field = Pubkey::new_from_array(owner_bytes);
            let mut mint_bytes = [0u8; 32];
            mint_bytes.copy_from_slice(&data[0..32]);
            let mint_field = Pubkey::new_from_array(mint_bytes);
            require!(owner_field == vault_key, SigilError::InvalidTokenAccount);
            require!(
                mint_field == session_output_mint,
                SigilError::InvalidTokenAccount
            );
            let mut amount_bytes = [0u8; 8];
            amount_bytes.copy_from_slice(&data[64..72]);
            u64::from_le_bytes(amount_bytes)
        };

        // P&L: set balance_after once — covers both branches (M-5 fix)
        balance_after_tracked = stablecoin_current;

        // CPI balance audit: verify vault balance didn't decrease more than authorized.
        // Catches compromised DeFi programs that CPI burn/transfer vault tokens via
        // the agent's SPL delegation. C-1 fix: this balance is read BEFORE the
        // finalize-side fee transfer (which happens later in the outcome block), so
        // the measured decrease here is the DeFi spend ONLY — bounded by the agent's
        // delegation, i.e. the full authorized_amount.
        if is_stablecoin_input && session_delegated && stablecoin_current < session_balance_before {
            let actual_decrease = session_balance_before.saturating_sub(stablecoin_current);
            require!(
                actual_decrease <= session_authorized_amount,
                SigilError::UnexpectedBalanceDecrease
            );
        }

        if is_stablecoin_input {
            // Stablecoin input: measure how much LEFT the vault.
            // C-1 fix: fees are NO LONGER taken upfront at validate, so the
            // measured decrease IS the DeFi spend directly — no fee subtraction.
            // (A net stablecoin INFLOW on a stablecoin-input session saturates to
            // a 0 decrease ⇒ actual_spend == 0, which then must evidence an
            // acquiring vault-owned output via the require-measurable-outcome
            // guard below, else 6115.)
            let actual_spend = session_balance_before.saturating_sub(stablecoin_current);
            actual_spend_tracked = actual_spend;

            if actual_spend > 0 {
                // ── M1 output-ownership closure ──────────────────────────────
                // An acquiring spend MUST have landed its output in the
                // validate-pinned VAULT-OWNED account, which MUST have INCREASED.
                // Closes M1: output redirection (the swap output sent to the
                // agent's own ATA) and the unacquired drain both revert here —
                // a declared-but-unincreased account, a non-vault owner, the
                // wrong mint, a substituted key, or no declared output at all
                // (key stays Pubkey::default()) all fail. GENERIC: no protocol
                // knowledge; vault-ownership + increase only (no price/oracle).
                // Raw post-CPI byte read (F19), mirroring the F-Q8 check above.
                // Extracted to enforce_output_ownership (#[inline(never)]): the
                // account resolution, AccountInfo, and byte-buffer locals all
                // live in that helper's SEPARATE frame, keeping this handler
                // under the 4096-byte BPF stack limit.
                enforce_output_ownership(
                    &ctx.accounts.output_swap_account,
                    &vault_key,
                    &session_output_swap_account,
                    &session_output_swap_mint,
                    session_output_swap_balance_before,
                )?;

                // ── C-1: fees on the MEASURED spend, INSIDE the caps ─────────
                // Compute the protocol + developer fee on the actual measured
                // spend (NOT the declared amount) and enforce EVERY spend cap
                // against `net_value_out = actual_spend + fees`. Every lamport
                // that leaves the vault — the DeFi spend AND the fees — is thus
                // bounded by the per-tx / daily / per-agent / per-protocol caps.
                // ceil_fee guarantees a non-zero protocol fee for any non-zero
                // spend (PROTOCOL_FEE_RATE > 0).
                let policy = &ctx.accounts.policy;
                let policy_dev_fee_rate = policy.developer_fee_rate;
                let true_protocol_fee = ceil_fee(actual_spend, PROTOCOL_FEE_RATE as u64)?;
                let true_developer_fee = ceil_fee(actual_spend, policy_dev_fee_rate as u64)?;
                let net_value_out = actual_spend
                    .checked_add(true_protocol_fee)
                    .ok_or(SigilError::Overflow)?
                    .checked_add(true_developer_fee)
                    .ok_or(SigilError::Overflow)?;

                // Per-transaction limit (fees included)
                require!(
                    net_value_out <= policy.max_transaction_size_usd,
                    SigilError::TransactionTooLarge
                );

                // Rolling 24h cap (fees included)
                let mut tracker = ctx.accounts.tracker.load_mut()?;
                let rolling_usd = tracker.get_rolling_24h_usd(&clock);
                let new_total = rolling_usd
                    .checked_add(net_value_out)
                    .ok_or(SigilError::Overflow)?;
                require!(
                    new_total <= policy.daily_spending_cap_usd,
                    SigilError::SpendingCapExceeded
                );

                // Per-agent cap (fees included)
                let agent_entry = vault
                    .get_agent(&session_agent)
                    .ok_or(error!(SigilError::UnauthorizedAgent))?;
                let mut overlay = ctx.accounts.agent_spend_overlay.load_mut()?;
                if let Some(agent_slot) = overlay.find_agent_slot(&session_agent) {
                    if agent_entry.spending_limit_usd > 0 {
                        let agent_rolling = overlay.get_agent_rolling_24h_usd(&clock, agent_slot);
                        let new_agent = agent_rolling
                            .checked_add(net_value_out)
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
                            amount: net_value_out,
                            timestamp: clock.unix_timestamp,
                        });
                    }
                    overlay.record_agent_contribution(&clock, agent_slot, net_value_out)?;
                    overlay.lifetime_spend[agent_slot] = overlay.lifetime_spend[agent_slot]
                        .checked_add(net_value_out)
                        .ok_or(SigilError::Overflow)?;
                    overlay.lifetime_tx_count[agent_slot] = overlay.lifetime_tx_count[agent_slot]
                        .checked_add(1)
                        .ok_or(SigilError::Overflow)?;
                } else if agent_entry.spending_limit_usd > 0 {
                    return Err(error!(SigilError::AgentSlotNotFound));
                }
                drop(overlay);

                // TA-13 (Phase 5 ratification): per-protocol rolling 24h cap
                // (fees included). This enforcement existed since Phase 2 (per
                // F-15 audit) — ratified here with a distinct error code so
                // off-chain monitors can disambiguate "rolling cap hit" from the
                // legacy "slot allocation exhausted" path (which still returns
                // ProtocolCapExceeded from inside `record_protocol_spend`).
                if let Some(proto_cap) = policy.get_protocol_cap(&session_authorized_protocol) {
                    if proto_cap > 0 {
                        let proto_spend =
                            tracker.get_protocol_spend(&clock, &session_authorized_protocol);
                        let new_proto = proto_spend
                            .checked_add(net_value_out)
                            .ok_or(SigilError::Overflow)?;
                        require!(new_proto <= proto_cap, SigilError::ErrDailyCapExceeded);
                    }
                }

                // Record spend (the capped net value-out, including fees)
                tracker.record_spend(&clock, net_value_out)?;
                if policy.has_protocol_caps {
                    tracker.record_protocol_spend(
                        &clock,
                        &session_authorized_protocol,
                        net_value_out,
                    )?;
                }
                drop(tracker);

                // ── C-1: collect the fees on the measured spend ──────────────
                // Vault-PDA-signed transfers (NOT via the agent's delegation),
                // from the vault's stablecoin ATA to the protocol treasury +
                // developer fee destination. The transfer is bounded by the caps
                // above (net_value_out) and runs AFTER cap accounting so a fee
                // shortfall reverts the whole atomic tx (no inconsistent state).
                // Extracted to a #[inline(never)] helper so the two CpiContext /
                // Transfer locals live in a SEPARATE frame, keeping this handler
                // under the 4096-byte BPF stack limit.
                let token_program_ai = ctx.accounts.token_program.to_account_info();
                let vault_token_ai = ctx
                    .accounts
                    .vault_token_account
                    .as_ref()
                    .ok_or(error!(SigilError::InvalidTokenAccount))?
                    .to_account_info();
                let vault_authority_ai = vault.to_account_info();
                transfer_measured_fees(
                    true_protocol_fee,
                    true_developer_fee,
                    &token_program_ai,
                    &vault_token_ai,
                    &vault_authority_ai,
                    &ctx.accounts.protocol_treasury_token_account,
                    &ctx.accounts.fee_destination_token_account,
                    &session_authorized_token,
                    &vault_fee_destination,
                    &binding,
                )?;
                developer_fee_charged = true_developer_fee;

                emit!(FeesCollected {
                    vault: vault_key,
                    token_mint: session_authorized_token,
                    protocol_fee_amount: true_protocol_fee,
                    developer_fee_amount: true_developer_fee,
                    protocol_fee_rate: PROTOCOL_FEE_RATE,
                    developer_fee_rate: policy_dev_fee_rate,
                    transaction_amount: actual_spend,
                    protocol_treasury: PROTOCOL_TREASURY,
                    developer_fee_destination: vault_fee_destination,
                    cumulative_developer_fees: vault
                        .total_fees_collected
                        .saturating_add(true_developer_fee),
                    timestamp: clock.unix_timestamp,
                });
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
            spend_is_inflow = true; // L11-2: INFLOW (stablecoin received from non-stablecoin-input swap)

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

            // TA-13 (Phase 5 ratification): per-protocol rolling 24h cap.
            // Same enforcement as the stablecoin-input branch above — uses
            // ErrDailyCapExceeded for the "rolling cap hit" semantic.
            if let Some(proto_cap) = policy.get_protocol_cap(&session_authorized_protocol) {
                if proto_cap > 0 {
                    let proto_spend =
                        tracker.get_protocol_spend(&clock, &session_authorized_protocol);
                    let new_proto = proto_spend
                        .checked_add(stablecoin_delta)
                        .ok_or(SigilError::Overflow)?;
                    require!(new_proto <= proto_cap, SigilError::ErrDailyCapExceeded);
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

    // ─── Require-measurable-outcome (async/CPI/data-mode cap-bypass closure) ──
    // A SPENDING session (run_outcome_check) that exits the outcome-measurement
    // block with actual_spend_tracked == 0 moved no measurable stablecoin out of
    // the vault in-transaction. Sigil's allowlist + async denylist are TOP-LEVEL-
    // instruction-scoped (no CPI enumeration) and program-ID-only (no discriminator
    // gate post-M1-04), so an owner-allowlisted CPI-capable program — or an
    // allowlisted program driven into a request/keeper-fill mode — can defer the
    // real transfer to a LATER block, where finalize measures 0 and the session
    // would otherwise settle on the dust fee, never binding the caps. REQUIRE a
    // measurable in-tx vault outcome instead:
    //   - actual_spend_tracked > 0 (stablecoin measurably left / returned), OR
    //   - an acquiring swap that landed a vault-owned output which INCREASED (M1).
    // Otherwise REVERT. VALUE-BLIND: no oracle, no magnitude valuation of any
    // position — it only requires SOME measurable vault-owned delta to exist in
    // this tx. (The unbounded async drain additionally requires owner-granted
    // surviving custody = position-world; Sigil's own agent SPL delegation is
    // revoked in this same tx, so this closes the token-world cap-accounting slip.)
    // Exempt: non-spending / expired sessions (run_outcome_check == false).
    // Extracted to a #[inline(never)] helper so the guard + the nested
    // enforce_output_ownership call live in their OWN frame, keeping this handler
    // under the 4096-byte BPF limit on the post-assertion path (an inline version
    // overflowed in the release build).
    enforce_measurable_outcome(
        run_outcome_check,
        actual_spend_tracked,
        &ctx.accounts.output_swap_account,
        &vault_key,
        &session_output_swap_account,
        &session_output_swap_mint,
        session_output_swap_balance_before,
    )?;

    // C-1 fix: the legacy "fee-to-cap fallback" for NON-spending / EXPIRED
    // sessions that pre-charged fees at validate is REMOVED — fees are no longer
    // collected upfront, so a non-spending / expired session collects zero fees
    // and there is nothing to charge to the cap. (Spending sessions collect fees
    // at finalize INSIDE the caps in the outcome block above; a spending session
    // with actual_spend == 0 reverts at the require-measurable-outcome guard.)

    // ─── Item 1: F-Q1b/M2 finalize-side completeness ───────────────────────
    // When a real spend occurred, EVERY writable non-vault meta of the counted
    // DeFi ix MUST be present in finalize's remaining_accounts (symmetric to
    // validate's F-Q1a). Without it, a raw-tx caller could pass all metas to
    // validate (satisfying F-Q1a) then OMIT an output/recipient leg from finalize,
    // silently shrinking the per-recipient cap + output attribution (a dual-output
    // CLMM close leaks the un-passed leg). Re-derive the DeFi ix from the
    // instructions sysvar (runtime truth, same index the per-recipient walk uses)
    // and fail closed on omission, BEFORE the per-recipient / stable-floor walks
    // so neither can be dodged.
    if run_outcome_check && actual_spend_tracked > 0 {
        // Extracted to a #[inline(never)] helper so the loaded Instruction (a
        // Vec-bearing local) does NOT inflate this handler's stack frame, which
        // is already near the 4096-byte BPF limit on the post-assertion path
        // (mirrors enforce_output_ownership). Inlining the load here overflowed
        // that path in the release build.
        enforce_finalize_completeness_from_sysvar(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            ctx.remaining_accounts,
            &vault_key,
        )?;
    }

    // ─── TA-14 (Phase 5 post-exec invariant #2): per-recipient cap ───
    //
    // When a spending finalize completes with `actual_spend_tracked > 0`,
    // identify the recipient(s) whose token accounts received outflow and
    // enforce `policy.per_recipient_daily_cap_usd` against each.
    //
    // RECIPIENT RESOLUTION: walk the PREVIOUS (DeFi) instruction's
    // account metas via the instructions sysvar. For each writable
    // SPL/Token-2022 token account in the metas where:
    //   1. The deserialized SPL TokenAccount.owner ∈ allowed_destinations
    //   2. The mint is a stablecoin (USDC/USDT)
    // attribute outflow. CRITICAL: recipient = TokenAccount.owner (the
    // wallet), NOT the meta pubkey (which is the ATA). The §RP brief
    // explicitly flags ATA-vs-owner confusion as the attack class.
    //
    // V1 SCOPING: this loop only RECOGNIZES recipients whose owner is on
    // the policy's allowed_destinations allowlist. Other writable token
    // accounts in the DeFi ix's metas (DEX-internal vaults, protocol
    // treasuries, etc.) are NOT counted as recipients. This matches the
    // policy model: the owner pre-authorizes the set of legitimate
    // outflow destinations; any address NOT on that list cannot receive
    // a deliberate outflow without ALSO breaking the global spending cap.
    //
    // When per_recipient_daily_cap_usd == 0, the entire block is skipped
    // (default — preserves existing vault behavior).
    let per_recipient_policy = &ctx.accounts.policy;
    if per_recipient_policy.per_recipient_daily_cap_usd > 0 && actual_spend_tracked > 0 {
        // Find the DeFi instruction immediately preceding this finalize.
        // It sits at `validate_ix_index + 1` per the sandwich pattern, OR
        // we can scan backwards from `current_ix_index - 1`.
        let ix_sysvar_info_ta14 = ctx.accounts.instructions_sysvar.to_account_info();
        let current_index = load_current_index_checked(&ix_sysvar_info_ta14)
            .map_err(|_| error!(SigilError::InvalidSession))? as usize;
        // The DeFi ix sits at current_index - 1 (the instruction
        // immediately before finalize_session in the sandwich
        // [validate, DeFi, finalize]).
        require!(current_index >= 1, SigilError::InvalidSession);
        let defi_ix_index = current_index.saturating_sub(1);
        let Ok(defi_ix) = load_instruction_at_checked(defi_ix_index, &ix_sysvar_info_ta14) else {
            // No preceding instruction — fail closed.
            return Err(error!(SigilError::ErrRecipientCapExceeded));
        };

        // Walk metas to find recipient token accounts. The DeFi ix's metas
        // contain pubkeys but NOT account data — we must look up each
        // pubkey in `ctx.remaining_accounts` to get the deserialized
        // TokenAccount.owner field. The §RP-correct resolution.
        //
        // Track distinct recipients seen in THIS tx — V1 rejects if more
        // than one distinct recipient is touched (the per-recipient
        // outflow attribution becomes ambiguous and is deferred to V2).
        let mut recipient_seen: Option<Pubkey> = None;
        // L10-2 (audit 2026-06-15): explicit iteration cap on the DeFi-ix meta
        // walk, mirroring `agent_transfer.rs:416` (M-12). validate already caps
        // the DeFi ix at ≤64 total metas, so 64 is the structural ceiling and
        // never rejects a legitimate route; this just makes the bound explicit
        // and independent of tx-size mechanics (no self-grief via meta padding).
        const MAX_RECIPIENT_WALK_ITERATIONS: usize = 64;
        let mut recipient_walk_iterations: usize = 0;
        for meta in defi_ix.accounts.iter() {
            require!(
                recipient_walk_iterations < MAX_RECIPIENT_WALK_ITERATIONS,
                SigilError::IxMetaCountExceeded
            );
            recipient_walk_iterations = recipient_walk_iterations.saturating_add(1);
            // Only writable token accounts could be recipients. The DeFi
            // program's read-only accounts (oracles, config PDAs) can't
            // receive outflow.
            if !meta.is_writable {
                continue;
            }
            // Look up the meta pubkey in remaining_accounts to get the
            // account data. If not present, skip (the floor check below
            // may still pass if this recipient isn't a vault stablecoin
            // ATA).
            let Some(info) = ctx
                .remaining_accounts
                .iter()
                .find(|a| a.key() == meta.pubkey)
            else {
                continue;
            };
            // Must be token-program-owned.
            if info.owner != &anchor_spl::token::ID && info.owner != &TOKEN_2022_PROGRAM_ID {
                continue;
            }
            let data = info.try_borrow_data()?;
            if data.len() < 72 {
                continue;
            }
            // Parse mint (0..32), owner (32..64) — see TA-12 block above
            // for the same shape. Skip non-stablecoin accounts and
            // accounts whose owner is the vault itself (those are
            // self-transfers, not recipient outflow).
            let mut mint_bytes = [0u8; 32];
            mint_bytes.copy_from_slice(&data[0..32]);
            let mint = Pubkey::new_from_array(mint_bytes);
            let mut owner_bytes = [0u8; 32];
            owner_bytes.copy_from_slice(&data[32..64]);
            let recipient = Pubkey::new_from_array(owner_bytes);
            if recipient == vault_key {
                continue;
            }
            if !is_stablecoin_mint(&mint) {
                continue;
            }
            // CRITICAL: only count owners on the policy's allowlist. Any
            // other destination is either a DEX-internal vault (not a
            // human recipient) or an unauthorized outflow target — the
            // latter case is already blocked by destination_check in
            // validate_and_authorize, so reaching it here would indicate
            // a deeper validation gap. Defense-in-depth: skip.
            if !per_recipient_policy.is_destination_allowed(&recipient) {
                continue;
            }
            // Found a legitimate recipient. V1 only supports one
            // distinct recipient per tx — reject if we see a second.
            if let Some(prev) = recipient_seen {
                if prev != recipient {
                    // Multiple distinct recipients in same finalize.
                    return Err(error!(SigilError::ErrRecipientCapExceeded));
                }
            } else {
                recipient_seen = Some(recipient);
            }
        }

        if let Some(recipient) = recipient_seen {
            // Read-only prior spend in the active window.
            let mut tracker = ctx.accounts.tracker.load_mut()?;
            let prior_spend = tracker.get_recipient_spend(&clock, &recipient);
            let new_total = prior_spend
                .checked_add(actual_spend_tracked)
                .ok_or(SigilError::Overflow)?;
            require!(
                new_total <= per_recipient_policy.per_recipient_daily_cap_usd,
                SigilError::ErrRecipientCapExceeded
            );
            // Record (may evict an age-elapsed entry; rejects if all
            // slots are filled within last 24h per the no-churn rule).
            tracker.record_recipient_spend(&clock, &recipient, actual_spend_tracked)?;
            drop(tracker);
        }
        // If no recipient was seen but actual_spend_tracked > 0, the
        // spend went to a non-allowlisted destination (DEX-internal
        // vault for a swap that lands stablecoin back in the vault, or
        // protocol treasury). Per the policy model, no per-recipient
        // attribution applies; the global daily cap already enforced
        // the spend ceiling. NO-OP for the per-recipient cap.
    }

    // ─── TA-12 (Phase 5 post-exec invariant #1): stable balance floor ──
    //
    // After ALL spending paths complete (DeFi spend bookkeeping, fee
    // collection, fee-to-cap fallback), assert the combined USDC+USDT
    // balance held by this vault is ≥ policy.stable_balance_floor.
    //
    // The floor is the LAST defensive line — no combination of attacks
    // (CPI drain, per-protocol cap evasion via async fulfillment, fee
    // inflation, slippage manipulation) may drain the vault below it.
    //
    // Sources of vault stablecoin ATAs (in priority order):
    //   1. `vault_token_account` (Option<TokenAccount>) — when present,
    //      validate owner == vault + mint ∈ {USDC, USDT}, contribute amount.
    //   2. `output_stablecoin_account` (Option<TokenAccount>) — same checks.
    //   3. `ctx.remaining_accounts` — every account whose deserialized SPL
    //      TokenAccount has owner == vault + mint ∈ {USDC, USDT}. Caller
    //      MUST include the OTHER stablecoin ATA when only one stablecoin
    //      session is in scope (e.g. USDC→SOL session needs vault's USDT
    //      ATA passed via remaining_accounts for the floor check).
    //
    // Default policy.stable_balance_floor = 0 means "no reserve" — the
    // check passes trivially. Owners explicitly opt in by setting a
    // non-zero value via initialize_vault or queue_policy_update.
    //
    // The §RP brief explicitly calls out attack class "wrong pubkey
    // (parses ATA pubkey instead of owner field)" — we MUST resolve
    // via SPL TokenAccount.owner (the WALLET that holds the token
    // account), NOT the meta pubkey. Same fix applies here.
    let stable_floor_policy = &ctx.accounts.policy;
    if stable_floor_policy.stable_balance_floor > 0 {
        let mut combined_stable_balance: u64 = 0;

        // M3-01 (Option 2): canonical-ATA pin. A vault-owned stablecoin balance
        // counts toward the floor ONLY if the account is the vault's CANONICAL
        // associated token account for its own mint + token-program (re-derived
        // on-chain from the candidate's own bytes). This narrows the floor to
        // exactly one canonical ATA per stablecoin mint, so a second vault-owned
        // token account for the same mint cannot inflate the sum (the over-count
        // surface a non-canonical account would otherwise open).
        //
        // INTENDED, FAIL-SAFE narrowing: a stablecoin balance held in a
        // NON-canonical (non-ATA) account is deliberately NOT counted. This only
        // makes the sum SMALLER, so `require!(combined >= floor)` fires more
        // eagerly (stricter) — never a bypass. It cannot brick custody: owner
        // withdraw/freeze paths do not run this check, so the owner always keeps
        // control; at worst an unusual vault that parks reserves outside its ATA
        // sees agent spends over-blocked until it moves them in. Skipped, never
        // reverted.
        //
        // SCOPE: USDC/USDT are legacy SPL Token, and typed Sources 1+2
        // (`Account<TokenAccount>`) are SPL-only by construction. Adding a
        // Token-2022 stablecoin to `is_stablecoin_mint` would also require a
        // Token-2022-aware typed source AND a Token-2022-aware SDK ATA
        // derivation (deriveAta is legacy-SPL-only) — tracked, not in scope.
        // Deriving from the candidate's own mint + `info.owner` keeps this
        // correct under the devnet-testing escape hatch and for whichever token
        // program owns the account.
        let is_canonical_vault_ata = |key: Pubkey, mint: &Pubkey, token_program: &Pubkey| -> bool {
            key == get_associated_token_address_with_program_id(&vault_key, mint, token_program)
        };

        // CRITICAL H-2 fix (audit 2026-05-19): Anchor 0.32.1 does NOT
        // auto-reload `Account<TokenAccount>` after CPI. Reading
        // `acct.amount` returns the PRE-CPI cached value. For the
        // finalize-time floor check (which runs AFTER the spending CPI
        // sandwiched between validate and finalize), we MUST re-read raw
        // post-CPI bytes — same pattern as agent_transfer.rs:316-424
        // (commit 48c6239). Failing to do so defeats the TA-12 invariant
        // on the canonical spending path: cached `.amount` = $1000,
        // actual post-CPI balance = $500, floor = $700 → check passes
        // ($1000 >= $700) → vault drains below floor unchallenged.
        //
        // SPL TokenAccount layout (identical first 72 bytes for SPL +
        // Token-2022): 0..32 mint, 32..64 owner, 64..72 amount u64 LE.
        // Token-2022 ConfidentialTransfer extensions blocked at validate
        // time (Phase 1) so amount field is always ground-truth.

        // Source 1: vault_token_account (raw post-CPI re-read).
        if let Some(acct) = ctx.accounts.vault_token_account.as_ref() {
            let info = acct.to_account_info();
            let data = info.try_borrow_data()?;
            if data.len() >= 72 {
                let mut owner_bytes = [0u8; 32];
                owner_bytes.copy_from_slice(&data[32..64]);
                let owner = Pubkey::new_from_array(owner_bytes);
                let mut mint_bytes = [0u8; 32];
                mint_bytes.copy_from_slice(&data[0..32]);
                let mint = Pubkey::new_from_array(mint_bytes);
                if owner == vault_key
                    && is_stablecoin_mint(&mint)
                    && is_canonical_vault_ata(info.key(), &mint, info.owner)
                {
                    let mut amount_bytes = [0u8; 8];
                    amount_bytes.copy_from_slice(&data[64..72]);
                    let amount = u64::from_le_bytes(amount_bytes);
                    combined_stable_balance = combined_stable_balance
                        .checked_add(amount)
                        .ok_or(SigilError::Overflow)?;
                }
            }
        }

        // Source 2: output_stablecoin_account (raw post-CPI re-read).
        // Skip if same pubkey as vault_token_account (double-count guard).
        if let Some(acct) = ctx.accounts.output_stablecoin_account.as_ref() {
            let same_as_input = ctx
                .accounts
                .vault_token_account
                .as_ref()
                .is_some_and(|t| t.key() == acct.key());
            if !same_as_input {
                let info = acct.to_account_info();
                let data = info.try_borrow_data()?;
                if data.len() >= 72 {
                    let mut owner_bytes = [0u8; 32];
                    owner_bytes.copy_from_slice(&data[32..64]);
                    let owner = Pubkey::new_from_array(owner_bytes);
                    let mut mint_bytes = [0u8; 32];
                    mint_bytes.copy_from_slice(&data[0..32]);
                    let mint = Pubkey::new_from_array(mint_bytes);
                    if owner == vault_key
                        && is_stablecoin_mint(&mint)
                        && is_canonical_vault_ata(info.key(), &mint, info.owner)
                    {
                        let mut amount_bytes = [0u8; 8];
                        amount_bytes.copy_from_slice(&data[64..72]);
                        let amount = u64::from_le_bytes(amount_bytes);
                        combined_stable_balance = combined_stable_balance
                            .checked_add(amount)
                            .ok_or(SigilError::Overflow)?;
                    }
                }
            }
        }

        // Source 3: remaining_accounts — caller passes any additional
        // vault stablecoin ATAs needed to cover the floor invariant.
        // We deserialize each as an SPL TokenAccount and check
        // owner=vault + mint∈{USDC,USDT}. De-duplicate by pubkey to
        // defend against double-count from a caller passing the same
        // ATA twice.
        let already_counted_a = ctx.accounts.vault_token_account.as_ref().map(|t| t.key());
        let already_counted_b = ctx
            .accounts
            .output_stablecoin_account
            .as_ref()
            .map(|t| t.key());
        let mut seen: Vec<Pubkey> = Vec::with_capacity(2);
        if let Some(k) = already_counted_a {
            seen.push(k);
        }
        if let Some(k) = already_counted_b {
            if !seen.contains(&k) {
                seen.push(k);
            }
        }
        // L10-1 (audit 2026-06-15; cap REVISED 2026-06-16 after peer review):
        // explicit iteration cap on the stable-floor remaining_accounts walk.
        // The cap is 64 (the tx structural ceiling, matching validate's total-
        // meta guard and L10-2), NOT 16. Unlike `agent_transfer` (which carries
        // no DeFi-route metas), `seal()` feeds finalize's remaining_accounts the
        // sandwiched DeFi ix's FULL writable set (the F-Q1a set, ≤24 per
        // MAX_DESTINATION_WRITABLE_METAS) PLUS the vault's stablecoin ATAs for
        // the floor sum — a legitimate multi-leg swap on a stable_balance_floor>0
        // vault is ~12-30 metas. A cap of 16 FALSE-REJECTED those
        // (IxMetaCountExceeded 6093, persistent). 64 bounds the pathological
        // without rejecting any tx validate already accepted.
        const MAX_STABLE_FLOOR_WALK_ITERATIONS: usize = 64;
        let mut floor_walk_iterations: usize = 0;
        for info in ctx.remaining_accounts.iter() {
            require!(
                floor_walk_iterations < MAX_STABLE_FLOOR_WALK_ITERATIONS,
                SigilError::IxMetaCountExceeded
            );
            floor_walk_iterations = floor_walk_iterations.saturating_add(1);
            if seen.contains(&info.key()) {
                continue;
            }
            // Defensive: must be a token-program-owned account. Accept
            // both SPL Token and Token-2022 — the first 72 bytes of the
            // serialized layout (mint, owner, amount) are identical
            // between the two, and Token-2022 ConfidentialTransfer
            // extensions are blocked at validate time so the amount
            // field is always ground-truth.
            if info.owner != &anchor_spl::token::ID && info.owner != &TOKEN_2022_PROGRAM_ID {
                continue;
            }
            let data = info.try_borrow_data()?;
            // SPL TokenAccount packed length = 165 bytes (no extension).
            // Token-2022 accounts may be larger but the prefix layout
            // (mint, owner, amount) is identical for the first 72 bytes,
            // so we only require >=72 here. Token-2022 ConfidentialTransfer
            // extensions are blocked at validate time (Phase 1) so the
            // amount field still reflects ground-truth balance.
            if data.len() < 72 {
                continue;
            }
            // SPL TokenAccount: bytes 0..32 = mint, 32..64 = owner,
            // 64..72 = amount (u64 LE). Parse only the fields we need
            // (cheaper than full deserialize).
            let mut mint_bytes = [0u8; 32];
            mint_bytes.copy_from_slice(&data[0..32]);
            let mint = Pubkey::new_from_array(mint_bytes);
            let mut owner_bytes = [0u8; 32];
            owner_bytes.copy_from_slice(&data[32..64]);
            let owner = Pubkey::new_from_array(owner_bytes);
            if owner != vault_key
                || !is_stablecoin_mint(&mint)
                || !is_canonical_vault_ata(info.key(), &mint, info.owner)
            {
                continue;
            }
            let mut amount_bytes = [0u8; 8];
            amount_bytes.copy_from_slice(&data[64..72]);
            let amount = u64::from_le_bytes(amount_bytes);
            combined_stable_balance = combined_stable_balance
                .checked_add(amount)
                .ok_or(SigilError::Overflow)?;
            seen.push(info.key());
            drop(data);
        }

        require!(
            combined_stable_balance >= stable_floor_policy.stable_balance_floor,
            SigilError::ErrStableFloorViolation
        );
    }

    // C-1 fix: track the developer fee CHARGED AT FINALIZE on the measured spend
    // (the `developer_fee_charged` accumulator). Fees are no longer collected at
    // validate, so accounting now advances from the finalize-side transfer.
    if developer_fee_charged > 0 {
        vault.total_fees_collected = vault
            .total_fees_collected
            .checked_add(developer_fee_charged)
            .ok_or(SigilError::Overflow)?;
    }

    // Update vault stats (non-expired sessions only)
    if !is_expired {
        vault.total_transactions = vault
            .total_transactions
            .checked_add(1)
            .ok_or(SigilError::Overflow)?;

        // Only add to total_volume for spending actions (actual measured spend)
        if session_is_spending {
            vault.total_volume = vault
                .total_volume
                .checked_add(actual_spend_tracked)
                .ok_or(SigilError::Overflow)?;
        }

        // Position counter mutation block REMOVED — counter system deleted wholesale
        // per council decision (9-1 vote, 2026-04-19). See Plans/we-need-to-plan-serialized-summit.md.
    }

    // ─── Post-Execution Assertions (Phase B1) ─────────────────────────────
    // If the vault has post-assertions configured, verify account state
    // AFTER the DeFi instruction executed. Uses remaining_accounts to
    // pass target accounts for byte-level comparison.
    let policy_ref = &ctx.accounts.policy;
    if !is_expired && policy_ref.has_post_assertions != 0 {
        // Extracted to a #[inline(never)] helper (`enforce_post_execution_assertions`)
        // so the assertions bytemuck view, the per-entry legacy match locals (three
        // [u8;8] buffers + the loaded Instruction for DeclarationConsistency + the
        // target_data borrow), and the 256-byte snapshot arrays all live in the
        // helper's SEPARATE frame, not this handler's. The handler frame is at the
        // 4096-byte BPF limit on the post-assertion path; an inline version
        // overflowed in the release build. The snapshot arrays are passed BY
        // REFERENCE (borrowed straight off the session account) so no 256-byte copy
        // lands in the handler frame either. Behavior is identical — same checks,
        // same order, same errors, same PostAssertionChecked events.
        enforce_post_execution_assertions(
            ctx.remaining_accounts,
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &vault_key,
            &ctx.accounts.session.assertion_snapshots,
            &ctx.accounts.session.snapshot_lens,
        )?;
    }

    // Analytics: count expired sessions for success rate metric.
    if is_expired {
        vault.total_failed_transactions = vault
            .total_failed_transactions
            .checked_add(1)
            .ok_or(SigilError::Overflow)?;
    }

    // H-1: Decrement active session counter (unconditional — both success and expired)
    vault.active_sessions = vault.active_sessions.saturating_sub(1);

    // AC-10 (Phase 4): nonce bump — dead-on-close under V2 (`close =
    // session_rent_recipient`); forward-compat for Phase 8 M-5 reuse.
    // See `docs/revamp/AUDIT_2026_05_18/G2_DEFERRAL_RATIONALE.md`. M-6
    // audit 2026-05-19 compressed prior 4-line comment to this 3-line cite.
    {
        let session = &mut ctx.accounts.session;
        session.nonce = session.nonce.checked_add(1).ok_or(SigilError::Overflow)?;
    }

    // Phase 7 — write audit-log entry. SUCCESS path goes to audit_log_success
    // (discriminator 2); REJECT/expired path goes to audit_log_rejected
    // (discriminator 16 — `AUDIT_DISC_FINALIZE_REJECT`, distinct from disc=1
    // which is reserved for future per-validate rows). The two buffers are
    // physically separate so an expired-finalize burst (permissionless
    // crank) cannot displace legitimate success history (Audit #2 F-19).
    // §RP-1 HIGH-1 (2026-05-19): previously reused disc=1
    // `AUDIT_DISC_VALIDATE` here, but `validate_and_authorize` writes NO
    // audit entries, so disc=1 on the rejected buffer was a forensic-
    // correctness lie. Disc=16 fixes the ambiguity.
    {
        // L11-2 (audit 2026-06-15): log the measured stablecoin movement in the
        // CORRECT direction — inflow (non-stablecoin-input swap) → balance_delta_in,
        // outflow (stablecoin-input spend) → balance_delta_out. Expired/0 → both 0.
        let measured: i64 = actual_spend_tracked.min(i64::MAX as u64) as i64;
        let (delta_in, delta_out): (i64, i64) = if spend_is_inflow {
            (measured, 0)
        } else {
            (0, measured)
        };
        if is_expired {
            let entry = build_audit_entry(
                AUDIT_DISC_FINALIZE_REJECT,
                session_authorized_protocol,
                delta_in,
                delta_out,
                clock.unix_timestamp,
                &ctx.accounts.slot_hashes_sysvar.to_account_info(),
            )?;
            let mut log = ctx.accounts.audit_log_rejected.load_mut()?;
            // §RP-1 I-2: defense-in-depth guard against future seeds drift.
            require_keys_eq!(
                log.vault,
                ctx.accounts.vault.key(),
                SigilError::ZeroCopyVaultMismatch
            );
            log.append(entry);
        } else {
            let entry = build_audit_entry(
                AUDIT_DISC_FINALIZE_SUCCESS,
                session_authorized_protocol,
                delta_in,
                delta_out,
                clock.unix_timestamp,
                &ctx.accounts.slot_hashes_sysvar.to_account_info(),
            )?;
            let mut log = ctx.accounts.audit_log_success.load_mut()?;
            // §RP-1 I-2: defense-in-depth guard against future seeds drift.
            require_keys_eq!(
                log.vault,
                ctx.accounts.vault.key(),
                SigilError::ZeroCopyVaultMismatch
            );
            log.append(entry);
        }
    }

    emit!(SessionFinalized {
        vault: vault_key,
        agent: session_agent,
        success: !is_expired,
        is_expired,
        timestamp: clock.unix_timestamp,
        actual_spend_usd: actual_spend_tracked,
        balance_after_usd: balance_after_tracked,
    });

    // --- Post-finalize instruction scan (defense-in-depth) ---
    // Ensures no unauthorized instructions execute after the security
    // window closes. Revocation already prevents token theft, but this
    // catches any future regression where revocation order changes.
    let ix_sysvar_info = ctx.accounts.instructions_sysvar.to_account_info();
    let current_ix_index = load_current_index_checked(&ix_sysvar_info)
        .map_err(|_| error!(SigilError::UnauthorizedPostFinalizeInstruction))?
        as usize;

    // P3.1 + P3.2 audit fix (2026-05-19): single source of truth at
    // `state/mod.rs::COMPUTE_BUDGET_PROGRAM_ID`. Replaces both the inlined
    // 32-byte literal AND the stale cross-file line reference (prior comment
    // pointed at validate_and_authorize.rs:248-251 which had drifted to :385-388).
    let compute_budget_id = crate::state::COMPUTE_BUDGET_PROGRAM_ID;
    let system_id = anchor_lang::solana_program::system_program::ID;

    // Bounded scan: check up to MAX_SYSVAR_SCAN_ITERATIONS instructions after
    // finalize. The loop terminates when (a) load_instruction_at_checked
    // returns Err (end of tx), or (b) the bound is reached.
    //
    // M11 hardening (SIMD-0296 pad-attack DoS guard): cap iterations at the
    // shared MAX_SYSVAR_SCAN_ITERATIONS constant (64). Solana v0 tx caps at
    // 64 ix already; the bound is unreachable in legitimate flows. Hitting
    // the bound means an adversary tried to pad the tx — finalize itself is
    // already complete (CPI revocation done) so we log + break rather than
    // error. The remaining unscanned ix space (idx 64+) cannot exist on a
    // valid v0 tx, so silently truncating is safe defense-in-depth.
    let mut iter_count: usize = 0;
    while iter_count < crate::instructions::validate_and_authorize::MAX_SYSVAR_SCAN_ITERATIONS {
        let post_idx = current_ix_index
            .saturating_add(1)
            .saturating_add(iter_count);
        let Ok(ix) = load_instruction_at_checked(post_idx, &ix_sysvar_info) else {
            break;
        };
        require!(
            ix.program_id == compute_budget_id || ix.program_id == system_id,
            SigilError::UnauthorizedPostFinalizeInstruction
        );
        iter_count = iter_count.saturating_add(1);
    }
    if iter_count >= crate::instructions::validate_and_authorize::MAX_SYSVAR_SCAN_ITERATIONS {
        // Telemetry: pad-attack attempted (or future Solana runtime change).
        // Finalize already committed; this is just a signal for monitoring.
        msg!("post-finalize scan reached MAX_SYSVAR_SCAN_ITERATIONS bound");
    }

    Ok(())
}
