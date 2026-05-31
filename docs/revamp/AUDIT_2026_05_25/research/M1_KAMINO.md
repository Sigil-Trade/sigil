# M-1 Research: Kamino Finance

**Date:** 2026-05-25
**Scope:** Kamino Vaults (`kvault`), Kamino Lending (`klend`), Kamino Liquidity (`yvaults` via `kliquidity-sdk` IDL — program closed-source).
**Heads:** all repos @ `master`, fetched 2026-05-25.

## Pattern

Kamino has **no `PendingStrategyUpdate`-style PDA anywhere in its public code.** Three distinct mature patterns appear:

**(P1) Same-account `pending_X` column + signer-rotates-itself.** Both `VaultState` and `GlobalConfig` carry `pending_admin: Pubkey` (`kvault/programs/kvault/src/state.rs` ~line 32 and ~145). Rotation is a one-arg ix where the `pending_admin` itself signs via `has_one = pending_admin` (`handler_update_admin.rs:5-13`). WhirlpoolStrategy mirrors this exactly — `pendingAdmin: Address` field + `updateStrategyAdmin` ix with only `{pendingAdmin signer, strategy writable}` (`kliquidity-sdk/src/@codegen/kliquidity/instructions/updateStrategyAdmin.ts`). klend `LendingMarket` uses the same idea under the name `lending_market_owner_cached` (`handler_update_lending_market_owner.rs:7-12`).

**(P2) Explicit `state: u8` enum with named predicates (state-machine).** klend's obligation ownership transfer is a 4-handler machine: `initiate → approve → accept | abort`. Lifecycle lives in `Obligation.ownership_transfer_state: u8` (`state/obligation.rs:100`) backed by `enum OwnershipTransferState { None, Initiated, Approved }`. Every transition is gated by a named predicate: `check_ownership_transfer_not_in_progress()` (line 597), `_in_initiated_state()` (615), `_approved()` (623). `accept_ownership` and `abort_ownership_transfer` BOTH reset `pending_owner = Pubkey::default()` AND `ownership_transfer_state = None` atomically inside the state-machine API (lines 664-678) — **two-field coherence enforced by one method.**

**(P3) Tombstone (don't close).** klend's `cancel_withdraw_ticket` zeros `WithdrawTicket.queued_collateral_amount` but does NOT close the account — `is_fully_cancelled() = queued_collateral_amount == 0` (`libs/klend-interface/src/state/withdraw_ticket.rs:32-34`). Certora 1.17.0 audit page 6 confirms: "the ticket account is not closed — it stays as a zero-amount tombstone and is skipped."

**Close paths:** kvault has **NO `close_vault` handler** (full `handlers/mod.rs` enumeration). klend has **NO `close_obligation`**. yvaults exposes `closeStrategy` (kliquidity-sdk), but the IDL is discriminator-only and the program is closed-source — internal drain logic cannot be verified. **For lending vaults and obligations, Kamino's answer to "close-with-pending-state" is: don't close.**

## Failure history

Ottersec audited yvaults Oct-Nov 2023 (`kamino_liquidity_audit_ottersec.pdf`). The only relevant finding is **OS-KLY-SUG-03 "Double Verification For Owner Change"** (page 19, suggestion): single-step admin change risks DoS from fat-finger. Remediation: "Utilize a two-step process." Kamino's response: shipped P1 (`pending_admin` field + rotate-by-signer) across kvault, klend, yvaults. **No findings on close-with-pending-state in any Kamino audit** I reviewed (Ottersec yvaults, Ottersec klend 1.15.0, Certora klend 1.17.0). No GitHub issues mention orphaned-rent, flag-desync, or cancel-races.

## End-user recovery story

Admin rotation: wrong `pending_admin` is overwritten by re-calling the setter — recoverable. State-machine (P2) has explicit `abort_*` handlers. No close = no orphan path. Tombstones never leak rent.

## M-1 fit verdict

**Partial.** P1 and P3 are real but don't directly address Sigil's 5 silently-no-op'd pending-PDA classes. **P2 IS directly applicable**: it's α-flags done right, with named predicates, atomic two-field coherence, and an explicit abort handler. Kamino hasn't solved Sigil's specific "many pending PDAs feed one close handler" shape because they avoid it architecturally.

## Security-first scores

- **Defense-in-depth: 4/5** — P2's named predicates eliminate the "lamports() > 0" silent-skip class; P3 sidesteps drain entirely.
- **End-user recovery: 4/5** — explicit `abort_*` in P2; overwrite-and-retry in P1; tombstones preserve rent.
- **Auditor onboarding: 5/5** — `check_ownership_transfer_in_initiated_state()` reads like a sentence; the enum self-documents.
- **Long-term consistency: 3/5** — naming drifts (`pending_admin` vs `lending_market_owner_cached`); state-machine API not shared as trait/module — each handler reimplements predicate calls; "no close" gap is an arch choice Sigil cannot copy.

## Recommendation for Sigil M-1

Adopt **P2 directly** for the 4 silently-no-op pending-PDA classes with real lifecycle meaning (`pending_owner`, `pending_agent_grant`, `pending_close_constraints`, `pending_constraints`): give each a `u8` state field + named predicates (`check_X_not_in_progress`, `check_X_initiated`, `check_X_approved`) AND a paired `pending_X: Pubkey/Hash` reset to `default()` atomically inside the state-machine API. Pattern α from R1-R3 is the right shape — Kamino's discipline is the upgrade: **predicates by name, never raw boolean comparisons; both fields reset together inside ONE method.** For `pending_agent_perms[N]`, P3 tombstone is a viable alternative — zeroed marker, downstream enumeration ignores. Do NOT copy Kamino's "no close handler" answer — Sigil's UX requires close. The lesson is that mature protocols find close-with-pending hard enough to architect around, which validates "security-first, no cost tradeoffs."

---

**Citations:**
- kvault state + handlers: github.com/Kamino-Finance/kvault/blob/master/programs/kvault/src/{state.rs, handlers/handler_update_admin.rs, handlers/handler_remove_allocation.rs, handlers/mod.rs}
- klend obligation state-machine: github.com/Kamino-Finance/klend/blob/master/programs/klend/src/state/obligation.rs lines 100/121/587-678
- klend 4 transition handlers: github.com/Kamino-Finance/klend/blob/master/programs/klend/src/handlers/handler_{initiate,approve,accept,abort}_obligation_ownership_transfer.rs
- klend cached owner: github.com/Kamino-Finance/klend/blob/master/programs/klend/src/handlers/handler_update_lending_market_owner.rs
- WithdrawTicket tombstone: github.com/Kamino-Finance/klend/blob/master/libs/klend-interface/src/state/withdraw_ticket.rs
- WhirlpoolStrategy pendingAdmin + updateStrategyAdmin: github.com/Kamino-Finance/kliquidity-sdk/blob/master/src/@codegen/kliquidity/{accounts/whirlpoolStrategy.ts, instructions/updateStrategyAdmin.ts, instructions/closeStrategy.ts}
- Ottersec OS-KLY-SUG-03: github.com/Kamino-Finance/audits/blob/master/kamino_liquidity_audit_ottersec.pdf p18-19
- Certora 1.17.0 tombstone reference: github.com/Kamino-Finance/audits/blob/master/kamino_lend_certora_1.17.0.pdf p6

**Speculation flag:** yvaults `closeStrategy` internals are closed-source — only the IDL shape (discriminator + accounts list) is verifiable; whether the program checks any pending fields cannot be confirmed. All other claims read directly from public source at the heads listed above.
