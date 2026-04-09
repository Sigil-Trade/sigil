use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::SigilError;
use crate::events::PdaAllocated;
use crate::state::*;

use super::allocate_constraints_pda::MAX_CPI_ACCOUNT_SIZE;

#[derive(Accounts)]
pub struct AllocatePendingConstraintsPda<'info> {
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
        constraint = policy.has_constraints @ SigilError::InvalidConstraintsPda,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Existing constraints PDA must exist (proves there's something to update).
    #[account(
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.load()?.bump,
    )]
    pub constraints: AccountLoader<'info, InstructionConstraints>,

    /// CHECK: PDA verified by seeds. Created in this instruction via invoke_signed CPI.
    #[account(
        mut,
        seeds = [b"pending_constraints", vault.key().as_ref()],
        bump,
    )]
    pub pending_constraints: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AllocatePendingConstraintsPda>) -> Result<()> {
    crate::reject_cpi!();

    let policy = &ctx.accounts.policy;

    // Timelock must be configured to use queue
    require!(
        policy.timelock_duration > 0,
        SigilError::NoTimelockConfigured
    );

    // Guard: account must not already exist
    require!(
        ctx.accounts.pending_constraints.lamports() == 0,
        SigilError::InvalidConstraintConfig
    );

    // Verify existing constraints belongs to this vault
    {
        let c = ctx.accounts.constraints.load()?;
        require!(
            c.vault == ctx.accounts.vault.key().to_bytes(),
            SigilError::InvalidConstraintsPda
        );
    }

    let vault_key = ctx.accounts.vault.key();
    let bump = ctx.bumps.pending_constraints;
    let signer_seeds: &[&[u8]] = &[b"pending_constraints", vault_key.as_ref(), &[bump]];

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(MAX_CPI_ACCOUNT_SIZE);

    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::CreateAccount {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.pending_constraints.to_account_info(),
            },
            &[signer_seeds],
        ),
        lamports,
        MAX_CPI_ACCOUNT_SIZE as u64,
        &crate::ID,
    )?;

    // Write vault key at offset 8..40
    {
        let info = ctx.accounts.pending_constraints.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        data[8..40].copy_from_slice(&vault_key.to_bytes());
    }

    emit!(PdaAllocated {
        vault: vault_key,
        pda_type: 1, // pending_constraints
        initial_size: MAX_CPI_ACCOUNT_SIZE as u32,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
