# M1-03 — Systemic Frozen-Status Gate Sweep

**Milestone:** M1 · **Depends on:** M1-02 · **Severity:** MEDIUM (root-cause class) · **Status:** PLAN

## The finding (this session's audits — two independent hits, same class)
Owner state-machine handlers don't re-check `frozen`:
- `accept_ownership_transfer` (HIGH — fixed in M1-02).
- `apply_pending_policy.rs:107-119` (MEDIUM) — does NOT re-check `vault.status`; a queued policy update can be **applied to a frozen vault** (e.g., a cap-raise queued before the owner froze in suspicion of compromise). Bounded (funds can't move while frozen) but defeats "freeze halts all churn."

This item closes the **class**, not just the two instances: every owner-callable apply/accept handler should refuse to mutate a frozen/closed vault unless that handler is itself a recovery path (freeze/reactivate/cancel/close are the deliberate exceptions).

## Goal
One coherent pass: every apply/accept handler re-checks `vault.status == Active` (or documents why it's a deliberate exception). Restores the "owner can always stop the system" guarantee.

## Files & changes (build-start: grep `apply_|accept_` handlers + audit each for a status gate)
Candidate set to audit + gate (re-verify each at build start):
- `apply_pending_policy.rs` — add Active gate (CONFIRMED missing).
- `apply_agent_grant.rs`, `apply_agent_permissions_update.rs`, `apply_constraints_update.rs`*, `apply_close_constraints.rs`* — audit; gate if mutating + not a recovery path. (*these are removed in M1-04 — sequence: if M1-04 lands first, skip them; if this lands first, gate then delete. Coordinate ordering at design-review.)
- Deliberate EXCEPTIONS (do NOT gate — they must work on a frozen vault): `freeze_vault`, `reactivate_vault`, `cancel_*` (cancels must work while frozen so the owner can unwind), `close_vault` per its own rules.
- `errors.rs` — reuse `VaultNotActive` (6000). No new code expected.

## Decision to lock at design-review
Exact membership of {gate} vs {exception}. Rule of thumb: **mutating apply/accept → gate; recovery/cancel/freeze → exception.** Enumerate every handler explicitly (CLAUDE.md "requirements are a checklist").

## Tests
- Per gated handler: queue/initiate → freeze → apply/accept → MUST reject `VaultNotActive`.
- Per exception handler: confirm it STILL works while frozen (cancel/reactivate/freeze).
- Regression: all happy-path apply/accept on Active vaults unchanged.

## DoD
Every apply/accept handler explicitly classified gate/exception with a test proving its behavior on a frozen vault; full suite green; adversarial review confirms no mutating handler accepts a frozen vault; pipeline complete.

## Risks
- Over-gating a legitimate recovery path (e.g., gating a cancel) would brick owner recovery → the exception list is the load-bearing decision; review it adversarially.
- Ordering vs M1-04 (constraints handlers) — coordinate so we don't gate a handler we're about to delete.

## Anti-criteria
- No recovery/cancel/freeze path gated (would harm the owner).
- No new authority.
