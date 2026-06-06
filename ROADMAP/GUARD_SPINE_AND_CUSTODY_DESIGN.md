# Sigil — Guard-Spine & Custody Architecture (Design, 2026-06-05)

**Status:** DESIGN / report-only (no program code changed in this phase).
**Branch/HEAD at authoring:** `revamp/onchain-m1`, HEAD `4e4b547a` (+ this doc).
**Supersedes:** the M3-02 "owner-pin" plan in `ROADMAP/M3_ASYNC_HARDENING.md` (the owner-pin is replaced by the native-delegate + mandatory-outcome-guard model below).
**Author note:** grounded in (a) a source-level map of Sigil's CURRENT guard code (file:line below) and (b) a completed 2-round, ~40-project competitor teardown (see §5).

---

## §0 — RESUME-AFTER-COMPACT (read this first)

**What this is:** the authoritative design for Sigil's custody model + the "mandatory outcome-guard spine," settling the custody fork and spec/ing three hardening items. Produced after a large research arc; this doc is self-contained so work survives context compaction.

**What is DECIDED here:**
- **Custody fork = SETTLED (ratifiable):** NON-CUSTODIAL outcome-guard spine + native-venue delegate for the 3 live delegate-perps (Drift, Mango v4, Parcl v3). Custodial executor ("Squads-for-agents") = documented alternative, trigger-gated. (§1)
- **The wedge = a MANDATORY, agnostic, non-omittable outcome-conservation floor** — the one thing every competitor (Squads, Swig, Maestro, GLAM) left OPT-IN or parse-based. (§2)
- **3 hardening items** specced. (§3)

**What needs Kaleb's input:** §4 (ratify/override the fork; the one product sub-question; the mandatory-mechanism choice).

**Where the evidence lives:** memory `project_sigil_perps_custody_architecture_2026_06_05.md` (full competitor matrix + per-project teardowns) and `project_squads_smart_account_program_competitive_2026_06_05.md`; cloned competitor source under `/tmp/{glam-recon,vault-research,perp-research,sigil-recon,research-clones,research-targets}` (ephemeral — re-clone if needed). Current-Sigil code map: §2.1.

**How to continue (next phase):** adversarial-review THIS design (pr-review-toolkit:code-reviewer + silent-failure-hunter on the spec), resolve §4 with Kaleb, then implement H1→H2→H3 under the mandatory review pipeline (build→restore-IDL→test→adversarial-review→PR→CI). Next-free error code = **6111**.

---

## §1 — CUSTODY FORK (SETTLED, ratifiable)

**Decision:** Sigil stays **NON-CUSTODIAL** (funds in the owner's own ATA; the SPL-Approve delegation sandwich) and adds **native-venue delegate** integration for the 3 live perps that support it (Drift, Mango v4, Parcl v3 — vault PDA = the venue account's owner/authority, agent = the venue's trade-only delegate, only the owner withdraws). The **custodial executor** ("full Squads-for-agents," vault PDA holds funds + `invoke_signed`s the trade) is the **documented alternative**, adopted ONLY if the override trigger fires.

**Custody gradient (honest):** "non-custodial" here = the protocol/founder have ZERO power; only the vault owner does. Layer-1 (spine) keeps funds in the owner's own ATA. Layer-2 (native delegate) parks funds in a *vault-PDA-owned venue account* (e.g. a Drift `User` whose authority is the vault PDA) — still owner-controlled, but funds leave the plain wallet. Both satisfy the non-custodial ethos; they differ in *where funds sit*. The custodial-executor alternative pools funds in a Sigil vault PDA (a honeypot, like every Squads/GLAM/Maestro vault).

**Tradeoff table:**

| | Non-custodial spine + native-delegate (CHOSEN) | Custodial executor ("Squads-for-agents") |
|---|---|---|
| Blast radius | Smallest — no pooled honeypot | Pooled vault = drain target |
| Position ownership | Full custody on Drift/Mango/Parcl; **loss-bounded (not owned) on non-delegate venues** | Vault owns positions on **depth-compatible** venues |
| CPI depth | Spine = top-level sibling (no cost); native-delegate setup = shallow CPI (depth-safe) | Executor = **+1 CPI depth → deep perps can exceed the 4-limit when wrapped** (not universal) |
| Agnostic | Yes — outcome-measured, no per-venue adapter | Per-venue adapter authoring (parse-based; the model the strategic reset deleted) |
| Market position | The **unoccupied** cell (no competitor here) | Contested (Swig, GLAM, Crossmint, Loyal) |
| Differentiation | Unique | Competes on others' turf |

**`Decision drivers:`** security + differentiation. The non-omittable agnostic outcome-guard is the unoccupied market cell, works on every venue at no CPI-depth cost, and is non-custodial (smallest blast radius). Native-delegate gives full custody on the 3 live delegate-perps without becoming a honeypot (the venue's own `has_one=authority` withdraw gate enforces it — source-confirmed for Drift; LIKELY-HIGH Parcl; Mango blocks third-party extraction but a trade-delegate can bleed to the margin floor → the spine covers that residual). REJECTED — custodial executor as default: (a) honeypot (tier-1 surface), (b) +1 CPI depth makes it non-universal for deep perps anyway, (c) per-venue parse-based adapters (rejected ethos), (d) abandons the unique non-custodial wedge. No time/effort input.

**OVERRIDE TRIGGER (when to adopt the custodial executor instead):** only if "the vault must **OWN** positions on **non-delegate venues** (Jupiter Perps / Flash / Hxro)" becomes a hard product requirement that *loss-bounding-without-ownership* cannot satisfy. **Mitigation that likely avoids the trigger:** Flash has a reserved-but-dead `delegate` field; activating it (Kaleb's relationship lever as Head of Growth at Flash) converts Flash to the native-delegate set — removing the main reason to go custodial.

**Security priority:** tier-1 (loss-of-funds + custody). Non-custodial is the lexicographically safer default; the custodial path must be justified by a Kaleb-named product requirement, never adopted silently.

> **RATIFY / OVERRIDE (Kaleb): ____** (default = non-custodial as settled above)

---

## §2 — THE MANDATORY OUTCOME-GUARD SPINE (the wedge)

### 2.1 What exists today (source-mapped — current Sigil, branch `revamp/onchain-m1`)

Sigil already has a **non-omittable validate→finalize sandwich** and a **rich agnostic-outcome assertion vocabulary**. Confirmed:

- **Non-omittability:** `validate_and_authorize.rs:923` forward-scans the instructions sysvar and `require!(found_finalize, MissingFinalizeInstruction)` (err **6025**) — every `validate` MUST be followed by a `finalize_session` in the same atomic tx. Top-level-only: `get_stack_height()==TRANSACTION_LEVEL` (`validate :151-155`, `finalize :117-121`, `CpiCallNotAllowed` 6028). Exactly one DeFi ix: `validate :920` (`TooManyDeFiInstructions` 6033). Backward scan rejects pre-validate non-infra ix (`UnauthorizedPreValidateInstruction` 6056); post-finalize scan rejects trailing non-infra ix (`finalize :1254-1294`, `UnauthorizedPostFinalizeInstruction` 6050).
- **The balance-delta sandwich:** pre-snapshot at `validate :329` (stablecoin-input) / `:362` (non-stablecoin-input); finalize re-reads RAW post-CPI token bytes 64..72 (`finalize :248-308`, bypassing Anchor's stale cache); computes `actual_spend` with **checked** sub of fees (`:349`, `SpendAccountingUnderflow` 6110, the F-Q9 fix).
- **The assertion vocabulary** (`state/post_assertions.rs:32-77`, 8 modes, `PostAssertionEntryZC` 78 B, account SIZE pinned 672 B `:205-208`): `0 Absolute`, `1 MaxDecrease`, `2 MaxIncrease`, `3 NoChange`, `4 MintDeltaCap` (vault-wide drain ceiling), `5 AtaAuthorityPin`, `6 OutputBalanceFloor`, `7 DeclarationConsistency`. Helpers in `post_assertion_helpers.rs`: MintDeltaCap `:31-65` (6088), AtaAuthorityPin `:68-101` (6090), OutputBalanceFloor `:115-160` (6091), DeclarationConsistency `:197-261` (6092). This vocabulary is a **superset** of Lighthouse's and richer than Swig's `program_scope`.
- **Completeness + pins:** F-Q1a destination completeness (`validate :900-906` → `destination_check.rs`; every writable non-vault meta must resolve in `remaining_accounts` or `DestinationAccountUnresolvable` 6105; caps 24 writable / 64 total). F-Q8 output-ATA pin (`validate :364` → session; `finalize :286-289` `require_keys_eq!`, `InvalidTokenAccount` 6021). F-Q4 Token-2022 extension allowlist on vault-owned output ATAs (`destination_check.rs:221-223`).

### 2.2 The gap (the Squads/Swig footgun, present in Sigil today)

**MANDATORY on every spend today:** non-omittability, single-DeFi, protocol allowlist, Token-2022 opcode blocklist, async-deny, F-Q1a completeness, F-Q8 pin, raw re-read, non-stablecoin-must-return-stablecoin, F-Q9 checked spend, per-tx cap (6005), rolling-24h cap (6006), fee-to-cap, post-finalize scan, SPL Revoke.

**OPT-IN today (the gap):** the **post-assertions block is gated on `has_post_assertions != 0`** (`finalize :937`); the **stable floor on `stable_balance_floor > 0`** (`finalize :723`). Both default to zero/inactive. The per-tx + rolling caps are always-on **but are configurable ceilings** — a vault with `daily_spending_cap_usd = u64::MAX` and `max_transaction_size_usd = u64::MAX` has caps that never fire.

> **Consequence (the exact thing to fix): a vault can seal a `amount>0` spend with ZERO conservation/outcome assertion and high caps — i.e. no bound on whether fair value came back or where value went.** This is identical to the Squads opt-in footgun (`if !instructions_constraints.is_empty()` skip) and Swig's optional limits. It is the single biggest lesson of the research.

### 2.3 The design — make a baseline conservation floor MANDATORY

**Principle:** *no spend may leave the vault's value unaccounted-for.* Every `amount>0` seal must satisfy at least one **conservation outcome** — enforced **unconditionally** (not gated on owner config):
- **(a) Round-trip / swap:** value returned to a vault-owned stablecoin/numéraire account ≥ value-out × (1 − `max_slippage_bps`) — an **effective-slippage floor** (repurpose the existing `max_slippage_bps` primitive into a universal value-conservation bound, per the agnostic-assertion-model memo). Builds on mode 6 `OutputBalanceFloor` but expressed *relative to value-out*, mandatory.
- **(b) Custody-delegating spend (perp deposit via native delegate):** the venue position/account authority is vault-pinned (mode 5 `AtaAuthorityPin` generalized to the venue account) AND collateral-out within caps. Value is "accounted-for" because it sits in a vault-owned position (out-of-window settlement returns to the vault by construction).
- **(c) Owner-allowlisted transfer (`agent_transfer`):** value to an owner-allowlisted destination within caps (already mandatory on that path).

**What "mandatory" means on-chain:** `validate_and_authorize` must **refuse to authorize a spending session that is not covered by a conservation outcome** for its action class — i.e. the absence of a conservation assertion is a `require!` failure, not a silent pass. (Symmetric to how `MissingFinalizeInstruction` makes finalize non-omittable; here we make *the conservation outcome* non-omittable.)

**Two mechanism options (pick in §4):**
- **Mechanism A — Required-assertion gate (recommended).** A spend's PolicyConfig MUST carry a conservation assertion appropriate to the lane: swaps require an effective-slippage floor entry; perp-delegate deposits require the venue authority-pin entry. `validate` checks presence + finalize runs it. Pros: reuses the existing 8-mode engine; agnostic; explicit. Cons: needs a "lane → required-assertion" mapping + a new validate-side `require!` + a new error (6111 `ErrConservationFloorMissing`).
- **Mechanism B — Built-in default floor.** A non-config-gated default conservation derived from the session's `authorized_amount` + a program-default `max_slippage_bps`, applied unconditionally in finalize even when no entry is configured. Pros: zero owner config; truly un-skippable. Cons: a sensible *default* for swaps (slippage) doesn't translate to perp-deposits (no in-window return) — needs lane awareness anyway; risks bricking legitimate flows if the default is wrong.

**Recommendation:** **Mechanism A**, with a conservative built-in fallback (B) for the pure-swap lane so the floor is never absent. Resolve the exact lane→assertion mapping during implementation; this doc fixes the *requirement* (mandatory), not the final wiring.

### 2.4 Agnostic-outcome principle (do NOT regress to parsing)

The guard **measures the result** (balance/equity/authority deltas via the 8-mode engine), it **never parses the inner instruction's semantics**. This is the line between Sigil and Squads/GLAM/Swig (all parse program-id + discriminator + data offsets). Keep it: the conservation floor is expressed as an *outcome* (value-back ≥ floor; authority == vault), not as "this instruction is a safe swap." This preserves the agnostic, atomic-guard, no-reshape ethos.

### 2.5 Layer-2 — native-venue delegate (Drift / Mango v4 / Parcl v3)

For the 3 live delegate-perps: vault PDA = the venue account's owner/authority (created via a **shallow** `invoke_signed` setup — `initialize_user`/equivalent + set delegate — depth-safe, mirrors `drift-vaults`); agent = the venue's trade-only delegate; withdrawals only via the vault PDA back to a vault-owned account. The **spine (§2.3) still wraps these** — because even a custody-pinned delegate can *bleed value via bad-price trades* (Mango source-confirmed; Drift same), the mandatory conservation floor is what bounds that. **Reference designs:** `drift-vaults` (full custody flow), Marginfi v2 (intent + permissionless executor + end-of-tx health assertion = Sigil's pattern in production), Zeta (cleanest trade/withdraw delegate split — spec template, protocol defunct).

### 2.6 Explicitly NOT changing (fixed ethos)

Non-custodial (only owner freezes; protocol zero power), atomic-guard-not-modifier (approve-or-revert; never reshape the agent's route/intent), agnostic outcome assertions (no instruction parsing), allowlist/fail-closed, oracle-free (conservation via numéraire + slippage, not price feeds), stablecoin-only numéraire, checked math, bounded vectors, IDL committed, build→restore→test.

---

## §3 — HARDENING ITEMS (specs)

### H1 — Make the conservation floor MANDATORY (= §2.3)
The on-chain enforcement that `validate` refuses a spend lacking a conservation outcome. New error `ErrConservationFloorMissing` (6111, positional append — see [[learning-anchor-error-code-renumber-blast-radius]] discipline). Tests: a high-cap, no-assertion spend that succeeds TODAY must REVERT after. **This is the wedge; highest priority.**

### H2 — Token-2022 `PermanentDelegate` mint-extension reject (tier-1)
`PermanentDelegate` is a mint-level authority that can transfer/burn ANY holder's tokens, bypassing all delegate scoping ($50M+ stolen Q1 2026). Extend Sigil's existing extension allowlist (`token2022_extension.rs`, currently accepts MemoTransfer + MetadataPointer) to **explicitly reject `PermanentDelegate`** (and re-confirm rejection of TransferHook/ConfidentialTransfer/DefaultAccountState-frozen) at the deposit + finalize chokepoints. Note: even the Foundation's `subscriptions` program does NOT gate PermanentDelegate — Sigil would be ahead. Low complexity; reuses the F-Q4 machinery.

### H3 — `anchor-idl-guard` audit of Sigil's account set
The `IdlCreateBuffer`/`IdlCreateAccount` attack class (Blueshift `anchor-idl-guard`) targets program-owned accounts ≥44 B with 8 leading zero bytes — exactly the shape of zero-copy `AccountLoader` PDAs (SpendTracker, AgentSpendOverlay, PostExecutionAssertions) and `UncheckedAccount`s. **Action:** audit each Sigil account's discriminator/size/owner against the attack; if exposed, adopt the gated-entrypoint mitigation (whitelist the IDL discriminators) or confirm not-exploitable. Report-only finding first; fix if confirmed. **Run via the security pipeline (vulnhunter skill + pr-review-toolkit).**

---

## §4 — OPEN DECISIONS (Kaleb)

1. **Ratify or override the custody fork** (§1). Default = non-custodial spine + native-delegate. Override only if owning non-delegate-venue positions is a hard requirement (see trigger + Flash lever).
2. **The product sub-question that gates #1:** must the vault *own* positions on Jupiter/Flash/Hxro, or is "full custody on Drift/Mango/Parcl + universal loss-bounding everywhere" enough?
3. **Mandatory-floor mechanism (§2.3):** Mechanism A (required-assertion gate, recommended) vs B (built-in default) vs A+B hybrid.

---

## §5 — SOURCES

- Competitor research (2 rounds, ~40 projects, source-level): memory `project_sigil_perps_custody_architecture_2026_06_05.md`, `project_squads_smart_account_program_competitive_2026_06_05.md`. Cloned source under `/tmp/{glam-recon,vault-research,perp-research,sigil-recon,research-clones,research-targets}` (ephemeral).
- Current-Sigil code map (§2.1): `state/post_assertions.rs`, `instructions/finalize_session.rs`, `instructions/validate_and_authorize.rs`, `utils/post_assertion_helpers.rs`, `utils/destination_check.rs`, `state/policy.rs`, `errors.rs`, `state/session.rs`, `utils/mint_delta_cap.rs`.
- Key precedents validating Sigil's primitives: Marginfi v2 (intent + executor + end-of-tx health assertion), Fragmetric (on-chain pinned account-metas = F-Q1a), Symmetry (bounded-vector + commitment digest), drift-vaults (native-delegate custody), Lighthouse (assertion vocabulary, but omittable), Swig (`program_scope` outcome primitive, but custodial + optional).

---

## §6 — STATUS / NEXT STEPS

1. **Adversarial-review this design** (pr-review-toolkit:code-reviewer + silent-failure-hunter on the spec; vulnhunter for H2/H3) — attack the mandatory-floor design + the lane→assertion mapping + the native-delegate trust assumptions.
2. **Resolve §4 with Kaleb.**
3. **Implement H1 → H2 → H3** under the mandatory pipeline (build --no-idl → restore IDL → full LiteSVM + kit + cargo → adversarial review → PR → CI). Error codes append-only from 6111.
4. **Reconcile** `M3_ASYNC_HARDENING.md` + `STATUS.md`. **CORRECTION (per §7):** the M3-02 owner-pin is NOT superseded — it is RE-INSTATED as a required component of the perp-custody lane.

---

## §7 — ADVERSARIAL REVIEW FINDINGS + REQUIRED REVISIONS (2026-06-05)

Pre-implementation security review (hostile-auditor pass) on this doc + the current guard code. **Two CRITICALs found in the §1/§2 design as originally written — §1 and §2 are REVISION-REQUIRED per below.** Path is now settled by Kaleb's override: **own Jupiter/Flash positions = non-negotiable → HYBRID: native-delegate for Drift/Mango/Parcl + a minimal-authority SCOPED EXECUTOR (vault PDA `invoke_signed`s the open) for the non-delegate venues (Jupiter/Flash).** That makes CRITICAL-2 a live, must-fix.

**CRITICAL-1 — the "mandatory" floor is gameable by lane-misclassification.** No on-chain swap-vs-perp lane exists (only `is_spending`/`is_stablecoin_input`, validate:267-268); the post-assertions PDA is GLOBAL per-vault (`[b"post_assertions", vault]`, not per-protocol — create_post_assertions.rs:35; finalize loads it regardless of protocol, finalize:944); no `PostAssertionEntryZC` field binds to a protocol. The doc DEFERRED the lane→assertion map. A floor present-but-trivially-satisfiable (OutputBalanceFloor validator is `min_increase > 0` only, post_assertions.rs:317 → a 1-lamport return passes = the G9 dust residual) is WORSE than honest opt-in (manufactures an unbacked guarantee). **FIX:** bind the required conservation assertion to `target_protocol` (a TRUSTED input) via a program-curated per-protocol required-assertion table, enforced at `validate`. Swap-lane fallback (Mechanism B) must be slippage-relative: `value-out ≥ authorized_amount × (1 − max_slippage_bps)`, NOT `>0`. Acceptance test: a 1-lamport-return swap REVERTS (assertion *present* is insufficient — it must *bind*).

**CRITICAL-2 — owning Jupiter/Flash positions REQUIRES the M3-02 per-protocol owner-pin this doc wrongly "superseded," + exact-account binding.** (a) The M3-02 `verify_protocol_account_owner_pin` (`Position.owner == vault` at a per-protocol offset) is exactly what stops the keeper settling to the agent (M3_ASYNC_HARDENING.md:29,112-138); dropping it reopens the drain. (b) It is INHERENTLY per-venue (offset per IDL) → the "agnostic / no per-venue adapter" claim is FALSE for the perp-custody lane. (c) The intent digest binds only 5 scalars (vault, agent, mint, amount, target_protocol — validate:173-179; ENFORCEMENT_MODEL G7); an executor signing the open inherits the **Maestro CRITICAL account-substitution class** (measure one account, CPI debits another — mint_delta_cap scope=0 misses protocol-auto-created position accounts). **FIX:** RE-INSTATE the M3-02 per-protocol owner-pin as a required component of the perp lane; the scoped executor MUST bind the full account-meta list + ix-data (promote to F-Q1b full-meta intent digest), or it must not be built; drop the "agnostic" claim for the perp lane (it is per-venue by construction).

**CORRECTED REFRAME (load-bearing):** agnostic OUTCOME assertions apply to the **swap/round-trip lanes** (value-back is measurable in-window). The **perp-custody lane is inherently PER-VENUE** — there is NO in-window outcome to measure (settlement is out-of-window/keeper), so safety = **per-protocol position-owner pin + exact-account/meta validation + spend cap**, NOT an agnostic outcome measure. "Own Jupiter/Flash without a honeypot" = per-user isolation + scoped executor (signs ONLY the validated open + owner-pinned withdraw) + per-protocol owner-pin + full-meta binding + mandatory per-protocol floor.

**HIGHs:** H1 owner-pinned withdraw HOLDS for the spine (`withdraw_funds.rs:16,46-51` pins dest to owner ATA, Sigil-measured) but the VENUE-position withdrawal is TRUSTED to the venue's `has_one=authority` (GLAM-E20 class; "source-confirmed Drift, LIKELY Parcl, leaky Mango" is below auditor bar). H2 no-standing-pool HOLDS for the spine; the native-delegate SETUP `invoke_signed` (`initialize_user` + set-delegate) + re-delegation is UNSPECCED/unguarded. H3 ASYNC REGRESSION: keep `KNOWN_ASYNC_FULFILLMENT_PROGRAMS` rejection as fail-closed default; retire a venue ONLY after its owner-pin + a source-verified (not "LIKELY") delegate-scoping proof lands. **MEDs:** depth violation fails-closed (revert) — good, but spec it + analyze native-delegate-setup composed depth; bind every new executor/delegate account to the vault by seed + has_one (preserve per-user isolation).

**Review verdict:** the non-custodial spine (SPL-Approve sandwich) is SOUND. The two pre-implementation holes (CRITICAL-1 gameable floor; CRITICAL-2 dropped owner-pin + unbound executor) WOULD ship a hole. §1/§2 to be revised after the Jupiter/Flash executor-feasibility + prior-art agents land. Source-cited; full review in the session transcript.
