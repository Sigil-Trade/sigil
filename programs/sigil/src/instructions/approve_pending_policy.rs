use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::PolicyCosignApproved;
use crate::state::*;

/// Async cosign approval (2026-06-17, design `COSIGN_ASYNC_APPROVAL_2026-06-17`).
///
/// The bound cosigner K approves an elevated queued policy update on-chain, on
/// their own schedule (their own fresh transaction — a Solana blockhash expires
/// in ~60-90s, so a remote cosigner cannot co-sign the SAME tx the owner
/// queued). `apply_pending_policy` then requires `cosign_approved == true` for
/// elevated mutations (this REPLACES #351's synchronous apply-time cosigner
/// re-assert).
///
/// Strict staleness (Squads `stale_transaction_index` analog): the live
/// `policy_version` MUST still equal the value snapshotted at queue
/// (`pending.queued_policy_version`). Any policy change since queue — including
/// a cosigner rotation, which bumps `policy_version` — invalidates this pending
/// approval; the owner must re-queue.
#[derive(Accounts)]
pub struct ApprovePendingPolicy<'info> {
    /// The bound cosigner K. Must equal `policy.cosign_session_pubkey`.
    pub cosigner: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
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
    )]
    pub pending_policy: Account<'info, PendingPolicyUpdate>,
}

pub fn handler(ctx: Context<ApprovePendingPolicy>) -> Result<()> {
    crate::reject_cpi!();

    // M1-03 (mirror queue_policy_update / apply_pending_policy): no cosign churn
    // on a non-Active vault. Without this, an approval set during a freeze would
    // age past the F-10 window before reactivation makes apply legal.
    require!(
        ctx.accounts.vault.status == VaultStatus::Active,
        SigilError::VaultNotActive
    );

    // Snapshot the policy reads + signer/vault keys BEFORE the mutable pending
    // borrow (disjoint-field clarity).
    let bound_cosigner = ctx.accounts.policy.cosign_session_pubkey;
    let live_policy_version = ctx.accounts.policy.policy_version;
    let cosigner_key = ctx.accounts.cosigner.key();
    let vault_key = ctx.accounts.vault.key();
    let clock = Clock::get()?;

    let pending = &mut ctx.accounts.pending_policy;

    // This pending must be an ELEVATED one bound to a cosigner. A non-elevated
    // pending has `cosign_session == default` (zero digest) and is applied
    // owner-only — there is nothing to approve.
    require_keys_neq!(
        pending.cosign_session,
        Pubkey::default(),
        SigilError::ErrCosignRequired
    );

    // The signer MUST be the vault's currently-bound cosigner K. The strict
    // staleness check below guarantees the bound K has not rotated since queue,
    // so this also equals `pending.cosign_session`.
    require_keys_eq!(cosigner_key, bound_cosigner, SigilError::ErrCosignRequired);

    // WRITE-ONCE (adversarial review 2026-06-17): approval is single-use.
    // Re-approval would overwrite `approved_at_slot` and re-arm the F-10 freshness
    // window indefinitely (the durable-nonce pre-signing class F-10 bounds). If
    // the post-approval apply window lapses, the owner must cancel + re-queue.
    require!(!pending.cosign_approved, SigilError::ErrCosignRequired);

    // Strict staleness gate: the live policy_version must still equal the value
    // snapshotted at queue. Any policy mutation since queue (incl. a cosigner
    // rotation, which bumps the version) invalidates this pending.
    require!(
        live_policy_version == pending.queued_policy_version,
        SigilError::PolicyVersionMismatch
    );

    // Approve only AFTER the timelock matures (adversarial review 2026-06-17).
    // `timelock_duration` has no upper bound; approving early on a long-timelock
    // pending would age `approved_at_slot` past MAX_APPLY_AGE_SLOTS before apply
    // is legal and PERMANENTLY brick the update. Gating on `is_ready` anchors the
    // approval inside the apply-able window, keeping the F-10 re-anchor coherent.
    require!(
        pending.is_ready(clock.unix_timestamp),
        SigilError::TimelockNotExpired
    );

    pending.cosign_approved = true;
    pending.approved_at_slot = clock.slot;

    emit!(PolicyCosignApproved {
        vault: vault_key,
        cosigner: cosigner_key,
        approved_at_slot: clock.slot,
    });

    Ok(())
}
