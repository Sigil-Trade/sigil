use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CloseSettledEscrow<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = source_vault.owner == signer.key() @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", source_vault.owner.as_ref(), source_vault.vault_id.to_le_bytes().as_ref()],
        bump = source_vault.bump,
    )]
    pub source_vault: Account<'info, AgentVault>,

    /// CHECK: destination_vault_key is only used for PDA seed derivation, not loaded.
    /// Validated indirectly: if the wrong key is passed, the escrow PDA seeds won't
    /// match and Anchor will reject the account.
    pub destination_vault_key: UncheckedAccount<'info>,

    #[account(
        mut,
        close = signer,
        has_one = source_vault @ SigilError::InvalidEscrowVault,
        seeds = [b"escrow", source_vault.key().as_ref(), destination_vault_key.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowDeposit>,
}

pub fn handler(ctx: Context<CloseSettledEscrow>, _escrow_id: u64) -> Result<()> {
    let escrow = &ctx.accounts.escrow;

    // Escrow must be settled or refunded (not Active)
    require!(
        escrow.status == EscrowStatus::Settled || escrow.status == EscrowStatus::Refunded,
        SigilError::EscrowNotActive
    );

    // Anchor `close = signer` handles PDA closure, rent → signer
    // No event needed — EscrowSettled/EscrowRefunded already emitted

    Ok(())
}
