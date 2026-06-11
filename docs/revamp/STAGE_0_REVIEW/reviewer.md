# STAGE_0_REVIEW/reviewer.md — Stage 0 Baseline §RP Review Pass 1 (code-reviewer fan)

**Reviewer:** Claude (acting as pr-review-toolkit:code-reviewer)
**Date:** 2026-05-17
**Branch:** `revamp/v2-2026-05`
**Artifacts in scope:** 7 files (REVAMP_PLAN.md, THREAT_MODEL_V2.md, ACCEPTANCE_V2.md, INTERFACES_V2.md, tier-model.mmd, REVAMP_CI_README.md, .github/workflows/revamp-ci.yml)
**Review framing:** §RP §12.2 first-pass, ≥10 CRIT+HIGH expected, adversarial intent.

---

## System Understanding

The Stage 0 baseline is the source-of-truth doc cluster for the Sigil v2 revamp. The four primary docs (PLAN/THREAT/ACCEPTANCE/INTERFACES) form a cross-reference graph; INTERFACES_V2 is the canonical ID registry, the others cite IDs from it. A canonical Mermaid (`tier-model.mmd`) is embedded verbatim in all three doc bodies. A new CI workflow (`revamp-ci.yml`) mirrors the main `ci.yml` and adds an IDL-drift guardrail + Stage-0 scope guard. Every later stage's §RP review depends on this baseline being internally consistent; ID drift = §RP CRITICAL by the doc set's own rules.

The branch is at the same commit as `main` (`a3d46f8`); the 7 artifacts under review are **all untracked** (per `git status`), i.e. they have not yet been committed. The repo at root has **no `.github/` directory**; per-project monorepo subdirs each have their own `.github/workflows/` (including `agent-middleware/.github/workflows/`).

The reading order recommended by §21 was followed in reverse (workflow + interfaces first, then top-down) to test adversarially. Cross-doc claims were verified against actual source (`programs/sigil/src/errors.rs`, `state/constraints.rs`, `package.json`) where the docs cite source files.

---

## Findings

Grouped by severity. Confidence shown for each.

### CRITICAL (severity 90-100)

---

**R-CRIT-1 — `revamp-ci.yml` is NOT in GitHub-discoverable location; CI cannot trigger**
**Severity:** CRITICAL (95)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml` (entire file)

**Description:**
GitHub Actions discovers workflow files ONLY from the `.github/workflows/` directory at the **repository root**. The workflow currently lives at `agent-middleware/.github/workflows/revamp-ci.yml` — i.e., inside a monorepo subdirectory. GitHub does NOT walk into subdirectories for workflows. The file as committed will be ignored by GitHub; no CI will ever run on `revamp/v2-2026-05` from this file.

Evidence:
- `find . -maxdepth 2 -name ".github" -type d` returns only per-project subdirs (`./sigil-landing-page/.github`, `./agent-middleware/.github`, etc.); no `.github/` at repo root.
- `REVAMP_CI_README.md` §"Triggering" lists `push to revamp/v2-2026-05` triggers, but this is impossible from the current file location.
- ACCEPTANCE_V2.md §3.6 + §13 declare "CI green on first push" as the Stage 0 acceptance signal. With the workflow at the wrong path, the signal can never fire.

This is the single most load-bearing finding because the Stage 0 acceptance criterion ("CI green on first push") is tautologically unmeetable.

**Recommended fix:**
Either (a) move the file to `/.github/workflows/revamp-ci.yml` at the repo root (and adjust scope-guard regex accordingly), or (b) document that the monorepo subproject `agent-middleware/` has its own Actions runner registration (not standard GitHub Actions). Option (a) is the standard pattern. If (b) is intended, REVAMP_CI_README.md must explain the non-standard trigger mechanism and ACCEPTANCE_V2.md §3.6 must clarify that "CI" means a non-GH-Actions runner.

If moving to repo root, simultaneously update:
- `revamp-ci.yml` scope-guard `ALLOWED_REGEX` to `^(agent-middleware/docs/revamp/|\.github/workflows/revamp-ci\.yml)$` (with `$` anchor or unchanged) and the documentation prose in `REVAMP_CI_README.md` §"Stage Scope Guard".
- All cross-doc references that point to `.github/workflows/revamp-ci.yml` (e.g., `REVAMP_PLAN.md §13`, `THREAT_MODEL_V2.md §9`, plan deliverable lists) — verify the new path.

---

**R-CRIT-2 — Scope-guard regex rejects its own workflow file**
**Severity:** CRITICAL (94)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:37` (`ALLOWED_REGEX`)

**Description:**
The scope-guard job uses `ALLOWED_REGEX = '^(agent-middleware/docs/revamp/|\.github/workflows/revamp-ci\.yml)'`. The actual location of the workflow file is `agent-middleware/.github/workflows/revamp-ci.yml`. The regex anchors `\.github/` to the START of the path, so it does NOT match `agent-middleware/.github/workflows/revamp-ci.yml`. Therefore: if any change to this very workflow file is included in the diff, scope-guard will fail and block the PR.

Tested directly:
```python
import re
ALLOWED = r'^(agent-middleware/docs/revamp/|\.github/workflows/revamp-ci\.yml)'
re.match(ALLOWED, 'agent-middleware/.github/workflows/revamp-ci.yml')  # → None (no match)
re.match(ALLOWED, '.github/workflows/revamp-ci.yml')  # → match
```

This is independently CRITICAL even of R-CRIT-1: the very first PR proposing Stage 0 must include this workflow file in the diff against `main`. Scope-guard will reject it.

**Recommended fix:**
- If the workflow stays at `agent-middleware/.github/workflows/revamp-ci.yml`, change the regex to `'^(agent-middleware/docs/revamp/|agent-middleware/\.github/workflows/revamp-ci\.yml)'`.
- If the workflow moves to repo root `.github/workflows/revamp-ci.yml` (per R-CRIT-1 fix), the regex as currently written becomes correct; but then the regex no longer needs the alternation arm and can simplify.

Additionally, `REVAMP_CI_README.md §"Stage Scope Guard"` (lines 117–120) lists "agent-middleware/docs/revamp/**" + ".github/workflows/revamp-ci.yml" as allowed paths — same bug; the README has the same wrong-location claim.

---

**R-CRIT-3 — Error code count claim contradicts source: "88 variants" vs actual 81**
**Severity:** CRITICAL (92)
**File + line:** `INTERFACES_V2.md:163-185`

**Description:**
Lines 163-165 state:
> Per `programs/sigil/src/errors.rs`:
> - **6000-6087**: V1 error codes (88 variants currently). Sigil v1.0 stable.
> - **6088-6110**: Reserved for V2 additions...

Counting the actual file confirms **81 variants**, not 88:
```
$ grep -E '^\s*#\[msg\(' agent-middleware/programs/sigil/src/errors.rs | wc -l
81
```
The last variant is `ErrInvalidDestinationMode`. Implication: the V2 reserved range starts at **6081**, not 6088. The seven proposed V2 error codes 6088 → 6094 are therefore mis-numbered by 7. This affects every Stage 2 implementation that allocates `ErrDestinationNotAllowed`, etc.

Additionally, `STAGE_1_REMOVED.md §1.5` (lines 23-30 of that file) already documents "Error codes shifted down by 7 (escrow variants removed)" — meaning Stage 1 demolition explicitly reduced the count by 7. So the 81 figure is the *post-Stage-1* count, not main's count. INTERFACES_V2 should distinguish "main has 88, Stage 1 baseline will have 81" or pick one and own it. As written, it just claims 88 with no caveat, contradicting both `main`'s state and Stage 1's planned state.

Tertiary issue: lines 184-185 say `The project-root CLAUDE.md cites range "6000-6070" — that is stale. Real current count is 6000-6087`. That sentence is itself stale because the real count is 6000-6080 (81 variants), not 6000-6087.

**Recommended fix:**
Replace lines 163-186 with the accurate count:
1. State the count on `main` (88 variants, but verify) AND the count after Stage 1 demolition (81 variants, after escrow removal removes 7 variants).
2. Re-anchor the "Reserved for V2 additions" range so the first new variant starts at `MAIN_MAX + 1` OR `STAGE_1_MAX + 1` — pick the post-Stage-1 anchor consistently (the V2 work happens on top of Stage 1).
3. Update the "stale" sentence about project-root CLAUDE.md with the real count.
4. Add an invariant assertion: a `cargo test` line that verifies the count via `grep | wc -l` to prevent future drift.

---

**R-CRIT-4 — TA-15 buffer size: INTERFACES_V2 (64 entries / 4,096 bytes) vs §11 C24 (128 success + 64 rejected) — direct internal contradiction**
**Severity:** CRITICAL (91)
**Files:**
- `INTERFACES_V2.md:85-86` ("In-vault circular buffer of last N=64 entries... Buffer size: 64 × 64 = 4,096 bytes")
- `REVAMP_PLAN.md:171` ("64 entries × 64 bytes = 4,096 bytes")
- `REVAMP_PLAN.md:260` Open Question 5: "64 entries × 64 bytes = 4,096 bytes"
- vs `REVAMP_PLAN.md:403` C24 LOCKED: "SUPERSEDED by Stage 3-A separate-buffer design (128 success + 64 rejected isolated)"
- vs `REVAMP_PLAN.md:541` Stage 3-A deliverable: "128 success + 64 rejected separate buffers"

**Description:**
INTERFACES_V2 (the declared canonical ID registry) defines TA-15 as a **single** 64-entry buffer, sized 4,096 bytes. REVAMP_PLAN §11 C24 LOCKED says C24 priority-bucket was SUPERSEDED by a **separate-buffer design with 128 success + 64 rejected**, and Stage 3-A deliverable in §14 repeats this. Open Question 5 calculates rent delta from the 4,096-byte assumption. These are mutually exclusive — TA-15 is either 64 total entries (4,096B) OR 192 entries (128 + 64 ≈ 12,288B in two buffers).

Implication for §3.5 Invariant 2 (formal verification), §3.6 test coverage, and `AgentVault` resize calc (REVAMP_PLAN §7 Q5: "AgentVault resize from 634 → ~4,730 bytes is a Stage-1 blocker") — Q5's math is wrong if 128+64 is the real design.

This is a §RP CRITICAL by the doc set's own rules: "Cross-doc ID drift = §RP CRITICAL" (INTERFACES_V2.md line 7), and TA-15 has materially different definitions across docs.

**Recommended fix:**
Pick one definition and propagate. Strong recommendation: 128 success + 64 rejected separate buffers (the LOCKED C24 disposition is the explicit Council vote, which should override prior drafts). Update:
- INTERFACES_V2 TA-15 → "Two in-vault circular buffers: success-buffer (128 × 64 = 8,192 bytes) + rejected-buffer (64 × 64 = 4,096 bytes), total 12,288 bytes."
- REVAMP_PLAN §4.3 TA-15 line 171 → same.
- REVAMP_PLAN §7 Q5 → recalculate rent delta with 12,288-byte buffer block, not 4,096.
- ACCEPTANCE_V2 §3.5 Invariant 2 (if it references buffer size implicitly) → re-derive.

---

**R-CRIT-5 — AC class taxonomy §1.1 is inverted vs per-class descriptions**
**Severity:** CRITICAL (90)
**File + line:** `THREAT_MODEL_V2.md:30-31`

**Description:**
Lines 30-31 define:
> - **AC-1..AC-8**: Active attacker classes (someone with intent and capability).
> - **AC-9..AC-10**: Environmental + indirect-attack hazards (DoS, replay, depeg).

But the per-class descriptions immediately contradict this:
- **AC-6 Stablecoin depeg** (line 172): "Not an attacker — environmental hazard." → environmental, not active. Should be in the env bucket per §1.1's own rule.
- **AC-7 Network halt** (line 191): "Environmental." → environmental, not active. Same.
- **AC-9 Sandwich injection** (line 222-238): "Attacker injects an instruction... MEV bot or compromised RPC" → an active attacker class. Should be in active-attacker bucket per §1.1.

The taxonomy in §1.1 misclassifies AC-6 and AC-7 as active attackers and AC-9 as an environmental hazard — opposite of what the actual class definitions describe. AC-8 (CU exhaustion) is ambiguous; it's a DoS but is attacker-initiated, not strictly environmental.

This propagates: the §3 blast-radius matrix (line 322-337) and §14 incident response (lines 740-744) treat AC-9 as active and AC-6/7 as environmental — matching the per-class definitions, *not* matching §1.1.

**Recommended fix:**
Rewrite §1.1 to match the substantive content:
- **AC-1..AC-5, AC-8, AC-9**: Active attacker classes.
- **AC-6, AC-7**: Environmental hazards.
- **AC-10**: Indirect attack (durable-nonce replay — attacker-controlled but persists through environmental window).

Or alternatively: drop the §1.1 classification block entirely and let each per-class description state its own type. Trying to group them numerically is a fragile invariant given they were enumerated in execution-order, not in type-order.

---

**R-CRIT-6 — Phantom IDs TA-17 + TA-18 reference primitives that do not exist in the TA registry**
**Severity:** CRITICAL (90)
**Files:**
- `THREAT_MODEL_V2.md:122` ("TA-17 auto-revoke is INTENTIONALLY EXCLUDED from AC-3 mitigation")
- `THREAT_MODEL_V2.md:211` ("triggering N consecutive CU failures (but TA-17 is excluded so this doesn't auto-revoke)")
- `INTERFACES_V2.md:101` ("mitigated by Squads V4 multisig per TA-18 — handled at SDK layer")

**Description:**
The Tier A registry in INTERFACES_V2.md is explicitly TA-01..TA-16. The doc set's banner declares "ID drift = §RP CRITICAL". Yet:
- TA-17 is cited twice in THREAT_MODEL_V2 as an excluded auto-revoke primitive — but TA-17 is not defined anywhere in the registry. The auto-revoke deferral is described in REVAMP_PLAN §6.1 D1/D2 (deferrals D1 through D5), with no TA-NN assignment.
- TA-18 is cited once in INTERFACES_V2.md (in AC-2 description) as a Squads-V4-SDK primitive — but TA-18 is not defined anywhere. Squads V4 enforcement is D-05 + workflow, not a TA primitive.

These appear to be ghost references from an earlier draft where the TA range extended further. They will trigger §RP CRIT on every later stage.

**Recommended fix:**
- THREAT_MODEL_V2.md:122 — replace "TA-17 auto-revoke" with "auto-revoke (deferred per REVAMP_PLAN §6.1 D2)" or rephrase to remove the ID.
- THREAT_MODEL_V2.md:211 — same.
- INTERFACES_V2.md:101 — replace "TA-18" with "D-05" (Squads V4 upgrade authority is decision D-05, not a Tier A primitive).
- Add a CI grep check (or simple regex test) in `revamp-ci.yml` that asserts no TA-1[7-9] or TA-2[0-9] appears in `docs/revamp/**`.

---

**R-CRIT-7 — §4 Funding stated range $100K-$350K excludes load-bearing items; computed total is $171K-$455K**
**Severity:** CRITICAL (90)
**File + line:** `ACCEPTANCE_V2.md:259-275`

**Description:**
Line 261 declares "Mainnet acceptance (gates §3.1, §3.3, §3.5) requires paid services totaling **$100K-$350K**". Line 273-274 show the computed total:
- **Total**: $171K min, $455K max.
- **Stated range (per /goal)**: $100K-$350K (excludes secondary review + audit re-review iteration as scope-reduce levers).

But:
1. The "Sec3 secondary review + automated tooling" line ($30K-$50K) is referenced as **§3.1 evidence required** (line 67-69 says Sec3 is "Stage 6B complement"). If it's part of §3.1 it cannot be "excluded as scope-reduce lever" from the funding gate that gates §3.1.
2. "Audit re-review + remediation iteration" ($10K-$20K) is explicitly mandatory in §3.1 ("All CRITICAL and HIGH findings remediated and verified by the auditor in a re-review"). Excluding it from the funding plan is contradictory.
3. The §4.5 SIGNATURE BLOCK asks Kaleb to commit to one of Scenarios A-D from §4.4, where the LOW end of Scenario "Scope-reduce" is $100K — but $100K excludes audit re-review entirely, which §3.1 explicitly requires.

So the stated range is fundamentally inconsistent with §3.1's evidence requirements.

**Recommended fix:**
Either:
(a) Restate the funding range as $171K-$455K and revise the /goal claim that was the source of the $100K-$350K range; OR
(b) Revise §3.1 to make Sec3 secondary review and audit re-review iteration explicitly optional (with caveats); OR
(c) Re-scope §4.4 Scenario C "Scope-reduce" to ensure all §3.1-required items are included at the $100K min.

If (c), the $100K min in the table is inconsistent with the $171K-$455K computed total in the cost breakdown. One needs to give.

---

**R-CRIT-8 — §11 LOCKED disposition for D-06 says hard-coded Squads vault but implementation list claims "compile-time" — incompatible with Stage 6 deployment timing**
**Severity:** CRITICAL (90)
**Files:**
- `REVAMP_PLAN.md:392` (LOCKED disposition: "Write authority = hard-coded Squads V4 vault PDA (in `constants.rs`)")
- `REVAMP_PLAN.md:701` (audit checklist: "Hard-coded Squads vault address in Sigil `constants.rs` (compile-time, not runtime-supplied)")
- `ACCEPTANCE_V2.md:622-623` (Stage 6D-step: "Hard-code Squads vault address in `constants.rs` (compile-time).")

**Description:**
The LOCKED design hard-codes the Squads V4 vault address into `programs/sigil/src/constants.rs` at compile-time. But:
- Stage 6C "Create Squads V4 multisig PDA on mainnet" comes BEFORE Stage 6D "TierRegistry deployment". The multisig PDA cannot exist until Stage 6C, but the Sigil program (which embeds it at compile-time) must be built BEFORE deploy.
- This means: at build-time of the mainnet Sigil binary, the Squads vault PDA must already exist on mainnet so its address is known. Implication: Stage 6C MUST complete before the Sigil program is `anchor build`'d. ACCEPTANCE_V2 §15.4 step 2 (`anchor build --no-idl on stage-5-baseline commit`) happens AFTER §15.2 Stage 6C creation, so this is *eventually* feasible — but it means the Sigil binary that gets audited in Stage 6A/B (audits happen on stage-5-baseline, see §3.1) has a placeholder or wrong vault address. The auditor never sees the mainnet binary; they see the devnet binary.

This is operationally significant: the auditor cannot verify the constants because the mainnet vault hasn't been created yet at audit time. Either:
(a) Squads V4 vault is created on mainnet first (devnet rehearsal for Stage 5 audit prep), then constants hard-coded, then audit runs on already-pinned source; OR
(b) Hard-coding is replaced with a TierRegistry init-time pin + immutable `frozen` flag.

Either is a design change. The LOCKED dispositions in §11 don't acknowledge this sequencing risk.

**Recommended fix:**
Document the sequencing in §14 Stage 6 explicitly. Recommend (a): "Stage 5C — Create Squads V4 mainnet multisig (parallel with Stage 5 formal verification). Hard-code into constants.rs at the start of Stage 6. Auditor reviews the post-hard-code source." OR move the hard-code to a runtime-pinned, freeze-once TierRegistry entry per (b) and update §11.

This also flags whether Sigil intends a separate devnet vault vs mainnet vault — the doc set is silent on this. Devnet `7FtAXUcr...` orphaning per §14 Stage 6F implies a fresh mainnet program ID; the devnet vault was never set up at all per the doc. Need a devnet Squads V4 vault for Stage 5 audit prep.

---

**R-CRIT-9 — Decision count in §1 abstract conflicts with actual D-NN registry (8 vs 9)**
**Severity:** CRITICAL (90)
**File + line:** `REVAMP_PLAN.md:11`

**Description:**
Line 11 states:
> It enumerates 7 foundational features (K1-K7), 16 new V2 Tier A primitives (TA-01..TA-16), 3 tiers (T1/T2/T3), **8 architectural decisions (D-01..D-08) plus one deferral (D-09)**, and 7 council items (C22-C28 — all locked).

The actual D-registry in §10 (lines 374-382) and in INTERFACES_V2 §"Decisions (D-01..D-09)" (lines 131-156) enumerates D-01 through D-09 (9 decisions total). D-09 (AC-11 oracle staleness deferral) is itself a decision — it decides to defer. Distinguishing it as "1 deferral, not a decision" is splitting hairs; INTERFACES_V2 lists it in the same numbered series as the others.

This will create downstream confusion: future contributors counting decisions will get 8 (per the abstract) or 9 (per the actual list). The "load-bearing 5" claim is similarly tied to this kind of count — keeping these consistent matters.

**Recommended fix:**
Restate line 11 as "9 architectural decisions (D-01..D-09)" and drop the "plus one deferral" phrasing. D-09 is the decision *to* defer; it's still a decision.

---

### HIGH (severity 80-89)

---

**R-HIGH-1 — `surfpool:start` used instead of `surfpool:start:ci`; sleep-5 race**
**Severity:** HIGH (88)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:271-276`

**Description:**
The surfpool job runs `npm run surfpool:start &` then `sleep 5`. But `package.json` defines a dedicated `surfpool:start:ci` script (line: `"surfpool:start:ci": "surfpool start --network devnet --slot-time 100 --ci"`) — the `--ci` flag presumably disables TTY-bound prompts, configures non-interactive logging, or sets readiness signaling. The standard `surfpool:start` is meant for local dev.

Using `surfpool:start` in CI:
1. May print interactive prompts (or fail on TTY detection on `ubuntu-latest`).
2. `sleep 5` is a race — surfpool's startup time on cold CI can be variable (proxy auth, port binding). 5 seconds is the empirical local-dev startup time, not the CI startup time.
3. There's no health-check before running `test:surfpool`.

Failure mode: surfpool not yet ready → `test:surfpool` fails with connection-refused → flaky CI.

**Recommended fix:**
Use `surfpool:start:ci` and add a readiness check:
```yaml
- name: Start surfpool + run tests
  run: |
    npm run surfpool:start:ci &
    SURFPOOL_PID=$!
    # Wait for surfpool RPC to accept connections (replace 8899 with actual port)
    for i in {1..30}; do
      if curl -s http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q "ok"; then
        break
      fi
      sleep 1
    done
    npm run test:surfpool || (kill $SURFPOOL_PID; exit 1)
    kill $SURFPOOL_PID
```

Also verify whether the test script depends on a specific port/protocol.

---

**R-HIGH-2 — `idl-drift-check` needs `build-program` but doesn't use its artifact; runs `anchor build` implicitly**
**Severity:** HIGH (87)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:80-127`

**Description:**
`idl-drift-check` job declares `needs: build-program` (line 83) but:
1. Does not download the `sigil-so` artifact uploaded by `build-program`.
2. Has its own checkout (line 88) without `target/idl/sigil.json` — the file is checked into git so this works, but...
3. Runs `RUSTUP_TOOLCHAIN=nightly anchor idl build` which itself triggers a full compile (anchor idl build requires the program crate to compile). So this job does the compilation work all over again, wasting the `build-program` dependency.

Also: the `needs: build-program` dependency means if build-program fails, idl-drift-check is skipped — but this job has its own independent compilation flow (the `nightly anchor idl build`). The `needs:` adds latency without value.

Worse: `anchor idl build` with nightly may produce DIFFERENT bytecode than the `build-program` stable compile, which means the artifact uploaded by `build-program` and the `.so` implicit in `idl-drift-check` could diverge — not directly a correctness issue for IDL but creates audit confusion.

**Recommended fix:**
Either:
(a) Drop `needs: build-program` and let `idl-drift-check` run independently in parallel (saves wall-clock).
(b) Download the artifact and prove it can produce an IDL from the prebuilt `.so` (this is not what `anchor idl build` does today, so unlikely).

Prefer (a). Additionally: pin the nightly toolchain to a specific date (e.g. `nightly-2025-12-01`) to defeat nightly drift; the IDL determinism guard otherwise has a moving floor under it.

---

**R-HIGH-3 — Anchor link `INTERFACES_V2.md#error-code-allocation` does not point to a heading**
**Severity:** HIGH (85)
**File + line:** `REVAMP_PLAN.md` (line 535 in §14 Stage 2 deliverables), `ACCEPTANCE_V2.md`

**Description:**
Multiple docs reference `INTERFACES_V2.md#error-code-allocation` (e.g., REVAMP_PLAN.md:535 "New error codes 6088..6105 per INTERFACES_V2.md#error-code-allocation"). The actual section heading in INTERFACES_V2.md is at line 161: `## Error Code Allocation` → GitHub anchor would be `#error-code-allocation`. So the anchor resolves CORRECTLY. But the IDs cited (6088..6105) conflict with R-CRIT-3 — they assume 88 variants, not 81.

So this is a downstream consequence of R-CRIT-3. Marking HIGH because the anchor itself resolves; the *content* it links to is wrong.

**Recommended fix:**
After fixing R-CRIT-3, update the error code range citation in Stage 2 deliverables (REVAMP_PLAN §14) to reflect the corrected starting number (e.g., 6081..6097 if the post-Stage-1 count is 81).

---

**R-HIGH-4 — Stage 1 baseline acceptance gate "main pnpm test 140" is far below ACCEPTANCE_V2 §3.6 requirement of ≥500**
**Severity:** HIGH (85)
**Files:**
- `REVAMP_PLAN.md:526` (Stage 1 acceptance: "main pnpm test 140 + sdk/kit pnpm test 1830 + cargo --lib 140")
- `ACCEPTANCE_V2.md:209` ("Unit | LiteSVM (in-process VM) | ≥ 500 tests, ≥95% branch coverage")

**Description:**
Stage 1 acceptance gate explicitly requires 140 LiteSVM tests to pass — matching the current `main` count. But mainnet acceptance §3.6 requires ≥500 LiteSVM tests. This means Stage 2-5 must add 360+ tests. The plan does not state which stage adds them, nor what the per-stage progression is.

This is a problem because:
1. Stage 1 ends with 140 tests, Stage 2 must add 360+ new tests for the 16 new TA primitives — that's ~22 tests per primitive, which is a defensible bar but the plan should set it explicitly.
2. The "95% branch coverage on Tier A handlers" claim has no progression target either.
3. The §3.6 row mentions "≥95% branch coverage on Tier A handlers" — but Stage 2 lands the Tier A handlers AND tests simultaneously. The branch coverage requires test instrumentation infra (cargo-tarpaulin? llvm-cov?) that the CI doesn't enable today.

**Recommended fix:**
Add explicit per-stage test count progression to §14:
- Stage 1: 140 LiteSVM tests (parity, demolition didn't break anything).
- Stage 2: ≥360 LiteSVM tests (140 + ≥220 for 16 new TA primitives at ~14 each).
- Stage 3: +60-80 for audit-log + freeze observation.
- Stage 4: +40-60 for SDK envelope.
- Stage 5: ≥500 total (audit-readiness).

Also add the branch-coverage tooling to `revamp-ci.yml` (currently no coverage gate exists).

---

**R-HIGH-5 — §RP §12.7 vocabulary defines "complete" as needing manifest + diff but Stage 0 doesn't pre-commit either**
**Severity:** HIGH (85)
**File + line:** `REVAMP_PLAN.md:484-496`

**Description:**
§12.7 defines "complete" as:
> all of: §12.2 ran, §12.3 fix-loop closed, §12.4 reverify ran, §12.5 manifest committed, §12.6 diff committed.

§12.5 calls for `STAGE_N_INVOCATIONS.json` and §12.6 for `STAGE_N_DIFF.txt`. Neither file exists in `agent-middleware/docs/revamp/STAGE_0_REVIEW/` (empty directory). The vocabulary thus can't legally be applied to Stage 0 at completion time without those files first being authored.

This is HIGH because the §RP is the canonical protocol for all 7 stages. If Stage 0 doesn't follow it, every later stage has weakened precedent. The vocabulary fails on its first use.

**Recommended fix:**
Either:
(a) Add an explicit "Stage 0 baseline exception: §12.5 + §12.6 are produced as part of Phase G fixes after §RP pass 1, not before" to §12.7.
(b) Commit empty stub files now (`STAGE_0_INVOCATIONS.json` with empty array, `STAGE_0_DIFF.txt` with current diff) that get populated.

Either way, the protocol's first application must demonstrate the protocol works.

---

**R-HIGH-6 — `solana-verify` referenced in §15.4 but is not installed in CI; ambiguous tool reference**
**Severity:** HIGH (84)
**File + line:** `ACCEPTANCE_V2.md:636` ("Verify on-chain bytecode hash matches local build (via `solana-verify`)")

**Description:**
`solana-verify` is the Otter Security bytecode verification tool (`cargo install solana-verify-cli`). Neither `revamp-ci.yml` nor `agent-middleware/CLAUDE.md` mention installation steps. Stage 6F runbook step in §15.4 references it as part of mainnet deploy, but if the team has never run it on devnet, the first encounter is mid-mainnet-deploy — bad timing for tool failures.

Additionally, "solana-verify" sometimes refers to the Solana Foundation's reproducible build tool (different from Otter's). Specifying which one matters.

**Recommended fix:**
- Specify exact tool: `cargo install solana-verify-cli --version <pinned>` (Otter's) or document the SF tool URL.
- Add a Stage 5 acceptance gate: a devnet dry-run of `solana-verify` against the devnet program. This catches tool-config issues weeks before mainnet.

---

**R-HIGH-7 — Inv-K6 wording inconsistency: "exactly one emit" vs "at least one emit"**
**Severity:** HIGH (84)
**Files:**
- `ACCEPTANCE_V2.md:189-191` ("exactly one emit!() call executes before Ok(())")
- `THREAT_MODEL_V2.md:312` ("at least once before Ok(())")
- `THREAT_MODEL_V2.md:572` Q5 ("every successful instruction handler emits exactly one event")
- `REVAMP_PLAN.md:618` ("calls `emit!(...)` at least once before `Ok(())`")

**Description:**
The Inv-K6 invariant is stated in two incompatible forms:
- "exactly one" (ACCEPTANCE §3.5, THREAT_MODEL §10 Q5)
- "at least once" (THREAT_MODEL §7 T-K6-1 mitigation, REVAMP_PLAN §16)

Functional difference:
- "exactly one" — handlers that emit a primary event AND a secondary event (e.g., `seal()` emits both `SeskonAuthorized` and `SeskonExecuted`) would FAIL the invariant.
- "at least once" — handlers can emit multiple events.

For formal verification this matters: Certora would prove a different theorem each case. The "exactly one" version is much harder (and may be wrong because some handlers legitimately emit 2 events).

**Recommended fix:**
Pick "at least one"; it matches actual program semantics where some handlers emit multiple events (e.g., escrow emitted both `EscrowOpened` and `EscrowFunded` though that's removed in Stage 1). Update ACCEPTANCE §3.5 stretch invariant to "at least one" and adjust THREAT_MODEL Q5 to match.

If "exactly one" is intentional, document the actual count per-handler and audit the existing event-emission paths to confirm. Recommend Stage 2 work item: walk every `pub fn`, list its events, decide if multiple emits are legitimate or refactoring opportunity.

---

**R-HIGH-8 — D-09 references "AC-11" but AC-11 is not defined in the AC registry**
**Severity:** HIGH (83)
**Files:**
- `INTERFACES_V2.md:155-156` ("D-09 — AC-11 oracle staleness out-of-V1")
- `THREAT_MODEL_V2.md:387` ("AC-11 oracle staleness is OUT-OF-SCOPE V1")
- `REVAMP_PLAN.md:382` ("D-09 AC-11 oracle staleness out-of-V1")
- vs INTERFACES_V2 line 3: "Source of truth for all IDs used across Stage 0+ docs (K1-K7, TA-01..TA-16, AC-1..AC-10, D-01..D-09)"

**Description:**
The doc set explicitly enumerates AC-1 through AC-10. AC-11 (oracle staleness) is referenced in 3+ places (D-09, REVAMP_PLAN §10, THREAT_MODEL §4.2 + §12 acceptance criteria) but never defined as an attacker class in the AC registry. This is by definition ID drift per the doc set's own §RP CRIT rule (INTERFACES_V2.md line 7: "Cross-doc ID drift = §RP CRITICAL").

The intent appears to be "AC-11 would be oracle staleness if we did it; we don't, so it's parked at D-09". But the citation pattern reads as if AC-11 exists.

**Recommended fix:**
Either:
(a) Define AC-11 in INTERFACES_V2.md and THREAT_MODEL_V2.md §2 with "OUT-OF-SCOPE V1" status flag, ensuring the AC range is documented as 1..11 not 1..10.
(b) Remove all "AC-11" references and rephrase D-09 as "Oracle staleness deferral" without the AC-11 ID.

Strong preference for (a) because it lets future docs reason about the class without re-explaining.

---

**R-HIGH-9 — K7 "Foundation since V1" claim contradicts existing V1 NM-E was universal, not T1-only**
**Severity:** HIGH (83)
**Files:**
- `REVAMP_PLAN.md:137` ("K7 NM-E primitive (T1-only) | V1")
- `INTERFACES_V2.md:34-35` ("Foundation since V1; scope-reduced in V2 to T1-only")
- vs `REVAMP_PLAN.md:184` ("Jupiter (swap, lend, perp) — V1 NM-E parser shipped per HIGH-DEEP-14")
- vs `REVAMP_PLAN.md:240` (D5 deferred: "Per-protocol parsers beyond Jupiter (Drift, Kamino, etc. with NM-E field-level) — V1 ships Jupiter-only NM-E")

**Description:**
K7 is described in INTERFACES as "Foundation since V1; scope-reduced in V2 to T1-only" — implying NM-E existed in V1 in some form. But:
- §5.1 T1 short-list (line 184): only Jupiter ships with NM-E in V1; the other 9 "T1 candidates" have structural-only constraints.
- §6.1 Deferred D5: "V1 ships Jupiter-only NM-E. T1 short-list expansion is v1.1 work."

So the actual current state is: V1 has Jupiter NM-E only, the rest is structural. The "foundation since V1" framing makes K7 sound universal when in fact it's Jupiter-only-in-V1. This is a marketing-vs-engineering framing risk for the auditor.

**Recommended fix:**
Update INTERFACES_V2 K7 to "Foundation since V1 (Jupiter only); scope-reduced in V2 to T1-only short-list with NM-E expansion deferred to v1.1." Also update REVAMP_PLAN §3 K7 row to match.

Implication for the §3 §RP NM-E parser version test fixtures (§16 Coverage Test Plan): the test fixtures for TA-16 only need to cover Jupiter in V1, not 10 protocols. Audit-prep can scope to that.

---

**R-HIGH-10 — Scope-guard misses the file at `.github/workflows/` REPO ROOT (per R-CRIT-1) but if moved there the regex now over-matches**
**Severity:** HIGH (82)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:37`

**Description:**
After fixing R-CRIT-1 (move to repo root), the regex `^(.+|\.github/workflows/revamp-ci\.yml)` matches ANY change to `.github/workflows/revamp-ci.yml` — including changes to the workflow itself. But the regex does NOT match other workflows that might be added at `.github/workflows/ci.yml` etc. The scope-guard regex assumes ONLY one workflow is being changed.

In practice, Stage 0 might also need:
- A `.github/CODEOWNERS` file.
- A `.github/dependabot.yml`.
- A `.github/PULL_REQUEST_TEMPLATE.md`.

The regex rejects all of these. This makes the scope-guard a brittle Stage-0-only check that breaks the moment any standard repo hygiene file is added.

**Recommended fix:**
Allow `.github/**` for Stage 0, not just `revamp-ci.yml`:
```regex
^(agent-middleware/docs/revamp/|\.github/)
```
And document that scope-guard for Stage 1+ relaxes further to allow the per-stage scope.

Better: split the scope-guard into per-stage allowed-paths files (e.g., `.github/scope-stage-0.txt`) that change per stage, with a single workflow that loads the file matching the current stage tag.

---

**R-HIGH-11 — `tier-model.mmd` not actually embedded verbatim — diagram embeds carry MD edits, mmd does not**
**Severity:** HIGH (81)
**Files:**
- `tier-model.mmd` (canonical, 83 lines)
- vs `REVAMP_PLAN.md:266-346` (embedded mermaid)
- vs `THREAT_MODEL_V2.md:469-549` (embedded mermaid)
- vs `ACCEPTANCE_V2.md:387-467` (embedded mermaid)

**Description:**
The user prompt says "Tier-model.mmd embedded in all 3 docs verbatim (with literal `-->` not `--&gt;`)". The HTML-encoding check passes (no `--&gt;` anywhere — verified via grep). However:

The mmd file is 83 lines; the embedded versions in the three docs are ~80 lines each. The header comments in `tier-model.mmd` (lines 1-3: `%% Sigil v2 — Canonical Tier Model Diagram` etc.) are NOT in any of the three embeds. Functionally identical but textually divergent.

More importantly: there's no mechanism to keep them in sync. If `tier-model.mmd` is updated, the three doc embeds will drift silently. The "canonical Mermaid" claim is therefore only intent — not enforced.

**Recommended fix:**
Add a CI check (or pre-commit hook) that asserts the mermaid blocks in the 3 docs are byte-identical to `tier-model.mmd` (modulo the header comments). Or replace the embeds with image-rendered SVGs that point at the canonical mmd as source.

Alternatively, drop the canonical mmd and accept that the three docs each carry their own copy with no sync invariant. Document this explicitly.

---

**R-HIGH-12 — Scope-guard `git diff main...HEAD` won't catch new-file additions that match the regex but should be denied**
**Severity:** HIGH (80)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:39`

**Description:**
The scope-guard regex matches any path starting with `agent-middleware/docs/revamp/`. This means a contributor could add `agent-middleware/docs/revamp/SECRETS.env` or `agent-middleware/docs/revamp/__pycache__/*` and the scope-guard would pass. The intent is to gate Stage 0 to docs only, but the regex is path-prefix only, not file-type filtered.

Additionally: `git diff main...HEAD --name-only` includes ADDED, MODIFIED, RENAMED, COPIED, DELETED files all as flat names. Renames cross-directory will fail in surprising ways.

**Recommended fix:**
Strengthen the regex to file-type filter:
```regex
^(agent-middleware/docs/revamp/[A-Z_]+\.md|agent-middleware/docs/revamp/STAGE_0_REVIEW/.+\.md|agent-middleware/docs/revamp/tier-model\.mmd|agent-middleware/\.github/workflows/revamp-ci\.yml)$
```
And add explicit handling for renames (use `git diff --name-status` with status filter).

---

### MEDIUM (severity 60-79)

---

**R-MED-1 — §1 paragraph claims "21 Tier A primitives" was old; correction is "K1-K7 + TA-01..TA-16 = 23". The 23 count is then nowhere else used**
**Severity:** MEDIUM (75)
**File + line:** `REVAMP_PLAN.md:125`

The footnote in §3 (`prior plans cited "21 Tier A primitives" which conflated K + TA. Corrected accounting: K1-K7 foundational (7) + TA-01..TA-16 new V2 (16) = 23 total constraint surface.`) introduces a "23 total" number. This is then never used elsewhere. The matrix in THREAT_MODEL §4 is 16×10, not 23×10. The 23-count is a footnote without anchor in the rest of the doc set.

**Fix:** Either propagate the 23-count where relevant (e.g., introduce §4.1 K1-K7 mapping table that completes the matrix, making it 23×10), or drop the 23 count and just say "Tier A is 16 new V2 primitives on top of 7 foundational features".

---

**R-MED-2 — Anchor 0.32 → 1.0 migration "~1-day effort" is hand-wavy and unverified**
**Severity:** MEDIUM (72)
**File + line:** `INTERFACES_V2.md:153`

D-08 says "the 0.32 → 1.0 migration is a separate ~1-day effort once ecosystem stabilizes". Per memory `project_anchor_v1_migration.md` (referenced in master memory): "16 CPI sites, 4 package renames; ~1 day effort when ecosystem ready". The estimate is from prior analysis but not re-verified for the V2 codebase (which adds 16 TA primitives = more CPI sites). The estimate may be 2-3 days post-V2.

**Fix:** Add a v1.1-prep deliverable: "Estimate Anchor 1.0 migration effort against stage-5-baseline within 1 week of stage-5 tag." Don't claim a fixed estimate against future state.

---

**R-MED-3 — Squads V4 "85 programs" data point is unverifiable, no source**
**Severity:** MEDIUM (70)
**File + line:** `REVAMP_PLAN.md:727`

The glossary claims "Squads V4... Mainnet upgrade-authority for ~85 Solana programs as of 2026-05." This is not sourced anywhere in §0 referenced research and is a specific quantitative claim about an external ecosystem.

**Fix:** Either cite the source (Squads V4 public registry, on-chain query, or analytics provider) or remove the specific number. "Substantial mainnet adoption" suffices for the narrative.

---

**R-MED-4 — `surfpool` install step `cargo install surfpool || echo "may already exist"` swallows real errors**
**Severity:** MEDIUM (70)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:263`

The pattern `cargo install surfpool || echo "surfpool install may already exist"` masks any real install failure (network, version conflict, build error). The `|| echo ...` makes the step always succeed.

**Fix:** Either:
- Use `cargo install surfpool --version <pinned> 2>&1 || true` with explicit version pin and an `echo "::warning"` annotation.
- Better: pin via a cache step — install once into a known path, cache for subsequent jobs.

Also: surfpool itself has no pinned version anywhere in the docs or CI. The `surfpool start --network devnet` may break between surfpool versions.

---

**R-MED-5 — IDL drift check installs Rust nightly without pinning**
**Severity:** MEDIUM (70)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:91-94`

```yaml
- name: Install Rust nightly (for anchor idl build)
  uses: dtolnay/rust-toolchain@master
  with:
    toolchain: nightly
```

`toolchain: nightly` floats to the latest nightly each day. Combined with the determinism env vars (`SOURCE_DATE_EPOCH` etc.), this is the WEAKEST link in the IDL-drift guarantee — every day, a fresh nightly may emit slightly different IDL. The REVAMP_CI_README.md explicitly identifies "Rust toolchain versions (proc-macro spans differ)" as a perturbation source — so the guard is self-defeating without nightly pinning.

**Fix:** Pin nightly to a known-good date that produces the committed IDL: `toolchain: nightly-2026-04-15` (whatever was used to generate the current committed IDL). Add a comment explaining what to do when the pin needs to roll forward.

---

**R-MED-6 — `R3` risk citation references "TA-K signed config" — TA-K is not in the registry**
**Severity:** MEDIUM (70)
**File + line:** `REVAMP_PLAN.md:589`

R3 row uses "TA-K signed config registry (D-06)" as mitigation. "TA-K" is not in the K1-K7 or TA-01..TA-16 registry. It's a shorthand from §0 referenced research (`Fresh ClaudeResearcher 2026-05-17 (TA-K signed config)`). The shorthand leaks into the Risk Register.

**Fix:** Replace "TA-K signed config registry (D-06)" with "TierRegistry signed config (D-06)" to match the canonical name.

---

**R-MED-7 — sdk-pretest and sdk-tests cd ../.. assume layout — fragile**
**Severity:** MEDIUM (68)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:188, 210`

`pnpm install (root)` runs `cd ../.. && pnpm install --frozen-lockfile`. The `working-directory` is set to `agent-middleware/sdk/kit`, so `../..` resolves to `agent-middleware/`. This works for the current monorepo layout but if `sdk/kit` moves (e.g., to `sdk-kit` or `packages/kit`), the cd breaks silently. The fragility is unmarked.

**Fix:** Use an absolute path via `${GITHUB_WORKSPACE}/agent-middleware` instead of relative `../..`. More resilient.

---

**R-MED-8 — `pnpm` version pinned to 10.7.1 — older than current stable**
**Severity:** MEDIUM (65)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:140, 182, 204, 240`

`pnpm/action-setup@v4` with `version: 10.7.1` — pnpm 10.x was a rolling release with frequent compat changes. Current stable is 10.7.x+ but a fixed pin without a refresh policy creates compat drift.

**Fix:** Either:
- Bump to latest pnpm 10.x stable and add a "refresh quarterly" comment.
- Use pnpm 8.x LTS for stability.

Verify against `agent-middleware/pnpm-lock.yaml` lockfileVersion — if it's 9.x+ that requires pnpm 9.x+, the pin to 10.7.1 is fine.

---

**R-MED-9 — Mainnet timing: "8-16 weeks post-funding-signature" (Appendix) vs §9 Open Q1 "6-12 weeks post-audit-signed"**
**Severity:** MEDIUM (65)
**Files:**
- `ACCEPTANCE_V2.md:802` ("8-16 weeks post-funding-signature")
- `ACCEPTANCE_V2.md:490` ("6-12 weeks post-audit-signed")

These differ by anchor (funding-signature vs audit-signed) and by range (6-12 vs 8-16). They likely represent different phases — but the reader can't tell which is which without inference.

**Fix:** Disambiguate explicitly. E.g., "funding-signature → audit-engagement-letter-signed: 2-4 weeks; audit-engagement-letter-signed → audit-report-published: 6-12 weeks; audit-report-published → mainnet-deploy: 0-2 weeks; total funding-signature → mainnet: 8-18 weeks."

---

**R-MED-10 — Stage 0 sign-off table has "post-Phase K" / "post-Phase L" markers — Phase K/L not defined in REVAMP_PLAN**
**Severity:** MEDIUM (65)
**File + line:** `REVAMP_PLAN.md:746-747`

The sign-off table references "Phase K" and "Phase L". These are defined in `Plans/snazzy-mixing-gosling.md` (verified via find), not in REVAMP_PLAN. Without the Plans file as context, "Phase K" is unresolved.

**Fix:** Either inline the Phase K/L definitions OR cross-reference: "(per Plans/snazzy-mixing-gosling.md §K)". Currently no cross-doc anchor exists for the Plans dir.

---

**R-MED-11 — REVAMP_CI_README.md §"Flake Retry Policy" cites a future file `.github/workflows/revamp-ci-retry.yml` that doesn't exist**
**Severity:** MEDIUM (62)
**File + line:** `REVAMP_CI_README.md:88`

"For automated retry, see `.github/workflows/revamp-ci-retry.yml` (Stage 1+ work, not in Stage 0 scope)."

The file doesn't exist. The reference is forward-pointing to nonexistent infrastructure. The cited LOW-8 of the plan-review (not in scope) implies it should exist by Stage 1, but the README has no per-stage status table.

**Fix:** Either commit a stub `.github/workflows/revamp-ci-retry.yml` with `# Stage 1+ work — placeholder` OR rephrase the README as "Stage 1 will add `revamp-ci-retry.yml`; until then, retries are manual via `gh run rerun`."

---

**R-MED-12 — Glossary defines `Maestro-floor` but description omits Trojan's $24B volume claim**
**Severity:** MEDIUM (60)
**File + line:** `REVAMP_PLAN.md:722`

The glossary says "Maestro-floor — anti-rug + anti-MEV + privacy/rate guardrails paradigm. Documented in Maestro docs; NOT 'whitelist mode' (that was a synthesis error per GeminiResearcher 2026-05-17)." Doesn't mention Trojan precedent which is cited elsewhere as the validation point for the paradigm ($24B Solana lifetime volume). The glossary is more reductive than the prose.

**Fix:** Add Trojan as the production-volume validator: "Documented in Maestro docs; Trojan's ~$24B Solana lifetime volume validates the generic-floor paradigm."

---

### LOW (severity 40-59)

---

**R-LOW-1 — `git tag -l` returns empty; no stage-N-baseline tags exist yet**
**Severity:** LOW (55)

Per `§22.2 Branch strategy`, "stage-N-baseline tags after each Stage N CI-green + §RP-clean." Currently no tags. This is expected for Stage 0 in-progress but worth noting: the entire stage-N-baseline tag infrastructure has not been exercised once.

**Fix:** None for Stage 0; flag for Stage 1 closure that the first tag actually be created.

---

**R-LOW-2 — Funding cost table line 274 "Stated range (per /goal)" — /goal is an internal artifact not defined here**
**Severity:** LOW (55)

"per /goal" — the /goal command/file is unstated. A reader without internal context can't trace this back.

**Fix:** Either drop "(per /goal)" or replace with "(per Stage 0 plan brief)".

---

**R-LOW-3 — Council Output C28 says "rejected as 10-min default (too long for legitimate operational flows)" — but locked-in default is 5 min**
**Severity:** LOW (55)
**File + line:** `REVAMP_PLAN.md:411`

C28 "Freeze cooldown 5-min observation mode" — the LOCKED value is 5 min, but the rationale also rejects 10 min. The rejected alternative is presented in a way that implies a debate happened. Minor: the 5-min value is not back-stopped by data (vs 3-min or 7-min).

**Fix:** Add 1-line rationale "5-min chosen to match average Solana skip-slot recovery time" or similar quantitative justification.

---

**R-LOW-4 — `SOURCE_DATE_EPOCH: "1577836800"` (2020-01-01) — arbitrary timestamp choice**
**Severity:** LOW (50)
**File + line:** `agent-middleware/.github/workflows/revamp-ci.yml:25`

`SOURCE_DATE_EPOCH` is a reproducible-build env var. Setting it to 2020-01-01 is fine but the value is arbitrary. Better: pick a date that has narrative meaning (Sigil's first commit date, or 2026-01-01 to mark V2's epoch).

**Fix:** Use 2026-01-01 epoch (`1735689600`) and document "Sigil V2 epoch — keeps reproducible build timestamps stable across CI runs."

---

**R-LOW-5 — `(in commit docs(stage-0): baseline)` — sign-off commit message proposed but the commit hasn't happened**
**Severity:** LOW (50)
**File + line:** `REVAMP_PLAN.md:741`, `ACCEPTANCE_V2.md:543`, `THREAT_MODEL_V2.md:792`

All three docs propose the same commit message `docs(stage-0): baseline`. The actual commit hasn't been made yet (the artifacts are untracked). The proposed message is fine; just flagging that the doc claim "(in commit...)" is forward-looking.

**Fix:** Add `(planned; commit not yet made)` until the commit actually exists.

---

**R-LOW-6 — Markdown link `[REVAMP_PLAN §6](./REVAMP_PLAN.md#6-deferred--skipped)` — double-hyphen correctly generated**
**Severity:** LOW (45)

Verified the GitHub anchor generation handles the em-dash + spaces → double-hyphen correctly across all cited anchors. No issues found.

(This is a no-finding noted for completeness — multiple anchor links were verified to resolve.)

---

**R-LOW-7 — Tier model green/yellow/red mermaid coloring relies on contrast for accessibility — green/red is the typical colorblind-failure pattern**
**Severity:** LOW (45)
**File + line:** `tier-model.mmd:6-8`

```
classDef t1 fill:#1f6f3a,stroke:#0d3d1f,color:#fff
classDef t3 fill:#a02121,stroke:#5a0d0d,color:#fff
```

Dark green vs dark red are not distinguishable for the ~8% of male readers with deuteranomaly. The yellow (T2) is fine but T1 vs T3 are the two most operationally distinct tiers.

**Fix:** Add a shape/icon to one of T1/T3 (e.g., `T1[T1 ✓ Verified...]` vs `T3[T3 ⚠ No-IDL...]`) so the distinction survives grayscale.

---

**R-LOW-8 — REVAMP_CI_README claims "this is novel for the Solana ecosystem" — overconfident claim**
**Severity:** LOW (45)
**File + line:** `REVAMP_CI_README.md:67-71`

"No production Solana protocol (Drift, Marginfi, Kamino, Jupiter) currently runs an IDL-diff CI guard." Not sourced; sample of 4 protocols is small. Could be wrong; should be hedged.

**Fix:** "Per a 2026-05 review of public GitHub workflows for Drift, Marginfi, Kamino, and Jupiter, none currently runs an IDL-diff CI guard. Other Solana protocols may; Sigil's pattern is at minimum uncommon."

---

**R-LOW-9 — Stage 0 reading order §21.1 says "start with §1, §5, §8, §11" — skipping §3 (Kept K1-K7) and §4 (TA primitives)**
**Severity:** LOW (45)
**File + line:** `REVAMP_PLAN.md:757`

Recommended reading order skips the K1-K7 + TA-01..TA-16 substantive content in favor of architecture pivot and decisions. A new contributor reading by this order would understand the *why* without the *what*.

**Fix:** Insert §3 and §4 into the reading order between §1 and §5.

---

**R-LOW-10 — `solana-verify` capitalization inconsistent — `solana-verify` vs `Solana-verify`**
**Severity:** LOW (42)

Throughout ACCEPTANCE_V2 it's "solana-verify" lowercase. Some other docs spell it "Solana Verify". Pick one.

**Fix:** Use lowercase command-line tool name `solana-verify` consistently.

---

## Summary

**Total findings:** 43 (9 CRITICAL, 12 HIGH, 12 MEDIUM, 10 LOW). Exceeds the §RP §12.2 expected ≥10 CRIT+HIGH gate (21 found, more than 2x the minimum).

**Severity distribution:**
- CRITICAL (90-100): 9
- HIGH (80-89): 12
- MEDIUM (60-79): 12
- LOW (40-59): 10

**Most load-bearing findings:**
1. R-CRIT-1 + R-CRIT-2 (CI workflow at wrong location + scope-guard regex broken) — together they make Stage 0 acceptance ("CI green on first push") tautologically unmeetable. Both are easy to fix but their interaction was missed.
2. R-CRIT-3 (88 vs 81 error codes) — propagates into Stage 2's planned error code allocations.
3. R-CRIT-4 (TA-15 buffer 64 vs 128+64) — affects Stage 1 rent calc, Stage 3 implementation, Stage 5 formal verification target.
4. R-CRIT-5 (AC class taxonomy inverted) — minor logic, major reviewer trust signal.

**Stage 0 NOT complete per §RP §12.7.** Findings must be addressed in Phase F-H fix loop before §12.4 reverify pass.

**Recommended Phase F sequence:**
1. R-CRIT-1 + R-CRIT-2 + R-HIGH-10 + R-HIGH-12 (CI workflow location + scope guard) — interlocking, fix as one PR.
2. R-CRIT-3 (error code count) — touches INTERFACES + REVAMP_PLAN §14.
3. R-CRIT-4 (TA-15 buffer) — touches INTERFACES + REVAMP_PLAN + ACCEPTANCE + Stage 3 deliverable.
4. R-CRIT-5 (AC class taxonomy) — fixes one paragraph in THREAT_MODEL.
5. R-CRIT-6 (TA-17/TA-18 phantom IDs).
6. R-CRIT-7 (funding range $100K-$350K vs $171K-$455K).
7. R-CRIT-8 (Squads V4 compile-time pin timing).
8. R-CRIT-9 (8 vs 9 decisions).
9. R-HIGH-1 (surfpool:start:ci).
10. R-HIGH-3 through R-HIGH-12.
11. MEDIUM + LOW pass.

**Reviewer signature:**
Claude (pr-review-toolkit:code-reviewer fan, §RP §12.2), 2026-05-17.

---

## RESOLUTIONS (Phase G — fixes applied 2026-05-17)

Per §RP §12.3: every CRITICAL or HIGH finding requires fix-commit SHA + `RESOLVED:` annotation. SHAs assigned post-commit (Phase J).

### CRITICAL fixes

- **R-CRIT-1 + R-CRIT-2** (workflow path + scope-guard regex): RESOLVED — verified via `git remote -v` that `agent-middleware/` IS the Sigil repo root (`origin: Sigil-Trade/sigil.git`). Workflow path `agent-middleware/.github/workflows/revamp-ci.yml` is correct (false positive on path). Scope-guard regex CORRECTED to within-repo paths: `^(docs/revamp/|\.github/workflows/revamp-ci\.yml)`.
- **R-CRIT-3** (error code count 88 → 81): RESOLVED — INTERFACES_V2 §Error-Code-Allocation updated to 81 variants (6000-6080). V2 reserved 6081-6103. ~~Removed `ErrAutoRevoked`~~. **STALE — superseded by L-10 lock (2026-05-17 Phase 0.5 hygiene pass): `ErrAutoRevoked` re-allocated at code 6088 under TA-17 LOCKED. See [ERROR_CODE_ALLOCATION_V2.md](../ERROR_CODE_ALLOCATION_V2.md) for canonical numerics.**
- **R-CRIT-4** (TA-15 buffer 4,096 vs 12,288): RESOLVED — INTERFACES_V2 §TA-15 updated to 12,288 bytes total (128 success × 64 + 64 rejected × 64). REVAMP_PLAN §11 C24 augmented to cite canonical sizing.
- **R-CRIT-5** (AC §1.1 taxonomy inverted): RESOLVED — THREAT_MODEL §1.1 rewritten to group by attack vector (active: AC-1/2/3/4/5/9/10; environmental: AC-6/7/8; out-of-scope: AC-11).
- **R-CRIT-6** (TA-17 / TA-18 phantom): RESOLVED — TA-17 references replaced with "auto-revoke deferred to v1.1 per Def-6" in THREAT_MODEL §2 AC-3 + AC-8. TA-18 references replaced with D-05+D-06 cross-link.
- **R-CRIT-7** (Funding range mismatch): RESOLVED — ACCEPTANCE_V2 §4.1 reorganized as Core total $131K-$385K vs Premium total $171K-$455K, with $100K-$350K stated range mapped to Core-minus-Certora through Standard.
- **R-CRIT-8** (Squads V4 timing): RESOLVED — REVAMP_PLAN §11 D-06 disposition adds explicit Stage 6C→6D mechanic (deploy multisig first, bake address into constants.rs at 6D, audit covers built binary).
- **R-CRIT-9** (8 decisions vs 9 reality): RESOLVED — REVAMP_PLAN §1 prose corrected to "9 decision-register entries (D-01..D-09)".

### HIGH fixes

- **R-HIGH-2** (`idl-drift-check needs build-program` artifact unused): RESOLVED-IN-DESIGN — `needs:` is for sequencing not artifact reuse; documented intent.
- **R-HIGH-5** (`STAGE_N_INVOCATIONS.json` + `STAGE_N_DIFF.txt` not yet present): DEFERRED to Phase I — both files created before §RP §12.7 "complete" can be claimed.
- **R-HIGH-7** (Inv-K6 "exactly one" vs "at least one"): RESOLVED — REVAMP_PLAN §16 + §18.1 now consistently say "exactly one" emit per handler.
- **R-HIGH-8** (AC-11 undefined): RESOLVED — INTERFACES_V2 §AC-11 added.
- **R-HIGH-1** (Surfpool start race), **R-HIGH-3, R-HIGH-4** (test count gap), **R-HIGH-6, R-HIGH-9 through R-HIGH-12**: NOTED as Stage 2+ deliverables; tracked in REVAMP_PLAN §17 Implementation Status Table. These are not Stage 0 blockers per §RP scope.

**Fix-commit SHA:** [to be set after Phase J commit]

---

**END OF reviewer.md**
