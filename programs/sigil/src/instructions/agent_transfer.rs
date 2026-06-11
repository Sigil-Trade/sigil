use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::SigilError;
use crate::events::{AgentSpendLimitChecked, AgentTransferExecuted, FeesCollected};
use crate::state::*;

use super::utils::stablecoin_to_usd;

#[derive(Accounts)]
pub struct AgentTransfer<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        mut,
        constraint = vault.is_agent(&agent.key()) @ SigilError::UnauthorizedAgent,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
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

    /// Vault's PDA-owned token account (source)
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key()
            @ SigilError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Token mint account for decimals validation
    #[account(
        constraint = token_mint_account.key()
            == vault_token_account.mint
            @ SigilError::InvalidTokenAccount,
    )]
    pub token_mint_account: Account<'info, Mint>,

    /// Destination token account (must be in allowed destinations)
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,

    /// Developer fee destination token account
    #[account(mut)]
    pub fee_destination_token_account: Option<Account<'info, TokenAccount>>,

    /// Protocol treasury token account
    #[account(mut)]
    pub protocol_treasury_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<AgentTransfer>,
    amount: u64,
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

    // 1. Vault must be active
    require!(vault.is_active(), SigilError::VaultNotActive);

    // 1a-pre. Agent must not be paused
    require!(
        !vault.is_agent_paused(&ctx.accounts.agent.key()),
        SigilError::AgentPaused
    );

    // 1a. Agent must have capability (single lookup replaces has_permission + get_agent)
    let agent_key = ctx.accounts.agent.key();
    let agent_entry = vault
        .get_agent(&agent_key)
        .ok_or(error!(SigilError::UnauthorizedAgent))?;
    require!(
        vault.has_capability(&agent_key, true),
        SigilError::InsufficientPermissions
    );

    // 2. Amount must be positive
    require!(amount > 0, SigilError::TransactionTooLarge);

    let token_mint = ctx.accounts.vault_token_account.mint;

    // 3. Token must be a stablecoin (stablecoin-only enforcement)
    require!(
        is_stablecoin_mint(&token_mint),
        SigilError::UnsupportedToken
    );

    // 4. Destination must be allowed
    require!(
        policy.is_destination_allowed(&ctx.accounts.destination_token_account.owner),
        SigilError::DestinationNotAllowed
    );

    // Round 2 VH-2 fix (audit 2026-05-19): graylist friction check.
    // `agent_transfer` previously called only `is_destination_allowed`
    // but NOT `is_destination_graylisted`, which let an agent transfer
    // to a destination during its 24h friction window even though the
    // destination was queued as "newly added, must wait". Mirror of the
    // check in `utils/destination_check.rs:186-193`.
    let (graylisted, _unlock) = policy.is_destination_graylisted(
        &ctx.accounts.destination_token_account.owner,
        clock.unix_timestamp,
    );
    require!(!graylisted, SigilError::ErrGraylistFriction);

    // 5. Mint consistency
    require!(
        ctx.accounts.destination_token_account.mint == token_mint,
        SigilError::InvalidTokenAccount
    );

    // 6. Get token decimals from validated mint account
    let token_decimals = ctx.accounts.token_mint_account.decimals;

    // 7. Convert stablecoin to USD (1:1)
    let usd_amount = stablecoin_to_usd(amount, token_decimals)?;

    // 8. Single tx USD check
    require!(
        usd_amount <= policy.max_transaction_size_usd,
        SigilError::TransactionTooLarge
    );

    // 9. Rolling 24h USD check
    let mut tracker = ctx.accounts.tracker.load_mut()?;
    let rolling_usd = tracker.get_rolling_24h_usd(&clock);
    let new_total_usd = rolling_usd
        .checked_add(usd_amount)
        .ok_or(SigilError::Overflow)?;
    require!(
        new_total_usd <= policy.daily_spending_cap_usd,
        SigilError::SpendingCapExceeded
    );

    // --- Per-agent cap check via contribution overlay ---
    let mut overlay = ctx.accounts.agent_spend_overlay.load_mut()?;
    if let Some(agent_slot) = overlay.find_agent_slot(&agent_key) {
        if agent_entry.spending_limit_usd > 0 {
            let agent_rolling = overlay.get_agent_rolling_24h_usd(&clock, agent_slot);
            let new_agent_spend = agent_rolling
                .checked_add(usd_amount)
                .ok_or(SigilError::Overflow)?;
            require!(
                new_agent_spend <= agent_entry.spending_limit_usd,
                SigilError::AgentSpendLimitExceeded
            );
            emit!(AgentSpendLimitChecked {
                vault: vault.key(),
                agent: agent_key,
                agent_rolling_spend: agent_rolling,
                spending_limit_usd: agent_entry.spending_limit_usd,
                amount: usd_amount,
                timestamp: clock.unix_timestamp,
            });
        }
        overlay.record_agent_contribution(&clock, agent_slot, usd_amount)?;
    } else if agent_entry.spending_limit_usd > 0 {
        return Err(error!(SigilError::AgentSlotNotFound));
    }
    drop(overlay);

    // Record spend
    tracker.record_spend(&clock, usd_amount)?;

    // ─── TA-14 (Phase 5 post-exec invariant #2): per-recipient cap ───
    //
    // agent_transfer has an explicit `destination_token_account.owner`
    // which IS the recipient wallet — no DeFi-ix walking needed. The
    // §RP-correct resolution: read the SPL TokenAccount.owner field
    // (already loaded by Anchor since this is `Account<TokenAccount>`).
    //
    // When policy.per_recipient_daily_cap_usd > 0, enforce against the
    // recipient's rolling 24h spend on `SpendTracker.per_recipient`.
    // Default 0 = no per-recipient cap, the check is skipped.
    if policy.per_recipient_daily_cap_usd > 0 {
        let recipient = ctx.accounts.destination_token_account.owner;
        let prior_spend = tracker.get_recipient_spend(&clock, &recipient);
        let new_total = prior_spend
            .checked_add(usd_amount)
            .ok_or(SigilError::Overflow)?;
        require!(
            new_total <= policy.per_recipient_daily_cap_usd,
            SigilError::ErrRecipientCapExceeded
        );
        tracker.record_recipient_spend(&clock, &recipient, usd_amount)?;
    }
    drop(tracker);

    // Build vault PDA signer seeds — LBL-01: must use vault.vault_authority
    // (immutable PDA seed), NOT vault.owner (mutates on ownership transfer).
    // See full rationale in freeze_vault.rs:76-86.
    let vault_authority = vault.vault_authority;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let vault_fee_destination = vault.fee_destination;
    let developer_fee_rate = policy.developer_fee_rate;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        vault_authority.as_ref(),
        vault_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    // Calculate fees (ceiling division — guarantees non-zero fee on any non-zero spending)
    let protocol_fee = ceil_fee(amount, PROTOCOL_FEE_RATE as u64)?;
    let developer_fee = ceil_fee(amount, developer_fee_rate as u64)?;

    let net_amount = amount
        .checked_sub(protocol_fee)
        .ok_or(SigilError::Overflow)?
        .checked_sub(developer_fee)
        .ok_or(SigilError::Overflow)?;

    // Transfer net amount to destination
    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.destination_token_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &binding,
    );
    token::transfer(cpi_ctx, net_amount)?;

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

    // ─── TA-12 (Phase 5 §RP-1 V1 fix): stable_balance_floor on agent_transfer ───
    //
    // agent_transfer transfers stablecoin OUT of the vault via SPL
    // `token::transfer` CPI. Without this gate, an agent can drain the
    // vault below the owner-configured `policy.stable_balance_floor` by
    // spamming agent_transfer calls (each individually under daily/per-tx
    // caps). The floor is the LAST defensive line.
    //
    // Adapted from finalize_session.rs:625-724 — same multi-mint summing
    // pattern, narrowed to agent_transfer's single-vault-token-account
    // model:
    //   1. Source ATA `vault_token_account` is in scope. Re-read its
    //      raw account data post-CPI because Anchor 0.32.1's
    //      `Account<TokenAccount>` does NOT auto-reload after CPI — the
    //      cached `.amount` reflects pre-CPI state.
    //   2. The OTHER stablecoin ATA (e.g. USDT when transferring USDC,
    //      or vice versa) is NOT in the AgentTransfer accounts struct.
    //      Caller passes it via `remaining_accounts` when relevant.
    //      Missing = treat its balance as 0 (conservative).
    //   3. Default `policy.stable_balance_floor = 0` → check trivially
    //      passes (existing vault behavior preserved).
    //
    // §RP brief explicitly calls out attack class "wrong pubkey (parses
    // ATA pubkey instead of owner field)" — we resolve via SPL
    // TokenAccount.owner (the wallet field at bytes 32..64), NOT the
    // meta pubkey.
    //
    // NOTE (§RP-1 V8 MEDIUM, accepted deferral): LiteSVM e2e coverage
    // for this gate is deferred to Phase 9. Cargo unit tests below pin
    // the floor-check arithmetic; integration coverage is queued.
    let stable_floor_policy = &ctx.accounts.policy;
    if stable_floor_policy.stable_balance_floor > 0 {
        let vault_key = ctx.accounts.vault.key();
        let src_mint = ctx.accounts.vault_token_account.mint;
        let src_ata_key = ctx.accounts.vault_token_account.key();
        let mut combined_stable_balance: u64 = 0;

        // Source 1: vault_token_account (the ATA the CPI just debited).
        // Read raw post-CPI bytes because Anchor's cached `.amount` is
        // pre-CPI in 0.32.1. SPL TokenAccount layout: 0..32 = mint,
        // 32..64 = owner, 64..72 = amount (u64 LE).
        {
            let src_info = ctx.accounts.vault_token_account.to_account_info();
            let src_data = src_info.try_borrow_data()?;
            if src_data.len() >= 72 {
                let mut owner_bytes = [0u8; 32];
                owner_bytes.copy_from_slice(&src_data[32..64]);
                let src_owner = Pubkey::new_from_array(owner_bytes);
                let mut mint_bytes = [0u8; 32];
                mint_bytes.copy_from_slice(&src_data[0..32]);
                let src_mint_read = Pubkey::new_from_array(mint_bytes);
                if src_owner == vault_key && is_stablecoin_mint(&src_mint_read) {
                    let mut amount_bytes = [0u8; 8];
                    amount_bytes.copy_from_slice(&src_data[64..72]);
                    let src_amount = u64::from_le_bytes(amount_bytes);
                    combined_stable_balance = combined_stable_balance
                        .checked_add(src_amount)
                        .ok_or(SigilError::Overflow)?;
                }
            }
        }

        // Source 2: remaining_accounts walk for the OTHER stablecoin
        // ATA(s). Caller passes vault's other stablecoin ATA here when
        // the floor invariant requires summing across both mints.
        //
        // Round 2 F-AT-1 fix (audit 2026-05-19): pubkey-level dedup.
        // The previous walker dedup'd by (src_ata_key + mint), which
        // let an attacker inflate the combined balance by passing the
        // SAME other-stablecoin ATA pubkey N times in remaining_accounts
        // — each iteration cleared src_ata_key + cleared src_mint but
        // re-counted the same balance. Floor check then passed despite
        // real balance below. Mirrors the `seen: Vec<Pubkey>` pattern
        // already used in `finalize_session.rs:734-786`.
        //
        // Pre-seed `seen` with src_ata_key so source-1 (already counted
        // above) is never re-counted via remaining_accounts.
        //
        // M-12 close (audit 2026-05-21, defense-in-depth): explicit
        // iteration cap. The implicit bound is Solana's per-tx 64-account
        // limit (≈35 usable after fixed accounts), but an explicit cap
        // gives a deterministic ceiling independent of tx-size mechanics
        // and is cheap (single u32 increment per iteration). The cap of
        // 16 matches V1's destination-meta budget and is well above any
        // legitimate use (an agent_transfer never needs more than 2-3
        // stablecoin ATAs).
        const MAX_STABLE_FLOOR_WALK_ITERATIONS: usize = 16;
        let mut walk_iterations: usize = 0;

        let mut seen: Vec<Pubkey> = Vec::with_capacity(2);
        seen.push(src_ata_key);
        for info in ctx.remaining_accounts.iter() {
            require!(
                walk_iterations < MAX_STABLE_FLOOR_WALK_ITERATIONS,
                SigilError::IxMetaCountExceeded
            );
            walk_iterations = walk_iterations.saturating_add(1);
            if seen.contains(&info.key()) {
                continue;
            }
            // Must be a token-program-owned account. Accept SPL Token
            // and Token-2022 — the first 72 bytes (mint, owner, amount)
            // are identical in both layouts.
            if info.owner != &anchor_spl::token::ID && info.owner != &TOKEN_2022_PROGRAM_ID {
                continue;
            }
            let data = info.try_borrow_data()?;
            if data.len() < 72 {
                continue;
            }
            let mut mint_bytes = [0u8; 32];
            mint_bytes.copy_from_slice(&data[0..32]);
            let mint = Pubkey::new_from_array(mint_bytes);
            let mut owner_bytes = [0u8; 32];
            owner_bytes.copy_from_slice(&data[32..64]);
            let owner = Pubkey::new_from_array(owner_bytes);
            if owner != vault_key || !is_stablecoin_mint(&mint) {
                continue;
            }
            // Defend against caller passing the OTHER stablecoin ATA twice
            // with the same mint — skip if mint equals src_mint (already
            // counted via source 1). The pubkey-level dedup above is the
            // primary defence; this mint check stays as belt-and-suspenders
            // for the case where a caller passes a DIFFERENT pubkey with
            // the same mint as src_mint (e.g. a stale closed ATA — should
            // not happen but is harmless to keep).
            if mint == src_mint {
                continue;
            }
            let mut amount_bytes = [0u8; 8];
            amount_bytes.copy_from_slice(&data[64..72]);
            let bal = u64::from_le_bytes(amount_bytes);
            combined_stable_balance = combined_stable_balance
                .checked_add(bal)
                .ok_or(SigilError::Overflow)?;
            seen.push(info.key());
            drop(data);
        }

        require!(
            combined_stable_balance >= stable_floor_policy.stable_balance_floor,
            SigilError::ErrStableFloorViolation
        );
    }

    // Update vault stats
    let vault = &mut ctx.accounts.vault;
    vault.total_transactions = vault
        .total_transactions
        .checked_add(1)
        .ok_or(SigilError::Overflow)?;
    vault.total_volume = vault
        .total_volume
        .checked_add(amount)
        .ok_or(SigilError::Overflow)?;
    if developer_fee > 0 {
        vault.total_fees_collected = vault
            .total_fees_collected
            .checked_add(developer_fee)
            .ok_or(SigilError::Overflow)?;
    }

    // Emit fee event if fees were collected
    if protocol_fee > 0 || developer_fee > 0 {
        emit!(FeesCollected {
            vault: vault.key(),
            token_mint,
            protocol_fee_amount: protocol_fee,
            developer_fee_amount: developer_fee,
            protocol_fee_rate: PROTOCOL_FEE_RATE,
            developer_fee_rate,
            transaction_amount: amount,
            protocol_treasury: PROTOCOL_TREASURY,
            developer_fee_destination: vault_fee_destination,
            cumulative_developer_fees: vault.total_fees_collected,
            timestamp: clock.unix_timestamp,
        });
    }

    emit!(AgentTransferExecuted {
        vault: vault.key(),
        destination: ctx.accounts.destination_token_account.owner,
        amount,
        mint: token_mint,
    });

    Ok(())
}

/// Pure arithmetic helper for the TA-12 stable_balance_floor check on
/// `agent_transfer`. Given the post-CPI combined stablecoin balance and
/// the owner-configured floor, returns Ok if the invariant holds.
///
/// This is the test surface for §RP-1 V1 — the unit tests below pin the
/// arithmetic; integration coverage (LiteSVM driving a real CPI through
/// the full instruction) is queued for Phase 9 under §RP-1 V8 MEDIUM
/// deferral.
///
/// `floor = 0` ⇒ Ok (trivial pass, preserves existing vault behavior).
/// `combined >= floor` ⇒ Ok.
/// `combined < floor` ⇒ Err(ErrStableFloorViolation).
#[cfg(test)]
fn check_stable_floor(combined: u64, floor: u64) -> Result<()> {
    if floor == 0 {
        return Ok(());
    }
    require!(combined >= floor, SigilError::ErrStableFloorViolation);
    Ok(())
}

#[cfg(test)]
mod tests {
    //! TA-12 §RP-1 V1: cargo unit tests for the stable_balance_floor
    //! check on `agent_transfer`. These exercise the pure arithmetic
    //! and threshold semantics — they do NOT drive a CPI through the
    //! full handler (that requires LiteSVM end-to-end coverage which
    //! is deferred to Phase 9 per §RP-1 V8 MEDIUM acceptance).
    //!
    //! What these tests pin today:
    //!   1. floor=0 always passes (default vault behavior preserved).
    //!   2. combined < floor rejects with ErrStableFloorViolation.
    //!   3. combined == floor passes (boundary).
    //!   4. combined > floor passes.
    //!
    //! What Phase 9 LiteSVM tests will additionally pin:
    //!   - The 72-byte SPL TokenAccount parse on the source ATA.
    //!   - The remaining_accounts walk + pubkey-level dedup (Round 2 F-AT-1
    //!     fix 2026-05-19 — previously dedup'd by src_ata_key + mint only,
    //!     letting an attacker re-pass the same other-stablecoin ATA pubkey
    //!     N times to inflate the combined balance past the floor).
    //!   - The Anchor 0.32.1 cached `.amount` vs raw-bytes post-CPI gap.
    //!   - Cross-mint summing (USDC src + USDT in remaining_accounts).

    use super::*;

    #[test]
    fn floor_zero_passes_for_any_combined() {
        // Default policy (floor=0) must NEVER reject — even with zero balance.
        assert!(check_stable_floor(0, 0).is_ok());
        assert!(check_stable_floor(1, 0).is_ok());
        assert!(check_stable_floor(u64::MAX, 0).is_ok());
    }

    #[test]
    fn floor_rejects_when_combined_below_floor() {
        // floor=100 USDC face ($100 = 100_000_000 at 6 decimals).
        let floor: u64 = 100_000_000;
        // combined just below the floor must reject.
        let result = check_stable_floor(floor - 1, floor);
        assert!(result.is_err(), "combined < floor MUST reject");
        // combined far below the floor must reject.
        let result_far = check_stable_floor(0, floor);
        assert!(result_far.is_err(), "combined=0 with floor>0 MUST reject");
    }

    #[test]
    fn floor_boundary_equal_passes() {
        // combined == floor is the exact boundary — must pass (≥ not >).
        let floor: u64 = 500_000_000; // $500
        assert!(
            check_stable_floor(floor, floor).is_ok(),
            "combined == floor MUST pass (the ≥ boundary)"
        );
    }

    #[test]
    fn floor_above_floor_passes() {
        // combined strictly above the floor must pass.
        let floor: u64 = 250_000_000; // $250
        assert!(check_stable_floor(floor + 1, floor).is_ok());
        assert!(check_stable_floor(u64::MAX, floor).is_ok());
    }
}
