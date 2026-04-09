use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::errors::SigilError;
use crate::events::ConstraintsChangeQueued;
use crate::state::constraints::pack_entries;
use crate::state::pending_constraints::PendingConstraintsUpdate;
use crate::state::*;

/// Queue a constraints update. The PendingConstraintsUpdate PDA must have been
/// pre-allocated via `allocate_pending_constraints_pda` + `extend_pda` to reach
/// `PendingConstraintsUpdate::SIZE` before this instruction is called.
#[derive(Accounts)]
pub struct QueueConstraintsUpdate<'info> {
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
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Existing constraints — seeds verify PDA, bump verified via load().
    #[account(
        seeds = [b"constraints", vault.key().as_ref()],
        bump = constraints.load()?.bump,
    )]
    pub constraints: AccountLoader<'info, InstructionConstraints>,

    /// CHECK: Pre-allocated PDA at PendingConstraintsUpdate::SIZE.
    /// Verified in handler: correct size, program-owned, vault match, no discriminator.
    #[account(
        mut,
        seeds = [b"pending_constraints", vault.key().as_ref()],
        bump,
    )]
    pub pending_constraints: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<QueueConstraintsUpdate>,
    entries: Vec<ConstraintEntry>,
    strict_mode: bool,
) -> Result<()> {
    crate::reject_cpi!();

    let policy = &ctx.accounts.policy;
    let vault_key = ctx.accounts.vault.key();

    // Verify constraints belongs to this vault
    {
        let c = ctx.accounts.constraints.load()?;
        require!(
            c.vault == vault_key.to_bytes(),
            SigilError::InvalidConstraintsPda
        );
    }

    // Timelock must be configured to use queue
    require!(
        policy.timelock_duration > 0,
        SigilError::NoTimelockConfigured
    );

    InstructionConstraints::validate_entries(&entries)?;

    let pending_info = ctx.accounts.pending_constraints.to_account_info();

    // Verify the account is fully extended and ready for population
    require!(
        pending_info.data_len() == PendingConstraintsUpdate::SIZE,
        SigilError::InvalidPendingConstraintsPda
    );
    require!(
        pending_info.owner == &crate::ID,
        SigilError::InvalidPendingConstraintsPda
    );

    let clock = Clock::get()?;
    let executes_at = clock
        .unix_timestamp
        .checked_add(policy.timelock_duration as i64)
        .ok_or(SigilError::Overflow)?;
    let bump = ctx.bumps.pending_constraints;

    {
        let mut data = pending_info.try_borrow_mut_data()?;

        // Verify discriminator slot is zeroed (prevents double-init)
        require!(data[..8] == [0u8; 8], SigilError::InvalidConstraintConfig);

        // Verify vault key was written by allocate step
        require!(
            data[8..40] == vault_key.to_bytes(),
            SigilError::ConstraintsVaultMismatch
        );

        // Write Anchor discriminator
        data[..8].copy_from_slice(PendingConstraintsUpdate::DISCRIMINATOR);

        // Write fields via bytemuck
        let struct_size = core::mem::size_of::<PendingConstraintsUpdate>();
        let pending: &mut PendingConstraintsUpdate =
            bytemuck::from_bytes_mut(&mut data[8..8 + struct_size]);

        pending.vault = vault_key.to_bytes();
        pending.strict_mode = strict_mode as u8;
        pending.queued_at = clock.unix_timestamp;
        pending.executes_at = executes_at;
        pending.bump = bump;

        let mut count = 0u8;
        pack_entries(&entries, &mut pending.entries, &mut count)?;
        pending.entry_count = count;
    }

    emit!(ConstraintsChangeQueued {
        vault: vault_key,
        executes_at,
    });

    Ok(())
}
