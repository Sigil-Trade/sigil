# Cosign Async Approval — Design (2026-06-17)

**Status:** APPROVED design (user GO 2026-06-17), pre-implementation. Authoritative spec for the cosign async-approval arc. Supersedes the *synchronous* co-sign **mechanism** from PR #351 (`0e09a473`); #351's **gating** is reused unchanged.

Related: [build on PR #351 cosign 2-of-2 hardening]; consumer is `sigil-dashboard` (separate repo).

---

## 1. Goal

Enable genuine **asynchronous 2-of-2 co-signing** of owner operations on a `cosign_required` vault. The owner initiates an elevated action; a separately-bound cosigner **K** (the owner's second device, OR an unrelated party in another country) signs in to the platform with their wallet and **approves on-chain on their own schedule**; the action then executes. This is the Squads "co-sign on the platform" model — identical UX whether K is the owner's second wallet or a remote third party.

### Why async forces on-chain approval (the constraint that drives everything)

A Solana transaction is bound to a recent blockhash that expires in ~60–90 s. So the owner cannot partial-sign now and have a remote cosigner add their signature to the *same* transaction hours later — it would be expired. Three mechanisms were weighed:

- **Synchronous partial-sign** — what PR #351 + the kit `CosignedActionBundle` do today: both sign one wire tx inside the blockhash window. Fails the remote/async requirement.
- **Durable nonce** — a non-expiring nonce lets one tx be co-signed over time. Keeps #351's program but stores a pre-signed owner tx off-chain and carries durable-nonce footguns.
- **On-chain approvals (CHOSEN)** — the pending action lives on-chain; the cosigner submits their *own* approval tx (fresh blockhash); execute once approved.

`Decision drivers:` on-chain approvals over durable-nonce on **security** — non-repudiable on-chain approval, a fresh blockhash per signer (no durable-nonce edge cases), and no owner-pre-signed transaction sitting in a backend (an off-chain exfil surface). The durable-nonce option's one advantage — keeping the just-merged program frozen (smaller audit delta) — is outweighed for a custody flow by the proven on-chain pattern. Synchronous-only was rejected because it cannot satisfy the explicit remote-cosigner requirement; scope is append-only, so the requirement is not narrowed to fit an easier option.

---

## 2. Primary-source grounding — Squads v4

Source: `squads-protocol/v4@main`, `programs/squads_multisig_program/src/` (read verbatim). The proven pattern + the lessons we adopt vs. drop.

**ADOPT:**
- **Separate the action ("what") from the votes.** The proposed action is stored immutably so approvers approve exactly what executes (`VaultTransaction` vs `Proposal`).
- **Record approver by identity, not a counter** (`Proposal.approved: Vec<Pubkey>`). Prevents one key from satisfying both signatures.
- **Strict staleness gate.** Squads blocks *config* transactions once the signer set changes (`config_transaction_execute`: `require!(proposal.transaction_index > multisig.stale_transaction_index, StaleProposal)`), while *vault* transactions may execute when stale. **Every Sigil cosign-gated op is config-like (it changes authority/policy/custody), so all take the STRICT behavior.**
- **Explicit status state machine with terminal `Executed`** prevents double-execution.
- **Time-lock checked at execute** (`now - approved_at >= time_lock`). Sigil already has `timelock_duration`.

**DROP** (multisig overhead a fixed 2-of-2 owner+cosigner does not need):
- ConfigTransaction / variable member set / threshold governance — Sigil's 2-of-2 is fixed (owner + bound K).
- The granular `Initiate`/`Vote`/`Execute` permission bitmask — replaced by "is this the owner / the bound K".
- **Arbitrary compiled-message storage + `invoke_signed` replay.** Squads stores an untrusted compiled message and therefore needs `ExecutableTransactionMessage::new_validated` (signer/writable validation) plus a `protected_accounts` reentrancy guard to execute it safely. **Sigil stores a TYPED action enum instead** → no general CPI-replay surface, none of that validation apparatus, far less to audit. Single biggest simplification and a security win.

---

## 3. The model

**#351's cosign GATING stays** — the `cosign_required` flag, the bound cosigner `K` (`cosign_session_pubkey`), the `is_elevated` classification + all elevation triggers, and the no-brick / fail-closed invariants (`has_bound_cosigner`, inert-state prevention). **The MECHANISM changes** from "K co-signs the action transaction synchronously" to "K approves on-chain asynchronously; the action executes once approved (+ timelock)."

Sigil has two op shapes (confirmed from source):

- **Pattern A — queued ops** (`queue_*` → `apply_*`, with a typed on-chain pending account that already stores a `cosign_digest`): policy update, agent permissions update, agent grant, ownership transfer.
- **Pattern B — immediate ops** (execute on owner signature today): `close_vault`, `withdraw_funds`, `set_observe_only`, `reactivate_vault`, `unpause_agent`, `register_agent` (non-OPERATOR), `close_post_assertions`.

### 3A. Pattern A — extend the existing pending account

- `queue_*` becomes **owner-only** (no synchronous cosigner). It records on the pending account: the bound `cosign_session`, a fresh `cosign_approved: bool = false`, the `policy_version` at queue time (staleness anchor), and the existing content `cosign_digest`.
- New `approve_pending_*` instruction, signed by **K**: `require_keys_eq!` K == bound `cosign_session_pubkey`; re-assert the content `cosign_digest` still matches and the current `policy_version` equals the queued anchor (strict staleness); set `cosign_approved = true`, stamp `approved_by` + `approved_at_slot`; emit an event.
- `apply_*` requires `cosign_approved == true` (this REPLACES #351's synchronous apply-time cosigner re-assert) plus the existing timelock + digest re-assert + no-brick guards.

### 3B. Pattern B — new typed `CosignActionProposal` account

A single account type holding a **typed action enum** + approval state (NOT arbitrary instruction bytes):

- `propose_cosign_action(action: CosignAction)` — owner-only; creates `{ vault, action, status: Active, proposed_at, queued_policy_version, cosign_session }`.
- `approve_cosign_action` — signed by **K**; strict staleness (policy_version unchanged) + K == bound; status → `Approved`, stamp `approved_at`.
- `execute_cosign_action` — status must be `Approved`, timelock elapsed, policy_version unchanged; **dispatch the typed enum to the existing op handler logic** (e.g. the same close-vault routine), then status → `Executed` (terminal).
- `CosignAction` variants (typed, params inline): `CloseVault`, `Withdraw { amount, destination }`, `SetObserveOnly { value }`, `Reactivate { … }`, `UnpauseAgent { agent }`, `RegisterAgent { agent, capability, spending_limit }`, `ClosePostAssertions`.

---

## 4. Replay / staleness gate (the load-bearing safety)

Every approval (both patterns) is bound to **`policy_version`** (Sigil's existing monotonic policy counter, `policy.rs:101`) + the content/action digest. At `approve` AND at `apply`/`execute`, require the current `policy_version` equals the value anchored when the pending/proposal was created. Because **cosigner rotation runs through `queue_policy_update` (elevated → bumps `policy_version`)**, any in-flight approval gathered under the old K is auto-invalidated — Sigil's equivalent of Squads' `stale_transaction_index`, reusing existing state rather than adding a new index. Terminal `Executed`/`Rejected` status prevents replay of a completed proposal.

### 4.1 Freshness ceiling (F-10) reconciliation — REQUIRED for async

`apply_pending_policy` (`:132`) enforces an F-10 freshness ceiling: `clock.slot - pending.queued_at_slot < MAX_APPLY_AGE_SLOTS` (~216,000 slots ≈ **24h**; the timelocked-admin variant `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN` ≈ 700,000 ≈ 78h). Its purpose: bound how long a pre-signed (durable-nonce) apply tx can be held before landing — defending the queue→apply gap against drift/replay (Drift $285M analog, CH-1 audit).

This **collides with the intentionally-async approval timeline** (a remote cosigner may approve days after queue). Resolution — split freshness into two correctly-anchored windows:
- **queue → approve:** UNBOUNDED in slots; protected instead by the strict `policy_version` staleness gate (§4). The pending may wait for K indefinitely *as long as policy has not drifted* — if it drifts, approve/apply is rejected.
- **approve → apply/execute:** keep the F-10 ceiling, **re-anchored to `approved_at_slot`** (apply must land within `MAX_APPLY_AGE_SLOTS` of the APPROVAL, not the queue). The authorization-complete point in the async model is the approval, so this preserves F-10's held-apply bound while giving the cosigner unlimited time to approve.

`Decision drivers:` re-anchor to approval over simply widening the ceiling — keeps F-10's held-apply bound intact (security) instead of loosening it; the `policy_version` gate, not a slot ceiling, is the correct defense for the queue→approve wait. This changes an audit-fix (F-10) behavior, so it is explicitly flagged for the mandatory adversarial-review step before merge.

---

## 5. Status lifecycle

`Active` → (`approve` by K) → `Approved` → (`apply`/`execute`, timelock elapsed) → `Executed` (terminal). Either party may `reject`/cancel from `Active`/`Approved` → `Rejected` (terminal); in a 2-of-2 a single rejection is decisive. No time-based expiry (as in Squads); staleness invalidation + reject are the exits.

---

## 6. Cancels

#351 made cancels cosign-gated (D4 symmetric, so one party can't unilaterally cancel). In the approval model, **cancel = reject the pending proposal** (one party decisive in 2-of-2). The separate `cancel_*` cosign-gated instructions are replaced by a `reject` on the pending/proposal. (The owner aborting their own queued action before K approves is just `reject` by the owner.)

---

## 7. Execute authority

Pattern A: `apply_*` keeps its current caller model (owner, post-approval + timelock). Pattern B: `execute_cosign_action` defaults to **owner-only** (the action is pre-approved + typed, so "who fires it" is not a trust boundary, but restricting to owner avoids griefing). Revisit only if a use case needs open execution.

---

## 8. What changes about PR #351

- **Reused:** `cosign_required`, `cosign_session_pubkey`, the `has_bound_cosigner` distinctness + fail-closed invariants, the `is_elevated` classification + all triggers, the digests, the no-brick / inert-state guards.
- **Replaced:** the synchronous "K is a signer on the action/queue/apply tx" enforcement → the async approve-flag (Pattern A) / proposal-approval (Pattern B) model. The kit `CosignedActionBundle` (synchronous partial-sign) is superseded by approval-tx builders.

---

## 9. SDK + dashboard

- **SDK (`@usesigil/kit`):** owner-only `queue_*` / `propose_*` builders; **K's `approve_*` tx builders**; a **pending-approvals query** (find proposals/pendings where `cosign_session_pubkey == myWallet`, via `getProgramAccounts` memcmp or an indexer); `apply_*` / `execute_*` builders.
- **Dashboard (separate repo `sigil-dashboard`, Next.js 16):** cosigner **sign-in-with-wallet** (wallet connect — no server auth needed; they query on-chain + sign); a **"pending approvals waiting for you"** view; the owner-initiate UI; the approve UI. Plus the **cosign-aware basics** — surface `cosign_required` / bound K, map error **6080** — which are independent of the on-chain work and can land first.

---

## 10. Phasing (dependency / risk order, not calendar)

- **Phase 1:** Pattern A **policy-update** path async-approval, end-to-end (on-chain + the SDK approve builder + dashboard cosign-aware basics). Proves the primitive on the cleanest op (it already has a pending account + digest).
- **Phase 2:** the rest of Pattern A — agent permissions, agent grant, ownership transfer.
- **Phase 3:** Pattern B — the typed `CosignActionProposal` (close_vault first, then the other immediate ops).

### Phase 1 — concrete on-chain scope

1. `PendingPolicyUpdate`: add `cosign_approved: bool`, `approved_by: Pubkey`, `approved_at_slot: u64`, and a `queued_policy_version: u64` anchor (or reuse an existing version field — confirm layout). Update the account SIZE and the canonical digest set if applicable.
2. `queue_policy_update`: drop the synchronous cosigner requirement for elevated mutations (owner-only); record the bound `cosign_session`, `cosign_approved = false`, and `queued_policy_version`.
3. NEW `approve_pending_policy`: K-signed; assert K == bound `cosign_session_pubkey`, content `cosign_digest` matches, `policy_version` unchanged; set approved + stamp; `emit!` an event.
4. `apply_pending_policy`: require `cosign_approved == true` for elevated (replaces the sync re-assert); keep timelock + digest + no-brick guards.
5. Tests (LiteSVM + Rust unit): owner-queue → K-approve → apply happy path; wrong-cosigner approve rejected (6080); apply-before-approve rejected; stale approval (policy_version moved) rejected; reject path.

---

## 11. Open questions (resolve during impl)

- Unify `approve_pending_*` into one instruction (dispatch by which pending) vs. per-op. Lean: per-op for typed clarity in Phase 1; revisit a unified instruction in Phase 2.
- Reuse `PendingPolicyUpdate`'s existing `cosign_session` field, or add explicit approval fields. Confirm against the current layout + SIZE.
- Exact `policy_version` field name + whether `queue` already snapshots it.
- Pattern B execute authority (owner-only vs. open) — default owner.
- Cosigner discovery indexer (getProgramAccounts memcmp vs. Helius DAS) — Phase 3 SDK concern.

---

## 12. Decision drivers (summary)

- **On-chain approvals** over durable-nonce / synchronous — §1 (non-repudiable, fresh-blockhash per signer, nothing pre-signed off-chain).
- **Typed action enum** over arbitrary compiled-message replay — §2 (no CPI-replay surface, no validation/reentrancy apparatus, less to audit).
- **Strict staleness** (policy_version-bound) for all cosign ops — §2/§4 (they are all config-like).
- **Extend existing typed pending accounts** over a generic proposal store for Pattern A — smaller, typed, reuses audited infra.
- **Phasing by dependency/risk** (prove on policy first) — §10 (a correctness/risk ordering, not a schedule).
