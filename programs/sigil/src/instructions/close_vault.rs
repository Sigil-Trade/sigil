use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::VaultClosed;
use crate::state::*;

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        close = owner,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
        close = owner,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Zero-copy SpendTracker — close returns rent to owner
    #[account(
        mut,
        seeds = [b"tracker", vault.key().as_ref()],
        bump = tracker.load()?.bump,
        close = owner,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Zero-copy AgentSpendOverlay — close returns rent to owner
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump = agent_spend_overlay.load()?.bump,
        close = owner,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CloseVault>) -> Result<()> {
    let vault = &ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );
    require!(vault.open_positions == 0, SigilError::OpenPositionsExist);
    require!(
        vault.active_escrow_count == 0,
        SigilError::ActiveEscrowsExist
    );
    require!(vault.active_sessions == 0, SigilError::ActiveSessionsExist);
    require!(
        !ctx.accounts.policy.has_constraints,
        SigilError::ConstraintsNotClosed
    );

    // If pending policy exists, caller MUST provide it in remaining_accounts for cleanup
    if ctx.accounts.policy.has_pending_policy {
        let pending_info = ctx
            .remaining_accounts
            .first()
            .ok_or(error!(SigilError::PendingPolicyExists))?;
        let (expected_pda, _) = Pubkey::find_program_address(
            &[b"pending_policy", vault.key().as_ref()],
            ctx.program_id,
        );
        require!(
            pending_info.key() == expected_pda && pending_info.lamports() > 0,
            SigilError::PendingPolicyExists
        );
        let owner_info = ctx.accounts.owner.to_account_info();
        let dest_lamports = owner_info.lamports();
        **owner_info.try_borrow_mut_lamports()? = dest_lamports
            .checked_add(pending_info.lamports())
            .ok_or(error!(SigilError::Overflow))?;
        **pending_info.try_borrow_mut_lamports()? = 0;
        pending_info.assign(&anchor_lang::system_program::ID);
        pending_info.resize(0)?;
    }

    // Clean up pending_agent_perms PDAs (per-agent: [b"pending_agent_perms", vault, agent]).
    // MUST derive expected PDA and verify — never drain unvalidated accounts.
    // Skip past pending_policy account if it was consumed above.
    let start_idx: usize = if ctx.accounts.policy.has_pending_policy {
        1
    } else {
        0
    };
    for agent_entry in vault.agents.iter() {
        let (expected_pda, _) = Pubkey::find_program_address(
            &[
                b"pending_agent_perms",
                vault.key().as_ref(),
                agent_entry.pubkey.as_ref(),
            ],
            ctx.program_id,
        );
        // Search remaining_accounts for this PDA
        for pending_info in ctx.remaining_accounts.iter().skip(start_idx) {
            if pending_info.key() == expected_pda && pending_info.lamports() > 0 {
                let owner_info = ctx.accounts.owner.to_account_info();
                let dest_lamports = owner_info.lamports();
                **owner_info.try_borrow_mut_lamports()? = dest_lamports
                    .checked_add(pending_info.lamports())
                    .ok_or(error!(SigilError::Overflow))?;
                **pending_info.try_borrow_mut_lamports()? = 0;
                pending_info.assign(&anchor_lang::system_program::ID);
                pending_info.resize(0)?;
                break;
            }
        }
    }

    // Clean up pending_close_constraints PDA: [b"pending_close_constraints", vault].
    let (expected_close_constraints_pda, _) = Pubkey::find_program_address(
        &[b"pending_close_constraints", vault.key().as_ref()],
        ctx.program_id,
    );
    for pending_info in ctx.remaining_accounts.iter().skip(start_idx) {
        if pending_info.key() == expected_close_constraints_pda && pending_info.lamports() > 0 {
            let owner_info = ctx.accounts.owner.to_account_info();
            let dest_lamports = owner_info.lamports();
            **owner_info.try_borrow_mut_lamports()? = dest_lamports
                .checked_add(pending_info.lamports())
                .ok_or(error!(SigilError::Overflow))?;
            **pending_info.try_borrow_mut_lamports()? = 0;
            pending_info.assign(&anchor_lang::system_program::ID);
            pending_info.resize(0)?;
            break;
        }
    }

    let clock = Clock::get()?;
    emit!(VaultClosed {
        vault: vault.key(),
        owner: ctx.accounts.owner.key(),
        timestamp: clock.unix_timestamp,
    });

    // Anchor `close = owner` handles the actual closing and rent reclamation

    Ok(())
}
