use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::OwnershipTransferAccepted;
use crate::state::*;
use crate::utils::audit_log::build_audit_entry;
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

/// Phase 8 Batch 4 — C26 ownership transfer (accept path, Squads V4 multisig).
///
/// Sibling handler to `accept_ownership_transfer` for the multisig-target flow.
/// When `pending.is_multisig_target == true`, the new owner is a Squads V4
/// multisig **vault PDA** (the signer derived from the multisig account). The
/// transaction containing this ix is built and signed via the Squads program;
/// from Sigil's perspective the multisig PDA is an **opaque non-signer account**
/// — Squads handles the underlying multisig signature aggregation off-chain,
/// then submits a transaction where the multisig PDA appears as a writable
/// (but NOT signer) account in `accept_ownership_transfer_multisig`.
///
/// Authority binding is therefore NOT via Anchor's `Signer<'info>` constraint
/// (which would require an actual signature on the multisig PDA private key —
/// which doesn't exist). Instead, authority is bound by:
///   1. `multisig_pda.owner == SQUADS_V4_PROGRAM_ID` — proves the account was
///      created by the Squads program (only Squads can mint accounts owned by
///      itself). An attacker cannot forge ownership without compromising the
///      Squads program itself.
///   2. `pending.new_owner == multisig_pda.key()` — pubkey identity match
///      against the target queued at initiate time.
///   3. `pending.is_multisig_target == true` — rejects standard-target pendings
///      (symmetric with the EOA accept's `!is_multisig_target` guard).
///
/// On success:
///   * `vault.owner` is overwritten with `multisig_pda.key()`
///   * `pending` PDA closes, rent returns to `multisig_pda` (the new authority)
///   * `policy.policy_version` bumps so any in-flight `validate_and_authorize`
///     fails fast with PolicyVersionMismatch under the new authority
///
/// **Why no Signer.** A Squads V4 multisig vault PDA is a program-derived
/// address with no private key. Squads V4's own `vault_transaction_execute`
/// re-derives the vault PDA at runtime and CPI-invokes the wrapped instruction
/// with the vault PDA passed as an UncheckedAccount, NOT a signer. The
/// multisig-side authority is enforced upstream by Squads (threshold-of-N
/// signatures on the wrapping `vault_transaction`). For Sigil to require an
/// actual signature here would make the multisig flow architecturally
/// impossible.
///
/// **V1 verification depth — Council ISC-A7.** Today we verify program-ID
/// match only. Stronger structural checks (multisig threshold > 0, vault
/// discriminator parse, anti-1-of-1-self-multisig) are V1.1 — V1 ships with
/// the program-ID match because (a) only Squads V4 can create accounts owned
/// by `SQUADS_V4_PROGRAM_ID` and (b) the owner-side `initiate` step is
/// gated by the cosign requirement (Council ISC-129), so a phished owner key
/// alone cannot queue a transfer to a malicious multisig.
///
/// Phase 8 §RP Fix-Up B (LBL-10 HIGH, audit 2026-05-19): the handler now
/// recomputes `policy.policy_preview_digest` after the owner mutation,
/// symmetric with the EOA accept handler. The recompute is BYTE-EQUAL to
/// the pre-accept value because none of the 21 digest fields is owner-derived
/// (`agent_set_hash` is computed from `vault.agents`). Performed
/// unconditionally so the invariant "every state-of-record mutating ix
/// re-derives the digest" holds uniformly across both the EOA and multisig
/// paths. Prior Batch 6 TODO closed by this Fix-Up.
#[derive(Accounts)]
pub struct AcceptOwnershipTransferMultisig<'info> {
    /// CHECK: Squads V4 multisig vault PDA. NOT a `Signer` because Squads V4
    /// vault PDAs have no private key — authority is enforced by:
    ///   1. `owner == SQUADS_V4_PROGRAM_ID` (verified in handler)
    ///   2. `key() == pending.new_owner` (verified in handler)
    ///   3. `pending.is_multisig_target == true` (verified in handler)
    ///
    /// Marked `mut` so the closed `pending` PDA's rent returns here.
    #[account(mut)]
    pub multisig_pda: UncheckedAccount<'info>,

    /// Vault is mutated (owner field overwritten). PDA derivation uses the
    /// immutable `vault.vault_authority` field (LBL-01) so the seed binding
    /// survives ownership transfer. Handler-level `require_keys_eq!(
    /// pending.current_owner, vault.owner)` replaces the implicit seed
    /// binding that previously enforced the queue→accept owner match.
    #[account(
        mut,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    /// Policy is mutated (policy_version bump + `policy_preview_digest`
    /// recompute — see handler lines 180-230, mirroring the EOA path).
    #[account(
        mut,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    /// PendingOwnershipTransfer PDA. `close = multisig_pda` returns rent to the
    /// new authority. `has_one = vault` binds the PDA to this vault explicitly
    /// (defense-in-depth against future seeds drift; same pattern as §RP-1 I-2).
    #[account(
        mut,
        has_one = vault @ SigilError::ZeroCopyVaultMismatch,
        seeds = [b"pending_owner", vault.key().as_ref()],
        bump = pending.bump,
        close = multisig_pda,
    )]
    pub pending: Account<'info, PendingOwnershipTransfer>,

    /// Phase 7 — success audit log; entry appended after state mutation.
    #[account(
        mut,
        seeds = [b"audit_success", vault.key().as_ref()],
        bump = audit_log_success.load()?.bump,
    )]
    pub audit_log_success: AccountLoader<'info, AuditLogSuccess>,

    /// CHECK: Phase 7 — slot_hashes sysvar; address-pinned.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AcceptOwnershipTransferMultisig>) -> Result<()> {
    crate::reject_cpi!();

    // M1-02 (kill-switch terminality, 2026-05-31): a frozen/closed vault MUST
    // NOT have ownership accepted — identical rationale to the EOA accept
    // handler. Freeze does not pause the 48h timelock, so without this gate a
    // phished-then-frozen vault could still be taken over once the timelock
    // elapses. Status check FIRST so the operator sees `VaultNotActive`,
    // mirroring `initiate_ownership_transfer` ISC-130. Only the owner's
    // deliberate `reactivate_vault` can unblock an accept.
    require!(
        ctx.accounts.vault.status == VaultStatus::Active,
        SigilError::VaultNotActive,
    );

    // 1. Authority binding gate A — multisig PDA owner program check.
    //    The supplied multisig PDA MUST be owned by the Squads V4 program;
    //    any other owner (SystemProgram, attacker-deployed program, etc.) is
    //    rejected hard. This is the load-bearing structural check that
    //    distinguishes a real Squads multisig from an attacker-forged account.
    //
    //    `AccountInfo::owner` returns `&Pubkey`; comparison is by reference to
    //    the program-pinned constant. We reuse `ErrInvalidOwnershipTarget`
    //    (6107) — the same code initiate emits when the new_owner pubkey is
    //    in the program/sysvar blocklist — because the semantics are
    //    identical: "the supplied target is not a valid ownership recipient."
    let multisig_info = ctx.accounts.multisig_pda.to_account_info();
    require!(
        multisig_info.owner == &SQUADS_V4_PROGRAM_ID,
        SigilError::ErrInvalidOwnershipTarget,
    );

    // 2. Authority binding gate B — pubkey identity match.
    //    The supplied multisig PDA must be the same pubkey queued at initiate.
    //    Without this check, an attacker could swap in a DIFFERENT
    //    Squads-owned account (e.g. a multisig they control) and accept on
    //    behalf of the owner's queued multisig.
    require_keys_eq!(
        ctx.accounts.multisig_pda.key(),
        ctx.accounts.pending.new_owner,
        SigilError::ErrPendingOwnershipNotReady,
    );

    // 3. Variant binding — reject standard-target pendings on the multisig
    //    handler. Symmetric with the EOA accept's `!is_multisig_target` guard:
    //    without this, an EOA-target pending could be claimed via the multisig
    //    handler by deploying a Squads-owned account at the EOA address (a
    //    practically-impossible address collision but defensible).
    require!(
        ctx.accounts.pending.is_multisig_target,
        SigilError::ErrPendingOwnershipNotReady,
    );

    // 3.5. Phase 8 LBL-01 defense-in-depth — see the EOA accept handler for
    //      the full rationale. The pre-LBL-01 seed pattern
    //      `seeds = [b"vault", pending.current_owner, ...]` implicitly bound
    //      `pending.current_owner == vault.owner`. LBL-01 moves the seed-key
    //      to `vault.vault_authority` (immutable), so this implicit binding
    //      is lost. Reinstate it as an explicit handler check.
    require_keys_eq!(
        ctx.accounts.pending.current_owner,
        ctx.accounts.vault.owner,
        SigilError::ErrPendingOwnershipNotReady,
    );

    let clock = Clock::get()?;

    // 3.5. CH-1 close (Bucket-3 audit 2026-05-23): F-10 freshness — same
    //      cap as the EOA accept path. Slot delta bound by
    //      `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN = 700_000` (~78h), wider
    //      than the 216_000-slot (~24h) non-admin window because the 48h
    //      timelock is the primary defense and an apply landing AFTER
    //      the timelock matures (24h..78h post-queue) is legitimate. Front-
    //      runs the timelock so a stale-slot reject surfaces with the
    //      diagnostic `QueuedUpdateExpired` rather than the misleading
    //      `ErrPendingOwnershipNotReady`.
    // F-4 close (audit 2026-05-25): use checked_sub instead of saturating_sub
    // so an impossible-in-prod clock-backward anomaly surfaces as `Overflow`
    // rather than silently rounding to 0 and passing the freshness check.
    // Matches the sibling `unix_timestamp.checked_sub(...)` pattern below.
    let slot_delta = clock
        .slot
        .checked_sub(ctx.accounts.pending.queued_at_slot)
        .ok_or(error!(SigilError::Overflow))?;
    require!(
        slot_delta < crate::state::MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN,
        SigilError::QueuedUpdateExpired,
    );

    // 4. Timelock — identical to the EOA accept path. Checked arithmetic
    //    on i64 to guard against backward-moving clocks (rare devnet anomaly).
    let queued_at = ctx.accounts.pending.queued_at;
    let min_delay = ctx.accounts.pending.min_delay_seconds as i64;
    let elapsed = clock
        .unix_timestamp
        .checked_sub(queued_at)
        .ok_or(error!(SigilError::Overflow))?;
    require!(
        elapsed >= min_delay,
        SigilError::ErrPendingOwnershipNotReady,
    );

    // Snapshot fields BEFORE we mutate vault.owner.
    let vault_key = ctx.accounts.vault.key();
    let previous_owner = ctx.accounts.vault.owner;
    let multisig_key = ctx.accounts.multisig_pda.key();

    // 5. Mutate vault owner. Same one-and-only-place rule as the EOA path —
    //    every downstream `has_one = owner` re-reads from here.
    {
        let vault = &mut ctx.accounts.vault;
        vault.owner = multisig_key;
        // F-Q6 (2026-06-02): this path verified a Squads V4 multisig owner
        // (multisig_pda.owner == SQUADS_V4_PROGRAM_ID + identity match above), so
        // record owner_type = MULTISIG. register_agent's tier rule treats a
        // multisig owner as >=2-factor → eligible for instant OPERATOR grants.
        vault.owner_type = OWNER_TYPE_MULTISIG;
    }

    // 6. Phase 8 §RP Fix-Up B (LBL-10 HIGH, audit 2026-05-19): recompute
    //    policy_preview_digest after the owner mutation. Today's TA-19
    //    digest does NOT bind `vault.owner` so the recompute is byte-equal
    //    to the pre-accept value. Symmetric with the EOA accept handler —
    //    see the rationale comment there. Performed unconditionally so the
    //    invariant "every state-of-record mutating ix re-derives the digest"
    //    holds uniformly; any future owner-keyed digest field lands here.
    //
    //    Bump policy_version — symmetric with the EOA accept handler and the
    //    PEN-CROSS-5 pattern (register/pause/unpause/revoke). Any in-flight
    //    `validate_and_authorize` snapshotted the prior version and will now
    //    fail fast under the new (multisig) authority.
    {
        let policy = &mut ctx.accounts.policy;
        let new_agent_set_hash = compute_agent_set_hash(&ctx.accounts.vault.agents);
        let new_digest = compute_policy_preview_digest(&PolicyPreviewFields {
            daily_spending_cap_usd: policy.daily_spending_cap_usd,
            max_transaction_size_usd: policy.max_transaction_size_usd,
            max_slippage_bps: policy.max_slippage_bps,
            developer_fee_rate: policy.developer_fee_rate,
            protocol_mode: policy.protocol_mode,
            protocols: &policy.protocols,
            destination_mode: policy.destination_mode,
            allowed_destinations: &policy.allowed_destinations,
            timelock_duration: policy.timelock_duration,
            session_expiry_seconds: policy.session_expiry_seconds,
            observe_only: ctx.accounts.vault.observe_only,
            has_post_assertions: policy.has_post_assertions,
            created_at_slot: policy.created_at_slot,
            operating_hours: policy.operating_hours,
            auto_promote_grays: policy.auto_promote_grays,
            auto_revoke_threshold: policy.auto_revoke_threshold,
            stable_balance_floor: policy.stable_balance_floor,
            per_recipient_daily_cap_usd: policy.per_recipient_daily_cap_usd,
            cosign_required: policy.cosign_required,
            agent_set_hash: new_agent_set_hash,
            // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey bound
            // at canonical position 22 — accept_ownership_transfer_multisig
            // never mutates it, so pass-through from live policy keeps the
            // re-bind digest matching the queue-time digest.
            cosign_session_pubkey: policy.cosign_session_pubkey,
            // F-Q6: operator_grant_delay_seconds bound at canonical digest position 22.
            operator_grant_delay_seconds: policy.operator_grant_delay_seconds,
        });
        policy.policy_preview_digest = new_digest;
        policy.policy_version = policy
            .policy_version
            .checked_add(1)
            .ok_or(error!(SigilError::Overflow))?;
    }

    // 7. Phase 7 — audit-log entry BEFORE `emit!` (ISC-144 ordering). Reuses
    //    disc=8 `AUDIT_DISC_OWNERSHIP_ACCEPT` — distinguishing EOA vs multisig
    //    accepts is the event's `via_multisig` flag, not a separate disc byte.
    //    `subject` slot stores the multisig PDA pubkey so off-chain monitors
    //    get the new authority routing target directly.
    {
        let entry = build_audit_entry(
            AUDIT_DISC_OWNERSHIP_ACCEPT,
            multisig_key,
            0,
            0,
            clock.unix_timestamp,
            &ctx.accounts.slot_hashes_sysvar.to_account_info(),
        )?;
        let mut log = ctx.accounts.audit_log_success.load_mut()?;
        // §RP-1 I-2: defense-in-depth guard against future seeds drift.
        require_keys_eq!(log.vault, vault_key, SigilError::ZeroCopyVaultMismatch,);
        log.append(entry);
    }

    emit!(OwnershipTransferAccepted {
        vault: vault_key,
        previous_owner,
        new_owner: multisig_key,
        via_multisig: true, // Batch 4 multisig variant — distinguishes from EOA accept
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
