use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use solana_program::hash::Hasher;

use crate::errors::SigilError;
use crate::events::EscrowSettled;
use crate::state::*;

/// SHA-256 hash for escrow condition verification.
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Hasher::default();
    hasher.hash(data);
    hasher.result().to_bytes()
}

#[derive(Accounts)]
pub struct SettleEscrow<'info> {
    #[account(mut)]
    pub destination_agent: Signer<'info>,

    #[account(
        constraint = destination_vault.is_agent(&destination_agent.key()) @ SigilError::UnauthorizedAgent,
        seeds = [b"vault", destination_vault.owner.as_ref(), destination_vault.vault_id.to_le_bytes().as_ref()],
        bump = destination_vault.bump,
    )]
    pub destination_vault: Account<'info, AgentVault>,

    #[account(
        mut,
        seeds = [b"vault", source_vault.owner.as_ref(), source_vault.vault_id.to_le_bytes().as_ref()],
        bump = source_vault.bump,
    )]
    pub source_vault: Account<'info, AgentVault>,

    #[account(
        mut,
        constraint = escrow.destination_vault == destination_vault.key() @ SigilError::InvalidEscrowVault,
        constraint = escrow.source_vault == source_vault.key() @ SigilError::InvalidEscrowVault,
        seeds = [b"escrow", source_vault.key().as_ref(), destination_vault.key().as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
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
        token::authority = destination_vault,
    )]
    pub destination_vault_ata: Account<'info, TokenAccount>,

    /// CHECK: Validated as source vault owner — receives escrow ATA rent
    #[account(
        mut,
        constraint = rent_destination.key() == source_vault.owner @ SigilError::UnauthorizedOwner,
    )]
    pub rent_destination: UncheckedAccount<'info>,

    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SettleEscrow>, proof: Vec<u8>) -> Result<()> {
    // 0. CPI guard
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        SigilError::CpiCallNotAllowed
    );

    let escrow = &ctx.accounts.escrow;
    let clock = Clock::get()?;

    // 0b. Destination agent must not be paused
    require!(
        !ctx.accounts
            .destination_vault
            .is_agent_paused(&ctx.accounts.destination_agent.key()),
        SigilError::AgentPaused
    );

    // 1. Permission check
    require!(
        ctx.accounts.destination_vault.has_permission(
            &ctx.accounts.destination_agent.key(),
            &ActionType::SettleEscrow
        ),
        SigilError::InsufficientPermissions
    );

    // 2. Escrow must be Active
    require!(
        escrow.status == EscrowStatus::Active,
        SigilError::EscrowNotActive
    );

    // 3. Must not be expired
    require!(
        clock.unix_timestamp < escrow.expires_at,
        SigilError::EscrowExpired
    );

    // 4. Conditional escrow: verify SHA-256 proof
    if escrow.condition_hash != [0u8; 32] {
        require!(
            sha256(&proof) == escrow.condition_hash,
            SigilError::EscrowConditionsNotMet
        );
    }

    // 5. Build escrow PDA signer seeds
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

    // 6. Transfer funds from escrow ATA → destination vault ATA
    let cpi_accounts = Transfer {
        from: ctx.accounts.escrow_ata.to_account_info(),
        to: ctx.accounts.destination_vault_ata.to_account_info(),
        authority: ctx.accounts.escrow.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &escrow_binding,
    );
    token::transfer(cpi_ctx, transfer_amount)?;

    // 7. Close escrow ATA — rent → source_vault.owner
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

    // 8. Update status
    let escrow = &mut ctx.accounts.escrow;
    escrow.status = EscrowStatus::Settled;

    // 8b. Decrement source vault escrow counter
    let source_vault = &mut ctx.accounts.source_vault;
    source_vault.active_escrow_count = source_vault.active_escrow_count.saturating_sub(1);

    // 9. Emit event
    emit!(EscrowSettled {
        source_vault: source_vault_key,
        destination_vault: dest_vault_key,
        escrow_id: escrow.escrow_id,
        amount: transfer_amount,
        settled_by: ctx.accounts.destination_agent.key(),
    });

    Ok(())
}
