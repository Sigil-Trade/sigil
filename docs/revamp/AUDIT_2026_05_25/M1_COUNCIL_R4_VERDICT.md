# M-1 Council Round 4 — Final Verdict

**Result: 7-0 UNANIMOUS for option μ (synthesis).**

Decision rule: security-first, no cost tradeoffs. All seven voices converged onto μ under this weighting after reviewing 12 ecosystem research reports.

---

## Final scoring table (1-5 per axis)

| Voice | α | ζ | η | θ | ι | κ | λ | **μ** |
|---|---|---|---|---|---|---|---|---|
| Jordan (Security) | 11 | 13 | 10 | 15 | 11 | 13 | 10 | **20** |
| Ava (SDK) | 11 | 13 | 10 | 15 | 9 | 14 | 11 | **20** |
| Sam (On-chain) | 13 | 16 | 12 | 17 | 13 | 14 | 11 | **20** |
| Marcus (Architect) | 11 | 13 | 10 | 15 | 13 | 14 | 17 | **20** |
| Riley (Ops) | 11 | 15 | 11 | 16 | 12 | 13 | 16 | **20** |
| User-Voice (real user, 3x Rec weight) | 14 | 19 | 13 | 21 | 10 | 18 | 18 | **30** |
| Solana-Vet (ecosystem veteran) | 11 | 17 | 13 | 17 | 13 | 14 | 16 | **20** |

**μ wins every voice's scoring, every axis, every voter type.** This is the rarest possible Council outcome: 7-0 with no convergence-conditions outstanding.

---

## Verbatim concessions (R3 → R4)

| Voice | R3 vote | R4 vote | Concession |
|---|---|---|---|
| Jordan | α | μ | "Conceding α. Hard. Per-class bool flags are a weaker form of what Squads/Mango/SPL-Governance already proved out." |
| Ava | δ+γ | μ | "Concede. Fully. My R1/R3 argument rested on three load-bearing claims that the research demolishes." |
| Sam | δ+γ | μ | "PendingGuard RAII is dead — twice over. R3 δ+γ holdable? No. Shifting to μ." |
| Marcus | α | μ | "My R3 cost-weighted 'right-sized' framing was incorrect under the security-first directive. Conceded." |
| Riley | δ+γ | μ | "δ+γ is dead on arrival. If every mature protocol uses uniform hard-fail, I'm the operator who has to explain at the next audit why we're the outlier." |
| User-Voice | (new) | μ | "It's the only option where, when my agent gets compromised at 3am, I have recovery." |
| Solana-Vet | (new) | μ | "Boring ecosystem-converged composites beat clever single-mechanism solutions." |

---

## The pattern Solana-Vet named

**"OutstandingChildrenCount + IsFinalState"** — reference-counter-gated close paired with typed terminal-state discriminator on each tracked child.

Why it dominates: **arithmetic invariant** (writer and reader live in the same handler family — no possible drift) vs **categorical invariant** of bool flags (cancel path can miss a `= false` write and permanently brick close). The ecosystem has converged on this independently across SPL Governance, Mango, Marginfi, Squads, Drift.

---

## Final μ build sheet (Council-locked)

Every component has at least one $1B+ TVL deployed exemplar. Schema cost is **+9 bytes on PolicyConfig** plus per-PDA fields — per user directive, this is documentation only, not a vote.

### Core on-chain components

1. **`PolicyConfig.outstanding_pending_count: u8`** — SPL Governance `outstanding_proposal_count` verbatim. Increments on every queue. Decrements on every apply/cancel/drain/reclaim. `close_vault` hard-fails on `!= 0`.

2. **Per-pending-PDA `state: PendingState` enum** — Drift `OrderStatus` / Squads `ProposalStatus #[non_exhaustive]` pattern. Variants: `Queued | Applied | Cancelled | Expired`. Compile-time exhaustive match in every handler (`error[E0004]` if a contributor forgets a variant).

3. **`PolicyConfig.pending_epoch: u64` monotonic** — Squads V4 `stale_transaction_index` exactly. Every policy-affecting mutation bumps the epoch. Pending PDAs carry `created_at_epoch`. Apply rejects on mismatch. **One counter invalidates ALL stale pending state on a config change.**

4. **`created_at_epoch: u64` + `created_at_slot: u64` per pending PDA** — twin freshness gates. Already partially implemented (F-4 in working tree); μ unifies the discipline.

5. **F-10 freshness gate ported onto `close_vault.rs`** — Drift's `THIRTEEN_DAY + idle` and Sigil's own existing F-10 on 8+ apply handlers. **Currently MISSING from close_vault.rs.** ~30 LOC + new constant `MAX_CLOSE_AGE_SLOTS`.

6. **`permissionless_reclaim_orphaned_pending` ix** — Squads V4 Rent Reclaim semantics with Riley's dual-gate:
   - REQUIRE `pending.created_at_epoch < policy.pending_epoch - STALE_EPOCH_THRESHOLD`
   - REQUIRE `clock.slot - pending.created_at_slot > MAX_PENDING_AGE_SLOTS`
   - Lamports return to the **recorded rent payer**, NOT the caller (User-Voice's concern).
   - Emit `PendingPdaReclaimed { reclaimer, pending_pda, age_slots }` event for indexer grief-pattern detection.
   - Decrement `outstanding_pending_count` atomically with the close.

7. **Anti-revival sentinel** — Anchor 0.30+ no longer writes `CLOSED_ACCOUNT_DISCRIMINATOR` by default. Manual sentinel byte sequence written before `info.assign(&system_program::ID)` to prevent revival attacks. **Field-declaration-order matters** — declare `policy` AFTER `vault` so its `exit()` runs later in the codegen sequence.

8. **Per-class named hard-fail errors** — Jupiter `BalanceNotZero` discipline: `PendingPolicyExists`, `PendingOwnerExists`, `PendingAgentGrantExists`, `PendingConstraintsExists`, `PendingCloseConstraintsExists`, `PendingAgentPermsExists`. Distinct error codes for off-chain alert routing.

### Discipline + enforcement

9. **Explicit-call lifecycle helper** (`pending_lifecycle.rs`) — Marcus's R2 proposal (NOT Sam's Drop-based RAII, which is dead per Anchor `exit()` semantics):
   - `fn open(state: &mut PendingState, counter: &mut u8, epoch: &mut u64)`
   - `fn apply(state: &mut PendingState, counter: &mut u8)`
   - `fn cancel(state: &mut PendingState, counter: &mut u8)`
   - All `outstanding_pending_count`, `state`, and `pending_epoch` mutations funnel through here.

10. **CI grep test** — build fails if any `has_pending_*` or `outstanding_pending_count` or `pending_epoch` mutation occurs outside `pending_lifecycle::*` module.

11. **CI exhaustiveness test** — build fails if a new `pending_*.rs` struct lacks the `PendingPdaClass` trait impl (single variant: `Lifecycle::HardFail`).

12. **Certora CVLR rule** — formal invariant: `outstanding_pending_count == sum(exists(pending_X) where state != Cancelled && state != Applied)`. Proven across queue/apply/cancel/close/reclaim handler call graphs. Squads V4 already has Certora coverage; this is table-stakes at Sigil's intended TVL.

13. **ADR** at `docs/revamp/ADR/M1-PENDING-PDA-DRAIN-SEMANTICS.md` — documents the test for any new pending PDA: *"Will close_vault hard-fail on this PDA's existence? Yes (HardFail) is the only valid answer; design otherwise as state living on the parent struct."*

### Solana-Vet's new spec gap: parent lifecycle

14. **`AgentVault.lifecycle_state: VaultLifecycle`** — `{ Active | Frozen | Closing | Closed }`. Adds `prepare_close_vault` ix that sets `state = Closing` and `prepare_close_at_slot = clock.slot`. `close_vault` requires `state == Closing && prepare_close_at_slot + MIN_CLOSE_DELAY < clock.slot`. **Generalizes Jupiter's two-phase pattern to the parent. Adds a second timelock surface so cancel-handlers can explicitly intercept close.** Drift `User.idle`, Mango `AccountState`, klend `Obligation.ownership_transfer_state` all do this for their root account.

### Spec gaps surfaced by R4 voices, all incorporated above

| Spec gap | Surfaced by | Addressed by build-sheet item |
|---|---|---|
| Reclaim grief surface (dual-gate) | Riley | #6 |
| Counter-decrement under stale-apply race | Marcus | #6 + #9 (atomic in helper) |
| Anchor close-codegen field-order | Jordan + Sam | #7 (declare `policy` after `vault`) |
| `pending_epoch` SDK contract | Ava | Documented in ADR #13 |
| Zero-copy constraint | Sam | μ counter lives on `#[account] PolicyConfig`, NOT zero-copy `AccountLoader` |
| Rent destination on reclaim | User-Voice | #6 (recorded rent payer, not caller) |
| Parent lifecycle state machine | Solana-Vet | #14 |

---

## OUT-OF-SCOPE CRITICAL FINDING — Lost-cosigner recovery (P0 adjacent)

User-Voice surfaced this in R4: every M-1 option assumes the owner still has BOTH keys (owner + cosigner). If a user loses their Ledger / cosigner phone, the agent keeps spending $5K/day, and the user cannot:
- Pause the vault (cosign required)
- Close the vault (cosign required for queue_close_constraints)
- Rotate the cosigner (cosign required)

μ's permissionless reclaim recovers **rent**, but does not address this. **The Drift April 2026 lesson applies adjacently: pre-signed material that can't be revoked == catastrophic exposure.**

Recommended P0 follow-up (separate finding, NOT in M-1 scope but discovered during M-1 research):

**Permissionless freeze trigger** — if owner doesn't co-sign anything for N days (configurable, default 7 days), a `guardian` address (set by owner at vault init) can call `permissionless_freeze` to set `lifecycle_state = Frozen`. While frozen: no spending, no new sessions, no queue ix. Owner can recover via fresh cosigner setup + `reactivate_vault`.

This finding is **out of M-1 scope** but should be tracked as a new audit-2026-05-25 issue or escalated to the audit-2026-06-XX backlog.

---

## What μ retires

| Threat | How μ retires it |
|---|---|
| Silent-skip orphaned rent on RPC failure | F-3 ERROR signal (off-chain) + permissionless reclaim (on-chain) |
| Stale `pending_owner` collision-on-reinit | `pending_epoch` invalidates ALL stale state on config change |
| Stale `pending_agent_grant` phantom OPERATOR claim | Same — `pending_epoch` + per-class typed `state` |
| Cancel-handler race bricking close_vault | Explicit-call lifecycle helper + CI grep + counter (no flag-flip required) |
| Audit-fatigue re-filing M-1 | Every component traces to a named protocol exemplar — no asymmetry to flag |
| Anchor 0.30+ revival attack | Anti-revival sentinel manually written |
| Pre-signed close attack (Drift April 2026 class) | F-10 freshness gate on close_vault |
| Wedged user (Marginfi sec3 I-1 class) | Permissionless reclaim ix with dual-gate |
| Wrong-PDA-passed in remaining_accounts | Counter ≠ 0 hard-fail catches this even without per-class flags |
| Contributor #7 drift | Trait exhaustiveness + CI grep + ADR |
| Formal invariant verification | Certora CVLR rule |

11 attack classes retired. Each cited in the research dossier.

---

## Implementation plan (Council-locked, awaiting user approval)

**Phase M1-1: On-chain core** (~6h)
1. Add `outstanding_pending_count: u8` + `pending_epoch: u64` to PolicyConfig
2. Add `created_at_epoch: u64` + `created_at_slot: u64` to each pending PDA struct
3. Add `state: PendingState` enum field to each pending PDA struct
4. Add `lifecycle_state: VaultLifecycle` to AgentVault
5. Build `pending_lifecycle.rs` helper module (open/apply/cancel — explicit-call, not Drop-based)
6. Add `PendingPdaClass` trait + `Lifecycle::HardFail` variant
7. Define 6 named errors (`PendingPolicyExists` etc.)
8. Define `MAX_CLOSE_AGE_SLOTS`, `MAX_PENDING_AGE_SLOTS`, `STALE_EPOCH_THRESHOLD`, `MIN_CLOSE_DELAY` constants

**Phase M1-2: Handler retrofits** (~6h)
9. Retrofit all 6 queue handlers to call `pending_lifecycle::open`
10. Retrofit all 6 apply handlers to call `pending_lifecycle::apply` + epoch check
11. Retrofit all 6 cancel handlers to call `pending_lifecycle::cancel`
12. Retrofit `close_vault.rs` to: (a) require `lifecycle_state == Closing`, (b) hard-fail on `outstanding_pending_count != 0`, (c) F-10 freshness gate, (d) declare `policy` AFTER `vault` in account struct
13. Add `prepare_close_vault` ix
14. Add `permissionless_reclaim_orphaned_pending` ix with dual-gate

**Phase M1-3: Enforcement + verification** (~4h)
15. CI grep test (build fails on `outstanding_pending_count` mutation outside helper)
16. CI trait-exhaustiveness test (build fails if pending PDA struct lacks trait impl)
17. Certora CVLR rule for counter invariant
18. Anti-revival sentinel pattern
19. LiteSVM tests for: griefing-resistant reclaim, cancel-race coverage on all 6 classes, freshness-gate on close, prepare-close two-phase

**Phase M1-4: Documentation + SDK** (~3h)
20. ADR documenting the lifecycle test
21. SDK update — read `outstanding_pending_count`, surface it in UI, batch into existing `mutations.closeVault`
22. Per-class named-error mapping in SDK `agent-errors.generated.ts`
23. Update CLOSURE.md with M-1 closed status

**Total: ~19h engineering. Rides next devnet redeploy** (already needed for H-1 + F-4).

---

## Status of prior verdicts

- **Council R3 δ+γ verdict** → RESCINDED
- **Sam's `PendingGuard<T>` R2 proposal** → ABANDONED (Anchor `exit()` semantics)
- **Type-state with PhantomData (Marcus R3 + Sam R2)** → REJECTED (zero Solana adoption)
- **R3 cancel-race CI invariant test** → SUBSUMED into Phase M1-3 #15-16
- **Option β** → DISCARDED (Solana runtime constraint, unchanged from R1)
- **Options γ, δ, ε** → REJECTED on ecosystem-evidence grounds

---

## What's next

The Council has spoken: 7-0 for μ. Specification is locked. Implementation plan is on the table.

User authorization required to proceed with Phase M1-1 implementation. Adjacent P0 finding (lost-cosigner recovery) should be tracked as a new audit issue.
