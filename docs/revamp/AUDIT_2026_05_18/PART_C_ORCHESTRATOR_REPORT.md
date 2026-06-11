# Sigil V2 Phases 1-5 Foundation Audit — Orchestrator Report (Part C)

**Date:** 2026-05-18
**Branch:** revamp/v2-2026-05
**HEAD:** 1dcc92d (60 commits since Phase 1 close 96ed5a2)
**Audit scope:** Phases 1-5 (Demolition + TA-19 + 7 pre-exec guards + bundle integrity + post-exec invariants)
**Dispatched:** 10 Part A technical tracks + 10 Part B character takes × 2 rounds = 30 agent invocations
**Orchestrator (this document):** Independent verification + synthesis

---

## VERDICT: **FIX-FIRST**

Phase 6 dispatch BLOCKED until 5 named gates close. Verdict converges 9/10 across the Part B roundtable (Skeptic alone holds PIVOT, but with flip conditions that overlap the FIX-FIRST gate list).

**Estimated time to clear all 5 gates: 5-7 working days for solo founder.**

---

## §1. Wild-Goose-Chase Check

Per Part C Step 1 — every subagent finding cross-checked against current code state.

| Agent | Finding | Verdict |
|---|---|---|
| Pentester A1 | HIGH-1: set_observe_only has no `expected_digest` arg | **MISFRAMED** — set_observe_only is a direct owner ix (has_one = owner). Owner's tx signature IS the binding. PEN-CROSS-3 pattern applies to pending-PDA-tampering windows, not direct owner mutations. Verified: `set_observe_only.rs:41` handler takes `new_value: bool` only — correct design. |
| Skeptic | KILL TA-19 (pure ceremony) | **FORMALLY INCORRECT** — Academic + Architect (independently) refute: owner signature proves *willingness*; TA-19 proves *willingness over a specific binding*. Confused-deputy class (Hardy 1988) requires content-binding distinct from principal-binding. Plus TA-19 is what makes §RP mechanically find sibling-handler digest drift. |
| code-reviewer A2 | LOW: bare `+` in const SIZE math (CLAUDE.md "checked math") | **FALSE POSITIVE** (self-acknowledged by agent) — CLAUDE.md rule applies to runtime u64 ops; const-expr is compile-time. |
| VulnHunter A9 | AT-RISK: raw i64 in agent_spend_overlay.rs:218-224 | **TRUE but bounded** — operates on clock-derived values bounded by ~2^31 in any plausible horizon. Practical impact zero, CLAUDE.md compliance only. |

All other findings VALID after spot-check. **15+ findings cross-checked, 2 misframed, 1 false positive, 0 stale-HEAD analyses.**

---

## §2. Conflict Resolution

| Disagreement | Resolution |
|---|---|
| Skeptic vs Architect/Academic on TA-19 | **TA-19 stays.** Architect/Academic correct. Content-OCC is a distinct property from owner authentication. |
| Engineer vs Architect on codegen direction (Rust authoritative vs schema authoritative) | **Schema DSL authoritative.** Architect correct on multi-target durability — Sigil's mobile-native plan (Kotlin/Swift) per memory `project_sigil_mobile_native_plan_2026_05_18` requires both targets to derive from one source, not Rust-as-authoritative. |
| Architect (REMOVE TA-17) vs VulnHunter/code-recon (TA-17 working) | **TA-17 stays for now, Phase 11 candidate for removal.** Architect's argument is sound (off-chain monitor + freeze_vault is simpler), but ripping it out now creates fixture churn. Re-evaluate at Phase 11 final sync. |
| Skeptic (PIVOT, scope-cut to ~10 protocols) vs Market Analyst (FIX-FIRST, defend wedge) | **Market Analyst wins on framing.** Sigil is generic; cutting to ~10 protocols undoes Phase 1 demolition (L-1). But Skeptic's "freeze Phase 5 ix-count until 30d post-mainnet" is sound — adopt as Phase 6 dispatch condition. |

---

## §3. CRITICAL — Must Address Before Phase 6 Dispatch

### CRIT-1: SDK Generated Types Missing Phase 5 Args
**Severity:** CRITICAL — orchestrator independently verified at HEAD `1dcc92d`.
**File:** `sdk/kit/src/generated/instructions/initializeVault.ts` + `queuePolicyUpdate.ts`
**Finding:** `grep -c "stableBalanceFloor|perRecipientDailyCapUsd"` returns 0 in both files. IDL has 17 args, SDK InstructionData has 14. Wire payload short 16 bytes. **Any SDK caller invoking `getInitializeVaultInstruction()` or `getQueuePolicyUpdateInstruction()` today produces malformed transactions.**
**Fix:** ONE command, per Engineer Round 2:
```bash
cd sdk/kit && pnpm run codama
```
This regenerates from `target/idl/sigil.json` via `codama.mjs` (verified present at `sdk/kit/codama.mjs`). Last SDK regen was `3da5fa4` (Phase 3 TA-07) — missing 7 phases of IDL changes. Expected diff: ~30-60 lines of generated code + zero source changes. TypeScript will fail typecheck for ~4-6 hand-written caller sites (`create-vault.ts`, `dashboard/mutations.ts`, `preview-create-vault.ts`); that's the forcing function — wire the new fields through.
**Earliest ship:** Tuesday if dispatched Monday.
**Impact if unaddressed:** Per Market Analyst — collapses Maestro Agent Mode threat window from 12-18mo to **6-9mo**. Sigil cannot demonstrate its own Phase 5 features to design partners.

---

## §4. HIGH — Should Address Before Phase 6 OR Document Explicit Deferral

### HIGH-1: PEN-CROSS-1 register_agent No-TA-19, No-Timelock
**Severity:** HIGH (CRITICAL per cross-phase audit memory; downgraded by orchestrator because owner signature is still required — exploitability narrows to owner-key phishing).
**Files:** `programs/sigil/src/instructions/register_agent.rs`
**Finding:** No timelock, no TA-19 digest binding, no cosign requirement. Owner-key phish → instant operator grant (`capability=FULL_CAPABILITY`, `spending_limit_usd=u64::MAX`). Memory says "Phase 8 absorption" but THREAT_MODEL_V2 doesn't list it as open (Ava).
**Cross-confirmed by:** Pentester + VulnHunter + code-recon + Ava + Remy + Architect (6 independent agents).
**Fix:** Add `expected_digest: [u8; 32]` arg following PEN-CROSS-3 pattern. Optionally add 1-slot timelock. ~2-3 hours.

### HIGH-2: TA-09 Cosign Excludes TA-12 + TA-14 Elevation
**Severity:** HIGH
**Files:** `programs/sigil/src/instructions/queue_policy_update.rs:241-273`
**Finding:** TA-09 elevated-detection covers raise-daily-cap, raise-max-tx, expand-destinations/protocols. Phase 5 shipped `stable_balance_floor` (lower) + `per_recipient_daily_cap_usd` (raise) as queueable but NOT classified elevated. Compromised SDK can lower floor / raise per-recipient cap without cosign.
**Cross-confirmed by:** Pentester + code-reviewer + Architect.
**Fix:** Single line each:
```rust
let lowers_floor = stable_balance_floor.is_some_and(|new| new < policy.stable_balance_floor);
let raises_per_recip = per_recipient_daily_cap_usd.is_some_and(|new| new > policy.per_recipient_daily_cap_usd);
```
Add to `is_elevated` predicate. ~30 minutes.

### HIGH-3: TA-09 Cosign Has No SDK Client (`cosignHelper.ts` Absent)
**Severity:** HIGH — feature ships unexercisable.
**Files:** `sdk/kit/src/` — `cosignHelper.ts` does not exist
**Finding:** Per Ava + Remy: `grep cosignHelper sdk/kit/src/` returns nothing. Owner gets `ErrCosignRequired (6089)` with no SDK path to produce a valid cosign session. 7 LiteSVM tests fail with this error and were deferred to Phase 9.
**Fix:** Ship `sdk/kit/src/cosignHelper.ts` (~60 LOC per Remy estimate). Takes `(elevatedFields, ownerKeypair, sessionPda) → cosignSession`. 1 day.

### HIGH-4: destination_check::take(16) Silently Skips Foreign Destinations at Meta[17+]
**Severity:** HIGH — exploitable on Jupiter v6.
**Files:** `programs/sigil/src/utils/destination_check.rs:120`
**Finding:** Per Pentester. Jupiter v6 routes commonly have 22-25 metas. Current `.take(16)` silently skips metas 17+. Attacker crafts a protocol ix with unauthorized recipient ATA at meta[16+] → passes destination allowlist.
**Fix:** Replace `.take(16)` with `require!(ix_accounts.len() <= 16, IxMetaCountExceeded)`. Or scan all metas (bounded anyway by Solana 64-meta tx limit). ~1 hour.

### HIGH-5: TA-14 Per-Recipient Cap Bypassed by Omitting Recipient ATA
**Severity:** HIGH
**Files:** `programs/sigil/src/instructions/finalize_session.rs:524-527`
**Finding:** Per A3 silent-failure-hunter. TA-14 loop silently skips meta pubkeys not in `ctx.remaining_accounts`. Attacker omits the recipient ATA → `recipient_seen = None` → per-recipient cap NEVER enforced even when spend occurred.
**Fix:** Reject finalize with `ErrRecipientCapExceeded` when `actual_spend_tracked > 0`, cap enabled, no allowlisted recipient resolved. ~2 hours.

### HIGH-6: register_agent Swallows load_mut() Err Arm
**Severity:** HIGH
**Files:** `programs/sigil/src/instructions/register_agent.rs:91-104`
**Finding:** Per A3. `if let Ok(mut overlay) = ctx.accounts.agent_spend_overlay.load_mut()` swallows Err. Agent registered without overlay slot → per-agent spend limit permanently unenforceable for that agent. Comment claims "fail-closed" but only in Ok branch.
**Fix:** Replace `if let Ok(...)` with `let mut overlay = ctx.accounts.agent_spend_overlay.load_mut()?;`. ~10 minutes.

### HIGH-7: Rust 6047 #[msg] Disagrees with SDK 6047 Message
**Severity:** HIGH — 2am-page debugging trap.
**Files:** `programs/sigil/src/errors.rs:166` vs `sdk/kit/src/agent-errors.ts:765-787`
**Finding:** Per A3 + Engineer. Rust says "Per-protocol rolling 24h spending cap would be exceeded"; SDK says "Per-protocol counter slot allocation exhausted." Post-Phase-5 split was incomplete on Rust side. On-call engineer sees Rust message in logs and gets wrong story.
**Fix:** Flip Rust #[msg] to match SDK; accept the codama regen cascade (CRIT-1 forces it anyway).

### HIGH-8: Doc Drift in INTERFACES_V2.md + HARDENED §6 Phase 2
**Severity:** HIGH — readers build against ghost numbers.
**Files:**
- `INTERFACES_V2.md:82` says PROTECTED set is `{vault, tracker, session, policy}` (4 keys) — real is 16
- `INTERFACES_V2.md:112` says ErrAutoRevoked = 6088 — real is 6090
- `INTERFACES_V2.md:132` says ErrPolicyPreviewMismatch = 6081 — real is 6080
- `HARDENED_V2_PROMPT_MAP.md:569,583` Phase 2 body still has 6080/6081 reversed vs §4 table
**Fix:** Edit-only, no code change. ~30 minutes.

### HIGH-9: THREAT_MODEL_V2 AC-10 Drift
**Severity:** HIGH — threat model lags reality.
**Files:** `docs/revamp/THREAT_MODEL_V2.md:257-264, 652, 775`
**Finding:** Per Ava. THREAT_MODEL_V2 still says nonce "increments per seal" but HARDENED was patched 2026-05-18 to clarify AC-10 is forward-compat-only (active V2 defense is policy_version). Also still references "external audit (Stage 6)" and "audit firm engagement" that were deleted per L-2.
**Fix:** Sync THREAT_MODEL_V2 to HARDENED. Add PEN-CROSS-1 to §2 attacker-class coverage as open critical.

### HIGH-10: finalize_session.rs AC-10 Nonce Dead-Code With Misleading 26-Line Comment
**Severity:** HIGH — misleads future readers.
**Files:** `programs/sigil/src/instructions/finalize_session.rs:925-958`
**Finding:** Per code-reviewer A2. Verified: `session.nonce = session.nonce.checked_add(1)?` at line 954-957. Session uses `init` (not `init_if_needed`), account closes at finalize, write doesn't persist. 26-line comment block buries the dead-code fact.
**Fix:** Either gate behind `#[cfg(...)]` feature flag for Phase 8 use, OR add a one-line clarifier saying "this write is dead-on-close; lives here for Phase 8 reuse."

### HIGH-11: InstructionConstraints Entries Carry No Digest Binding
**Severity:** HIGH (orchestrator note: per Pentester, but partial — has_constraints bool IS in TA-19; only the entries themselves are unbound)
**Files:** `queue_constraints_update.rs` + `apply_constraints_update.rs`
**Finding:** Owner blind-signs `queue_constraints_update` with attacker-supplied entries widening cursor allowlists; timelock then auto-applies. Only the `has_constraints: bool` flag at TA-19 position 12 is digest-bound.
**Fix:** Add canonical-digest-of-entries arg to queue + apply, mirroring TA-19 pattern. ~3-4 hours.

---

## §5. MEDIUM/LOW — Catalog for Phase 11 Final Docs

(Abbreviated — full list in agent transcripts under `docs/revamp/AUDIT_2026_05_18/`)

- Type design improvements (Phase 11 candidate): PolicyConfig split into Core+Meta; PerRecipientCounter add impl methods; ProtocolCapEntry as struct not parallel vec; Graylist newtype
- Test coverage gaps: TA-05/06/07/08/14/17 all fixture-only; recordAgentViolation has zero callers in tests
- `record_agent_violation` lacks rate limit (potential DoS on legitimate agent via owner-key compromise)
- 5 sites with stale "CU exhaustion 6047" comments (real: 6068 SysvarScanBoundExceeded)
- 3 timelock test rewrites for elevated-detection (acknowledged by Phase 5 engineer; deferred)
- Schema math docs in 3 places (HARDENED §5, INTERFACES, repo CLAUDE.md) — codegen will collapse this

---

## §6. Conceptual Insights from Part B (5+ characters converge)

### Insight 1: T-21 (Owner Policy Underspecification) is the Load-Bearing Weakness
**Converged by:** Remy, Johannes, Decomposer, Designer, Skeptic (5/10)
- The system has 19 canonical TA-19 fields, 24-bit operating_hours bitmask, graylist friction, per-protocol caps as parallel array. Owner cannot read this.
- Engine shipped before steering wheel. Maestro succeeded by being opinionated; Sigil must too.
- **Designer's prescription:** Single screen `/vaults/[id]/policy/draft` — left column renders policy as 5 English sentences, right shows proposed diff with TA-09 elevated-cosign warnings inline + TA-19 digest abbreviation. **Ship before any Phase 6-11 work.**

### Insight 2: §RP Transcripts are the Audit Substitute, Undermarketed
**Converged by:** Johannes, Architect, Engineer, Ava, Market Analyst (5/10)
- Phase 1 §RP caught 75 silently-broken tests. Phase 2 caught a CRITICAL. Round 1 of this audit caught CRIT-1.
- "Maestro can ship guardrails fast; they cannot retroactively manufacture 18 months of adversarial-review evidence" — Architect
- **Market Analyst risk:** TA-19 content-OCC primitive is uncited externally. Phantom/Backpack/Maestro could publish first and capture inventor status. **Publish the TA-19 primer + §RP transcripts publicly BEFORE Phase 6 starts.**

### Insight 3: Codegen TA-19 from Schema DSL = Highest-Leverage Single Intervention
**Converged by:** Remy, Architect, Engineer, Decomposer (4/10)
- Current state: 4 hand-mirrored encoders (Rust, SDK TS, LiteSVM helper TS, inline test TS). Each new field = 15 atomic touch points + 6-8h + drift risk.
- Architect correction: Schema DSL authoritative, **Rust + TS + Kotlin + Swift derived from one source**. Future-proofs mobile native (Kotlin/Swift per Sigil mobile plan memory).
- Decomposer: Improves Axis E (Cross-Impl Discipline) +2 grades, Axis C (Code Quality) +1, Axis F (Operability) +1.
- 1-week deliverable. **Phase 11 anchor, but spec it in Phase 6.**

### Insight 4: Bus Factor 1 is Structural (Not Technical) Risk
**Converged by:** Architect, Johannes, Skeptic, Remy, Decomposer (5/10)
- Phase 2 already passed the "one head" gate per Architect's diagnosis.
- HARDENED_V2_PROMPT_MAP.md exists *because* the model no longer fits in working memory.
- 11 HIGH findings landed in this audit against one founder.
- **Architect's prescription:** Squads multisig on program upgrade authority + 2 external keyholders. **Zero dollars cost. Phase 6 prerequisite.**

### Insight 5: Maestro is the Reference Implementation; Sigil is the Same Primitive for AI Agents
**Converged by:** Market Analyst (explicit) + Johannes (implicit)
- Sigil 2x2 position: upper-left (generic + owner-controlled)
- Beachhead: Flash Trade agent-traders (Kaleb's distribution)
- Pitch (Market Analyst): "Maestro's $24B-volume guardrail playbook, retargeted from Telegram-bot users to AI agents, enforced on-chain so policy outlives the runtime that holds the keys."
- Threat (medium-high probability in 12-18mo): Maestro ships "Agent Mode" SDK with same primitives, distribution-backed. Sigil loses on every axis except technical owner-control purity.
- CRIT-1 collapses that window to 6-9mo if unfixed.

---

## §7. Market Positioning — Does the Wedge Hold?

**Yes, but conditionally.** The wedge ("on-chain policy that survives the agent and the runtime") is defensible against:
- Privy / Crossmint / Turnkey (custody, not policy)
- Squads V4 (multisig, not agent-native)
- AgentLayer (off-chain Python, restart-zeros — Sigil correctly avoided 6 anti-patterns per MEMORY)
- IKA (Layer 1 signing, complementary not competing)

The wedge is THREATENED by:
- Maestro shipping "Agent Mode" SDK in 12-18 months (Market Analyst's primary concern)
- Phantom/Backpack publishing a content-OCC primitive first and capturing inventor narrative (Market Analyst)

**Three moats to actively build:**
1. **Persisted §RP transcripts** — undermarketed durable artifact. Convert PHASE_N_REVIEW dirs into public-facing case studies.
2. **TA-19 content-OCC primer** — publish externally. Academic frame (KeyKOS/EROS + Kung-Robinson OCC) gives intellectual provenance.
3. **Integration play** — be the policy primitive Maestro routes through. Stop competing on UX (lose ground). Compete on enforceability.

---

## §8. Five Named Phase 6 Gates (Must Close Before Dispatch)

| # | Gate | File(s) | Effort | Blocks |
|---|---|---|---|---|
| G1 | Run `pnpm --filter @usesigil/kit run codama`; wire 4-6 caller sites | sdk/kit | 1-2 days | CRIT-1 |
| G2 | Add TA-19 digest binding to register_agent | register_agent.rs | 2-3 hours | HIGH-1 (PEN-CROSS-1) |
| G3 | Wire TA-12 floor-lower + TA-14 cap-raise into TA-09 elevated | queue_policy_update.rs | 30 min | HIGH-2 |
| G4 | Ship cosignHelper.ts in SDK + close 7 deferred tests | sdk/kit | 1 day | HIGH-3 |
| G5 | Sync doc drift: INTERFACES_V2, HARDENED §6 P2, THREAT_MODEL_V2 AC-10/PEN-CROSS-1 | docs/revamp | 1-2 hours | HIGH-8 + HIGH-9 |

**Additional unblocking prerequisite (zero $, structural):**
- G0: Squads multisig on program upgrade authority + 2 external keyholders

**Total clear time: 5-7 working days for solo founder.**

---

## §9. Phase 11 Candidates (Defer, Don't Forget)

- Codegen TA-19 from schema DSL (1 week deliverable)
- Designer's Policy Draft Preview screen (UX gate before mainnet)
- USDC/USDT stablecoin-registry seam (Johannes' 24-month rot prediction)
- Publish TA-19 content-OCC primer externally
- TA-17 redesign consideration (Architect's REMOVE proposal vs current owner-mediated)

---

## §10. Final Action

**Verdict: FIX-FIRST.**

Phase 6 dispatch **BLOCKED** until G1-G5 close. Estimated 5-7 days for solo founder. After G1-G5 closure, dispatch Phase 6 (Maestro borrows R-1/R-2/R-3) with confidence.

**Skeptic flip threshold check (would flip from PIVOT to CLEAR-with-conditions if):**
- ✅ A3 closes within 72h via codegen (G1 — possible Tuesday)
- ⚠️ All 11 HIGH findings close before Phase 6 commit (G1-G5 closes 7 HIGHs; 4 remain medium-effort)
- ⚠️ Scope freezes at Phase 5 ix-count until 30d post-T1-mainnet (recommend adopt as Phase 6 dispatch condition)
- ❌ External audit firm signed engagement before Phase 6 (NOT MET — L-2 budget constraint)

Skeptic's flip mostly achievable except external-audit-firm — which the L-2 budget constraint explicitly forbids. The §RP transcript pipeline is the credible substitute (per Johannes/Architect/Market Analyst convergence).

---

## Audit Artifacts

- `docs/revamp/AUDIT_2026_05_18/ROUND_1_SYNTHESIS.md` — 10-character Round 1 synthesis
- `docs/revamp/AUDIT_2026_05_18/PART_C_ORCHESTRATOR_REPORT.md` — this file
- Full subagent transcripts in `/private/tmp/claude-501/-Users-kalebrupe-Downloads-Middleware-Agent-Layer/.../tasks/` (ephemeral)

**Dispatched agents:** 30 invocations across Part A (10 technical tracks) + Part B (10 characters × 2 rounds). Independent verification by orchestrator at each step. Wild-goose-chase check identified 2 misframes + 1 false positive; remaining findings stand.

**Author:** Orchestrator (Claude Opus 4.7), 2026-05-18
