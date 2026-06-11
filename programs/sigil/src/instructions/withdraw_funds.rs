use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::SigilError;
use crate::events::FundsWithdrawn;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;

#[derive(Accounts)]
pub struct WithdrawFunds<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// Round 2 fix (audit 2026-05-19): policy is now read by
    /// `withdraw_funds` to enforce the interim cosign gate when
    /// `policy.cosign_required == true`. `withdraw_funds` is the REAL
    /// drain primitive on cosign-opted-in vaults — a phished owner can
    /// withdraw 100% custody in a single tx without the gate. PDA
    /// seeds binding mirrors the pattern at
    /// `register_agent.rs:35-40`.
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    pub mint: Account<'info, Mint>,

    /// Vault's PDA-controlled token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Owner's token account to receive funds
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    /// Phase 7 — success audit log; entry appended after token transfer.
    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// CHECK: Phase 7 — slot_hashes sysvar; address-pinned.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawFunds>, amount: u64) -> Result<()> {
    crate::reject_cpi!();

    // Round 2 fix (audit 2026-05-19): interim cosign gate for
    // `withdraw_funds`. This is the REAL drain primitive on
    // cosign-opted-in vaults — a phished/leaked owner key can withdraw
    // 100% of custody in a single tx without this gate (interim cosign
    // gates on register_agent / set_observe_only / reactivate_vault are
    // moot if withdraw_funds is unguarded). Mirrors the pattern at
    // `register_agent.rs:91-95`. Vaults with the default
    // `cosign_required: false` are unaffected.
    //
    // Placed AFTER the vault.status check (so a frozen vault still
    // returns VaultAlreadyClosed not ErrCosignRequired) and BEFORE the
    // token::transfer CPI.
    require!(
        ctx.accounts.vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_non_owner_signer(
            ctx.remaining_accounts,
            &owner_key,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    let vault = &mut ctx.accounts.vault;

    require!(
        ctx.accounts.vault_token_account.amount >= amount,
        SigilError::InsufficientBalance
    );

    // PDA signer seeds — LBL-01: must use vault.vault_authority (immutable PDA
    // seed), NOT vault.owner (mutates on ownership transfer). See full rationale
    // in freeze_vault.rs:76-86.
    let vault_authority = vault.vault_authority;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = [vault.bump];
    let signer_seeds = [
        b"vault" as &[u8],
        vault_authority.as_ref(),
        vault_id_bytes.as_ref(),
        bump.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.owner_token_account.to_account_info(),
        authority: vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &binding,
    );
    token::transfer(cpi_ctx, amount)?;

    // P&L tracking: increment lifetime withdrawal counter for stablecoin mints only.
    if is_stablecoin_mint(&ctx.accounts.mint.key()) {
        vault.total_withdrawn_usd = vault
            .total_withdrawn_usd
            .checked_add(amount)
            .ok_or(error!(SigilError::Overflow))?;
    }

    let clock = Clock::get()?;
    let vault_key = vault.key();
    let mint_key = ctx.accounts.mint.key();
    let owner_key = ctx.accounts.owner.key();

    // Phase 7 — write success audit-log entry. Mint pubkey in
    // `subject` slot, withdrawn amount in `balance_delta_out`.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_WITHDRAW,
            mint_key,
            0,
            amount.min(i64::MAX as u64) as i64,
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

    emit!(FundsWithdrawn {
        vault: vault_key,
        token_mint: mint_key,
        amount,
        destination: owner_key,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
