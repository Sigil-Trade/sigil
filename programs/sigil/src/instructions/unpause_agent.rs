use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentUnpausedEvent;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;

#[derive(Accounts)]
pub struct UnpauseAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PEN-CROSS-5 (Phase 4 absorption) — bump policy_version on unpause.
    /// Symmetric with pause_agent; the four agent-mutation ix
    /// (register / revoke / pause / unpause) all bump version so OCC
    /// signals fire uniformly regardless of which mutation lands.
    #[account(
        mut,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Phase 7 — success audit log; entry appended after unpause flip.
    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// CHECK: Phase 7 — slot_hashes sysvar; address-pinned.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<UnpauseAgent>, agent_to_unpause: Pubkey) -> Result<()> {
    crate::reject_cpi!();

    // P0.1 §RP-2 H-NEW-1 interim cosign gate (audit 2026-05-19).
    //
    // Mirrors `register_agent.rs:78-82` and `set_observe_only.rs:60-66`.
    // `unpause_agent` semantically restores an agent's full capability +
    // bumps `policy.policy_version` — same threat class as register_agent
    // (silent operator grant on a cosign-opted-in vault from a phished
    // owner key). Without this gate, the sequence
    //     pause_agent -> unpause_agent
    // bypasses the cosign workflow even when `policy.cosign_required ==
    // true`, because neither ix passes through queue_policy_update.
    //
    // pause_agent itself is deliberately NOT gated — pause is the SAFE
    // direction (it removes capability), so the OCC signal symmetry is
    // already preserved via the policy_version bump without a gate.
    //
    // Mechanism: scan ctx.remaining_accounts for any signer pubkey that
    // is NOT the owner. Absence of such a signer == cosign missing on a
    // vault that requires it -> reject with 6080 ErrCosignRequired.
    if ctx.accounts.policy.cosign_required {
        let owner_key = ctx.accounts.owner.key();
        let has_cosigner = crate::instructions::register_agent::has_bound_cosigner(
            ctx.remaining_accounts,
            &owner_key,
            &ctx.accounts.policy.cosign_session_pubkey,
        );
        require!(has_cosigner, SigilError::ErrCosignRequired);
    }

    let vault = &mut ctx.accounts.vault;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // M1-03 (systemic frozen-gate, 2026-05-31): a frozen vault MUST NOT un-pause
    // an agent. Un-pausing is ADDITIVE — it restores an agent's execution
    // capability, which a freeze is meant to halt and a phished owner key could
    // abuse to re-enable a suspended agent. The defensive inverse (pause_agent)
    // stays allowed while frozen. (Supersedes the prior "Works on Active or
    // Frozen" intent for this handler — frozen un-pause is now blocked.)
    require!(
        vault.status != VaultStatus::Frozen,
        SigilError::VaultNotActive
    );

    // Find the agent entry
    let agent_entry = vault
        .agents
        .iter_mut()
        .find(|a| a.pubkey == agent_to_unpause)
        .ok_or(error!(SigilError::UnauthorizedAgent))?;

    // Must be paused
    require!(agent_entry.paused, SigilError::AgentNotPaused);

    agent_entry.paused = false;

    // PEN-CROSS-5 (Phase 4 absorption): bump policy_version. See
    // revoke_agent.rs for rationale.
    let policy = &mut ctx.accounts.policy;
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    let clock = Clock::get()?;
    let vault_key = vault.key();

    // Phase 7 — write success audit-log entry.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_UNPAUSE_AGENT,
            agent_to_unpause,
            0,
            0,
            clock.unix_timestamp,
            &ctx.accounts.slot_hashes_sysvar.to_account_info(),
        )?;
        let mut log = ctx.accounts.audit_log_success.load_mut()?;
        // §RP-1 I-2: defense-in-depth guard against future seeds drift.
        require_keys_eq!(
            log.vault,
            ctx.accounts.vault.key(),
            SigilError::ZeroCopyVaultMismatch
        );
        log.append(entry);
    }

    emit!(AgentUnpausedEvent {
        vault: vault_key,
        agent: agent_to_unpause,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod cosign_gate_tests {
    //! P0.1 §RP-2 H-NEW-1 interim cosign gate decision (audit 2026-05-19).
    //!
    //! Pins the call-site behaviour of `unpause_agent`'s cosign gate. The
    //! underlying predicate `has_non_owner_signer` is exhaustively pinned
    //! in `register_agent::cosign_gate_predicate_tests`; this module pins
    //! the SAME decision matrix specifically for unpause_agent's branch,
    //! so future refactors that move or rename the call cannot silently
    //! drop the gate.
    //!
    //! The threat: phished owner key + cosign-opted-in vault + sequence
    //! `pause_agent` -> `unpause_agent` would otherwise silently restore
    //! the agent's full capability without the second factor.

    use crate::instructions::register_agent::has_non_owner_signer;
    use anchor_lang::solana_program::account_info::AccountInfo;
    use anchor_lang::solana_program::pubkey::Pubkey;

    fn key_n(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    /// Models the exact branch in `unpause_agent::handler`:
    /// `if policy.cosign_required { require!(has_cosigner, ErrCosignRequired) }`.
    /// Returns true iff the gate would PASS (allow the unpause to proceed).
    fn gate_passes(cosign_required: bool, remaining: &[AccountInfo<'_>], owner: &Pubkey) -> bool {
        if cosign_required {
            has_non_owner_signer(remaining, owner)
        } else {
            true
        }
    }

    /// cosign-opted-out vault: gate passes unconditionally (single-signer
    /// flow). This pins the back-compat path — vaults that never opted in
    /// are unaffected by H-NEW-1.
    #[test]
    fn gate_passes_when_cosign_not_required() {
        let owner = key_n(1);
        let remaining: Vec<AccountInfo> = vec![];
        assert!(
            gate_passes(false, &remaining, &owner),
            "cosign_required=false must allow unpause_agent with no cosigner"
        );
    }

    /// cosign-opted-in vault + no non-owner signer in remaining_accounts:
    /// gate REJECTS. This pins the H-NEW-1 fix — the phished-owner attack
    /// shape gets caught.
    #[test]
    fn gate_rejects_when_cosign_required_and_no_cosigner() {
        let owner = key_n(1);
        let remaining: Vec<AccountInfo> = vec![];
        assert!(
            !gate_passes(true, &remaining, &owner),
            "cosign_required=true with empty remaining_accounts MUST reject"
        );
    }

    /// cosign-opted-in vault + non-owner signer present: gate PASSES.
    /// Pins the happy path — legitimate owner+cosigner flow continues to
    /// work after H-NEW-1.
    #[test]
    fn gate_passes_when_cosign_required_and_cosigner_signs() {
        let owner = key_n(1);
        let cosigner = key_n(2);
        let mut lp = 0u64;
        let mut d: [u8; 0] = [];
        let cosigner_info =
            AccountInfo::new(&cosigner, true, false, &mut lp, &mut d, &cosigner, false, 0);
        let remaining = vec![cosigner_info];
        assert!(
            gate_passes(true, &remaining, &owner),
            "cosign_required=true with a non-owner signer MUST allow unpause"
        );
    }
}
