# M-1 Ecosystem Research Synthesis

**12 of 12 research reports complete.** This is the evidence base for Council R4. Source reports in `docs/revamp/AUDIT_2026_05_25/research/`.

---

## TL;DR

**Zero of 10 mature Solana protocols use δ/γ-style asymmetric variants** for close-with-pending semantics. All use uniform hard-fail, often layered with typed enum state-machines, reference counters, or monotonic epoch invalidation. Multiple sidestep close paths entirely.

**The δ+γ verdict from Council R3 is now ecosystem-refuted.** It was a cost-weighted compromise; security-first weighting (user directive) plus ecosystem evidence makes that verdict structurally untenable.

**New options ζ / η / θ / ι / κ / λ surfaced from the research.** A synthesis option **μ** combines the strongest patterns from all 10 ecosystem references.

---

## 1. Empirical findings from 10 protocols + audit mining + formal methods

### 1.1 Universal patterns

| Finding | Evidence | Implication |
|---|---|---|
| All mature protocols use uniform hard-fail on close path | SPL Governance, Mango v4, Squads V4, Marginfi, Drift v2, Lighthouse, Token-2022, Jupiter, Kamino | Sigil's silent-skip on 5 of 6 PDAs is the outlier |
| Typed enum state-machines preferred over bool flags | Squads `ProposalStatus #[non_exhaustive]`, Mango sentinel-index, SPL Governance `ProposalState` (10 variants), Drift `OrderStatus` | Per-class bool flags (α) are weaker than typed enums |
| Reference counters used for cross-state dependencies | Mango `in_use_count`, SPL Governance `outstanding_proposal_count`, Marginfi `lending_position_count` | Counters dominate flags on schema + drift resistance |
| Monotonic stale-epoch invalidates pending state on config change | Squads `Multisig.stale_transaction_index: u64` | One counter invalidates ALL pending state — orthogonal to per-PDA flags |
| Audit-fatigue threat is empirically real | OS-KLY-SUG-03 (Kamino, OtterSec 2023), TOB-SQUADS-4 (Trail of Bits 2023), ND-SQD2-L2 (Neodyme 2024), sec3 I-1 (Marginfi Dec 2023) | A future Sigil audit WILL re-file M-1 if asymmetry persists |
| Escape-hatch is empirically required | Marginfi sec3 I-1 (dust-balance wedged users) + permanent pre-0.1.4 bank lockout | Riley's R2 escape-hatch concern is validated by production incident |
| Freshness gate (F-10 pattern) on close_vault prevents pre-sign attacks | Drift `THIRTEEN_DAY + idle` gate; Drift April 2026 $270M shows what happens without it | F-10 should extend to close_vault |
| Multiple protocols sidestep close entirely | SPL Governance (no `close_realm`), Kamino kvault/klend (no `close_vault`/`close_obligation`) | Eliminating the close path is a valid security-first option |

### 1.2 Anchor framework constraints (load-bearing)

From `docs/revamp/AUDIT_2026_05_25/research/M1_ANCHOR.md`:

1. **`exit()` fires ONLY on `Ok(_)`** — Err short-circuits before exit. **This invalidates Sam's R2 `PendingGuard<T>` RAII proposal.** Drop fires both paths but `AccountInfo` serialization doesn't happen on Err. The cancel-race remediation must be **explicit-call helper** (Marcus's `PendingLifecycle::open/apply/cancel`), NOT Drop-based RAII.

2. **Anchor 0.30+ no longer writes `CLOSED_ACCOUNT_DISCRIMINATOR`** — revival-attack resistance is now MANUAL remediation. **Sigil's `close_vault` may have current revival-attack exposure** (separate audit class, not directly M-1 but adjacent).

3. **Zero PhantomData, zero Drop in `Account<'info, T>`**, zero ecosystem precedent for type-state programming on Solana. Marcus's compile-time type-state proposal lacks any battle-tested Anchor pattern.

4. **Field-declaration-order is load-bearing** in Anchor's exit codegen — close-marked fields fire at their declaration position, interleaved with mutable serialize calls. Hidden footgun.

### 1.3 Formal verification posture

From `docs/revamp/AUDIT_2026_05_25/research/M1_FORMAL_METHODS.md`:

- **Certora Prover** is the ONLY production-ready FV path on Solana today (open-sourced Feb 2025). 12 Solana reports shipped (Squads V4, Kamino, Jito, Marinade-adjacent, etc.).
- **Sec3 X-Ray does NOT cover** lifecycle/pending-state bugs — wrong tool.
- **Kani + OtterSec Anchor harness** — research-grade, zero production adopters in 3 years.
- **Type-state with PhantomData** — only technique that makes bug class unrepresentable at compile time, but ZERO Solana deployments.
- **Recommended overlay**: Certora CVLR rule (`#[rule]`, `cvt_assert!`, `cvt_assume!`) for the M-1 invariant.

### 1.4 Audit-history catalog (14 findings)

From `docs/revamp/AUDIT_2026_05_25/research/M1_AUDIT_REPORT_MINING.md`:

- SPL Token frozen-close-reinit (#3190)
- Jupiter Lend orphaned-rent (Code4rena L03)
- Jupiter Perpetuals ClosePositionRequestEvent + SystemAccount-vs-PDA (OtterSec + Offside)
- Squads V4 transaction_accounts_close.rs state-machine + Rent Reclaim semantics
- Drift V2 delete_user preconditions
- Orderly Network deposit_nonce race (Sherlock #34)
- OptiFi $661K operational close-incident
- Plus 7 more

Systemic patterns recurring across audits:
1. Generic revival/reinit is foundational concern
2. Mature protocols converge on typed enum state-machines (NOT bool flags)
3. Permissionless rent-reclaim is the recurring recovery pattern
4. Nonce/flag-update-after-side-effect races recur across protocols
5. Documented "cannot close this PDA" is a valid acknowledged pattern provided no downstream invariant depends on it

---

## 2. Comprehensive option set after research

The 5 options Council R1-R3 considered are now augmented by **6 new options from ecosystem research**, plus a synthesis option **μ**.

| Option | Source | Schema impact | Mechanism |
|---|---|---|---|
| α | R1-R3 | +14 bytes | Per-class bool flags, hard-fail on close |
| **β** | R1-R3 | — | **DISCARDED** (Solana runtime blocks AccountInfo inspection of unpassed accounts) |
| **γ** | R1-R3 | +2 bytes | **REJECTED by Drift** ("exact failure mode the April 2026 attack class embodied") |
| **δ** | R1-R3 | +2 bytes + events | **REJECTED by 10 of 10 protocols** (no ecosystem precedent for asymmetric variants) |
| **ε** | R1-R3 | 0 | **REJECTED by audit-history** (OS-KLY-SUG-03, ND-SQD2-L2, sec3 I-1, TOB-SQUADS-4 all re-file this class) |
| **ζ** | SPL Governance | +1 byte | Single `pending_pda_count: u8` counter; close hard-fails if non-zero |
| **η** | Lighthouse | 0 bytes | Caller-attested bidirectional presence assertions with compile-time `match` exhaustiveness |
| **θ** | Squads V4 | +8 bytes | α-flags + monotonic stale-epoch + `#[non_exhaustive]` enum |
| **ι** | Kamino P3 | 0 bytes on PolicyConfig | Tombstone-don't-close pattern (zero marker field, account never reclaimed) |
| **κ** | Jupiter | 0 bytes | Two-phase drain-then-close, named-per-class hard-fail errors |
| **λ** | SPL Gov + Kamino | N/A | Eliminate `close_vault` entirely (radical refactor) |
| **μ** | Synthesis | +variable | Combination of strongest patterns from all 10 references (see §3) |

---

## 3. Option μ — the security-first synthesis

Built from the 10 ecosystem references with the user's "security-first, no cost tradeoffs" rule. Every component traces to a specific protocol's production-validated pattern.

### Components

| Component | Source | Implements |
|---|---|---|
| Typed enum state-machine for each pending-PDA class | Squads V4 `ProposalStatus #[non_exhaustive]` + SPL Governance `ProposalState` | `PendingState::{None, Queued, Applied, Cancelled, Expired}` per PDA class. Compile-time exhaustive match in every handler. |
| Reference counter on parent | Mango `in_use_count`, SPL Governance `outstanding_proposal_count` | `PolicyConfig.outstanding_pending_count: u8` increments on queue, decrements on apply/cancel. `close_vault` hard-fails if `> 0`. |
| Monotonic stale-epoch | Squads V4 `Multisig.stale_transaction_index: u64` | `PolicyConfig.pending_epoch: u64` bumps on every policy-affecting state change. Pending PDA carries `created_at_epoch`. Apply rejects if mismatch. **One counter invalidates ALL stale pending state.** |
| F-10 freshness gate on close_vault | Drift `THIRTEEN_DAY + idle`, our existing F-10 on apply handlers | `close_vault` requires `clock.slot - vault.last_mutation_slot < MAX_CLOSE_AGE_SLOTS` |
| Permissionless rent reclaim ix | Squads V4 Rent Reclaim semantics | Separate `permissionless_reclaim_orphaned_pending` ix for emergency rent recovery on stuck pending PDAs |
| Anti-revival sentinel | Anchor 0.30 manual remediation | After close, write a sentinel discriminator to the data buffer before `info.assign(&system_program::ID)` |
| Explicit-call lifecycle helper | Marcus R2 (not Sam's Drop-based RAII per Anchor exit() semantics) | `pending_lifecycle::open(state)`, `apply(state)`, `cancel(state)` — all flag/counter/epoch mutations funnel through here |
| CI grep test + exhaustiveness | Marcus R2 + Jordan R3 | Build fails if `outstanding_pending_count` mutated outside `pending_lifecycle::*` OR if a new pending PDA struct lacks `PendingPdaClass` trait impl |
| Certora CVLR rule | Formal Methods research | Specify the invariant: `outstanding_pending_count == sum(exists(pending_X))` and prove it holds across all queue/apply/cancel/close handler call graphs |
| ADR documenting the lifecycle test | Marcus R3 | New pending PDA must answer: "Will close_vault hard-fail on this PDA's existence?" — yes-only design, the trait enum has only `Lifecycle::HardFail` |
| Per-class named hard-fail errors | Jupiter `BalanceNotZero`, Marginfi `RemainingLiabilityShares` | `PendingPolicyExists`, `PendingOwnerExists`, `PendingAgentGrantExists`, `PendingConstraintsExists`, etc. — distinct error codes for off-chain alerting |

### Schema impact

| Field | Bytes |
|---|---|
| `PolicyConfig.outstanding_pending_count: u8` | +1 |
| `PolicyConfig.pending_epoch: u64` | +8 |
| Per-pending-PDA `state: PendingState` (u8) | +1 per existing pending PDA struct (6 classes = +6 bytes spread across PDAs, not on PolicyConfig) |
| Per-pending-PDA `created_at_epoch: u64` | +8 per pending PDA |
| **Total on PolicyConfig:** | **+9 bytes** |

Per the user directive, **schema cost is not a vote** — documentation only.

### Why μ dominates every prior option

| Prior option | Why μ is strictly stronger |
|---|---|
| α (R3 conditional) | μ keeps α's per-class enforcement AND adds counter + epoch + freshness + reclaim. α alone has no freshness gate, no monotonic epoch, no permissionless reclaim. |
| ζ (counter alone) | μ keeps the counter AND adds per-class typed state AND stale-epoch. Counter alone doesn't catch wrong-PDA-passed in remaining_accounts. |
| η (caller-assertions alone) | μ keeps caller-honesty out of the protocol — counter is on-chain truth. Lighthouse-style assertions are still useful as SDK overlay (Layer 2 in the formal-methods stack). |
| θ (Squads-style alone) | μ extends θ with reference counter (Mango), permissionless reclaim, anti-revival sentinel, formal-verification overlay. θ alone shipped silent-skip bugs (Neodyme ND-SQD2-L2). |
| ι (tombstone-don't-close) | μ keeps the option to NOT close pending PDAs, but adds the on-chain enforcement that they MUST be in `Expired` or `Cancelled` state. ι alone is silent-skip with extra steps. |
| κ (two-phase drain-then-close) | μ implicitly supports two-phase via separate cancel/apply ix — but enforces atomicity via counter. κ alone doesn't catch the wrong PDA. |
| λ (eliminate close) | μ keeps close as an option for owner-initiated reclaim, but with full invariant enforcement. λ alone wedges users who legitimately want to close. |

### Security-first scores

| Axis | Score |
|---|---|
| Defense-in-depth | **5/5** — 7 independent enforcement layers (typed state, counter, epoch, freshness, helper, CI test, Certora rule) |
| End-user recovery | **5/5** — explicit cancel paths + permissionless reclaim ix |
| Auditor onboarding | **5/5** — every component traces to a named protocol exemplar |
| Long-term consistency | **5/5** — CI exhaustiveness + ADR + Certora rule prevent contributor drift |

---

## 4. What changed since Council R3

### Validated:
- **Jordan's "monitoring layers fail"** — validated by Drift April 2026 (off-chain monitors didn't catch the durable-nonce attack; γ-style trust would have repeated this)
- **Marcus's "structural drift"** — validated by 4 separate audit firms re-filing this class (Kamino, Squads, Marginfi)
- **Riley's "bricked vault SEV-1"** — validated by Marginfi sec3 I-1 (dust-balance wedged users) + permanent pre-0.1.4 lockout

### Invalidated:
- **Sam's R2 `PendingGuard<T>` RAII proposal** — Anchor `exit()` only fires on `Ok(_)`, Drop fires both paths but no state persistence on Err. Must use explicit-call helper.
- **R3 δ+γ verdict** — zero ecosystem precedent for asymmetric variants
- **Marcus's R3 "right-sized" framing** — security-first means uniform hard-fail; "right-sized" was a cost-weighted argument
- **Type-state programming as a primary mechanism** — zero Solana deployments, ecosystem hasn't pursued it

### New constraints:
- Anchor 0.30+ revival-attack surface (write sentinel discriminator manually)
- Field-declaration-order matters in Anchor close codegen
- `outstanding_pending_count` is the canonical Solana-ecosystem pattern (not bool flags)

---

## 5. Council R4 setup

### Voices (7 total)

1. **Jordan** — Security Pentester (R1-R3)
2. **Ava** — Off-chain SDK Engineer (R1-R3)
3. **Sam** — On-chain Anchor Engineer (R1-R3) — must address Anchor exit() invalidation of his RAII
4. **Marcus** — Protocol Architect (R1-R3) — must address ecosystem refutation of δ
5. **Riley** — Operational Monitor (R1-R3) — escape-hatch validated by Marginfi
6. **SOLANA-VET** — NEW. Channels mature Solana protocol engineering practice (Squads/Mango/SPL Governance). Has read every research report. Speaks ecosystem-evidence-first.
7. **USER-VOICE** — NEW. An actual Sigil end-user with non-trivial vault. Reasons about debug stories, recovery semantics, wedged-vault scenarios. Optimizes for "what happens to me when this fails."

### Decision rule

**Security-first, no cost tradeoffs.** Cost/effort/schema-bytes/IDL-churn are documentation items, never deciding factors. End-user experience IS part of the security calculus (an unrecoverable footgun is not "more secure").

### R4 task per voice

1. Read this synthesis + your prior R1-R3 positions
2. Score the comprehensive option set (α, ζ, η, θ, ι, κ, λ, μ) on security-first axes — 1-5 each on Defense-in-depth, End-user recovery, Auditor onboarding, Long-term consistency
3. State final vote (one option)
4. State convergence conditions for accepting the opposing camp's option
5. Identify the ONE specification gap in your preferred option that still worries you

Length: ~350 words per voice.
