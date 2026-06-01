//! TA-07 (Phase 3 pre-execution guard #4): owner-only fast-track of a
//! destination from the graylist to active.
//!
//! Background: when a new destination is added to `allowed_destinations`
//! via `queue_policy_update`, it enters
//! `PolicyConfig.destination_graylist` with `unlock_unix = now + 86400`.
//! Until either the unlock elapses or the owner calls this ix, spending
//! paths reject value routed to the destination with
//! `ErrGraylistFriction` (6077).
//!
//! This ix is the **owner-only** escape hatch — the agent / session
//! cannot self-promote. It sets the unlock to `clock.unix_timestamp`
//! (effective immediately) and emits `GraylistPromoted` for the audit
//! trail. No timelock — promotion is a strict subset of the already-
//! signed allowlist authorisation.
//!
//! Auth: `has_one = owner` on the vault. Per HARDENED prompt §6 (§RP
//! check): only the owner can promote, not the agent, not any session.

use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::GraylistPromoted;
use crate::state::*;

#[derive(Accounts)]
pub struct PromoteGraylistDestination<'info> {
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
}

pub fn handler(ctx: Context<PromoteGraylistDestination>, destination: Pubkey) -> Result<()> {
    crate::reject_cpi!();

    let vault = &ctx.accounts.vault;
    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // M1-03 (systemic frozen-gate, 2026-05-31): a frozen vault MUST NOT promote
    // (whitelist) a destination. Adding an allowed destination is ADDITIVE — a
    // phished owner key could whitelist a drain address during a freeze to apply
    // once reactivated. Gated. Closed is rejected above with its own diagnostic.
    require!(
        vault.status != VaultStatus::Frozen,
        SigilError::VaultNotActive
    );

    // Round 2 V5 MED finding (audit 2026-05-19): interim cosign gate for
    // `promote_graylist_destination`. Without this gate a phished owner
    // on a cosign-opted-in vault could pre-stage a hostile destination
    // through the 24h graylist friction window in a single tx (the
    // graylist promotion is owner-only but did NOT require cosign even
    // when `policy.cosign_required == true`). Mirrors the gate already
    // on `register_agent.rs:91-95`, `set_observe_only.rs`, and
    // `reactivate_vault.rs` (F-RP3-1). Vaults with the default
    // `cosign_required: false` are unaffected.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_non_owner_signer(
            ctx.remaining_accounts,
            &owner_key,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    let policy = &mut ctx.accounts.policy;
    let clock = Clock::get()?;

    // Locate the entry. Promotion is a no-op on a destination that is not
    // currently graylisted (idempotent). But to avoid silent owner
    // misconfiguration, we surface a clear error path: the destination
    // must EITHER be in the graylist OR be a recognised allowlist entry
    // — promoting an unknown pubkey is rejected as
    // DestinationNotAllowed.
    require!(
        policy.allowed_destinations.contains(&destination),
        SigilError::DestinationNotAllowed
    );

    // Idempotent: if the destination is in the graylist, set unlock to
    // now. If not present (e.g. already past unlock and cleaned up), do
    // nothing — promotion is a no-op.
    let mut promoted = false;
    for entry in policy.destination_graylist.iter_mut() {
        if entry.destination == destination {
            entry.unlock_unix = clock.unix_timestamp;
            promoted = true;
            break;
        }
    }

    // TA-19 (Phase 2): graylist is NOT in the canonical digest, so
    // promoting does not require digest recomputation. The
    // allowed_destinations field (digest position 8) is unchanged.

    emit!(GraylistPromoted {
        vault: vault.key(),
        destination,
        promoted,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
