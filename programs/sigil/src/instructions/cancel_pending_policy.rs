use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::PolicyChangeCancelled;
use crate::state::*;

#[derive(Accounts)]
pub struct CancelPendingPolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
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
        has_one = vault,
        seeds = [b"pending_policy", vault.key().as_ref()],
        bump = pending_policy.bump,
        close = owner,
    )]
    pub pending_policy: Account<'info, PendingPolicyUpdate>,
}

pub fn handler(ctx: Context<CancelPendingPolicy>) -> Result<()> {
    crate::reject_cpi!();

    // ASYNC COSIGN (2026-06-17, design COSIGN_ASYNC_APPROVAL_2026-06-17): cancel
    // is now OWNER-ONLY. #351 added a synchronous D4 cosign gate here so a phished
    // owner key alone couldn't cancel a cosigned pending and re-queue a weaker
    // policy. In the async model that attack is already defeated downstream: a
    // re-queued weaker policy CANNOT be applied without the bound cosigner's
    // on-chain approval (`apply_pending_policy` requires `cosign_approved`).
    // Canceling is the owner withdrawing their OWN un-applied proposal (a 2-of-2
    // where either party may decline); it moves no funds and weakens no live
    // policy. Requiring the cosigner synchronously here would only re-introduce
    // the blockhash-expiry problem the async model exists to solve, so the gate
    // is removed.

    ctx.accounts.policy.has_pending_policy = false;

    emit!(PolicyChangeCancelled {
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}
