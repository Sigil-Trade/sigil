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

    // M2 (audit 2026-06-15): D4 symmetric cosign gate — mirrors
    // `cancel_ownership_transfer.rs:111-121` / `cancel_agent_grant.rs:107-115`.
    // On a cosign-opted-in vault, a phished owner key ALONE must not be able
    // to cancel a queued (cosigned) policy update and then re-queue a weaker
    // policy. The cancel therefore also requires the bound cosigner. The
    // default `cosign_required == false` leaves the single-signer flow
    // unchanged. No `Active` gate here (unlike ownership/grant cancels):
    // `freeze_vault` does not drain `pending_policy`, so keeping cancel
    // available while Frozen is a liveness benefit, and the cosign gate is the
    // correct anti-phishing protection for this lower-stakes pending.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_bound_cosigner(
            ctx.remaining_accounts,
            &owner_key,
            &ctx.accounts.policy.cosign_session_pubkey,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    ctx.accounts.policy.has_pending_policy = false;

    emit!(PolicyChangeCancelled {
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}
