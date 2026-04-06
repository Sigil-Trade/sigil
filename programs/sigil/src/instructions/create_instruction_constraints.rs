use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::errors::SigilError;
use crate::events::InstructionConstraintsCreated;
use crate::state::constraints::{pack_entries, InstructionConstraints};
use crate::state::*;

/// Populate a pre-allocated InstructionConstraints PDA with entries.
///
/// The PDA must have been created via `allocate_constraints_pda` + `extend_pda`
/// to reach `InstructionConstraints::SIZE` before this instruction is called.
/// All five instructions are composed into a single atomic transaction by the SDK.
#[derive(Accounts)]
pub struct CreateInstructionConstraints<'info> {
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

    /// CHECK: Pre-allocated PDA at InstructionConstraints::SIZE.
    /// Verified in handler: correct size, program-owned, vault match, no discriminator yet.
    #[account(
        mut,
        seeds = [b"constraints", vault.key().as_ref()],
        bump,
    )]
    pub constraints: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<CreateInstructionConstraints>,
    entries: Vec<ConstraintEntry>,
    strict_mode: bool,
) -> Result<()> {
    InstructionConstraints::validate_entries(&entries)?;

    let vault_key = ctx.accounts.vault.key();
    let bump = ctx.bumps.constraints;
    let entry_count = entries.len() as u8;

    let info = ctx.accounts.constraints.to_account_info();

    // Verify the account is fully extended and ready for population
    require!(
        info.data_len() == InstructionConstraints::SIZE,
        SigilError::InvalidConstraintsPda
    );
    require!(info.owner == &crate::ID, SigilError::InvalidConstraintsPda);

    {
        let mut data = info.try_borrow_mut_data()?;

        // Verify discriminator slot is zeroed (prevents double-init)
        require!(data[..8] == [0u8; 8], SigilError::InvalidConstraintConfig);

        // Verify vault key was written by allocate step
        require!(
            data[8..40] == vault_key.to_bytes(),
            SigilError::ConstraintsVaultMismatch
        );

        // Write Anchor discriminator
        data[..8].copy_from_slice(InstructionConstraints::DISCRIMINATOR);

        // Write fields via bytemuck (zero-copy direct memory access)
        let struct_size = core::mem::size_of::<InstructionConstraints>();
        let constraints: &mut InstructionConstraints =
            bytemuck::from_bytes_mut(&mut data[8..8 + struct_size]);

        constraints.vault = vault_key.to_bytes();
        constraints.strict_mode = strict_mode as u8;
        constraints.bump = bump;

        let mut count = 0u8;
        pack_entries(&entries, &mut constraints.entries, &mut count)?;
        constraints.entry_count = count;
    }

    // Set has_constraints flag on policy
    ctx.accounts.policy.has_constraints = true;

    emit!(InstructionConstraintsCreated {
        vault: vault_key,
        entries_count: entry_count,
        strict_mode,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
