# STAGE_0_REVIEW/hunter.md — Silent-Failure Hunter Transcript

**Reviewer:** pr-review-toolkit:silent-failure-hunter (Opus 4.7)
**Date:** 2026-05-17
**Branch:** `revamp/v2-2026-05`
**Scope:** Stage 0 baseline artifacts (7 files)
- `agent-middleware/docs/revamp/REVAMP_PLAN.md` (806 lines)
- `agent-middleware/docs/revamp/THREAT_MODEL_V2.md` (807 lines)
- `agent-middleware/docs/revamp/ACCEPTANCE_V2.md` (804 lines)
- `agent-middleware/docs/revamp/INTERFACES_V2.md` (189 lines)
- `agent-middleware/docs/revamp/tier-model.mmd` (83 lines)
- `agent-middleware/docs/revamp/REVAMP_CI_README.md` (143 lines)
- `agent-middleware/.github/workflows/revamp-ci.yml` (296 lines)

**Methodology:** §RP §12.2 hunter pass — silent failures, hidden assumptions, undefined terms, unenforced invariants, default-allow ambiguity, claim-without-enforcement, cascade dependencies, design contradictions between docs. Treat every reference, term, and number as a hypothesis until adversarially verified.

**Findings summary:** 14 CRITICAL + HIGH (target ≥10 met), 9 MEDIUM, 6 LOW.

---

## CRITICAL findings

### H-CRIT-1 — TA-15 buffer size contradiction between INTERFACES_V2 and REVAMP_PLAN §11 / §14 (canonical drift)

**Severity:** CRITICAL
**Files:**
- `agent-middleware/docs/revamp/INTERFACES_V2.md:86` says "last N=64 entries ... Buffer size: 64 × 64 = **4,096 bytes**"
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:171` says "64 entries × 64 bytes = 4,096 bytes"
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:260` open-question Q5 says "64 entries × 64 bytes = 4,096 bytes. `AgentVault` resize from 634 → ~4,730 bytes is a Stage-1 blocker"
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:403` C24 says "**SUPERSEDED by Stage 3-A separate-buffer design (128 success + 64 rejected isolated)**"
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:541` Stage 3 deliverable says "TA-15 audit-log circular buffer (128 success + 64 rejected separate buffers per C24)"

**Silent failure mode:** Two of four references say 64 total entries / 4,096 bytes (canonical IDL registry); two say 128+64 = 192 entries / 12,288 bytes (Stage 3 implementation plan). Stage 2 will be built against INTERFACES_V2's spec (4,096 bytes single buffer); Stage 3 will then "resize" to 12,288 bytes with C22 slot+blockhash, requiring an in-place account migration — exactly the catastrophic-class pre-V2 PDA decode failure mode listed in R9 of the Risk Register (CATASTROPHIC, "in-place upgrade"). The §RP §12.7 Vocabulary defines doc drift = CRITICAL; INTERFACES_V2 is the canonical source per its own header (`Cross-doc ID drift = §RP CRITICAL finding`). The drift is between INTERFACES_V2 and REVAMP_PLAN, the two highest-priority Stage 0 artifacts.

**Hidden errors:**
- Stage 2 acceptance gate ("≥95% LiteSVM branch coverage for new code") could pass against a 4,096-byte buffer and then Stage 3 will silently change the layout, breaking all Stage 2 fixtures.
- Architect 2026-05-17 dependency audit calls TA-15 ↔ K6 the highest-leverage single dependency; if its size is wrong, every load-bearing-5 acceptance gate built on it is built on the wrong target.
- The "AgentVault resize from 634 → ~4,730 bytes" calculation in Q5 is wrong if 12,288 bytes is the real target — vaults will run out of allocated space at Stage 3 and `realloc` may fail without explicit error handling.

**User impact:** Stage 2 implementation will pick whichever of the two specs the implementing engineer reads first. If they read INTERFACES_V2, Stage 3 breaks. If they read REVAMP_PLAN §11, INTERFACES_V2's "canonical" claim is a lie.

**Recommended fix:** Pick one. Recommend C24's 128+64 design (it's documented as superseding the 64-entry plan). Update INTERFACES_V2.md TA-15 entry to say "two separate buffers: success_buffer 128 × 64 = 8,192 bytes + rejected_buffer 64 × 64 = 4,096 bytes = **12,288 bytes total**". Update REVAMP_PLAN §4.3 TA-15 + §7 Q5 to reflect new total + new vault size delta. Re-derive rent cost.

**Example:**
```diff
- ### TA-15 — Audit-log circular buffer (with N1 temporal binding per C22)
- In-vault circular buffer of last N=64 entries: `(...)`. Buffer size: 64 × 64 = **4,096 bytes**. Tiers: T1, T2, T3.
+ ### TA-15 — Audit-log circular buffer (with N1 temporal binding per C22)
+ Per C24 design: TWO separate buffers — success buffer (128 entries) + rejected buffer (64 entries),
+ each entry 64 bytes. Total: (128 + 64) × 64 = **12,288 bytes**. Both bound by C22 slot+blockhash. Tiers: T1, T2, T3.
```

---

### H-CRIT-2 — Undefined ID "TA-17" referenced in THREAT_MODEL_V2 with active semantics; INTERFACES_V2 stops at TA-16

**Severity:** CRITICAL
**Files:**
- `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:122` — "TA-17 auto-revoke is INTENTIONALLY EXCLUDED from AC-3 mitigation (deferred per [REVAMP_PLAN §6](./REVAMP_PLAN.md#6-deferred--skipped)) — only counts policy-rejected bundles. Successful bug-exploits do NOT increment the failure counter and are NOT contained."
- `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:211` — "Force-revert a vault into a wedged state by triggering N consecutive CU failures (but TA-17 is excluded so this doesn't auto-revoke)."
- `agent-middleware/docs/revamp/INTERFACES_V2.md:39-89` — TA-NN registry stops at TA-16.
- `agent-middleware/docs/revamp/INTERFACES_V2.md:180` — `6103 ErrAutoRevoked (Sigil safety)` is reserved but its TA mapping is unstated.

**Silent failure mode:** TA-17 is referenced as if it has agreed-upon semantics (auto-revoke counter), but it has no canonical definition in INTERFACES_V2. A future implementer searching for "TA-17" gets zero hits in the ID registry and must reconstruct intent from THREAT_MODEL prose. Worse, an `ErrAutoRevoked` (6103) error code IS reserved, suggesting some auto-revoke logic IS planned for V1 — but its TA number, trigger condition, threshold, decrement rules, and reset semantics are all unspecified. This is **exactly** the silent-failure pattern §RP exists to catch: an active error path with no canonical specification of what fires it.

**Hidden errors:**
- Auditors will ask "what fires `ErrAutoRevoked`?" and get inconsistent answers.
- The `T-DoS-1` rate-limit logic ("at most 1 increment per `cooldown_seconds` window") references a counter that has no specified backing PDA field, no max threshold, no reset mechanism.
- Stage 2 will reserve error code 6103 without implementing the handler that emits it (or worse, implement it differently than T-DoS-1 prose assumes).
- Concurrent attacker spam vs legitimate operations during a TA-13 cap window: ambiguous what counts as "policy-rejected" vs "CU-exhausted" without a spec.

**Recommended fix:**
- Either: (a) define TA-17 properly in INTERFACES_V2 (PDA field, threshold, trigger conditions, rate limit, decrement on success) and add it to REVAMP_PLAN §4.x + the 16×10 matrix; or (b) drop the "TA-17" name entirely. Use phrasing like "auto-revoke counter (v1.1 deferred per §6)" without an ID claim.
- Reserve `ErrAutoRevoked` only if (a). Otherwise remove 6103 from the V2 reservation list.

---

### H-CRIT-3 — Undefined ID "TA-18" referenced in INTERFACES_V2 attacker-class glossary

**Severity:** CRITICAL
**File:** `agent-middleware/docs/revamp/INTERFACES_V2.md:101` — AC-2 "mitigated by Squads V4 multisig per TA-18 — handled at SDK layer"

**Silent failure mode:** "TA-18" appears exactly once in any Stage 0 doc, in the canonical ID registry's own glossary, and references nothing. INTERFACES_V2 self-defines TA-01..TA-16 only. The reader is told TA-18 exists at SDK layer but no spec, semantics, or ownership is given. This is the textbook silent failure: an authoritative-sounding cross-reference to nothing.

**Hidden errors:**
- A reader investigating "how is AC-2 mitigated?" follows the reference to TA-18 and finds no definition. They construct their own answer (likely "Squads V4 SDK detection helper") which is **not** an enforcement primitive at all — it's an off-chain heuristic. The doc reads as if there's an on-chain "TA-18" that mitigates AC-2; reality is the mitigation is off-chain only.
- This compounds with T-21 — the load-bearing trust assumption depends on owners using Squads V4. If the doc convinces a Stage 6 auditor that "TA-18" enforces this on-chain, they may not stress-test the off-chain heuristic.

**Recommended fix:** Either define TA-18 (as a TA primitive — but it isn't; Squads V4 SDK detection is workflow not primitive), or replace the reference with a workflow ID. Recommend `M-AC-2-1` (Squads V4 SDK detection helper, off-chain workflow) consistent with `M-T21-1..4` workflow naming.

```diff
- ### AC-2 — Owner key leak
- Single-key owner phishing / hardware compromise / key-management failure (mitigated by Squads V4 multisig per TA-18 — handled at SDK layer).
+ ### AC-2 — Owner key leak
+ Single-key owner phishing / hardware compromise / key-management failure. Mitigation is the
+ workflow recommendation D-05 (Squads V4 3-of-5 + 48-72hr timelock), enforced by SDK detection
+ helper (off-chain, not an on-chain primitive). No on-chain primitive blocks AC-2 — see
+ THREAT_MODEL_V2.md §2 AC-2 residual.
```

---

### H-CRIT-4 — Stage 6 sub-deliverable "Stage 6 D2" is not defined; conflicts with Stage 6D / 6E / 6F naming

**Severity:** CRITICAL
**Files:**
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:392` — "Implementation in **Stage 6 D2** (deferred from Stage 2 to avoid scope creep; Kaleb confirmed default)."
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:405` — "**C25** Tier registry signed config — Stage 6 D2 (deferred from Stage 2 to avoid scope creep)."
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:564-572` — Stage 6 sub-deliverables are 6A, 6B, 6C, **6D**, 6E, 6F. There is no "Stage 6 D2".

**Silent failure mode:** TierRegistry implementation — the **load-bearing primitive for D-06 asymmetric multisig threshold** — is gated on "Stage 6 D2", which does not exist. Either it means Stage 6D (TierRegistry deployment, which is the right step), or it means a sub-substage that hasn't been named anywhere. The reader cannot tell. Stage 6D in §14 says "TierRegistry deployment" with no "D2" branch.

**Hidden errors:**
- A Stage 6 executor following §14 will deploy TierRegistry per 6D, satisfying the C25 disposition by accident.
- A Stage 2 executor reading §11 might infer "Stage 6 D2 means Stage 6 has a sub-step D2 I should add" and create scope creep.
- The Stage 6 critical path summary at the end of ACCEPTANCE_V2 doesn't mention "6 D2" — auditors get a Stage 6 critical path that doesn't match REVAMP_PLAN's §11 LOCKED disposition.

**Recommended fix:** Replace every "Stage 6 D2" with "Stage 6D" or rename the sub-deliverable canonically.

---

### H-CRIT-5 — Default-deny ambiguity in TA-01/TA-02 init paths: silent "permit-all" when allowlist Vec is empty

**Severity:** CRITICAL
**Files:**
- `agent-middleware/docs/revamp/INTERFACES_V2.md:44` — "TA-01 ... `PolicyConfig.allowed_protocols: Vec<Pubkey>` runtime-bounded to 10. Default-deny. Entry guard rejects any seal() whose next DeFi-instruction program ID is absent."
- `agent-middleware/docs/revamp/INTERFACES_V2.md:47` — "TA-02 ... `PolicyConfig.allowed_destinations: Vec<Pubkey>` runtime-bounded to 10. Default-deny per Ondo USDY precedent."

**Silent failure mode:** "Default-deny" is asserted but the semantic of an **empty** `Vec` is not specified. There are two valid readings: (a) empty Vec = deny-all (vault unusable until owner adds a protocol; truly default-deny) or (b) empty Vec = "absent" = the test "is `next_program_id` in the Vec?" returns false, so deny. Both result in deny-all-when-empty in the success case. However, what if the implementation reads "empty Vec means policy not yet configured, so be permissive" — that's exactly the DEEP-1 strict_mode permissive-default bug that v2 set out to remove. The doc does not pin which semantic is mandatory.

**Hidden errors:**
- A Stage 2 implementer may follow the "ergonomic" path of "if Vec is empty, skip the check" to avoid bricking new vaults during testing. This silently re-creates DEEP-1.
- Stage 6 audit must specifically test "empty allowlist Vec → deny-all" but the test is not specified anywhere in §3.6 test coverage.

**Recommended fix:** In INTERFACES_V2 TA-01 + TA-02 + ACCEPTANCE_V2 §3.6, explicitly add:

```
Empty Vec semantics: an empty allowed_protocols / allowed_destinations Vec means
deny-ALL, NOT "policy not yet configured". The vault is intentionally unusable
until the owner explicitly adds at least one entry. Implementations that treat
empty Vec as "allow all" reintroduce DEEP-1 strict_mode-permissive-default and
are §RP CRITICAL.
```

Add a Stage 2 acceptance test fixture: empty `allowed_protocols` → `validate_and_authorize` rejects every seal with `ErrProtocolNotAllowed`.

---

### H-CRIT-6 — "Load-bearing 5" depends on K6 emit fidelity but no Stage 0 acceptance gate enforces K6 today; Stage 2 gate is forward-looking only

**Severity:** CRITICAL
**Files:**
- `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:302-314` — T-K6-1: "if a code path silently drops an `emit!(...)` call ... Stage 2 acceptance gate: CI static check that every `pub fn` in `lib.rs` calls `emit!(...)` at least once before `Ok(())`."
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:618` — load-bearing 5 explicit gate "K6 event emission: CI static check that every `pub fn` in `lib.rs` calls `emit!(...)` at least once before `Ok(())`."
- `.github/workflows/revamp-ci.yml:27-296` — workflow has scope-guard, build-program, idl-drift-check, litesvm-tests, sdk-pretest, sdk-tests, cargo-unit-tests, surfpool-tests. **No K6 static check job.**

**Silent failure mode:** The doc claims K6 is load-bearing 5 (highest-leverage single dependency) and the gate is a "Stage 2 acceptance gate" + "CI static check". But Stage 0 IS the baseline. If a refactor between Stages 0 and 2 silently drops an `emit!(...)`, the Stage 2 gate hasn't been built yet, so it will not catch. This is a temporal silent failure: the gate exists in doc only, not in code.

Worse, Stage 2's gate is specified at the prose level — there is no committed `scripts/k6_emit_check.sh` template, no example regex, no test corpus. Stage 2's implementing engineer will write *some* check, then later stages will rely on its fidelity without ever verifying the check itself catches the failure modes.

**Hidden errors:**
- A K6 emit dropped during Stage 1 demolition (which renames + collapses paths) will not be caught by Stage 1's `pnpm test` (events are not asserted on the existence side, only on the content of emitted events).
- A static-check that uses naive regex (`grep emit!`) will pass for `// emit!(...)` (commented out) or `let _emit = emit!(...);` (suppressed).

**Recommended fix:**
- Make K6 static check a Stage 0 deliverable. Add a `k6-emit-check` job to `revamp-ci.yml` that parses `lib.rs` with `syn` (Rust syntax tree, not regex) and confirms every public function has at least one `emit!` call in its happy path. This is ~50 lines of Rust.
- Document the exact check semantics + corpus of patterns that must trip it (commented-out emit, suppressed emit, dead-code-after-emit, error-path-before-emit).
- Without a Stage 0 implementation of this check, every claim that "K6 is load-bearing 5 with a gate" is an unenforced invariant — §RP CRITICAL.

---

## HIGH findings

### H-HIGH-7 — `[OPTIONAL: Kaleb's narrative on this item — leave blank if no addition]` markers in REVAMP_PLAN §11 have undefined §RP re-trigger semantics

**Severity:** HIGH
**File:** `agent-middleware/docs/revamp/REVAMP_PLAN.md:388, 393, 395, 400, 402, 404, 406, 408, 410, 412, 417, 419, 421, 423, 430, 432, 434` — 16 `[OPTIONAL: Kaleb's narrative...]` markers in §11

**Silent failure mode:** §11 LOCKED dispositions contain optional Kaleb-narrative slots. The intro says "The only [OPTIONAL] markers are for Kaleb's narrative additions; absence of narrative does not block any later stage." But:
- If Kaleb later adds narrative to one of these (post-baseline), does §RP need to re-run on the modified docs? §RP §12.1 trigger says "Every Stage N (1, 2, 3, 4, 5, 6) MUST execute §RP after Phase E (Draft artifacts) and before any commit". So the answer is yes if the addition is part of a Stage commit, no if it's a "documentation-only" change outside Stage scope.
- §RP has no notion of "documentation-only" changes outside Stage scope. So an [OPTIONAL] fill-in either triggers full §RP (heavy) or evades §RP (silent failure: modifying a LOCKED §11 disposition without review).
- §18.2 doc checklist line "All `[OPTIONAL: Kaleb's narrative...]` markers in §11 either filled or explicitly accepted as blank" implies they must be addressed before Stage 5→6 handoff. So the doc *needs* them to be filled, but never says how.

**Hidden errors:**
- Kaleb's narrative could contradict the locked disposition (e.g., "C25 — actually I want this in Stage 2 not Stage 6"). Without a §RP gate, the contradiction enters the canonical baseline silently.
- §RP §12.7 "complete" requires §12.4 reverify but does not specify what triggers a NEW reverify pass.

**Recommended fix:**
- In §11 intro, specify: "Filling an [OPTIONAL] marker post-baseline requires a documentation-only PR with §RP review-only mode (skip §12.4 reverify if no CRIT+HIGH found in narrative additions)."
- In §18.2 checklist line, replace "either filled or explicitly accepted as blank" with "marked `[ACCEPTED BLANK]` by Kaleb signature in the commit message, or filled via §RP-reviewed PR."
- §RP §12.x: add a sub-section "Documentation-only changes — §RP-lite triggers: only run hunter on the diff."

---

### H-HIGH-8 — TA-10 (load-bearing 5) ceiling specification has unstated upper-bound failure mode: bundle with >4 pairs

**Severity:** HIGH
**File:**
- `agent-middleware/docs/revamp/INTERFACES_V2.md:70-71` — "TA-10 ... asserts: (a) 1..=4 `validate_and_authorize` + `finalize_session` pairs in transaction"
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:163` — same wording

**Silent failure mode:** Two unstated invariants in TA-10:
1. The behavior when there are **zero** validate/finalize pairs (a legitimate non-Sigil tx posted to the same program ID) — does TA-10 reject, or does it bypass-and-permit? The doc says "1..=4 pairs" but the trigger condition for TA-10 firing in the first place is unspecified. If a tx contains zero Sigil instructions but is somehow routed to TA-10, the natural behavior is no-op — but the doc reads as if every transaction is gated by TA-10.
2. The behavior when there are **5+** pairs (a malicious tx that crafts the bundle to exceed the upper bound) — does the *whole tx* revert, or does TA-10 silently accept the first 4 pairs and skip the 5th? The "1..=4" assertion implies revert, but doesn't say which error code or which path.

**Hidden errors:**
- An attacker who finds a way to craft a 5-pair bundle, with the 5th pair containing the actual drain instruction, could bypass TA-10 if the implementation skips pairs >4.
- Stage 2 implementers might code "for i in 0..4 { check_pair(i); }" — a 5th pair is silently ignored.

**Recommended fix:** Specify exactly:
- `validate_and_authorize` count == 0 → no-op, this ix not in tx, irrelevant.
- `validate_and_authorize` count in 1..=4 → process all.
- `validate_and_authorize` count > 4 → revert tx with `ErrSandwichIntegrity` (or new code `ErrTooManyPairs`). Mandatory unit test: 5-pair tx → revert with the specific error code.

---

### H-HIGH-9 — INTERFACES_V2 §AC-9 N3 "reservation" promise conflicts with REVAMP_PLAN §1.3 "N3 — not used in Sigil V1" — undefined precondition for v1.1 enable

**Severity:** HIGH
**Files:**
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:79` — "(N3 — not used in Sigil V1. Reserved for future signer-introspection use cases. Deferred to T1 v1.1 per D-09 / §6 Deferred.)"
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:238` — Deferred row D3: "N3 multi-account snapshot (signer-introspection) for T1 v1.1"
- `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:570` — Open Question 3 "AC-9 N3 reservation: We skip N3 in V1. Document the use cases that would justify adding N3 (signer-introspection) for v1.1 — likely TEE/MPC custody integrations."

**Silent failure mode:** N3 is "reserved" but no precondition is stated for what would trigger v1.1 enablement. The reader is told "TEE/MPC custody integrations" might want it, but no acceptance criteria, no detection signal, no scope. This is precisely the "claim without enforcement" failure: a deferral is committed but its un-deferral is left unowned.

Worse, REVAMP_PLAN §6 D3 cites "T1 v1.1" — but T1 is defined as the *Verified Tier* (10 protocols), not a Sigil version. So the reader can't tell if the deferral means (a) v1.1 (next version) of Sigil for T1-tier protocols, (b) version 1.1 of the T1 protocol parser, or (c) something else.

**Hidden errors:**
- A v1.1 implementer will need to invent the trigger condition, which may differ from what Stage 0 reviewers expected.
- TEE/MPC custody adapters (per memory: `@usesigil/custody`) might already exist and might already need N3 — the deferral doesn't check existing scope.

**Recommended fix:**
- Rename "T1 v1.1" to "Sigil v1.1 for T1 tier" or just "v1.1".
- Add to REVAMP_PLAN §6 D3 a concrete trigger condition: "Enable N3 when first design partner uses `@usesigil/custody/turnkey` AND requests multi-account signer-introspection for a multi-step LP rebalance flow."

---

### H-HIGH-10 — `ErrAutoRevoked` (error code 6103) reserved without spec; auto-revoke logic is deferred per §6 but error code stays

**Severity:** HIGH
**Files:**
- `agent-middleware/docs/revamp/INTERFACES_V2.md:180` — "6103 `ErrAutoRevoked` (Sigil safety)"
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:268` — T-DoS-1: "Auto-revoke is excluded from V1 Tier A (deferred per §6 — not as TA-NN; reserved for v1.1 once UX patterns settle)."

**Silent failure mode:** An error code is reserved that **no V1 path can emit** (because the underlying primitive is deferred to v1.1). This is a silent-failure cascade: a Stage 2 implementer who reserves 6103 must implement a handler that *cannot fire* in V1. Either they (a) leave an unreachable branch (dead code, prone to bit-rot regression), (b) implement a partial version of TA-17/auto-revoke that emits 6103 (re-enables the deferred feature without §RP review), or (c) skip 6103 (and INTERFACES_V2 silently goes stale).

**Hidden errors:**
- The error-code allocation table reads as if 6103 will fire in V1 — audit firms might write tests assuming it does.
- C27 freeze_reason enum (Manual, AutoRevoke, EmergencyBoard) reserves an AutoRevoke variant but the autorevoke primitive is deferred. So the enum variant is unreachable in V1.

**Recommended fix:**
- Move 6103 to the "6106-6110 Reserved for V2.x additions" block.
- Drop the AutoRevoke variant from C27's freeze_reason enum (Stage 1) and add it back when v1.1 auto-revoke lands.

---

### H-HIGH-11 — IDL diff CI check uses nightly Rust but no toolchain-version pin; Rust nightly is non-deterministic

**Severity:** HIGH
**Files:**
- `.github/workflows/revamp-ci.yml:94` — "toolchain: nightly" (no version pin)
- `.github/workflows/revamp-ci.yml:115` — "RUSTUP_TOOLCHAIN=nightly anchor idl build"
- `agent-middleware/docs/revamp/REVAMP_CI_README.md:54-63` — "Per CodexResearcher 2026-05-17, Anchor IDL output is non-deterministic across: Anchor CLI versions ... Rust toolchain versions (proc-macro spans differ)"

**Silent failure mode:** The IDL diff check uses **unpinned nightly Rust** (`dtolnay/rust-toolchain@master` + `toolchain: nightly`). REVAMP_CI_README explicitly lists "Rust toolchain versions (proc-macro spans differ)" as a determinism perturbation source. The CI run on Day N uses nightly-N. The CI run on Day N+1 uses nightly-(N+1). If proc-macro spans differ between them, the IDL diff fails on the second run even though no source code changed.

**Hidden errors:**
- IDL diff CI becomes a flake — passing today, failing tomorrow on a re-run of the same commit.
- The "retry up to 2×" flake policy from REVAMP_CI_README §Flake Retry Policy will mask this — engineers retry until passing, then ship.
- The IDL diff guard was specifically called out as "load-bearing new check" — its flakiness undermines the §RP claim that v2 catches drift.

**Recommended fix:** Pin nightly to a specific date:
```yaml
- name: Install Rust nightly (for anchor idl build)
  uses: dtolnay/rust-toolchain@master
  with:
    toolchain: nightly-2026-05-15  # pinned per H-HIGH-11; bump only via documented review
```
Document in REVAMP_CI_README the nightly-bump procedure (when, why, who).

---

### H-HIGH-12 — Stage 4b on-chain `SessionAuthority.preview_digest` field is unscheduled in Stage 1 demolition baseline

**Severity:** HIGH
**Files:**
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:551` — "Stage 4b: `preview_digest` field on `SessionAuthority` on-chain."
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:632` — Stage table: K2 Session keys: "Stage 4: + preview_digest"
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:519-527` — Stage 1 deliverables do NOT include `preview_digest`.

**Silent failure mode:** `SessionAuthority` layout is changed at Stage 4 to add a new field. Stage 1 demolition includes a separate AgentVault layout change (per memory: `project_sigil_audit_deep_2026_05_11.md` HIGH-2 — Pre-V2 PDAs decode catastrophically with new layout). If Stage 4's `preview_digest` is a layout-changing add, Stage 4 needs **another** new program ID (or in-place migration risk like R9 CATASTROPHIC).

The Stage 6F runbook (ACCEPTANCE_V2.md §15.4) says "Generate new mainnet program ID (do NOT reuse devnet)". This handles Stage 1 demolition's layout shift. But Stage 4b's additional layout shift is **between** Stage 1 and Stage 6F. There's no acknowledgment in the doc that Stage 4b might also need a layout-rev acceptance gate.

**Hidden errors:**
- Stage 4b implementation might claim "we can add `preview_digest` via `realloc` without a new program ID" — silently re-introducing R9.
- Stage 6F's "single new program ID" plan might be insufficient if multiple layout changes accumulate between Stage 1 and Stage 6.

**Recommended fix:**
- Add explicit note in REVAMP_PLAN §14 Stage 4 deliverables: "Stage 4b `preview_digest` is a `SessionAuthority` layout change. Sessions are short-lived (TTL-bounded per K2); existing sessions expire naturally within K5 timelock window. Stage 4b is safe with `realloc` IF and only if all extant sessions expire before Stage 4b deploys."
- Or: bundle `preview_digest` into Stage 1's layout work so there's only one layout shift before Stage 6F redeploy.

---

### H-HIGH-13 — §4 Funding Plan `[SIGNATURE PENDING]` has no operational semantics: PDF signature, on-chain signature, or verbal commitment?

**Severity:** HIGH
**Files:**
- `agent-middleware/docs/revamp/ACCEPTANCE_V2.md:316-329` — Signature block
- `agent-middleware/docs/revamp/ACCEPTANCE_V2.md:331` — "This signature gate blocks Stage 6E ... Kaleb commits externally before Stage 6E."
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:745` — Stage 0 Sign-off table: "Funding signoff | Kaleb Rupe | (in `ACCEPTANCE_V2.md §4 [SIGNATURE PENDING]`) | (pre-Stage 6E)"

**Silent failure mode:** "Signed: ____________________________ [SIGNATURE PENDING]" — the doc has a typographic signature line in a Markdown file. There is no:
- Filename of a signed PDF artifact (e.g., `docs/audits/funding_commitment_signed_<date>.pdf`).
- On-chain commitment artifact (e.g., a memo transaction signed by Kaleb's owner key committing to a specific scenario).
- Reference to a corporate document.
- Date of the commitment / signature.

"Kaleb commits externally before Stage 6E" — what does "externally" mean? An email? A Notion page? A handshake?

This is the **§RP precision** failure mode: the doc uses vocabulary ("signed", "committed") without operational definition. A reviewer 12 months out will ask "is this signed?" and the only honest answer is "the markdown line is unchanged from Stage 0; what does signed mean here?"

**Hidden errors:**
- Stage 6E executor may treat any commit message ("docs: Kaleb selected Scenario B") as the signature, but that doesn't bind anyone to anything.
- An external investor or auditor reading this doc as part of due diligence finds an unsigned funding plan and treats it as unfunded — not "signed and confidential".

**Recommended fix:**
- Define exactly what "signed" means: e.g., "Kaleb publishes a signed PDF at `agent-middleware/docs/funding/COMMITMENT_<date>.pdf` countersigned by an independent witness (advisor, attorney) OR an on-chain memo transaction from Kaleb's owner key with payload `funding-commit-v1:<scenario>:<date>`."
- Specify how Stage 6E executor verifies the commitment exists.
- The §RP review explicitly should never accept a markdown-line-only commitment as the funding gate.

---

### H-HIGH-14 — Hidden default-allow: T2 "structural-only" enforcement omits TA-09 / TA-13 / TA-14 from listed coverage but the matrix says they apply

**Severity:** HIGH
**Files:**
- `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:415` — T2 guarantees: "TA-01, TA-02, TA-03, TA-04, TA-05, TA-06, TA-07, TA-08, TA-09, TA-10, TA-11, TA-12, TA-13, TA-14, TA-15 (15 of 16; TA-16 is T1-only)."
- `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:428` — T3 guarantees: "TA-01, TA-02, TA-03, TA-08, TA-10, TA-11, TA-12 (7 of 16)."
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:213-214` — T3 enforcement: "TA-01, TA-02, TA-03, TA-08, TA-10, TA-11, TA-12, plus K1-K7."

So T3 has 7 TA primitives — but **TA-04 (capability split), TA-05 (operating hours), TA-06 (cooldown), TA-07 (first-time friction), TA-09 (cosign), TA-13 (rolling 24h tracker), TA-14 (per-recipient cap), TA-15 (audit log)** are not active in T3.

**Silent failure mode:** TA-13 (rolling 24h tracker) — which the threat model AC-1 mitigation **specifically depends on** ("TA-13 rolling 24h tracker: cannot exceed `daily_cap_usdc_face` regardless of policy weakness") — is **silently OFF for T3 protocols**. A vault with even one T3 protocol allowlisted has a per-protocol rolling tracker that doesn't apply to T3 calls. The AC-1 blast-radius analysis claiming "MEDIUM" residual is wrong for T3-only vaults; the residual is **CATASTROPHIC**.

Similarly, TA-04 (capability split — DISABLED/OBSERVER/OPERATOR) silently does not enforce in T3? That makes no sense (capability is per-session, not per-protocol). The doc lists T3 primitives by exclusion but never explains the rationale per-primitive — TA-04 *should* be tier-agnostic.

**Hidden errors:**
- An owner who allowlists a T3 protocol thinks "my $5K daily cap applies" — but it only applies to T1/T2 routes.
- Stage 2 implementation will need to per-instruction-class gate TA-13 firing on the target's tier — and if it gates incorrectly, T1/T2 caps may also be bypassed.
- The 16×10 matrix shows TA-13 has `✓` for AC-1 — true for T1/T2, false for T3. The matrix doesn't disambiguate.

**Recommended fix:**
- Re-derive T3 enforcement: TA-13 + TA-14 + TA-04 + TA-05 + TA-06 + TA-09 are session-level / policy-level, not protocol-aware. They SHOULD apply across tiers regardless.
- Update INTERFACES_V2 TA-NN definitions: be explicit which primitives are protocol-aware (T1/T2-only or T1-only) and which are session/policy-level (all tiers).
- Update §5 per-tier guarantees in THREAT_MODEL with the rationale per-primitive.
- Re-derive AC-1 / AC-5 blast-radius for T3-only vaults — if TA-13 truly doesn't apply, T3 vaults need an additional warning.

---

## MEDIUM findings

### H-MED-15 — Event names `SeskonAuthorized` / `SeskonRejected` are typos (Session, not Seskon)

**Severity:** MEDIUM
**File:** `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:695-696` — "`SeskonAuthorized` ... `SeskonRejected`"

**Silent failure mode:** Detection-signal taxonomy uses event names that aren't in the program. Dashboard wiring (per §3.4 IR runbook) will look for "SeskonAuthorized" and find nothing. K6 event-emission gate would pass (some event fires) but the documented event name doesn't match.

**Recommended fix:** Replace with `SessionAuthorized` / `SessionRejected` (or whatever canonical event name lives in K6 emit calls).

---

### H-MED-16 — REVAMP_CI_README references external plan file `Plans/snazzy-mixing-gosling.md` outside this repo's docs/

**Severity:** MEDIUM
**Files:**
- `agent-middleware/docs/revamp/REVAMP_CI_README.md:133` — "after the consultation-gated push (Phase K of the [snazzy-mixing-gosling plan](../../../Plans/snazzy-mixing-gosling.md))."
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:744-747` + line 463 — Phase E/F/G/H/K/L references with no in-repo definition

**Silent failure mode:** "Phase E", "Phase F-H", "Phase K", "Phase L" reference an out-of-tree plan file. If `Plans/snazzy-mixing-gosling.md` is deleted/moved/renamed (it's not under `agent-middleware/`, so it's outside the revamp scope-guard), the Stage 0 docs become anchor-broken. Stage 6 audit firm onboarding (per §14.1) is supposed to receive the Stage 0 docs — auditors get phase references that don't exist in the package.

**Recommended fix:**
- Move phase definitions into REVAMP_PLAN §12 §RP or §14 Stage Sequencing.
- Or define `Phase E .. L` inline in REVAMP_PLAN as the canonical definitions.

---

### H-MED-17 — Flake retry policy is human-only, not automated; not visible to PR reviewers

**Severity:** MEDIUM
**Files:**
- `agent-middleware/docs/revamp/REVAMP_CI_README.md:74-86` — "Retry policy ... If `cargo-build-sbf` fails: retry the run via `gh run rerun <run-id>` up to **2 times**".
- `.github/workflows/revamp-ci.yml` — no retry logic; CI fails on first failure.

**Silent failure mode:** The doc says "rerun up to 2× for flake retry" but the workflow itself has no auto-retry. So retries are manual. A PR reviewer sees a failed run and has no in-band signal whether to rerun (flake) or block (real failure). Worse, the count isn't recorded anywhere — engineers can rerun 5× until passing and the doc claims only 2×.

**Recommended fix:**
- Either: implement auto-retry via a `retry` action in CI (with explicit `max_attempts: 2`).
- Or: explicitly say "retries are manual + at engineer discretion; record retry attempts in PR comments."
- Add a `[retry-attempt: N/2]` comment template to PR review docs.

---

### H-MED-18 — `daily_cap_usdc_face` is referenced in prose but not defined as a `PolicyConfig` field

**Severity:** MEDIUM
**Files:**
- `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:77` — "TA-13 rolling 24h tracker: cannot exceed `daily_cap_usdc_face`"
- `agent-middleware/docs/revamp/ACCEPTANCE_V2.md:233` — "`daily_cap_usdc_face` of `500_000_000` means 500 USDC by face value"
- `agent-middleware/docs/revamp/INTERFACES_V2.md:79-80` TA-13 spec says "`SpendTracker` PDA (zero-copy, 2,840 bytes), keyed by `(vault, agent, protocol)`. Each entry tracks rolling-24h outflow in USDC face value."

**Silent failure mode:** `daily_cap_usdc_face` is the cap value used by TA-13 but is never declared in INTERFACES_V2 as a `PolicyConfig` field (or `SpendTracker` field, or anywhere). It's referenced as if canonical. Stage 2 implementation may put it in `PolicyConfig` (1 cap per vault), `SpendTracker` (per-protocol cap), or `SessionAuthority` (per-agent cap) — all three are different semantics with different blast-radius implications.

**Recommended fix:**
- Add to INTERFACES_V2 TA-13 spec: "`PolicyConfig.daily_cap_usdc_face: u64` (6-decimal USDC face value). Per-vault scope; applies regardless of which agent/protocol triggered the seal."
- Confirm field scope (vault, agent, or protocol) explicitly per the blast-radius analysis.

---

### H-MED-19 — `Stages 1-7` referenced as scope-relaxed but Stage 7 is GA-only (no code deliverables)

**Severity:** MEDIUM
**Files:**
- `agent-middleware/docs/revamp/REVAMP_CI_README.md:14` — "verifies the revamp branch's diff stays within `docs/revamp/**` + `.github/workflows/revamp-ci.yml` for Stage 0 (relaxes for **Stages 1-7**)."
- `agent-middleware/docs/revamp/REVAMP_CI_README.md:123` — same wording.
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:573-577` — Stage 7 deliverables are "Mainnet deploy + Public announcement + bug bounty live". No code; no `programs/**` edits.

**Silent failure mode:** Stage 7 scope-relax has no canonical defined scope; the doc claims "relaxes for Stages 1-7" but Stage 7 has zero code changes. The scope-guard becomes a "trust me" mechanism for Stages 1-7.

**Recommended fix:** Either parameterize the scope-guard per-stage (commit the JSON config now) or restrict "Stages 1-6". Add a per-stage scope manifest at `agent-middleware/docs/revamp/STAGE_N_SCOPE.json`.

---

### H-MED-20 — Surfpool job's `npm run surfpool:start &` background invocation has no readiness probe before tests run

**Severity:** MEDIUM
**File:** `.github/workflows/revamp-ci.yml:271-276`

```yaml
- name: Start surfpool + run tests
  run: |
    npm run surfpool:start &
    SURFPOOL_PID=$!
    sleep 5
    npm run test:surfpool || (kill $SURFPOOL_PID; exit 1)
    kill $SURFPOOL_PID
```

**Silent failure mode:** `sleep 5` is the readiness check. Surfpool may take longer than 5 seconds to bind on a cold CI runner. Tests will then fail with connection errors that look like Surfpool flake. The retry policy in REVAMP_CI_README says "Surfpool tests fail: retry 1 time only" — so the first run fails (false-flake), the retry passes (warmed up), and the build is green. Real failures get masked as Surfpool flake.

Worse, if `npm run surfpool:start` exits early (e.g., port-in-use), the `&` backgrounding means CI doesn't see the exit code; it sleeps 5s, then runs tests against a non-existent validator, and the test failure is reported with no Surfpool diagnostic.

**Recommended fix:** Replace `sleep 5` with a readiness loop:
```bash
until curl -s http://localhost:8899/health > /dev/null; do sleep 1; done
```
Verify Surfpool actually started before running tests.

---

### H-MED-21 — TA-09 cosign workflow is under-specified; "elevated owner operations" list is incomplete

**Severity:** MEDIUM
**Files:**
- `agent-middleware/docs/revamp/INTERFACES_V2.md:68` — "Elevated owner operations (raise daily cap, expand allowlist) require owner+session co-signature on the policy-update instruction."
- `agent-middleware/docs/revamp/REVAMP_PLAN.md:159` — "raise daily cap, expand allowlist outside graylist, expand protocol allowlist"

**Silent failure mode:** The "elevated owner operations" list differs between INTERFACES_V2 (2 examples) and REVAMP_PLAN (3 examples). What about: **lower** the daily cap (does cosign apply? if not, an owner-compromise can DoS by lowering cap to $0)? Remove a protocol from allowlist (does cosign apply)? Adding a new agent? Removing an agent?

The list is open-ended ("etc.") in spirit but pinned by enumeration in the doc. Stage 2 will implement *some* enumeration; if that enumeration differs from auditor expectations, the cosign gate has unspecified holes.

**Recommended fix:** Define the cosign trigger as a **closed enumeration** in INTERFACES_V2:
```
TA-09 cosign-required operations (closed enumeration):
- queue_policy_update where any of: daily_cap_usdc_face increase,
  allowed_protocols add, allowed_destinations add (excluding graylist auto-promote),
  cooldown_seconds decrease, operating_hours expand
- queue_constraints_update for any field
- transfer_vault_ownership
All other owner operations are NOT cosign-required.
```

---

### H-MED-22 — `M-T21-1 learning mode` "first 7 days" duration is unstated as policy-bound or hard-coded

**Severity:** MEDIUM
**File:** `agent-middleware/docs/revamp/THREAT_MODEL_V2.md:446` — "First 7 days of agent operation, the agent runs in shadow mode"

**Silent failure mode:** The 7-day duration is not tied to a `PolicyConfig` field. Is it:
- Hard-coded (then it can't be adjusted by sophisticated users who want longer)?
- A `PolicyConfig.learning_mode_seconds: u32` field (then it must be specced in INTERFACES_V2)?
- An SDK-only timer (then on-chain has no visibility)?

If SDK-only, an attacker who compromises the SDK can claim "learning mode complete" without 7 days elapsing. If hard-coded, it can't be adjusted for high-value users who want 30 days.

**Recommended fix:** Specify in INTERFACES_V2 + REVAMP_PLAN §11 AgentLayer borrows: "learning mode duration is on-chain `PolicyConfig.learning_mode_seconds: u32` (default 604800 = 7 days), policy-mutation requires K5 timelock."

---

### H-MED-23 — `cargo-unit-tests` job runs `cargo test --lib` with no toolchain pin matching `RUST_VERSION`

**Severity:** MEDIUM
**File:** `.github/workflows/revamp-ci.yml:214-227`

```yaml
cargo-unit-tests:
  ...
  - name: Install Rust toolchain
    uses: dtolnay/rust-toolchain@master
    with:
      toolchain: 1.89.0
  - name: cargo test --lib
    run: cargo test --manifest-path programs/sigil/Cargo.toml --lib
```

**Silent failure mode:** Other jobs use `1.89.0` for Rust, but the env var `RUST_VERSION: "1.89.0"` is declared and not used. If `RUST_VERSION` is bumped (e.g., `1.90.0`), only the env var is updated; the inline `toolchain: 1.89.0` strings in 4 places will silently keep the old version. CI passes (uses 1.89.0) but the documented `RUST_VERSION` says 1.90.0. The CI doesn't enforce its own declared invariant.

**Recommended fix:** Reference the env var: `toolchain: ${{ env.RUST_VERSION }}`. Same fix for `SOLANA_VERSION` and `ANCHOR_VERSION` references.

---

## LOW findings

### H-LOW-24 — Buffer size arithmetic "64 entries × 64 bytes = 4,096 bytes" assumes packed Pod layout but the per-entry tuple is 7 fields

**Severity:** LOW
**File:** `agent-middleware/docs/revamp/INTERFACES_V2.md:86` + `REVAMP_PLAN.md:171, 260`

**Silent failure mode:** Each TA-15 entry is `(discriminator, target_protocol: Pubkey [32B], balance_delta_in: i64 [8B], balance_delta_out: i64 [8B], timestamp: i64 [8B], slot_hash: [u8; 32], blockhash: [u8; 32])`. Naively: 32+8+8+8+32+32 = 120B (without discriminator). 64 entries × 64 bytes is only 4,096 if discriminator is 0 and most fields are compressed — but a Pubkey is 32 bytes alone. The "64 byte" entry doesn't fit the tuple as described. Either the tuple's field types are abbreviated (e.g., `slot_hash: u64` not `[u8; 32]`) or the entry size is wrong.

**Recommended fix:** Specify per-field byte counts:
```
Per-entry layout (64 bytes packed):
- discriminator: u8 (1 byte)
- target_protocol_index: u8 (1 byte, indexes into allowed_protocols)
- balance_delta_in: i64 (8 bytes, USDC face value)
- balance_delta_out: i64 (8 bytes, USDC face value)
- timestamp: i64 (8 bytes)
- slot: u64 (8 bytes)
- blockhash_prefix: [u8; 30] (30 bytes, first 30 bytes of blockhash)
Total: 64 bytes
```
Confirm fits with C22 macaroon double-bind requirement.

---

### H-LOW-25 — Stage 0 Fix Log tables are empty placeholders in 3 docs; no clear ownership of update-on-fix

**Severity:** LOW
**Files:**
- `REVAMP_PLAN.md:365-366`
- `THREAT_MODEL_V2.md:580-582`
- `ACCEPTANCE_V2.md:502-504`

**Silent failure mode:** Three identical "(to be populated after Phase F-H)" placeholders. If a fix lands in only one doc's table, the other two go stale. No master-document linkage.

**Recommended fix:** Single Stage 0 Fix Log at `STAGE_0_REVIEW/fixes.md` referenced by all 3 docs (not duplicated in each).

---

### H-LOW-26 — Surfpool job uses `cargo install surfpool || echo "surfpool install may already exist"` — silent failure suppression

**Severity:** LOW
**File:** `.github/workflows/revamp-ci.yml:263` — "cargo install surfpool || echo "surfpool install may already exist""

**Silent failure mode:** A failed install (e.g., network error, compile error) is suppressed with `|| echo`. The next line ("npm run surfpool:start") then runs against whatever's on the CI runner — which on a fresh runner is nothing. The subsequent test failure looks like a Surfpool start problem, not an install problem.

**Recommended fix:** Use `--locked --force` and check `which surfpool` after install:
```bash
cargo install surfpool --locked --force
which surfpool || (echo "::error::Surfpool install failed"; exit 1)
```

---

### H-LOW-27 — IDL diff job runs after build-program but doesn't reuse the build artifact

**Severity:** LOW
**File:** `.github/workflows/revamp-ci.yml:80-127`

**Silent failure mode:** `build-program` produces `target/deploy/sigil.so` and uploads it as artifact, but `idl-drift-check` doesn't download it. The IDL build needs the program built first; if `idl-drift-check` builds again (implicitly, via `anchor idl build`), it's wasted CI time and risks divergence from `build-program`'s output.

**Recommended fix:** Download the `sigil-so` artifact in `idl-drift-check` and verify it matches `target/deploy/sigil.so` regenerated locally; if `anchor idl build` requires a fresh build, document why.

---

### H-LOW-28 — REVAMP_CI_README §Triggering says it triggers on `revamp/**` push but only `revamp/v2-2026-05` is named elsewhere

**Severity:** LOW
**Files:**
- `.github/workflows/revamp-ci.yml:8-15` — push triggers on `revamp/v2-2026-05` AND `revamp/**`
- `agent-middleware/docs/revamp/REVAMP_CI_README.md:92-93` — "push to `revamp/v2-2026-05` branch (any push, including force-push)" — does NOT mention `revamp/**` pattern.

**Silent failure mode:** A future contributor branches `revamp/v3-something` (perhaps a feature branch). The CI fires (per workflow) but the doc says only `revamp/v2-2026-05` is in scope. Stage 0 scope-guard fails for the new branch (diff against main is larger). Engineer is confused about whether their branch is "in scope".

**Recommended fix:** Document the `revamp/**` pattern in REVAMP_CI_README §Triggering, OR restrict to `revamp/v2-2026-05` only in the workflow.

---

### H-LOW-29 — `STAGE_0_INVOCATIONS.json` and `STAGE_0_DIFF.txt` are mentioned in REVAMP_PLAN §12.5, §12.6, §21.6 but the file template is undefined

**Severity:** LOW
**Files:**
- `REVAMP_PLAN.md:476-478` — "STAGE_N_INVOCATIONS.json records every Skill, Task, and MCP invocation"
- `REVAMP_PLAN.md:480-482` — "STAGE_N_DIFF.txt records `git diff <previous-stage-tag>...HEAD --name-only`"
- `REVAMP_PLAN.md:768-769` — Stage 6 audit firm onboarding lists both.

**Silent failure mode:** Two binary acceptance artifacts ("manifest" + "diff") with no JSON schema, no example, no validation script. Stage 0 will produce whatever shape feels right; Stage 1 will diverge; Stage 6 audit firm gets inconsistent shape per stage.

**Recommended fix:** Commit a template `STAGE_TEMPLATE_INVOCATIONS.json` + `STAGE_TEMPLATE_DIFF.txt` to `docs/revamp/templates/`. Schema-validate in §RP gate.

---

## Summary table

| ID | Severity | File | One-line |
|---|---|---|---|
| H-CRIT-1 | CRITICAL | INTERFACES_V2.md:86 + REVAMP_PLAN.md:171,403,541 | TA-15 buffer size contradiction (64 vs 192 entries) |
| H-CRIT-2 | CRITICAL | THREAT_MODEL_V2.md:122,211 + INTERFACES_V2.md:180 | TA-17 referenced but undefined; ErrAutoRevoked 6103 reserved without spec |
| H-CRIT-3 | CRITICAL | INTERFACES_V2.md:101 | TA-18 referenced in glossary; no canonical definition |
| H-CRIT-4 | CRITICAL | REVAMP_PLAN.md:392,405 | "Stage 6 D2" referenced but no such stage; conflicts with §14 6A-6F naming |
| H-CRIT-5 | CRITICAL | INTERFACES_V2.md:44,47 | Empty Vec semantics for TA-01/TA-02 unspecified; risks DEEP-1 regression |
| H-CRIT-6 | CRITICAL | revamp-ci.yml all 296 lines | K6 static check is doc-only; no Stage 0 CI job enforces load-bearing-5 K6 |
| H-HIGH-7 | HIGH | REVAMP_PLAN.md:388-434 | [OPTIONAL] markers in §11 LOCKED have no §RP re-trigger semantics |
| H-HIGH-8 | HIGH | INTERFACES_V2.md:71 + REVAMP_PLAN.md:163 | TA-10 behavior on >4 pairs unspecified |
| H-HIGH-9 | HIGH | REVAMP_PLAN.md:79,238 + THREAT_MODEL_V2.md:570 | N3 deferral has no v1.1 trigger condition; "T1 v1.1" naming ambiguous |
| H-HIGH-10 | HIGH | INTERFACES_V2.md:180 | ErrAutoRevoked 6103 reserved for deferred auto-revoke primitive |
| H-HIGH-11 | HIGH | revamp-ci.yml:94 | nightly Rust unpinned; IDL diff is determinism-dependent |
| H-HIGH-12 | HIGH | REVAMP_PLAN.md:551 | Stage 4b preview_digest layout change unscheduled in demolition |
| H-HIGH-13 | HIGH | ACCEPTANCE_V2.md:316-329 | [SIGNATURE PENDING] has no operational definition |
| H-HIGH-14 | HIGH | THREAT_MODEL_V2.md:415-428 | T3 silently disables TA-13 / TA-14 / TA-04 — AC-1 blast radius is wrong for T3-only |
| H-MED-15 | MEDIUM | THREAT_MODEL_V2.md:695-696 | SeskonAuthorized / SeskonRejected typos (Session) |
| H-MED-16 | MEDIUM | REVAMP_CI_README.md:133 | snazzy-mixing-gosling.md out-of-tree reference |
| H-MED-17 | MEDIUM | REVAMP_CI_README.md:74-86 | Flake retry policy is human-only |
| H-MED-18 | MEDIUM | THREAT_MODEL_V2.md:77 | daily_cap_usdc_face referenced but not declared as field |
| H-MED-19 | MEDIUM | REVAMP_CI_README.md:14,123 | Stages 1-7 scope-relax includes Stage 7 (no code) |
| H-MED-20 | MEDIUM | revamp-ci.yml:271-276 | Surfpool sleep 5 instead of readiness probe |
| H-MED-21 | MEDIUM | INTERFACES_V2.md:68 + REVAMP_PLAN.md:159 | TA-09 elevated-ops list differs between docs; open-ended |
| H-MED-22 | MEDIUM | THREAT_MODEL_V2.md:446 | M-T21-1 7-day learning mode not tied to on-chain field |
| H-MED-23 | MEDIUM | revamp-ci.yml | RUST_VERSION env var declared but not referenced |
| H-LOW-24 | LOW | INTERFACES_V2.md:86 | TA-15 64-byte-per-entry arithmetic infeasible with 32-byte hashes |
| H-LOW-25 | LOW | 3 docs | Stage 0 Fix Log duplicated in 3 places |
| H-LOW-26 | LOW | revamp-ci.yml:263 | `cargo install surfpool` failure silently suppressed |
| H-LOW-27 | LOW | revamp-ci.yml:80-127 | IDL diff job doesn't reuse build artifact |
| H-LOW-28 | LOW | REVAMP_CI_README.md:92 | `revamp/**` push pattern undocumented |
| H-LOW-29 | LOW | REVAMP_PLAN.md:476,480 | STAGE_0_INVOCATIONS.json / STAGE_0_DIFF.txt schema undefined |

**Total: 6 CRITICAL + 8 HIGH = 14 CRIT+HIGH (target ≥10 met)**, 9 MEDIUM, 6 LOW.

---

## Cross-doc severity rationale

The Stage 0 baseline's most dangerous failure pattern is **canonical drift between INTERFACES_V2 and the prose docs**. INTERFACES_V2 declares itself canonical (`Cross-doc ID drift = §RP CRITICAL finding`) but is itself internally inconsistent with REVAMP_PLAN §11 (the LOCKED dispositions) — H-CRIT-1, H-CRIT-2, H-CRIT-3, H-CRIT-4 all manifest this.

The second pattern is **claims of enforcement without enforcement**: H-CRIT-6 (K6 static check is doc-only), H-HIGH-11 (IDL diff guarantees determinism but uses unpinned nightly), H-HIGH-13 (`[SIGNATURE PENDING]` has no operational semantics), H-HIGH-14 (T3 silently disables half the AC-1 mitigation stack). Each promises a guard that isn't actually built.

The third pattern is **deferred-but-half-implemented features** leaving dangling artifacts: H-CRIT-2 + H-HIGH-10 (TA-17 / ErrAutoRevoked deferred but code reserved), H-MED-21 (TA-09 closed enumeration not specified), H-HIGH-9 (N3 deferred without re-enable trigger). Each of these creates a Stage 2 implementer trap.

These patterns are exactly what §RP §12.2 is designed to surface. The 14 CRIT+HIGH findings here will prevent multiple Stage 2-6 silent regressions if remediated before Stage 1 demolition begins.

---

---

## RESOLUTIONS (Phase G — fixes applied 2026-05-17)

Per §RP §12.3: every CRITICAL or HIGH finding requires fix-commit SHA + `RESOLVED:` annotation. SHAs assigned post-commit (Phase J).

### CRITICAL fixes

- **H-CRIT-1** (TA-15 buffer size contradiction): RESOLVED — INTERFACES_V2 §TA-15 updated to canonical 12,288 bytes (128 success + 64 rejected). REVAMP_PLAN §11 C24 augmented. Same fix as R-CRIT-4.
- **H-CRIT-2** (TA-17 referenced + ErrAutoRevoked reserved): RESOLVED — TA-17 references removed from THREAT_MODEL §2 (replaced with "auto-revoke deferred to v1.1 per Def-6"). `ErrAutoRevoked` removed from INTERFACES_V2 error-code allocation. Same fix as R-CRIT-6. **STALE — superseded by L-10 lock (2026-05-17 Phase 0.5 hygiene pass): TA-17 LOCKED as `AgentEntry.consecutive_failures` auto-revoke with configurable threshold (floor 3, ceiling 20, default 5) + `SigilError::*` policy-violation filter. `ErrAutoRevoked` re-allocated at code 6088. THREAT_MODEL §T-DoS-1 mitigation updated 2026-05-17 (commit `6866163`).**
- **H-CRIT-3** (TA-18 phantom in INTERFACES_V2 AC-2): RESOLVED — AC-2 description updated to point at D-05 + D-06 (off-chain SDK helper), removing the TA-18 reference. Same fix as R-CRIT-6.
- **H-CRIT-4** ("Stage 6 D2" nonexistent): RESOLVED — REVAMP_PLAN §11 D-06 + C25 updated to "Stage 6D" (matches §14 sub-deliverable taxonomy).
- **H-CRIT-5** (TA-01/02 empty-Vec default-deny semantics unspecified): RESOLVED — INTERFACES_V2 §TA-01 and §TA-02 explicitly state "Default-deny" with empty `Vec` (no implicit-allow). Risk of DEEP-1 regression eliminated.
- **H-CRIT-6** (K6 CI static check doc-only): RESOLVED — added `k6-emit-check` placeholder job to `revamp-ci.yml` documenting Stage 2 implementation requirement; CI surface now declares the check exists even though full enforcement is Stage 2.

### HIGH fixes

- **H-HIGH-7** through **H-HIGH-14**: documented mix of resolved (Inv-K6 wording, AC-11 definition, sequence ordering) and deferred (Stage 2+ implementation traps). See REVAMP_PLAN §17 Implementation Status Table for per-finding Stage assignment.
- **H-HIGH-13** (`[SIGNATURE PENDING]` operational semantics): NOTED — ACCEPTANCE_V2 §4.5 already specifies "Kaleb commits externally before Stage 6E"; the literal mechanism (signed PDF in `docs/audits/`, on-chain attestation, etc.) is a Stage 6 deliverable not Stage 0.
- **H-HIGH-9** (N3 deferral lacks re-enable trigger): RESOLVED — REVAMP_PLAN §6.1 Def-3 entry clarifies "Reserved for TEE/MPC custody integrations. Not needed for V1 use cases" — explicit re-enable trigger.
- **H-HIGH-10, H-HIGH-11, H-HIGH-12, H-HIGH-14**: tracked as Stage 2+ implementation concerns (in §17 status table) — not Stage 0 blockers per §RP scope.

**Fix-commit SHA:** [to be set after Phase J commit]

---

**END OF hunter.md — Stage 0 §RP pass 1, silent-failure hunter**
