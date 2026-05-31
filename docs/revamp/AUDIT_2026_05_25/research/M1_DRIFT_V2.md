# M-1 Research: Drift Protocol v2

**Protocol:** drift-labs/protocol-v2 (Solana perpetuals DEX, Anchor)
**Repo head:** `master` as of 2026-05-25
**Researcher:** CodexResearcher (Remy)
**Scope:** close-with-pending-state semantics, April-2026 incident lessons

---

## Pattern

**Named pattern:** "Eager structural invariant — every sub-state must be `is_available()` before close, hard-fail uniformly. No flags, no bitmask, no off-chain attestation, no silent skips."

The `User` PDA is Drift's single closeable account. It carries five orthogonal lifecycle surfaces: `status` byte, `idle: bool`, 8 `PerpPosition` slots, 8 `SpotPosition` slots, 32 `Order` slots ([`state/user.rs:113-125`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/state/user.rs#L113-L125)). The `open_orders: u8` count + `has_open_order: bool` flag on User exist *only* as off-chain keeper hints — the program never trusts them at close.

The close path is `handle_delete_user` ([`instructions/user.rs:3605-3623`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/user.rs#L3605-L3623)) — 19 lines that delegate all enforcement to `validate_user_deletion` ([`validation/user.rs:8-72`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/validation/user.rs#L8-L72)). The validator iterates every slot of every sub-state and hard-fails the whole tx with `ErrorCode::UserCantBeDeleted` on the first non-available element:

```rust
// validation/user.rs:35-58 — abridged
for perp_position in &user.perp_positions {
    validate!(perp_position.is_available(), ErrorCode::UserCantBeDeleted, ...)?;
}
for spot_position in &user.spot_positions { validate!(...)?; }
for order in &user.orders {
    validate!(order.is_available(), ErrorCode::UserCantBeDeleted, "user has an open order")?;
}
```

`Order::is_available()` is the punch-line — one line: `self.status != OrderStatus::Open` ([`state/user.rs:1796-1798`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/state/user.rs#L1796-L1798)). `OrderStatus` has four variants `Init | Open | Filled | Canceled` ([`state/user.rs:1866-1875`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/state/user.rs#L1866-L1875)); only `Open` blocks close. Cancel is its own four-handler family ([`instructions/user.rs:2373-2517`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/user.rs#L2373-L2517)) transitioning slots `Open → Canceled`. Cancel and close are **decoupled**: cancel everything in prior ix's, then call `delete_user`. Composability lives in the SDK, not the program.

`DeleteUser` ([`instructions/user.rs:5084-5103`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/user.rs#L5084-L5103)) uses Anchor `close = authority` to refund rent atomically. There is no pending-PDA accounting — Drift has no Sigil-class "queue change for later apply/cancel" surface, because trading state itself is the queue.

**Freshness layer (F-10-relevant):** `validate_user_deletion` ([`validation/user.rs:60-69`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/validation/user.rs#L60-L69)) additionally requires either `user_stats.get_age_ts(now) >= THIRTEEN_DAY` OR `user.idle == true`. `validate_user_is_idle` ([`validation/user.rs:74-137`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/validation/user.rs#L74-L137)) enforces a 1-week (`1_512_000` slots) idle window before `idle` can be set, again duplicating the zero-check.

---

## Failure history

**The big one is governance, not close-path.** April 1, 2026: Drift lost ~$285M when DPRK-attributed attackers obtained pre-signed multisig approvals tied to durable-nonce accounts (signatures harvested March 11-30 via social engineering), then executed two pre-signed transactions four slots apart at 16:05 UTC to swap admin authority and drain via a fake CVT collateral mint ([Chainalysis](https://www.chainalysis.com/blog/lessons-from-the-drift-hack/), [BlockSec](https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation)). The Credshields post-mortem ([credshields](https://discover.credshields.com/drift-protocol-incident-post-mortem/)) flags three failure classes: governance timelocks had been removed pre-incident; durable nonces extended signature validity indefinitely; oracle design lacked liquidity floors so fake CVT held price long enough to drain.

This is **exactly the F-10 + F-4 threat class** — stale pre-signed material executed against a state that no longer matches signer intent. Drift's program had no on-chain freshness/expiry checks on governance ix's; it relied on multisig sequencing semantics, which the durable-nonce flow defeated. As of 2026-05-25, no public commit in `master` shows Drift has shipped an on-chain `recent_slot` or `intent_expiry` validator on admin handlers. Lesson is architectural-by-omission: had Drift bound governance approvals to a recent slot or a hash-of-current-config digest, the months-old pre-signed payloads would have hard-failed.

**Close-path itself:** no public reports of `delete_user` bugs (orphaned rent, flag desync, cancel-race, close-while-pending data loss). The eager-validator design held. PR #1341 added `force_delete_user` for keeper-initiated cleanup of bankrupt accounts — a separate validated path, not a relaxation of `validate_user_deletion`.

---

## End-user recovery story

Three on-chain, owner-driven layers:

1. **Owner can always cancel.** `handle_cancel_orders` ([`instructions/user.rs:2482-2517`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/user.rs#L2482-L2517)) is permissionless from the user's authority and clears every `Open` order in one tx. Settle-funding + close-position drain the perp/spot slots. Once `is_available()` is true everywhere, `delete_user` succeeds and rent refunds via `close = authority`.
2. **Keeper escape.** `force_delete_user` lets a permissioned keeper close bankrupt accounts the owner abandoned. Still validation-gated under a bankruptcy rule, not a bypass.
3. **Rent reclaim.** `handle_reclaim_rent` ([`instructions/user.rs:3630-3666`](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/user.rs#L3630-L3666)) reclaims excess lamports above rent-minimum without closing, gated by `THIRTEEN_DAY` age.

**No admin escape, no flag-flip ix.** Recovery is entirely "make the state truly available, then close." No equivalent to `admin_clear_pending_flag` exists because there are no lifecycle flags whose desync needs recovering.

---

## M-1 fit verdict

**Verdict: PARTIAL — architectural lesson transfers cleanly, literal pattern does not.**

Drift's eager-structural-invariant pattern is viable *only* because pending state lives in fixed-size arrays inside the same account being closed (`perp_positions: [_; 8]`, `orders: [_; 32]`). The validator iterates in-account; nothing is in a sibling PDA. Sigil's M-1 is the opposite shape: each `pending_*` class is its own sibling PDA, and the runtime cannot enumerate siblings not passed in `ctx`. We cannot port `validate_user_deletion` verbatim — Solana's account-passing model forbids it (this killed M-1 option β).

**What transfers** (the strongest finding):

1. **Hard-fail uniformly.** Drift never silently no-ops. Every sub-state check is `validate!(...)`. The `lamports() > 0` silent-skip pattern in `close_vault.rs` is the inverse — it accepts ambiguity. Drift treats ambiguity as attack surface.
2. **One enum, one accessor.** `Order::is_available() = status != Open` is single source of truth. Sigil's analogue should be option α with a strict `PendingPdaClass` trait — every class implements one `is_present()` method, close iterates them, never reads `lamports()`.
3. **Freshness on close.** Drift's `THIRTEEN_DAY + idle` gate IS the F-10 design pattern applied to a non-governance handler. Cheap (`Clock::get` + sub) and forecloses rent-sniping entirely. Sigil's M-1 should bind close to a recent-blockhash-bound caller intent (the same primitive that would have stopped the April incident).

**What doesn't transfer:** the silent off-chain `has_open_order: bool` cache. It exists only as a keeper hint; the program never trusts it. Sigil must NOT introduce caller-attested flags the program then trusts — exact γ failure mode Council already flagged.

---

## Security-first scores

| Dimension | Score | Justification |
|---|---|---|
| Defense-in-depth strength | **5/5** | Validator iterates every slot. Cannot be subverted by partial-failed cancels — failed cancels leave `status == Open`, validator catches it. Adding a new sub-state class is structurally enforced because `validate_user_deletion` lives in one file with one function. |
| End-user recovery | **5/5** | Permissionless owner-driven cancel → close. Keeper escape for bankrupt. Rent-reclaim without close. Three orthogonal paths, all on-chain, no admin trust. |
| Auditor onboarding | **5/5** | One function, 65 lines, four `for` loops. Audit complete in 10 minutes. No flag-state-machine to reason about. |
| Long-term consistency | **4/5** | Adding a new sub-state class requires editing `validate_user_deletion` + adding `is_available()` to the new type. CI doesn't enforce this — a contributor could ship a new `[Foo; N]` field on User and forget the validator entry. The trait-based exhaustiveness check Council Round 3 proposed for option α would close this last gap. |

---

## Recommendation for Sigil M-1

**Adopt option α + trait exhaustiveness check, framed as "Drift's eager-invariant pattern, ported to sibling-PDA constraint."**

1. **Kill `lamports() > 0` silent-skip in `close_vault.rs`.** Every pending-PDA drain block must hard-fail when expected-but-missing — match the `policy.has_pending_policy` discipline already in place for the one class that gets it right.
2. **Per-class lifecycle flags on `PolicyConfig` + per-agent slots**, as Council α describes. The `PendingPdaClass` trait (Round-3 Jordan condition) is non-negotiable — CI guarantee future contributors cannot add a class without wiring close.
3. **Freshness gate on `close_vault`**, mirroring Drift's `THIRTEEN_DAY + idle`. Bind close intent to a recent slot via TA-19 digest. April-2026 lesson applied prophylactically: a pre-signed `close_vault` with stale pending-flag knowledge must fail, not silently no-op against current truth.
4. **Skip option γ.** Drift's `has_open_order: bool` redundant cache is off-chain hint only. Any pattern where the program trusts caller claims about pending classes IS the April failure mode — the multisig "trusted" the durable-nonce tx because the signature matched; the program had no on-chain check current state matched signed intent.

**Drift lesson in one sentence:** the security calculus must include *"what stale signed material could execute against this handler's current state, and does the handler hard-fail when that material no longer matches truth?"* F-10 and F-4 are Sigil's answer for governance; M-1 should be the same answer for close.

---

## Sources

- [drift-labs/protocol-v2 validation/user.rs](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/validation/user.rs), [instructions/user.rs](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/user.rs), [state/user.rs](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/state/user.rs)
- [Chainalysis — Lessons from the Drift Hack](https://www.chainalysis.com/blog/lessons-from-the-drift-hack/)
- [BlockSec — Durable Nonce Exploitation](https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation)
- [Credshields — Drift Post-Mortem](https://discover.credshields.com/drift-protocol-incident-post-mortem/)
- [The Hacker News — DPRK Attribution](https://thehackernews.com/2026/04/drift-loses-285-million-in-durable.html)
