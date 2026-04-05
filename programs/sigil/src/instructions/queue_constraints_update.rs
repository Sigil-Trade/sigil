use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::ConstraintsChangeQueued;
use crate::state::constraints::pack_entries;
use crate::state::*;

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

    #[account(
        init,
        payer = owner,
        space = PendingConstraintsUpdate::SIZE,
        seeds = [b"pending_constraints", vault.key().as_ref()],
        bump,
    )]
    pub pending_constraints: AccountLoader<'info, PendingConstraintsUpdate>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<QueueConstraintsUpdate>,
    entries: Vec<ConstraintEntry>,
    strict_mode: bool,
) -> Result<()> {
    let policy = &ctx.accounts.policy;

    // Verify constraints belongs to this vault (replaces has_one = vault)
    {
        let c = ctx.accounts.constraints.load()?;
        require!(
            c.vault == ctx.accounts.vault.key().to_bytes(),
            SigilError::InvalidConstraintsPda
        );
    }

    // Timelock must be configured to use queue
    require!(
        policy.timelock_duration > 0,
        SigilError::NoTimelockConfigured
    );

    InstructionConstraints::validate_entries(&entries)?;

    let clock = Clock::get()?;
    let executes_at = clock
        .unix_timestamp
        .checked_add(policy.timelock_duration as i64)
        .ok_or(SigilError::Overflow)?;

    {
        let mut pending = ctx.accounts.pending_constraints.load_init()?;
        pending.vault = ctx.accounts.vault.key().to_bytes();
        pending.strict_mode = strict_mode as u8;
        pending.queued_at = clock.unix_timestamp;
        pending.executes_at = executes_at;
        pending.bump = ctx.bumps.pending_constraints;

        let mut count = 0u8;
        pack_entries(&entries, &mut pending.entries, &mut count)?;
        pending.entry_count = count;
    }

    emit!(ConstraintsChangeQueued {
        vault: ctx.accounts.vault.key(),
        executes_at,
    });

    Ok(())
}
