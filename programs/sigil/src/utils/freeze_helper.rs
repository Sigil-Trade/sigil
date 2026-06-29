//! Phase 8 Batch 2 (F-7) — shared freeze entry point.
//!
//! ## Why this exists
//!
//! Batch 1 added `frozen_at_timestamp` + `freeze_reason` + the `FreezeReason`
//! enum to `AgentVault`, then patched two write sites inline:
//! `freeze_vault.rs` (manual path → `FreezeReason::Manual`) and
//! `revoke_agent.rs` (auto-freeze when last agent revoked →
//! `FreezeReason::AutoRevoke`). That inline-patch surface left the same
//! footgun the Round 2 line-by-line audit flagged on the `revoke_vault` /
//! `freeze_vault` / `register_agent` / `set_observe_only` cluster: the
//! sibling-handler drift class. A future fifth freeze site (`EmergencyBoard`,
//! Batch 3) added by a different PR could silently omit the reason byte,
//! corrupt the `from_u8` invariant, or skip the timestamp.
//!
//! This helper makes the reason byte a REQUIRED argument so the type system
//! refuses to compile a freeze site that forgets it.
//!
//! ## F19 lineage (historical)
//!
//! Round 2 finding F19 caught `finalize_session.rs` reading Anchor's cached
//! `TokenAccount.amount` instead of re-parsing the raw bytes; a compromised
//! DeFi program returning a stale-cache value defeated all 6 spending caps.
//! A speculative `parse_token_account_raw` cursor was once exposed here for a
//! planned Batch-3 token-account walker. That walker was never built: the SPL
//! delegation revocation that actually shipped (`freeze_vault.rs`) is
//! session-driven — it iterates `SessionAuthority` PDAs via `try_borrow_data()`
//! and revokes each `delegated` session, never inspecting token-account
//! `amount`. The unused cursor had zero call sites and was removed (foundation
//! review 2026-06-29).
//!
//! ## What this batch (Batch 2) actually does
//!
//! - Defines the `freeze_internal(vault, reason, clock, revoke_pairs_count)`
//!   entry point + `MAX_REVOKE_PAIRS` bound (Council ISC-136).
//! - Refactors the two existing write sites to call it.
//!
//! ## Closed in Fix-Up B (commit `1362dac`)
//!
//! Both of the original Batch-3 deferrals have since landed:
//! - PendingOwnershipTransfer cancellation routes through the optional
//!   `pending_owner` cancel block in `freeze_vault.rs:121-145` (rent →
//!   current owner, atomic with the status flip).
//! - SPL token delegation revocation iteration runs inside `freeze_vault.rs`
//!   per-session via the active-sessions loop, bounded by `MAX_REVOKE_PAIRS`.
//!   The helper's `revoke_pairs_count` argument is preserved for callers
//!   that need an explicit (agent, mint) revocation list — currently no
//!   handler exercises that path (all freeze sites pass `0`).

use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::state::{AgentVault, FreezeReason, VaultStatus};

/// Phase 8 — `MAX_REVOKE_PAIRS` upper bound (Council ISC-136).
///
/// `freeze_internal` accepts up to N `(agent, mint)` revocation pairs; more
/// than that is a DoS surface (CU budget for SPL `revoke` CPIs in a single
/// transaction). Callers that need to revoke more delegations MUST batch
/// across multiple transactions.
///
/// `validate_and_authorize` already caps active sessions per vault to a much
/// smaller number, but this bound is independent and defensive — the helper
/// must enforce it regardless of upstream invariants.
pub const MAX_REVOKE_PAIRS: usize = 10;

/// Phase 8 F-7 — shared freeze entry point.
///
/// Sets `vault.status = Frozen`, records `frozen_at_timestamp` + the typed
/// `freeze_reason` byte, and enforces the `MAX_REVOKE_PAIRS` bound on the
/// caller-provided revocation pair count. Returns `Ok(())` if all checks
/// pass; the caller then performs the PDA cancellation + SPL revocation
/// CPIs inside its own Anchor handler context (Batch 3).
///
/// ## Atomicity contract
///
/// The helper mutates vault state first. If the caller's subsequent CPIs
/// (PendingOwnershipTransfer close, SPL revoke) fail, the entire transaction
/// reverts and the vault stays in its pre-freeze status. Solana's all-or-
/// nothing transaction semantics make this safe — there is no partial-freeze
/// window visible to any other observer.
///
/// ## Why the caller does the CPI, not the helper
///
/// `Account<'_, PendingOwnershipTransfer>` and SPL `Revoke` both need the
/// account loaded in the Anchor `Context`. Passing those references through
/// a `utils/` helper signature couples the helper to every freeze site's
/// `#[derive(Accounts)]` shape. The Batch 2 design keeps the helper
/// account-agnostic — vault + reason + clock + bound — and documents what
/// the caller MUST also do.
///
/// ## Forward-compatibility
///
/// A new `FreezeReason` variant (e.g. `EmergencyBoard` in Batch 3) needs
/// only to extend the enum + `from_u8`; this helper requires no change.
/// That is the entire point: refactoring inline `vault.freeze_reason = ...`
/// writes into one entry point removes the "sibling-handler drift" class
/// of bug at compile time.
pub fn freeze_internal(
    vault: &mut Account<'_, AgentVault>,
    reason: FreezeReason,
    clock: &Clock,
    revoke_pairs_count: usize,
) -> Result<()> {
    require!(
        revoke_pairs_count <= MAX_REVOKE_PAIRS,
        SigilError::ErrTooManyRevokePairs
    );

    vault.status = VaultStatus::Frozen;
    vault.frozen_at_timestamp = clock.unix_timestamp;
    vault.freeze_reason = reason as u8;

    // NOTE (Batch 3): PendingOwnershipTransfer cancellation MUST happen at
    // the caller because `Account<'_, PendingOwnershipTransfer>` requires
    // the account loaded in Anchor context. The caller closes the PDA
    // explicitly with rent → current_owner.

    // NOTE (Batch 3): SPL revocation likewise MUST happen at the caller
    // because CPI requires `token_program` + signer seeds + each session's
    // delegate loaded in Anchor context. The bound (`MAX_REVOKE_PAIRS`) is
    // enforced here so a future caller cannot accidentally feed an unbounded
    // revocation list.
    //
    // F19 lineage: the shipped caller (`freeze_vault.rs`) reads each
    // `SessionAuthority` from its raw `try_borrow_data()` bytes — NOT from
    // Anchor's cached deserialization — and revokes every `delegated` session
    // via a vault-signed `Revoke` CPI. A compromised SPL Token program cannot
    // bypass the revocation surface because the delegate set is driven by
    // on-chain session state, not by a token account's cached fields.

    Ok(())
}
