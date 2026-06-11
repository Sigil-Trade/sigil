# M1-02 — HIGH-2: Frozen-Accept Kill-Switch Bypass

**Milestone:** M1 · **Depends on:** M1-00 · **Severity:** HIGH (needs compromised owner key) · **Status:** PLAN

## The finding (from this session's lifecycle audit, CONFIRMED by grep)
Neither `accept_ownership_transfer.rs` nor `accept_ownership_transfer_multisig.rs` checks `vault.status`. Combined with `freeze_vault` only *best-effort* cancelling an in-flight transfer (it drains the pending PDA only if the caller passes it at `remaining_accounts.first()`, `freeze_vault.rs:127`), a phished-owner-key attacker can: `initiate` transfer → real owner panics and `freeze`s → freeze doesn't pause the 48h timelock → attacker waits it out → **`accept` succeeds on the FROZEN vault** → attacker becomes owner. The kill-switch is supposed to be terminal; it isn't.

Grep CONFIRMED both accept handlers have zero `status`/`VaultStatus`/`is_active` references. The fix idiom already exists: `initiate_ownership_transfer.rs:85` and `cancel_ownership_transfer.rs:95` both do `require!(ctx.accounts.vault.status == VaultStatus::Active, ...)`. `vault.rs:256` has an `is_active()` helper.

## Goal
Make freeze a true terminal kill-switch: a frozen (or closed) vault cannot have ownership accepted until the owner reactivates.

## Files & changes (confidence: HIGH; re-verify line numbers at build start)
- `instructions/accept_ownership_transfer.rs` — add `require!(ctx.accounts.vault.status == VaultStatus::Active, SigilError::VaultNotActive)` (or `is_active()` helper) in the handler body, mirroring `initiate`/`cancel`. ~1 line.
- `instructions/accept_ownership_transfer_multisig.rs` — same. ~1 line.
- (Defense-in-depth, optional, design-review decision) make `freeze_vault`'s pending-transfer cancellation mandatory, OR have `reactivate_vault` clear any stale pending transfer. Keeps freeze's effect complete even if the caller omits the pending PDA.

## Tests
- NEW: initiate transfer → freeze → advance past timelock → accept → MUST reject `VaultNotActive` (single-sig AND multisig paths). This is the exploit; currently succeeds.
- Regression: normal initiate → accept on an Active vault still succeeds (both paths).
- Regression: cancel on frozen still behaves per existing semantics.
- (If defense-in-depth chosen) freeze with pending transfer present → pending cleared; reactivate → stale pending not acceptable.

## DoD
Exploit test reproduces takeover-through-freeze on baseline, fails-closed after fix, both accept paths; full suite green; adversarial review; mandatory pipeline complete.

## Risks
- Minimal — mirrors an existing, audited idiom in sibling handlers. Main risk is missing a third acceptance path; grep for ALL handlers touching `PendingOwnershipTransfer` at build start to be exhaustive.

## Anti-criteria
- No change to who can freeze (owner-only, unchanged).
- No new admin/guardian authority introduced (non-custodial invariant).
