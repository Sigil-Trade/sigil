use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::SigilError;
use crate::events::PdaAllocated;
use crate::state::*;

/// Maximum account size that can be created via a single CPI to the system program.
/// Solana runtime enforces MAX_PERMITTED_DATA_INCREASE = 10,240 bytes per inner instruction.
pub const MAX_CPI_ACCOUNT_SIZE: usize = 10_240;

#[derive(Accounts)]
pub struct AllocateConstraintsPda<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
        constraint = !policy.has_constraints @ SigilError::InvalidConstraintConfig,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// CHECK: PDA verified by seeds. Created in this instruction via invoke_signed CPI.
    /// Account must not already exist (lamports == 0).
    #[account(
        mut,
        seeds = [b"constraints", vault.key().as_ref()],
        bump,
    )]
    pub constraints: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AllocateConstraintsPda>) -> Result<()> {
    crate::reject_cpi!();

    // Guard: account must not already exist
    require!(
        ctx.accounts.constraints.lamports() == 0,
        SigilError::InvalidConstraintConfig
    );

    let vault_key = ctx.accounts.vault.key();
    let bump = ctx.bumps.constraints;
    let signer_seeds: &[&[u8]] = &[b"constraints", vault_key.as_ref(), &[bump]];

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(MAX_CPI_ACCOUNT_SIZE);

    // CPI: create the PDA at 10,240 bytes (max CPI-allowed size)
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::CreateAccount {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.constraints.to_account_info(),
            },
            &[signer_seeds],
        ),
        lamports,
        MAX_CPI_ACCOUNT_SIZE as u64,
        &crate::ID,
    )?;

    // Write vault key at the known offset (bytes 8..40, after discriminator slot).
    // The discriminator is written later in create_instruction_constraints (populate step).
    {
        let info = ctx.accounts.constraints.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        data[8..40].copy_from_slice(&vault_key.to_bytes());
    }

    emit!(PdaAllocated {
        vault: vault_key,
        pda_type: 0, // constraints
        initial_size: MAX_CPI_ACCOUNT_SIZE as u32,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
