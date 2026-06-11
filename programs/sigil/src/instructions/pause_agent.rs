use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::AgentPausedEvent;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;

#[derive(Accounts)]
pub struct PauseAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// PEN-CROSS-5 (Phase 4 absorption) — bump policy_version on pause.
    /// Mirrors revoke semantics: pause is a kill-switch for an agent,
    /// and concurrent validate_and_authorize calls must reject with
    /// PolicyVersionMismatch instead of relying on the slower
    /// is_agent_paused constraint check.
    #[account(
        mut,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// Phase 7 — success audit log; entry appended after pause flip.
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

pub fn handler(ctx: Context<PauseAgent>, agent_to_pause: Pubkey) -> Result<()> {
    crate::reject_cpi!();

    let vault = &mut ctx.accounts.vault;

    // Works on Active or Frozen vaults (not Closed)
    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // Find the agent entry
    let agent_entry = vault
        .agents
        .iter_mut()
        .find(|a| a.pubkey == agent_to_pause)
        .ok_or(error!(SigilError::UnauthorizedAgent))?;

    // Must not already be paused
    require!(!agent_entry.paused, SigilError::AgentAlreadyPaused);

    agent_entry.paused = true;

    // PEN-CROSS-5 (Phase 4 absorption): bump policy_version. See
    // revoke_agent.rs for rationale.
    let policy = &mut ctx.accounts.policy;
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    let clock = Clock::get()?;
    let vault_key = vault.key();

    // Phase 7 — write success audit-log entry using the paused agent's pubkey
    // in the `subject` slot for traceability.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_PAUSE_AGENT,
            agent_to_pause,
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

    emit!(AgentPausedEvent {
        vault: vault_key,
        agent: agent_to_pause,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
