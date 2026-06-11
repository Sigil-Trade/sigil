use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::SigilError;
use crate::events::FundsDeposited;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::token2022_extension::enforce_token2022_extension_allowlist;

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    pub mint: Account<'info, Mint>,

    /// Owner's token account to transfer from
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    /// Vault's PDA-controlled token account
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

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
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
    crate::reject_cpi!();

    let vault = &mut ctx.accounts.vault;
    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // TA-03 (Phase 3 pre-execution guard #1): pin the deposit mint at the
    // entry point to the build-time stablecoin allowlist. Closes the gap
    // where an owner could deposit an exotic / typosquatted mint and confuse
    // downstream balance-delta logic in `finalize_session` (which uses
    // `is_stablecoin_mint` — a wider predicate used for output-mint
    // accounting in the spending path, but historically NOT enforced at
    // deposit). Devnet-testing builds keep the existing escape hatch.
    require!(
        is_pinned_deposit_mint(&ctx.accounts.mint.key()),
        SigilError::ErrMintNotPinned
    );

    // TA-08 (Phase 3 pre-execution guard #5): if the pinned mint is a
    // Token-2022 mint, walk its TLV blob and reject any extension that is
    // not on the V1 allowlist (MemoTransfer / MetadataPointer — exactly
    // 2 IDs; F-Q4 removed NonTransferable). Forward-secure: unknown extension
    // type IDs reject. This is layered with the runtime opcode blocklist
    // in `validate_and_authorize.rs` (per F-5); both layers are required.
    //
    // For SPL-classic mints (USDC + USDT mainnet today), the function is
    // a no-op — there is no extension surface to validate.
    enforce_token2022_extension_allowlist(&ctx.accounts.mint.to_account_info())?;

    // Transfer tokens from owner to vault PDA token account
    let cpi_accounts = Transfer {
        from: ctx.accounts.owner_token_account.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    // P&L tracking: increment lifetime deposit counter for stablecoin mints only.
    if is_stablecoin_mint(&ctx.accounts.mint.key()) {
        vault.total_deposited_usd = vault
            .total_deposited_usd
            .checked_add(amount)
            .ok_or(error!(SigilError::Overflow))?;
    }

    let clock = Clock::get()?;
    let vault_key = vault.key();
    let mint_key = ctx.accounts.mint.key();

    // Phase 7 — write success audit-log entry. Mint pubkey is stored in
    // the `subject` slot for filtering by token; `balance_delta_in` is set
    // to the deposited amount (positive direction = funds IN).
    {
        let entry = build_audit_entry(
            AUDIT_DISC_DEPOSIT,
            mint_key,
            amount.min(i64::MAX as u64) as i64,
            0,
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

    emit!(FundsDeposited {
        vault: vault_key,
        token_mint: mint_key,
        amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
