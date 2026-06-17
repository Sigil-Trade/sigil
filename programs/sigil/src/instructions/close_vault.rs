use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::TokenAccount;

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
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
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

    /// Phase 7 — close success audit log; rent returns to owner.
    /// Closing here closes the close+reinit replay window: a vault can be
    /// re-initialised at the same (owner, vault_id) only after the audit
    /// logs have been reclaimed, and PEN-CROSS-2 still protects against
    /// stale-digest replay across the close boundary.
    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
        close = owner,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// Phase 7 — close rejected audit log; rent returns to owner.
    #[account(
        mut,
        seeds = [b"audit_rejected", vault.key().as_ref()],
        bump = audit_log_rejected.load()?.bump,
        close = owner,
    )]
    pub audit_log_rejected: AccountLoader<'info, AuditLogRejected>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CloseVault>) -> Result<()> {
    crate::reject_cpi!();

    let vault = &ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );
    require!(vault.active_sessions == 0, SigilError::ActiveSessionsExist);
    // M1-04 (constraints-engine teardown): the "constraints must be closed
    // before vault close" guard (`require!(!policy.has_constraints, …)`) was
    // removed — the constraints engine is gone, so no vault can ever carry a
    // live constraint set. The `has_constraints` field (Step 5) and the
    // `ConstraintsNotClosed` error variant (Step 6) are both removed.
    // H-3 close (audit 2026-05-21): the 672-byte
    // PostExecutionAssertions PDA has its own dedicated close handler
    // (close_post_assertions.rs) and must be drained before vault close to
    // avoid orphaning the PDA. Pre-fix, owners could close the vault while
    // policy.has_post_assertions == 1 — the PDA would persist on-chain with
    // no path to reclaim rent (post-close vault cannot re-init).
    require!(
        ctx.accounts.policy.has_post_assertions == 0,
        SigilError::ErrPostAssertionsNotClosed
    );

    // Take-over 2026-06-16 (B-1, user decision "Both"): closing a cosign vault is
    // the ULTIMATE protection-removal — it destroys the PolicyConfig that holds
    // `cosign_session_pubkey`, which is exactly what enables the
    // close -> reinit(cosign OFF) -> withdraw drain (threat-model T-19, previously
    // deferred to "V1.1" for rent cost). So on a cosign-required vault, the close
    // MUST be cosigned by the bound K — a leaked owner key alone can no longer
    // start that chain. Mirrors withdraw_funds / set_observe_only /
    // close_post_assertions. (The companion "vault must be empty" half of the
    // fix is enforced separately so funds can only ever exit via the K-gated
    // withdraw_funds.)
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        require!(
            crate::instructions::register_agent::has_bound_cosigner(
                ctx.remaining_accounts,
                &owner_key,
                &ctx.accounts.policy.cosign_session_pubkey,
            ),
            SigilError::ErrCosignRequired
        );

        // B-1 "empty" half (user decision "Both"): every stablecoin custody
        // account MUST be empty/closed at close, so custody can ONLY exit via the
        // cosign-gated withdraw_funds — never orphaned in a surviving ATA for a
        // close->reinit to drain. A vault's token custody is exactly the pinned
        // stablecoin set (mainnet: USDC + USDT, both classic SPL-Token; deposits
        // are pinned and agent outputs are F-Q8-pinned to these stablecoin ATAs).
        // Derive each vault ATA and REQUIRE the caller to supply it so the
        // balance can be verified; a missing account or a non-zero balance fails
        // CLOSED. (Token-2022 stablecoins are not in the pinned set today; adding
        // one would require deriving its ATA with the Token-2022 program here.)
        let vault_key = vault.key();
        for stable_mint in [USDC_MINT, USDT_MINT] {
            let ata = get_associated_token_address(&vault_key, &stable_mint);
            match ctx.remaining_accounts.iter().find(|ai| ai.key() == ata) {
                Some(ai) => {
                    // An initialized SPL-Token account at the derived ATA must be
                    // zero. A closed / never-created account (owner != Token
                    // program — e.g. SystemProgram) holds no custody → OK.
                    if ai.owner == &anchor_spl::token::ID {
                        let ta =
                            TokenAccount::try_deserialize(&mut &ai.try_borrow_data()?[..])?;
                        require!(ta.amount == 0, SigilError::ErrVaultNotEmpty);
                    }
                }
                // Not supplied → cannot prove empty → fail closed.
                None => return Err(error!(SigilError::ErrVaultNotEmpty)),
            }
        }
    }

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

    // Phase 8 §RP Fix-Up B (SFH-01 HIGH, audit 2026-05-19): drain
    // `PendingOwnershipTransfer` PDA if present. Without this, an in-flight
    // ownership transfer queued at the time of close would leave a stale
    // pending PDA at [b"pending_owner", vault] — its rent is unreclaimable
    // by the original owner (vault closed → has_one=owner fails) AND the
    // PDA's `pending.new_owner` becomes a phantom claim against a vault
    // that no longer exists. Even worse, if a future vault re-init at the
    // same (owner, vault_id) seed-collision lands, the stale PDA could
    // collide with a fresh queue.
    //
    // Same drain pattern as pending_policy above: derive expected PDA,
    // scan remaining_accounts for matching
    // pubkey, transfer lamports, zero the data, reassign to SystemProgram.
    let (expected_pending_owner_pda, _) =
        Pubkey::find_program_address(&[b"pending_owner", vault.key().as_ref()], ctx.program_id);
    for pending_info in ctx.remaining_accounts.iter().skip(start_idx) {
        if pending_info.key() == expected_pending_owner_pda && pending_info.lamports() > 0 {
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

    // Phase 8 §RP Fix-Up B (SFH-01 HIGH, audit 2026-05-19): drain
    // `PendingAgentGrant` PDA if present. Same rationale as
    // pending_owner above — a queued OPERATOR-class grant left dangling
    // post-close is a phantom claim. The PDA close is best-effort: if the
    // caller doesn't pass it in remaining_accounts the close still
    // succeeds (no rejection), but the orphan PDA's rent stays locked.
    // Off-chain SDK MUST include this PDA in the close call when
    // `has_pending_agent_grant` would have been true (we don't track a
    // bool flag for it on PolicyConfig — the SDK enumerates known pending
    // PDAs and passes any that exist).
    let (expected_pending_agent_grant_pda, _) = Pubkey::find_program_address(
        &[b"pending_agent_grant", vault.key().as_ref()],
        ctx.program_id,
    );
    for pending_info in ctx.remaining_accounts.iter().skip(start_idx) {
        if pending_info.key() == expected_pending_agent_grant_pda && pending_info.lamports() > 0 {
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

    // M1-04b (constraints-engine teardown): the pending_constraints and
    // pending_close_constraints drain blocks were REMOVED. The constraints
    // engine and its queue_constraints_update / queue_close_constraints
    // instructions are deleted, so those PDAs can never be allocated — the
    // drains were dead scans. close_vault now drains only pending_policy,
    // pending_agent_perms, pending_owner, and pending_agent_grant.

    let clock = Clock::get()?;
    emit!(VaultClosed {
        vault: vault.key(),
        owner: ctx.accounts.owner.key(),
        timestamp: clock.unix_timestamp,
    });

    // Anchor `close = owner` handles the actual closing and rent reclamation

    Ok(())
}
