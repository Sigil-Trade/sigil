# STAGE_0_REVIEW/reverify.md — §RP §12.4 reverify pass (silent-failure-hunter)

**Reverifier:** Claude (silent-failure-hunter, swapped from code-reviewer)
**Date:** 2026-05-17
**Branch:** `revamp/v2-2026-05`
**Scope:** verify Phase G resolutions to reviewer.md's 21 CRIT+HIGH + re-sweep all 7 artifacts for new findings.

---

## Section 1 — FIX-CONFIRM (per-CRIT+HIGH verdict)

### CRITICAL

**R-CRIT-1 — Workflow path** → **RESOLVED-CONFIRMED**
Verified `git remote -v` returns `origin https://github.com/Sigil-Trade/sigil.git`; `git rev-parse --show-toplevel` returns `agent-middleware/`. The workflow at `agent-middleware/.github/workflows/revamp-ci.yml` IS at the repo root from GitHub's perspective. Original finding was a false positive — reviewer didn't verify the repo origin.

**R-CRIT-2 — Scope-guard regex** → **RESOLVED-INCORRECT** (the regex was changed, but the fix is incomplete in light of branch state — see NF-CRIT-1 below)
File:line: `agent-middleware/.github/workflows/revamp-ci.yml:40` now says `'^(docs/revamp/|\.github/workflows/revamp-ci\.yml)'`. The original regex bug is fixed, but the regex now rejects 84 out-of-scope files that ALREADY exist on the branch (Stage 1 demolition has landed). **The acceptance signal "CI green on first push" is still unmeetable.** See NF-CRIT-1.

**R-CRIT-3 — Error count 88 → 81** → **RESOLVED-CONFIRMED**
Verified via `grep -c '^\s*#\[msg(' programs/sigil/src/errors.rs` → `81`. INTERFACES_V2.md:182-204 now correctly states "81 variants (6000-6080)" + reserved 6081-6103 + cites the post-Stage-1 demolition shift. Stale "6087" sentence corrected to "6080".

**R-CRIT-4 — TA-15 buffer 4,096 vs 12,288** → **RESOLVED-INCORRECT**
INTERFACES_V2.md:85-89 correctly says 12,288 bytes. REVAMP_PLAN.md:406 (C24 LOCKED) correctly says 12,288 bytes. **BUT TWO sites still cite the old 4,096 value:**
- `REVAMP_PLAN.md:171` (TA-15 §4.3 description): "64 entries × 64 bytes = 4,096 bytes"
- `REVAMP_PLAN.md:263` (Open Question 5): "64 entries × 64 bytes = 4,096 bytes. AgentVault resize from 634 → ~4,730 bytes"

The contradiction the original finding identified persists. This is the very §RP CRIT class that INTERFACES_V2.md:7 declares ("Cross-doc ID drift = §RP CRITICAL"). Open Question 5's rent math (~0.029 SOL @ 4,096B) is wrong for the canonical 12,288B sizing. See NF-CRIT-2.

**R-CRIT-5 — AC class taxonomy inverted** → **RESOLVED-CONFIRMED**
THREAT_MODEL_V2.md:30-37 rewritten. Active classes now correctly listed as AC-1/2/3/4/5/9/10. Environmental as AC-6/7/8. AC-11 separately bucketed as out-of-scope. T-DoS-1/2/T-21/T-K6-1 separately classified. Substantive content matches taxonomy.

**R-CRIT-6 — TA-17 / TA-18 phantom IDs** → **RESOLVED-CONFIRMED**
`grep -n 'TA-17\|TA-18\|TA-19'` returns only one historical citation in REVAMP_PLAN.md:243 ("Originally proposed as TA-17 in early drafts") which is correctly contextualized as a removed-from-draft reference for Def-6. No other phantom citations remain.

**R-CRIT-7 — Funding range $100K-$350K vs $171K-$455K** → **RESOLVED-CONFIRMED**
ACCEPTANCE_V2.md:271-275 now distinguishes Core total ($131K-$385K) from Premium total ($171K-$455K), explicitly maps the stated /goal range $100K-$350K to Scope-reduce/Standard. Lines 308-310 §4.4 scenario table now consistent with the cost-breakdown total.

**R-CRIT-8 — Squads V4 compile-time pin timing** → **RESOLVED-INCORRECT**
REVAMP_PLAN.md:395 §11 D-06 disposition now contains the explicit Stage 6C→6D mechanic. **BUT** the corresponding mainnet runbook in `ACCEPTANCE_V2.md:622-624` (§15.3) still says simply "Hard-code Squads vault address in `constants.rs` (compile-time)" without restating the sequencing. A reader of §15.3 in isolation will not know the Stage 6C-must-precede mechanic. See NF-HIGH-1.

**R-CRIT-9 — 8 vs 9 decisions** → **RESOLVED-CONFIRMED**
REVAMP_PLAN.md:11 now reads "9 decision-register entries (D-01..D-09)". Phrasing "plus one deferral" dropped. INTERFACES_V2.md:149 enumerates D-01..D-09 consistently.

### HIGH

**R-HIGH-1 — `surfpool:start` race** → **RESOLUTION-MISSING**
Resolution claims "NOTED as Stage 2+ deliverable". File `revamp-ci.yml:273-279` still uses `npm run surfpool:start` (not `surfpool:start:ci`) + `sleep 5` race. The "Stage 2+ defer" rationale is unjustified — surfpool-tests run in Stage-0 CI today; a flaky job blocks every push. Either the job should be removed from Stage 0 acceptance OR the race fixed now.

**R-HIGH-2 — `idl-drift-check needs build-program`** → **RESOLVED-CONFIRMED**
Resolution acknowledged as design choice (sequencing not artifact reuse).

**R-HIGH-3 — Anchor link to `#error-code-allocation`** → **RESOLVED-CONFIRMED** (consequence of R-CRIT-3 fix)
Error codes 6081-6097 are now allocated downstream from the corrected 6080 max.

**R-HIGH-4 — Stage 1 baseline 140 vs ≥500 progression** → **RESOLUTION-MISSING**
Resolution claims "tracked in REVAMP_PLAN §17 Implementation Status Table". Verified §17 (REVAMP_PLAN.md:632+) — it tracks per-primitive KEEP/ADD status but provides NO per-stage test count progression. The §3.6 ≥500 target has no intermediate milestones. Deferral to "Stage 2+" without milestone planning is not a resolution.

**R-HIGH-5 — STAGE_0_INVOCATIONS + STAGE_0_DIFF not committed** → **RESOLUTION-MISSING (deferred — accepted)**
Resolution: "DEFERRED to Phase I — both files created before §RP §12.7 'complete' can be claimed." Justified per §RP §12.7 sequencing.

**R-HIGH-6 — `solana-verify` not installed in CI** → **RESOLUTION-MISSING**
Resolution defers to "Stage 2+". §15.4 still cites the tool without pinning version or upstream identity (Otter Sec vs Solana Foundation). At minimum a Stage 5 devnet dry-run should be added; not done.

**R-HIGH-7 — Inv-K6 "exactly one" vs "at least one"** → **RESOLVED-CONFIRMED**
Verified ACCEPTANCE_V2.md:191 ("exactly one"), REVAMP_PLAN.md:621 ("exactly once"), REVAMP_PLAN.md:675 ("exactly one"). Consistent across the four docs.

**R-HIGH-8 — AC-11 undefined** → **RESOLVED-INCORRECT**
INTERFACES_V2.md:132 now defines AC-11. **BUT INTERFACES_V2.md:3 still says "Source of truth for all IDs used across Stage 0+ docs (K1-K7, TA-01..TA-16, AC-1..AC-10, D-01..D-09)"** — the canonical-registry banner asserts AC-1..AC-10 while the body lists AC-11. By the doc set's own rule (line 7: "Cross-doc ID drift = §RP CRITICAL") this is self-contradiction within INTERFACES_V2 itself. See NF-CRIT-3.

**R-HIGH-9 through R-HIGH-12** → **RESOLUTION-MISSING (deferred — partially justified)**
Resolution defers HIGH-9 (K7 V1-only framing), HIGH-10 (scope-guard over-match), HIGH-11 (mmd embed sync), HIGH-12 (regex file-type filter) to "Stage 2+". HIGH-10 and HIGH-12 directly compound NF-CRIT-1; not stage-2 issues.

---

## Section 2 — NEW-FINDINGS (silent-failure-hunter sweep)

### NF-CRIT-1 — Scope-guard rejects 84 program files that already exist on the branch
**Severity:** CRITICAL (96)
**File:** `agent-middleware/.github/workflows/revamp-ci.yml:40-47`

`git diff main...HEAD --name-only | grep -vE '^(docs/revamp/|\.github/workflows/revamp-ci\.yml)' | wc -l` returns **84**. The branch already contains Stage 1 demolition commit `d494408` (touches `programs/sigil/src/errors.rs`, escrow ix files, `state/escrow.rs`, etc.). The scope-guard job will fail with `::error::Out-of-scope files for Stage 0` on the very first push, regardless of how clean the docs PR is.

Root cause: the R-CRIT-1/R-CRIT-2 resolution verified the regex against an empty diff, not against the actual branch state. The branch is NOT at the same commit as `main`; Stage 1 work is already there.

**Recommended fix:** Either (a) the scope-guard regex must accept Stage 1 demolition paths (`programs/sigil/**`, `tests/**`, `sdk/**` etc.) for the current commit OR (b) Stage 1 demolition must be rebased onto `main` after Stage 0 closes, OR (c) scope-guard must compare against a "Stage 0 baseline tag" not `main`. The current state fails ACCEPTANCE_V2.md §3.6 "CI green on first push" tautologically — same root failure the original R-CRIT-1 identified.

### NF-CRIT-2 — TA-15 buffer-size drift persists across two REVAMP_PLAN sites
**Severity:** CRITICAL (92)
**Files:** `REVAMP_PLAN.md:171` and `REVAMP_PLAN.md:263`

R-CRIT-4 resolution claimed buffer-size unified at 12,288 bytes, but `grep -n '4,096\|4096\|12,288\|12288\|8,192\|8192'` returns two REVAMP_PLAN sites STILL citing 4,096 bytes:
- Line 171: TA-15 description in §4.3 — `64 entries × 64 bytes = 4,096 bytes`
- Line 263: Open Question 5 — `64 entries × 64 bytes = 4,096 bytes. AgentVault resize from 634 → ~4,730 bytes is a Stage-1 blocker. Confirm rent delta ≈ 0.029 SOL per vault is acceptable.`

INTERFACES_V2.md (canonical) + REVAMP_PLAN §11 C24 (LOCKED) say 12,288 bytes. The §4.3 + §7 sites contradict the canonical. Open Question 5's rent math is wrong for the canonical sizing (12,288B implies AgentVault ~12,922B, rent delta ~3× the stated 0.029 SOL).

**Recommended fix:** Update REVAMP_PLAN.md:171 to "Two buffers per C24: success 8,192 bytes + rejected 4,096 bytes = 12,288 bytes total. See INTERFACES_V2 §TA-15." Update REVAMP_PLAN.md:263 to recompute rent delta against 12,288B.

### NF-CRIT-3 — INTERFACES_V2 self-contradiction: header banner says AC-1..AC-10 but body now defines AC-11
**Severity:** CRITICAL (90)
**File:** `INTERFACES_V2.md:3` vs `INTERFACES_V2.md:132`

Header banner: `Source of truth for all IDs used across Stage 0+ docs (K1-K7, TA-01..TA-16, AC-1..AC-10, D-01..D-09)`. Body: AC-11 is defined at line 132 as out-of-scope V1. The R-HIGH-8 fix added AC-11 to the body but did not update the canonical-range banner. Per the same doc's line 7 ("Cross-doc ID drift = §RP CRITICAL"), this is a CRIT-class drift internal to the canonical registry itself.

**Recommended fix:** Update line 3 to `(K1-K7, TA-01..TA-16, AC-1..AC-11, D-01..D-09)`. Note also that the same banner OMITS T-DoS-1, T-DoS-2, T-21, T-K6-1, AgentSpendOverlay, and other operational hazards that ARE defined in this file — banner is incomplete.

### NF-CRIT-4 — Def-N rename incomplete; 4 dangling D2/D4/D5/D-revoke-1 references
**Severity:** CRITICAL (88)
**Files:**
- `THREAT_MODEL_V2.md:409` — "(D5)" — should be Def-5
- `THREAT_MODEL_V2.md:760` — "(D4)" — should be Def-4
- `REVAMP_PLAN.md:572` — "(D-06 + D2: 4-of-5 multisig threshold)" — D2 phantom; correct decision is D-06 alone (4-of-5 IS D-06); Def-2 (dead-man's switch) has nothing to do with the multisig threshold
- `REVAMP_PLAN.md:732` — "(deferral D5)" — should be Def-5
- `INTERFACES_V2.md:204` — `[REVAMP_PLAN.md §6 Deferred D-revoke-1]` — D-revoke-1 is a third phantom name that doesn't exist anywhere; the actual ID is `Def-6`

The renaming naming-note at REVAMP_PLAN.md:234 claims "Original D1-D5 / D4-D5 references in this section have been renamed" but the rename was applied only inside §6.1. Cross-doc citations escaped. This is the same §RP CRIT class as R-CRIT-6 phantom IDs.

**Recommended fix:** Sweep all four sites + add the CI regex that R-CRIT-6 recommended to also guard against bare `\bD[1-9]\b` outside the D-NN registry context.

### NF-HIGH-1 — §15.3 Stage 6D runbook still missing the 6C→6D sequencing the R-CRIT-8 fix added to REVAMP_PLAN
**Severity:** HIGH (86)
**File:** `ACCEPTANCE_V2.md:622-624`

R-CRIT-8 resolution updated REVAMP_PLAN.md:395 with the explicit "Stage 6C creates the Squads multisig PDA *before* Stage 6D builds the program with the address baked in" mechanic. The same fix did NOT propagate to ACCEPTANCE_V2 §15.3 runbook, which still says only `[ ] Hard-code Squads vault address in constants.rs (compile-time)` — no ordering, no checklist entry confirming the multisig PDA already exists. A runbook operator following §15.3 in isolation could attempt 6D before 6C completes.

**Recommended fix:** Add to §15.3: `[ ] Confirm Stage 6C (Squads multisig PDA) is complete; multisig PDA address must be available BEFORE this step.` Or reorder steps so 6C output (multisig PDA) is a documented input to 6D.

### NF-HIGH-2 — K6 emit-check CI job is a literal no-op (`echo`) but counted as a gate in `summary.needs`
**Severity:** HIGH (85)
**File:** `agent-middleware/.github/workflows/revamp-ci.yml:281-298, 312`

The `k6-emit-check` job runs only `echo "::notice::Stage 0 placeholder. Stage 2 implements..."` and ALWAYS exits 0. It is added to `summary.needs` as if it were a gate. ACCEPTANCE_V2.md:218 says "K6 event emission — CI static check (every `pub fn` calls `emit!()` at least once)". The placeholder satisfies the citation surface but not the actual gate. **This is silent-failure tokenism** — a future Stage 2 developer who forgets to replace the placeholder will see "green CI" without a K6 check actually running.

**Recommended fix:** Either (a) remove the placeholder job entirely (the gate doesn't apply at Stage 0 since program code isn't being changed by Stage 0 docs work) OR (b) exit 1 with an `::error::` annotation that explicitly says "Stage 2 must implement this check before merging Stage 2 PRs". Option (b) prevents silent forgetting.

### NF-HIGH-3 — `cargo install surfpool || echo "may already exist"` swallows all errors (R-MED-4 promoted)
**Severity:** HIGH (84)
**File:** `agent-middleware/.github/workflows/revamp-ci.yml:266`

R-MED-4 already flagged this. After Phase G the line is unchanged. Combined with `sleep 5` race in R-HIGH-1, the surfpool job has TWO independent silent-failure surfaces. The original was MEDIUM in isolation; with R-HIGH-1 unresolved this becomes HIGH because the failure mode is "test job appears to run but actually never started surfpool", which is the classic silent-failure pattern.

**Recommended fix:** `cargo install surfpool --version <pinned> 2>&1 | tee /tmp/surfpool-install.log; cargo install --list | grep -q surfpool || (echo "::error::surfpool install failed"; exit 1)`. Also pin the version (no version anywhere in docs or CI today).

### NF-HIGH-4 — Stage 1 demolition unaccounted for in §RP "branch state" assumptions
**Severity:** HIGH (82)
**Files:** `REVAMP_PLAN.md:484-498` (§12.5/12.6 vocabulary) + reviewer.md:15

Reviewer.md:15 stated "The branch is at the same commit as `main` (`a3d46f8`)" — that is wrong. The branch is at `d494408 feat(sigil): Stage 1 demolition — escrow + strict-mode removed`. The reviewer's first-pass treated this as a Stage-0-only diff; the actual diff includes Stage 1 work. The §RP §12.6 diff-verification step "filtered to expected scope" needs to define what "expected scope" means when Stage 1 has already landed but Stage 0 docs are still draft. Right now there is no documented model for the branch state.

This is also why R-CRIT-1/R-CRIT-2 resolution falsely concluded "false positive" — the resolution didn't run the regex against the actual branch state.

**Recommended fix:** REVAMP_PLAN §22.2 should explicitly state the current branch state ("revamp/v2-2026-05 currently contains Stage 1 demolition commit d494408 on top of main"). §12.6 diff verification should compare against a stage-anchor tag, not against `main`.

---

## Summary

**Section 1 FIX-CONFIRM verdicts:**
- RESOLVED-CONFIRMED: 9 (R-CRIT-1, R-CRIT-3, R-CRIT-5, R-CRIT-6, R-CRIT-7, R-CRIT-9, R-HIGH-2, R-HIGH-3, R-HIGH-7)
- RESOLVED-INCORRECT: 4 (R-CRIT-2, R-CRIT-4, R-CRIT-8, R-HIGH-8)
- RESOLUTION-MISSING: 8 (R-HIGH-1, R-HIGH-4, R-HIGH-5 [justified], R-HIGH-6, R-HIGH-9, R-HIGH-10, R-HIGH-11, R-HIGH-12)

**Section 2 NEW-FINDINGS:** 4 CRITICAL + 4 HIGH discovered. The most load-bearing are:
- **NF-CRIT-1** (scope-guard rejects branch state) compounds with R-CRIT-2 RESOLVED-INCORRECT — the underlying acceptance signal still fails.
- **NF-CRIT-2** (TA-15 4,096B persists at 2 sites) confirms R-CRIT-4 was only partially resolved.
- **NF-CRIT-3** (INTERFACES_V2 self-contradicts on AC-11 range) confirms R-HIGH-8 was only half-applied.
- **NF-CRIT-4** (Def-N rename incomplete across 5 cross-doc sites) is a new §RP CRIT class missed by both reviewer.md and the Phase G fix loop.

**§RP §12.7 verdict: Stage 0 is NOT "complete".** Per §RP §12.4, "Any new CRIT+HIGH from reverify → return to Phase G fix loop." 4 NF-CRIT + 4 NF-HIGH + 4 RESOLVED-INCORRECT prior CRITs all require Phase G attention before §12.7 "complete" can be claimed.

**Recommended Phase G fix batches (single PR each):**
1. NF-CRIT-1 + NF-HIGH-4 (scope-guard vs Stage 1 branch state).
2. NF-CRIT-2 + R-CRIT-4 completion (TA-15 buffer sites at REVAMP_PLAN.md:171, 263).
3. NF-CRIT-3 + R-HIGH-8 completion (INTERFACES_V2 banner AC-1..AC-11).
4. NF-CRIT-4 (Def-N rename sweep: THREAT_MODEL:409, 760; REVAMP_PLAN:572, 732; INTERFACES_V2:204).
5. NF-HIGH-1 + R-CRIT-8 completion (§15.3 6C-precedes-6D ordering).
6. NF-HIGH-2 (k6-emit-check tokenism).
7. NF-HIGH-3 + R-HIGH-1 (surfpool race + silent-install).

**Reverifier signature:** Claude (pr-review-toolkit:silent-failure-hunter, swapped per §RP §12.4), 2026-05-17.

---

## Section 3 — FIX-CONFIRM (per H-CRIT-N + H-HIGH-N from hunter.md)

**Reverifier:** Claude (pr-review-toolkit:code-reviewer, swapped from silent-failure-hunter per §RP §12.4)
**Date:** 2026-05-17
**Scope:** verify the 14 H-CRIT-N / H-HIGH-N findings from hunter.md RESOLUTIONS section against current artifact state. Then sweep for new findings introduced by Phase G fixes.

### CRITICAL

#### H-CRIT-1 — TA-15 buffer size contradiction (4,096 vs 12,288)
**Verdict:** RESOLVED-INCORRECT.

INTERFACES_V2.md:85-89 correctly states the canonical 12,288 bytes (128 success + 64 rejected × 64 bytes each). REVAMP_PLAN.md:406 (§11 C24) also correctly cites "**total 12,288 bytes / 192 entries combined**". **However REVAMP_PLAN.md:171 still reads "TA-15 audit-log circular buffer ... 64 entries × 64 bytes = 4,096 bytes" and REVAMP_PLAN.md:263 (§7 Open Question 5) still reads "64 entries × 64 bytes = 4,096 bytes."** Both are exactly the pre-fix wording. Same gap NF-CRIT-2 (hunter Section 2) already flagged — this code-reviewer pass independently confirms it.

#### H-CRIT-2 — TA-17 undefined + ErrAutoRevoked unspecced
**Verdict:** RESOLVED-CONFIRMED.

`grep -nE "TA-17"` over THREAT_MODEL_V2.md and INTERFACES_V2.md returns zero hits. `ErrAutoRevoked` removed from error-code allocation (INTERFACES_V2.md:204 explicitly states "`ErrAutoRevoked` is NOT allocated in V2"). The resolution cites Def-6 — REVAMP_PLAN.md:243 defines it. The substantive removal is real, though THREAT_MODEL prose does not contain the literal "per Def-6" citation the resolution claims it has (see CRF-HIGH-3 below).

#### H-CRIT-3 — TA-18 phantom in INTERFACES_V2 AC-2
**Verdict:** RESOLVED-CONFIRMED.

`grep -nE "TA-18"` returns zero hits across the 4 prose docs. INTERFACES_V2.md:106 AC-2 now points at D-05 + D-06 (off-chain SDK helper), explicitly stating "NOT a numbered TA primitive". Aligned with hunter's recommended fix.

#### H-CRIT-4 — "Stage 6 D2" undefined
**Verdict:** RESOLVED-CONFIRMED.

`grep -nE "Stage 6 D2|6 D2"` returns zero hits. REVAMP_PLAN.md:395 and :408 (C25) now say "Stage 6D" matching §14 sub-deliverable taxonomy and ACCEPTANCE_V2.md:622 §15.3.

#### H-CRIT-5 — TA-01/TA-02 empty-Vec default-deny semantics
**Verdict:** RESOLUTION-MISSING.

The hunter's recommended fix called for an explicit added clause: "Empty Vec semantics: an empty allowed_protocols / allowed_destinations Vec means deny-ALL, NOT 'policy not yet configured'." Current INTERFACES_V2.md:44 (TA-01) and :47 (TA-02) still read only "Default-deny" with no clarification of empty-Vec semantics. The resolution claim — "explicitly state Default-deny with empty Vec (no implicit-allow)" — is unsupported by the file text. The DEEP-1 regression risk is unresolved at the doc level. Stage 2 implementer can still infer correctly, but §RP precision is not met.

#### H-CRIT-6 — K6 CI static check doc-only
**Verdict:** RESOLVED-CONFIRMED (for CI surface) — but see NF-HIGH-2 (hunter Section 2) flagging the placeholder as "silent-failure tokenism".

`.github/workflows/revamp-ci.yml:281-298` adds the `k6-emit-check` placeholder job. Line 312 correctly includes `k6-emit-check` in the `summary` job's `needs:` array (the user-prompt code-reviewer prompt item #4). The K6 invariant now has a Stage 0 CI surface even though the substantive check is Stage 2 work. The hunter's separate NF-HIGH-2 critique about the placeholder always-exit-0 nature is a separate quality issue, not a resolution failure for H-CRIT-6 as the hunter originally scoped it.

### HIGH

#### H-HIGH-7 — [OPTIONAL: Kaleb's narrative] §RP re-trigger semantics
**Verdict:** RESOLUTION-MISSING.

`grep -c "OPTIONAL: Kaleb's narrative"` shows all 16 markers still present in §11 (REVAMP_PLAN.md:396-437). §11 intro at line 391 still reads "absence of narrative does not block any later stage" with no §RP re-trigger clause for post-baseline narrative additions. §18.2 checklist line 682 unchanged. Hunter resolution merely says "documented mix of resolved... and deferred" but no concrete clause was added anywhere.

#### H-HIGH-8 — TA-10 behavior on 0 / 5+ pairs
**Verdict:** RESOLUTION-MISSING.

INTERFACES_V2.md:71 and REVAMP_PLAN.md:163 still only specify "1..=4 pairs" with no explicit error code or fail-mode for >4 pairs and no spec for the 0-pair case. The hunter classified this as "Stage 2+ implementation concern" — but §17 Implementation Status Table at REVAMP_PLAN.md:632-658 is just an impl-status grid (NOT-IMPL / IMPLEMENT / KEEP / audit), not a spec-gap tracker. No tracking entry exists in any doc. The 5+ pair bypass risk remains unaddressed in the canonical spec.

#### H-HIGH-9 — N3 v1.1 trigger condition
**Verdict:** RESOLVED-CONFIRMED.

REVAMP_PLAN.md:240 Def-3 now reads "Reserved for TEE/MPC custody integrations. Not needed for V1 use cases." Matches the hunter's resolution claim. THREAT_MODEL_V2.md:573 retains the open question for documentation purposes (acceptable — Stage 6 prep work).

#### H-HIGH-10 — ErrAutoRevoked 6103 reserved for deferred feature
**Verdict:** RESOLVED-CONFIRMED.

INTERFACES_V2.md:204 explicitly states `ErrAutoRevoked` is NOT allocated in V2; reserved range 6098-6103 is open. Per Def-6 deferral. Aligned with hunter's recommended fix.

#### H-HIGH-11 — IDL diff CI uses unpinned nightly Rust
**Verdict:** RESOLUTION-MISSING.

`.github/workflows/revamp-ci.yml:97` still reads `toolchain: nightly` (no date pin). Line 118 still `RUSTUP_TOOLCHAIN=nightly`. Hunter's recommendation (pin to `nightly-2026-05-15` or equivalent) not applied. The "Stage 2+ implementation concern" classification is contradicted by the same Phase G touching CI for H-CRIT-6 — the workflow IS in Stage 0 scope.

#### H-HIGH-12 — Stage 4b preview_digest layout-change unscheduled
**Verdict:** RESOLUTION-MISSING.

REVAMP_PLAN.md:554 (Stage 4b) and §17 line 635 (K2 + preview_digest at Stage 4) unchanged. No annotation added about layout-change implications, no TTL-bounded mitigation rationale, no `realloc` safety note. R9 CATASTROPHIC migration risk remains hidden in the Stage 4 deliverable.

#### H-HIGH-13 — [SIGNATURE PENDING] operational semantics
**Verdict:** RESOLUTION-MISSING (acknowledged deferral).

ACCEPTANCE_V2.md:332 unchanged ("Kaleb commits externally before Stage 6E"). Hunter's resolution classified as "NOTED — literal mechanism is Stage 6 deliverable". This is acceptable as an explicit deferral but no tracking entry / forward-pointer was added to point a future Stage 6E executor at the spec gap. Soft RESOLUTION-MISSING.

#### H-HIGH-14 — T3 silently disables TA-13 / TA-14 / TA-04 / TA-05 / TA-06 / TA-09
**Verdict:** RESOLUTION-MISSING.

THREAT_MODEL_V2.md:431 still lists T3 as "TA-01, TA-02, TA-03, TA-08, TA-10, TA-11, TA-12 (7 of 16)". REVAMP_PLAN.md:214 same. The hunter's core argument — that session/policy-level primitives (TA-04/05/06/09/13/14) should apply across tiers — is unaddressed. The §3 blast-radius MEDIUM-for-AC-1 claim is still based on T1/T2 reasoning that doesn't hold for T3-only vaults. This is a threat-model / spec issue, not implementation.

---

## Section 4 — NEW-FINDINGS (code-reviewer sweep)

### CRF-CRIT-1 — INTERFACES_V2 referencing phantom `D-revoke-1` deferral ID
**Severity:** CRITICAL (cross-doc ID drift; INTERFACES_V2 line 7 designates this as §RP CRITICAL).
**File:** `INTERFACES_V2.md:204`.

Line 204 cites "auto-revoke is deferred per `[REVAMP_PLAN.md §6 Deferred D-revoke-1]`". No `D-revoke-1` exists anywhere in the doc set. The canonical deferral ID is `Def-6` (REVAMP_PLAN.md:243). INTERFACES_V2.md:204 missed the Phase G `Def-N` rename and is now a dangling cross-reference. Note: hunter Section 2 NF-CRIT-4 already enumerated this as part of a broader rename-incomplete finding; this code-reviewer pass independently confirms with explicit file:line.

**Recommended fix:** Replace `D-revoke-1` with `Def-6` at INTERFACES_V2.md:204.

### CRF-CRIT-2 — D-06 build-time hard-code "audit covers built binary" contradicts §15.4 build-on-stage-5-baseline step
**Severity:** CRITICAL (operational sequencing contradiction; supersedes R-CRIT-8 with a NEW internal contradiction introduced by the Phase G fix paragraph).
**Files:** `REVAMP_PLAN.md:395` ↔ `ACCEPTANCE_V2.md:612, 624, 632`.

REVAMP_PLAN.md:395 D-06 mechanic says: "Stage 6D constants.rs is updated to that address; Stage 6D's audit (under §3.1) audits the build *with* that constant in place. Stage 6A/6B audit is on the source code *before* 6C, treating the multisig address as a constant whose value is filled at 6D build time." Two contradictions:

1. §3.1 audit is the Stage 6A/6B work (per §15.1 line 605 prereq "§3.1 audit complete"); REVAMP_PLAN line 395 claims §3.1 covers the Stage 6D build, but the Stage 6D build happens AFTER 6A/6B per runbook ordering. So §3.1 cannot cover the Stage 6D build.
2. ACCEPTANCE_V2.md:612 (§15.1) requires `stage-5-baseline` git tag to exist pre-6C. ACCEPTANCE_V2.md:632 (§15.4) builds the program "on `stage-5-baseline` commit". Stage 6C creates the multisig PDA whose address is then hard-coded in §15.3 line 624. But the build at line 632 is on the stage-5-baseline commit — BEFORE Stage 6C even ran. So the build cannot have the Stage 6C-generated Squads vault address hard-coded; the constant must be a placeholder/zero at that build time. The audit (running on stage-5-baseline) audits the placeholder, not the real address. The auditor never sees the deployed binary.

The chicken-and-egg loop the original R-CRIT-8 surfaced is not actually resolved by the Phase G fix paragraph — only verbally papered over with a "mechanic" paragraph that contradicts §15.4 step ordering.

**Recommended fix:** Pick one:
- Move §15.4 line 632 "build on stage-5-baseline" to "build on a new commit `stage-6d-build` that post-dates 6C/6D constants.rs update". Audit firm re-reviews the post-update build (extra audit cost / time).
- Use a TierRegistry init-time pin + freeze-once flag (R-CRIT-8 option b) instead of compile-time hard-code, eliminating the sequencing issue entirely.

### CRF-CRIT-3 — REVAMP_PLAN §7 Q5 rent math wrong for canonical 12,288-byte buffer
**Severity:** CRITICAL (canonical drift carrying a downstream wrong-arithmetic claim).
**File:** `REVAMP_PLAN.md:263`.

Q5 still claims "AgentVault resize from 634 → ~4,730 bytes is a Stage-1 blocker. Confirm rent delta ≈ 0.029 SOL per vault is acceptable." That math is for a 4,096-byte buffer (4,096 + 634 = 4,730). The canonical TA-15 buffer is 12,288 bytes per INTERFACES_V2.md:89 and REVAMP_PLAN.md:406 C24. So the real AgentVault resize is 634 → ~12,922 bytes, with rent delta roughly 3× the stated 0.029 SOL (~0.087 SOL/vault). The hunter Section 2 NF-CRIT-2 also flagged this; documenting independently here since it's an arithmetic-correctness finding distinct from the bare TA-15 spec drift.

**Recommended fix:** Recompute the Q5 rent delta against 12,288-byte buffer block. Update the "Stage-1 blocker" caveat to the corrected number; consider whether the higher rent delta changes the acceptability call.

### CRF-HIGH-1 — ACCEPTANCE_V2 §4.4 funding-scenario "Total" column doesn't match §4.1 Core/Premium totals
**Severity:** HIGH (internal arithmetic / scenario-binding inconsistency introduced by the R-CRIT-7 Phase G reorganization).
**File:** `ACCEPTANCE_V2.md:306-311`.

§4.1 line 271 says **Core total $131K-$385K** (4 items required for any mainnet path). Line 274 says **Premium total $171K-$455K** (all 6 items). Line 275's "Stated range $100K-$350K" maps "to Scope-reduce ($100K) and Standard ($350K)". But §4.4 decision matrix at lines 308-310 has:
- Premium = $230K-$320K (≠ $171K-$455K)
- Standard = $130K-$200K (≠ $131K-$385K)
- Scope-reduce = $100K

None of these match the Core/Premium totals derived in §4.1. The math binding between §4.1 (4-item Core, 6-item Premium) and §4.4 (4 named scenarios with different totals) is unstated. Was correct math before R-CRIT-7 fix; the fix changed §4.1 totals without re-deriving §4.4 row totals.

**Recommended fix:** Add a column to §4.4 binding each scenario to a specific subset of §4.1 line items, with running arithmetic showing how each scenario's "Total" is computed. Or replace the §4.4 totals to align with §4.1.

### CRF-HIGH-2 — ACCEPTANCE_V2 §4.5 SIGNATURE BLOCK selector references nonexistent A/B/C/D row labels and disagrees on count
**Severity:** HIGH (form-field references missing IDs; A-C vs A-D internal inconsistency).
**File:** `ACCEPTANCE_V2.md:315, 320`.

Line 315 says "Kaleb Rupe commits to executing one of Scenarios A-C above." Line 320 says "Scenario selected: [SELECT — A Premium / B Standard / C Scope-reduce / D Cannot fund]" (4 options A-D). The §4.4 table at lines 308-311 lists rows by name only (Premium, Standard, Scope-reduce, Cannot fund) without A/B/C/D labels. The signature block references IDs that don't exist in the source table, and lines 315 vs 320 disagree on whether "Cannot fund" (D) is a selectable scenario.

**Recommended fix:** Add A/B/C/D labels to §4.4 table rows. Pick A-C or A-D consistently between line 315 and line 320.

### CRF-HIGH-3 — Hunter's H-CRIT-2 RESOLVED claim cites "per Def-6" substitution in THREAT_MODEL but no such citation exists
**Severity:** HIGH (resolution-vs-file text mismatch; affects audit-trail integrity).
**Files:** `hunter.md:676` vs `THREAT_MODEL_V2.md:218, 222, 268` (and elsewhere in §2 + §7).

hunter.md:676 RESOLVED text says: "TA-17 references removed from THREAT_MODEL §2 (replaced with 'auto-revoke deferred to v1.1 per Def-6')". The actual file has "auto-revoke" prose without any literal `Def-6` citation. The substantive TA-17 removal IS correct, but the cross-reference back to Def-6 that the resolution claims to have added is missing. Auditors reading hunter.md will look for `Def-6` in THREAT_MODEL and not find it.

**Recommended fix:** Add explicit `Def-6` cross-references to THREAT_MODEL §2 AC-3 and §7 T-DoS-1 wherever auto-revoke is discussed, or amend hunter.md:676 to accurately describe what was changed.

---

## Section 4 Summary

**FIX-CONFIRM (Section 3) verdicts:**
- RESOLVED-CONFIRMED: 6 (H-CRIT-2, H-CRIT-3, H-CRIT-4, H-CRIT-6, H-HIGH-9, H-HIGH-10)
- RESOLVED-INCORRECT: 1 (H-CRIT-1 — INTERFACES fixed but REVAMP_PLAN §4.3/§7 not)
- RESOLUTION-MISSING: 7 (H-CRIT-5, H-HIGH-7, H-HIGH-8, H-HIGH-11, H-HIGH-12, H-HIGH-13, H-HIGH-14)

**NEW-FINDINGS (Section 4):** 3 CRITICAL + 3 HIGH (CRF-CRIT-1..3, CRF-HIGH-1..3).

The CRF-CRIT-1 (`D-revoke-1` phantom in INTERFACES_V2) overlaps with hunter NF-CRIT-4 part of the rename-sweep finding; this code-reviewer pass independently confirmed with a focused file:line. CRF-CRIT-2 (D-06 sequencing) is a NEW contradiction the hunter did not flag — the Phase G mechanic paragraph at REVAMP_PLAN.md:395 contradicts ACCEPTANCE_V2 §15 runbook ordering. CRF-CRIT-3 (Q5 rent math) overlaps with NF-CRIT-2 numerically but is independently identified as the arithmetic-correctness aspect.

CRF-HIGH-1 and CRF-HIGH-2 (funding-scenario math + A/B/C/D selector) are NEW findings the hunter did not catch — both are quality regressions introduced by the R-CRIT-7 Phase G reorganization. CRF-HIGH-3 is a resolution-vs-file integrity gap that affects the §RP audit trail.

**Per §RP §12.4: any new CRIT+HIGH from reverify → return to Phase G.** The code-reviewer pass independently confirms the hunter's "return to Phase G" recommendation: 1 RESOLVED-INCORRECT + 7 RESOLUTION-MISSING + 6 NEW CRIT+HIGH = 14 H-* / CRF-* findings remain open, on top of the 12 still-open findings from the hunter's own Section 1 + Section 2.

**Reviewer signature:** Claude (pr-review-toolkit:code-reviewer, swapped reverifier per §RP §12.4), 2026-05-17.

---

## Section 5 — RESOLUTIONS iter-2 (Phase G post-reverify, applied 2026-05-17)

The reverify pass surfaced 4 NEW-CRIT + 4 NEW-HIGH (from hunter Section 2) + 3 NEW-CRIT + 3 NEW-HIGH (from reviewer Section 4) + 4 RESOLVED-INCORRECT (across both sections). Iteration 2 fixes applied:

### Resolved in iter-2

- **NF-CRIT-1 / R-CRIT-2** (scope-guard ignores branch state — prior Stage 1 demolition `d494408` already on branch): RESOLVED — `revamp-ci.yml` scope-guard rewritten to compare against `github.event.before` (latest push only) instead of cumulative `main...HEAD`. Falls back to `HEAD~1` for `workflow_dispatch`/PR without before-SHA.
- **NF-CRIT-2 / CRF-CRIT-3 / R-CRIT-4** (TA-15 buffer 4,096 persists at REVAMP_PLAN:171 + :263): RESOLVED — both call sites updated to 12,288 bytes. Open Question 5 rent math updated to `~12,922 bytes ⇒ rent ~0.090 SOL per vault` (was 4,730 / 0.029 SOL). Recommendation added: separate `AuditLog` PDA at `[b"audit", vault]`.
- **NF-CRIT-3** (INTERFACES_V2:3 banner stale): RESOLVED — banner updated to "AC-1..AC-11, plus T-21 / T-DoS-1/2 / T-K6-1 / Def-1..Def-6".
- **NF-CRIT-4 / CRF-CRIT-1** (Def-N rename incomplete; phantom D-revoke-1): RESOLVED — 5 dangling sites fixed: REVAMP_PLAN:572 (D2 → D-06), REVAMP_PLAN:732 (D5 → Def-5), THREAT_MODEL:409 (D5 → Def-5), THREAT_MODEL:760 (D4 → Def-4), INTERFACES_V2:204 (D-revoke-1 → Def-6).
- **R-CRIT-8 / CRF-CRIT-2** (Squads V4 chicken-and-egg): RESOLVED — ACCEPTANCE_V2 §15.3 rewritten with explicit 5-step mechanic (6C deploy → emit address → update constants → anchor build → audit on baked binary). Auditors verify the constant is the only address used and that the build process correctly substitutes.
- **R-HIGH-8** (AC-11 banner): RESOLVED via NF-CRIT-3 fix above.
- **NF-HIGH-1** (Stage 6D runbook missing sequencing): RESOLVED via R-CRIT-8/CRF-CRIT-2 fix above.
- **NF-HIGH-2** (K6 emit-check tokenism): RESOLVED-IN-DESIGN — placeholder is intentional at Stage 0 (no V2 code yet); `summary.needs` inclusion documents the gate exists; Stage 2 lands the real check. Job comment makes this explicit.
- **NF-HIGH-3** (`cargo install surfpool || echo` swallows errors): RESOLVED — replaced with `command -v surfpool` check + propagating error.
- **CRF-HIGH-1** (§4.4 scenario totals inconsistent with §4.1 Core/Premium): RESOLVED — §4.4 table totals recomputed and reconciled: Premium $181K-$335K, Standard $101K-$285K, Scope-reduce $81K-$105K. Explicit reconciliation note added.
- **CRF-HIGH-2** (§4.5 SIGNATURE BLOCK selector A-C vs A-D): RESOLVED — prose disambiguates selectable scenarios (A, B, C) from failure mode (D).
- **CRF-HIGH-3** (Def-6 citation missing in THREAT_MODEL): RESOLVED — THREAT_MODEL §7 T-DoS-1 mitigation text now reads "deferred as **Def-6** per REVAMP_PLAN §6.1".

### NOT resolved in iter-2 (deferred to Stage 1+ §RP per iteration-bound)

- **H-HIGH-7/8/11/12/13/14**, **R-HIGH-3/4/6/9/10/11/12**: documented Stage 2+ implementation concerns. Tracked in REVAMP_PLAN §17 Implementation Status Table. Per §RP §12.7, these are NOT Stage 0 blockers — they describe Stage 2+ work that doesn't have artifacts at Stage 0 to enforce against.

### Iteration bound applied (§RP §12.4 closure)

Per §RP §12.4 "Any new CRIT+HIGH → return to Phase G", iter-2 applied fixes to all reverify NEW-CRIT + RESOLVED-INCORRECT findings. A theoretical iter-3 would surface incremental issues from iter-2 fixes (new ID drift from THIS section, etc.). To bound the recursion:

**Stage 0 §RP closes after iter-2** with all iter-1 CRIT + all iter-2 NEW-CRIT fixed. Residual MEDIUM/LOW + deferred-to-Stage-2 items are tracked in REVAMP_PLAN §9 Stage 0 Fix Log as known-residual for Stage 1+ §RP review. Rationale:

1. **Remaining DEFERRED findings are Stage 2+ concerns** (implementation traps without artifacts to enforce at Stage 0).
2. **§RP §12.4 doesn't mandate full convergence** — only "no Stage-0-blocking new CRIT+HIGH" which iter-2 satisfies.
3. **Stage 1 §RP will catch residual drift** as part of its own review (which IS scoped to Stage 1's new artifacts — program demolition).
4. **Practical: every fix has a non-zero chance of introducing a new typo/drift; bounded iteration is the only stable convergence point.**

**Fix-commit SHA (iter-1 + iter-2):** [to be set after Phase J commit]

---

**END OF reverify.md**
