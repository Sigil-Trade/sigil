use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::CloseConstraintsApplied;
use crate::state::*;

#[derive(Accounts)]
pub struct ApplyCloseConstraints<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        mut,
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.load()?.bump,
        close = owner,
    )]
    pub constraints: AccountLoader<'info, InstructionConstraints>,

    #[account(
        mut,
        constraint = pending_close_constraints.vault == vault.key(),
        seeds = [b"pending_close_constraints", vault.key().as_ref()],
        bump = pending_close_constraints.bump,
        close = owner,
    )]
    pub pending_close_constraints: Account<'info, PendingCloseConstraints>,
}

pub fn handler(ctx: Context<ApplyCloseConstraints>) -> Result<()> {
    crate::reject_cpi!();

    let clock = Clock::get()?;
    let pending = &ctx.accounts.pending_close_constraints;

    // Verify constraints belongs to this vault (replaces has_one = vault)
    {
        let c = ctx.accounts.constraints.load()?;
        require!(
            c.vault == ctx.accounts.vault.key().to_bytes(),
            SigilError::InvalidConstraintsPda
        );
    }

    // Timelock must have expired
    require!(
        pending.is_ready(clock.unix_timestamp),
        SigilError::TimelockNotExpired
    );

    // Clear the has_constraints flag so validate_and_authorize skips constraint checks
    let policy = &mut ctx.accounts.policy;
    policy.has_constraints = false;

    // Bump policy version — removing constraints affects security posture
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    emit!(CloseConstraintsApplied {
        vault: ctx.accounts.vault.key(),
        applied_at: clock.unix_timestamp,
    });

    // If caller provides PendingConstraintsUpdate in remaining_accounts, close it too
    // (same pattern as the old close_instruction_constraints.rs:53-70)
    if let Some(pending_info) = ctx.remaining_accounts.first() {
        let (expected_pda, _) = Pubkey::find_program_address(
            &[b"pending_constraints", ctx.accounts.vault.key().as_ref()],
            ctx.program_id,
        );
        if pending_info.key() == expected_pda && pending_info.lamports() > 0 {
            let owner_info = ctx.accounts.owner.to_account_info();
            let dest_lamports = owner_info.lamports();
            **owner_info.try_borrow_mut_lamports()? = dest_lamports
                .checked_add(pending_info.lamports())
                .ok_or(error!(SigilError::Overflow))?;
            **pending_info.try_borrow_mut_lamports()? = 0;
            pending_info.assign(&anchor_lang::system_program::ID);
            pending_info.resize(0)?;
        }
    }

    Ok(())
}
