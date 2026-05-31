# M-1 Research: Jupiter Limit Order v2 + Jupiter DCA

**Programs:**
- **Limit Order v2** — `jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu` — source CLOSED. Public surface: paths `programs/limit-order-2/src/instructions/*.rs` cited in Offside Labs audit (April 2024, commit `34654f001af0b07b9b25ab8ea175a2a50eba2e91`, `jup-ag/docs/static/files/audits/limit-v2-offside.pdf`); `jup-ag/limit-order-taker-example` (archived 2025-11-14).
- **DCA** — `DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M` — source CLOSED, but `jup-ag/dca-cpi@master/idl.json` is the published Anchor IDL (27,920 bytes). **No published DCA audit.**

## Pattern

**Both programs use balance-driven runtime preconditions, not lifecycle flags or discriminator state machines.** Order/DCA accounts carry NO `status` enum, NO `is_active` bool. Lifecycle is encoded in token-account residual balances + cursor fields (`expired_at`, `nextCycleAt`, `inDeposited`/`inUsed`/`outReceived`).

**Limit Order v2** splits cancel from fill (Offside §4.3 "expired_at Check Conditions"):
- `validate_cancel_order` (`state.rs:L84` area) checks `now > self.expired_at`.
- `validate_pre_flash_fill` checks `expired_at > now` — inconsistent until commit `5af58d09`.
- `cancel_order` accepts maker as `UncheckedAccount` "to bypass the case where the account is a PDA"; `flash_fill_order.rs#L98` uses `SystemAccount` (Offside §4.3 "Maker Account Type Validation").

No "Filled"/"Cancelled"/"Partial" enum. A partially-filled order is the same account with reduced `making_amount`; cancel drains residual + rent to maker via Anchor's `close = maker` (inferred — Offside flagged no missing close-authority check, which would be Critical). Partial-fill cancel and full-fill cancel share the same handler.

**DCA** uses three lifecycle handlers (verbatim from IDL):
- `withdraw(WithdrawParams { withdrawAmount: u64, withdrawal: In|Out })` — partial drain either side mid-DCA.
- `closeDca` (args: `[]`, signer = user) — full close; transfers `inAta`→`userInAta`, `outAta`→`userOutAta`, closes `dca`.
- `endAndClose` (signer = keeper) — auto-fires on last cycle; same drain plus optional `initUserOutAta` + `intermediateAccount` for SOL re-wrap.

In-flight flash-fill state lives in `keeperInBalanceBeforeBorrow` + `dcaOutBalanceBeforeSwap` checkpoints on the DCA account, validated in `fulfillFlashFill`. Not liveness flags.

**The close-with-pending-state precondition is enforced by error 6040 `BalanceNotZero = "Can't close account with balance"`** and 6041 `UnexpectedWSOLLeftover = "Should not have WSOL leftover in DCA out-token account"`. Program hard-fails if either token account is non-empty at close — runtime balance check, not a flag.

## Failure history

Offside Labs (April 2024): **0 Crit, 0 High, 0 Med, 2 Low, 5 Informational.** Low findings are referral-fee griefing (§4.1, §4.2). Informational #04 (`expired_at` inconsistency) is the closest lifecycle-bug analogue — fixed in `5af58d09`. No finding relates to close-while-pending, orphaned rent, or cancel races. No DCA audit. No GitHub issue in `jup-ag/dca-cpi` or `limit-order-taker-example` reports orphaned-rent or stale-state.

## End-user recovery story

**Limit Order:** if `cancel_order` reverts, no admin escape. Order PDAs derive from maker + base key; seed collision impossible without maker signature. Retry with correct accounts is the only path.

**DCA:** if `closeDca` reverts on 6040, user must call `withdraw` first to drain residuals, then re-call `closeDca`. **Two-step recovery enforced by the program**, no admin escape. User owns the recovery. If keeper `endAndClose` fails, user can still self-close.

## M-1 fit verdict

**No — wrong shape for Sigil.** Jupiter's pattern only fits when "pending state" lives in token-account residuals of the SAME PDA being closed (DCA's `inAta`/`outAta` are passed to `closeDca` as mut accounts and balance is checked directly). Sigil's pending PDAs (`pending_owner`, `pending_agent_grant`, `pending_constraints`, etc.) are SEPARATE PDAs with seeds the runtime cannot derive without caller cooperation — the constraint that killed Option β. Jupiter never confronts this because their "pending" is balance-in-the-same-vault.

The **`BalanceNotZero` error idiom IS reusable**: Sigil could require any pending PDA passed in be empty/absent at close, hard-failing if non-empty — approximately what `close_vault` already does for `pending_policy` via `policy.has_pending_policy: bool` (α-style for one class). The asymmetry M-1 flags is that the other five classes silently no-op.

## Security-first scores

- **Defense-in-depth: 3/5.** Balance-driven check is unforgeable for cases covered; covers only token-residual. No cross-PDA pending. Single-purpose error per failure is good auditor signal.
- **End-user recovery: 5/5.** DCA's "withdraw then close" with a deterministic error naming the problem is exemplary. Failure self-documents the next ix.
- **Auditor onboarding: 4/5.** Closed source costs −1; IDL + Offside audit make lifecycle fully readable. `closeDca(args: [])` + 6040 is the cleanest "what fails and why" surface possible.
- **Long-term consistency: 2/5.** Pattern does NOT scale to N sibling-PDA classes; only works when pending state IS the account being closed.

## Recommendation for Sigil M-1

**Steal the error-code idiom, not the architecture.** Whatever Sigil picks (α / γ / δ), close failure must be a **single named error per class** (`PendingPolicyNotDrained`, `PendingOwnerNotDrained`, etc.) NOT generic `CloseFailed`, and the error message must name the recovery ix (`cancel_pending_owner_rotation`, etc.). Zero schema bytes; cheapest auditor-onboarding upgrade in the option set.

Jupiter's separation of `withdraw` (partial drain) from `closeDca` (full close) validates that Sigil's existing per-class `cancel_pending_X` ixs are the right shape — do NOT collapse them into `close_vault`. Two-phase drain-then-close is the documented mature-protocol pattern; the split is what makes failure on-chain-recoverable without admin.

**Anti-recommendation:** do NOT adopt "balance-driven runtime check" as Sigil's primary mechanism for sibling-PDA pending state. Jupiter avoids that problem by colocation; Sigil cannot, and faking colocation via SDK-attested account lists (γ alone) is the caller-honesty trap the user already rejected.
