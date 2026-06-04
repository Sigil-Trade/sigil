use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{self, Revoke, Token, TokenAccount};

use anchor_lang::accounts::account_loader::AccountLoader;

use crate::errors::SigilError;
use crate::events::{AgentSpendLimitChecked, DelegationRevoked, SessionFinalized};
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;

#[derive(Accounts)]
pub struct FinalizeSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
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
    let session_developer_fee = session.developer_fee;
    let session_output_mint = session.output_mint;
    let session_balance_before = session.stablecoin_balance_before;
    // F-Q8: the validate-pinned output stablecoin ATA (Pubkey::default() on
    // the stablecoin-input path, which uses vault_token_account instead).
    let session_output_stablecoin_account = session.output_stablecoin_account;
    let session_delegation_token_account = session.delegation_token_account;
    let session_authorized_amount = session.authorized_amount;
    let session_authorized_protocol = session.authorized_protocol;
    let session_authorized_token = session.authorized_token;
    let session_protocol_fee = session.protocol_fee;
    // Phase B2: extract snapshot data for delta assertions
    let session_snapshots = session.assertion_snapshots;
    let session_snapshot_lens = session.snapshot_lens;

    let vault_key = ctx.accounts.vault.key();
    let vault = &mut ctx.accounts.vault;

    // Extract vault PDA seeds data upfront — LBL-01: must use
    // vault.vault_authority (immutable PDA seed), NOT vault.owner (mutates on
    // ownership transfer). See full rationale in freeze_vault.rs:76-86.
    let vault_authority = vault.vault_authority;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;

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
    let mut balance_after_tracked: u64 = 0;

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
        // the agent's SPL delegation. stablecoin_balance_before is snapshotted BEFORE
        // fees are collected, so the maximum legitimate decrease is the full
        // authorized_amount (fees + delegation combined).
        if is_stablecoin_input && session_delegated && stablecoin_current < session_balance_before {
            let actual_decrease = session_balance_before.saturating_sub(stablecoin_current);
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
            // F-Q9 (audit 2026-06-01, G12): checked-revert, NOT saturating.
            // The fees were CPI'd OUT of THIS SAME ATA before the DeFi leg, so
            // for any honest spend `current <= before - fees` ⟹
            // `total_decrease >= fees`. `fees_collected > total_decrease` is
            // therefore reachable ONLY when the vault's stablecoin ATA ended
            // HIGHER than (snapshot - fees) — i.e. a net stablecoin INFLOW on
            // this stablecoin-INPUT session (a net-positive round-trip). That
            // is an explicitly-unsupported flow (see M2-05); failing closed is
            // intended. The prior `saturating_sub` silently zeroed
            // `actual_spend`, masking the anomaly and — with `ceil_fee`'s
            // round-up — letting small spends round to 0 and skip every cap.
            // DO NOT revert this to a saturating sub. (Conservation proof:
            // Certora rule I1 NO-UNDERCOUNT, tracked for M2.)
            let actual_spend = total_decrease
                .checked_sub(fees_collected)
                .ok_or(SigilError::SpendAccountingUnderflow)?;
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

                // TA-13 (Phase 5 ratification): per-protocol rolling 24h cap.
                // This enforcement existed since Phase 2 (per F-15 audit) —
                // ratified here with a distinct error code so off-chain
                // monitors can disambiguate "rolling cap hit" from the legacy
                // "slot allocation exhausted" path (which still returns
                // ProtocolCapExceeded from inside `record_protocol_spend`).
                if let Some(proto_cap) = policy.get_protocol_cap(&session_authorized_protocol) {
                    if proto_cap > 0 {
                        let proto_spend =
                            tracker.get_protocol_spend(&clock, &session_authorized_protocol);
                        let new_proto = proto_spend
                            .checked_add(actual_spend)
                            .ok_or(SigilError::Overflow)?;
                        require!(new_proto <= proto_cap, SigilError::ErrDailyCapExceeded);
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
        for meta in defi_ix.accounts.iter() {
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
        let is_canonical_vault_ata =
            |key: Pubkey, mint: &Pubkey, token_program: &Pubkey| -> bool {
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
        for info in ctx.remaining_accounts.iter() {
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
        // CRITICAL: hard-fail if assertions are configured but PDA is missing.
        // Soft guards would let agents bypass assertions by not passing the PDA.
        let remaining = &ctx.remaining_accounts;
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
                        &vault_key,
                        remaining,
                    )?;
                    emit!(crate::events::PostAssertionChecked {
                        vault: vault_key,
                        entry_index: i as u8,
                        passed: true,
                        timestamp: clock_ts,
                    });
                    continue;
                }
                crate::state::post_assertions::AssertionMode::AtaAuthorityPin => {
                    crate::utils::post_assertion_helpers::verify_ata_authority_pin(
                        entry, &vault_key, remaining,
                    )?;
                    emit!(crate::events::PostAssertionChecked {
                        vault: vault_key,
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
                        &vault_key,
                        remaining,
                    )?;
                    emit!(crate::events::PostAssertionChecked {
                        vault: vault_key,
                        entry_index: i as u8,
                        passed: true,
                        timestamp: clock_ts,
                    });
                    continue;
                }
                crate::state::post_assertions::AssertionMode::DeclarationConsistency => {
                    let ix_sysvar_info = ctx.accounts.instructions_sysvar.to_account_info();
                    crate::utils::post_assertion_helpers::verify_declaration_consistency(
                        entry,
                        &ix_sysvar_info,
                        remaining,
                    )?;
                    emit!(crate::events::PostAssertionChecked {
                        vault: vault_key,
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
                    let operator = crate::state::assertions::ConstraintOperator::try_from(
                        entry.operator,
                    )
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
                vault: vault_key,
                entry_index: i as u8,
                passed: true,
                timestamp: clock_ts,
            });
        }
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
        let delta_out: i64 = actual_spend_tracked.min(i64::MAX as u64) as i64;
        if is_expired {
            let entry = build_audit_entry(
                AUDIT_DISC_FINALIZE_REJECT,
                session_authorized_protocol,
                0,
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
                0,
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
