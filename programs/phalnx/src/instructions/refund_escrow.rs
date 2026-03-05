use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::errors::PhalnxError;
use crate::events::EscrowRefunded;
use crate::state::*;

#[derive(Accounts)]
pub struct RefundEscrow<'info> {
    /// Source vault's agent or owner
    #[account(mut)]
    pub source_signer: Signer<'info>,

    #[account(
        constraint = source_vault.is_agent(&source_signer.key())
            || source_vault.owner == source_signer.key()
            @ PhalnxError::UnauthorizedAgent,
        seeds = [b"vault", source_vault.owner.as_ref(), source_vault.vault_id.to_le_bytes().as_ref()],
        bump = source_vault.bump,
    )]
    pub source_vault: Account<'info, AgentVault>,

    #[account(
        mut,
        constraint = escrow.source_vault == source_vault.key() @ PhalnxError::InvalidEscrowVault,
        seeds = [b"escrow", source_vault.key().as_ref(), escrow.destination_vault.as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowDeposit>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = escrow,
    )]
    pub escrow_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = source_vault,
    )]
    pub source_vault_ata: Account<'info, TokenAccount>,

    /// CHECK: Validated as source vault owner — receives escrow ATA rent
    #[account(
        mut,
        constraint = rent_destination.key() == source_vault.owner @ PhalnxError::UnauthorizedOwner,
    )]
    pub rent_destination: UncheckedAccount<'info>,

    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RefundEscrow>) -> Result<()> {
    // 0. CPI guard
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        PhalnxError::CpiCallNotAllowed
    );

    let escrow = &ctx.accounts.escrow;
    let source_vault = &ctx.accounts.source_vault;
    let clock = Clock::get()?;

    // 1. If signer is agent (not owner), check RefundEscrow permission
    if source_vault.owner != ctx.accounts.source_signer.key() {
        require!(
            source_vault
                .has_permission(&ctx.accounts.source_signer.key(), &ActionType::RefundEscrow),
            PhalnxError::InsufficientPermissions
        );
    }

    // 2. Escrow must be Active
    require!(
        escrow.status == EscrowStatus::Active,
        PhalnxError::EscrowNotActive
    );

    // 3. Must be expired
    require!(
        clock.unix_timestamp >= escrow.expires_at,
        PhalnxError::EscrowNotExpired
    );

    // 4. Build escrow PDA signer seeds
    let source_vault_key = escrow.source_vault;
    let dest_vault_key = escrow.destination_vault;
    let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
    let escrow_bump = escrow.bump;
    let transfer_amount = escrow.amount;

    let bump_slice = [escrow_bump];
    let escrow_seeds = [
        b"escrow" as &[u8],
        source_vault_key.as_ref(),
        dest_vault_key.as_ref(),
        escrow_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let escrow_binding = [escrow_seeds.as_slice()];

    // 5. Transfer funds from escrow ATA → source vault ATA
    let cpi_accounts = Transfer {
        from: ctx.accounts.escrow_ata.to_account_info(),
        to: ctx.accounts.source_vault_ata.to_account_info(),
        authority: ctx.accounts.escrow.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &escrow_binding,
    );
    token::transfer(cpi_ctx, transfer_amount)?;

    // 6. Close escrow ATA — rent → source_vault.owner
    let close_accounts = CloseAccount {
        account: ctx.accounts.escrow_ata.to_account_info(),
        destination: ctx.accounts.rent_destination.to_account_info(),
        authority: ctx.accounts.escrow.to_account_info(),
    };
    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        close_accounts,
        &escrow_binding,
    );
    token::close_account(close_ctx)?;

    // 7. Update status
    let escrow = &mut ctx.accounts.escrow;
    escrow.status = EscrowStatus::Refunded;

    // 8. Emit event
    emit!(EscrowRefunded {
        source_vault: source_vault_key,
        destination_vault: dest_vault_key,
        escrow_id: escrow.escrow_id,
        amount: transfer_amount,
        refunded_by: ctx.accounts.source_signer.key(),
    });

    Ok(())
}
