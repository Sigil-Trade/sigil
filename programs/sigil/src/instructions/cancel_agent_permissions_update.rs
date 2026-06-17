use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentPermissionsChangeCancelled;
use crate::state::*;

#[derive(Accounts)]
pub struct CancelAgentPermissionsUpdate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PolicyConfig is read-only here — only `cosign_required` (and the bound
    /// `cosign_session_pubkey`) are consulted for the L1-1 / D4 symmetric
    /// cosign gate (audit 2026-06-15). Mirrors `cancel_agent_grant.rs:63-67`
    /// and `cancel_pending_policy.rs` (M2a). PDA seed derivation is the
    /// load-bearing vault binding; a cosmetic `has_one = vault` is unnecessary.
    #[account(
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        mut,
        constraint = pending_agent_perms.vault == vault.key(),
        seeds = [
            b"pending_agent_perms",
            vault.key().as_ref(),
            pending_agent_perms.agent.as_ref(),
        ],
        bump = pending_agent_perms.bump,
        close = owner,
    )]
    pub pending_agent_perms: Account<'info, PendingAgentPermissionsUpdate>,
}

pub fn handler(ctx: Context<CancelAgentPermissionsUpdate>) -> Result<()> {
    crate::reject_cpi!();

    // L1-1 (audit 2026-06-15) — D4 symmetric cosign gate. Mirrors
    // `cancel_agent_grant.rs:107-115` and `cancel_pending_policy.rs` (M2a):
    // on a cosign-opted-in vault the cancel ALSO requires a bound non-owner
    // cosigner in `remaining_accounts`. Closes the cancel-and-disrupt bypass
    // where a phished owner key alone aborts a legitimately-cosigned pending
    // agent-permissions change (re-queuing the elevated change still needs
    // the cosigner, so the residual is deny/grief, not direct escalation).
    // Single-signer flow is unchanged for vaults with `cosign_required: false`.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_bound_cosigner(
            ctx.remaining_accounts,
            &owner_key,
            &ctx.accounts.policy.cosign_session_pubkey,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    emit!(AgentPermissionsChangeCancelled {
        vault: ctx.accounts.vault.key(),
        agent: ctx.accounts.pending_agent_perms.agent,
    });

    Ok(())
}
