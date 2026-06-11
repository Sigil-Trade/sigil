# Phase 1 §RP — silent-failure-hunter transcript

**Date:** 2026-05-17
**Phase:** 1 — Complete demolition (Jupiter + Phase B3 CrossFieldLte + tier-model docs)
**Dispatched from:** main orchestrator thread
**Tool:** `pr-review-toolkit:silent-failure-hunter`
**Phase commits at time of review:** `2a27f96` + `1b173e0` + `383b1ee` + `3c44009`
**Verdict:** FIX-AND-RETEST → 2 CRITICAL + 2 HIGH + 3 MEDIUM + 1 LOW, all fixed in `ee62125` + `c4c4c06` + `054cca1` + `0fc53a4`

---

## Scope sent to the agent

10 attack vectors targeting the first Rust-touching phase:

1. JUPITER_LEND/EARN/BORROW/PERPS constants — strict Option A or defensible attack-class block?
2. Test files hardcode old error codes (post compaction renumbering)
3. Test-count regression rationale (-144 tests deleted)
4. PostAssertionEntryZC padding correctness
5. agent-errors.ts hand-renumbering completeness
6. HARDENED plan numerics vs actual error count
7. scripts/test-counts.json stale entries
8. max_slippage_bps preservation (D-5)
9. IDL Jupiter retentions (intentional vs accidental)
10. Compute-budget impact of B3 deletion

---

## Findings

### CRITICAL #2 — Test runtime broken: 46+ runtime failures + 68+ tsc errors

**File:** `tests/instruction-constraints.ts`, `tests/security-exploits.ts`, `tests/sigil.ts` (112 sites)

**Defect:** Engineer's "131/1706 passing" report omitted the LiteSVM on-chain test suite. Actual runtime test against `tests/instruction-constraints.ts`:

```
46 failing / 29 passing — every failure of the form:
SigilAssertionError: helper misuse: expected.name 'InvalidConstraintConfig' maps to code 6037,
but expected.code was 6039. Drop expected.code or fix the value.
  at expectSigilError (tests/helpers/strict-errors.ts:344:11)
```

The strict `expectSigilError` helper (`tests/helpers/strict-errors.ts:343-349`) rejects hardcoded `code: 6XXX` literals that drift from canonical name→code mapping. The engineer renumbered the SDK (`agent-errors.ts`, `simulation.ts`, generated/), but did NOT renumber the test files' hardcoded literals. ~112 test sites failed.

**Disposition:** RESOLVED in commit `ee62125`. Sed-pass dropped 165 `code:` literal sites across 10 test files. Helper auto-derives canonical code from `name` — tests now resilient to future renumbering. Post-fix: `grep -rn 'expectSigilError.*code:' tests/` returns zero.

---

### CRITICAL #2b — Deleted Jupiter error names referenced as string literals

**File:** `tests/security-exploits.ts:8598`, `tests/security-exploits.ts:11952`

**Defect:** Two test sites referenced `"InvalidJupiterInstruction"` and `"SwapSlippageExceeded"` as string literal `name:` values in `expectSigilError` calls. Both error variants were deleted in Phase 1 commit `1b173e0`. TypeScript compile error at the `SigilErrorName` union type.

**Disposition:** RESOLVED in commit `ee62125`. 1 orphan `it()` case at `security-exploits.ts:8434-8581` deleted (Jupiter slippage parser test); 1 entire `describe()` block at `:11653-11849` deleted (containing 2 `it()` cases). Net deletion: 3 `it()` cases + ~330 lines of orphaned helpers (`buildJupiterV1IxData`, `SHARED_ACCOUNTS_ROUTE_DISC`). Surviving Jupiter tests preserved (the 2 `ProtocolMismatch` cases exercising generic program-ID mismatch).

---

### HIGH #2c — surfpool-setup.ts:494-495 stale error code mappings

**File:** `tests/helpers/surfpool-setup.ts:494-495`

**Defect:** Hardcoded `6030: "SwapSlippageExceeded"` + `6031: "InvalidJupiterInstruction"` — both deleted variants. Post Phase 1 compaction, code 6030 is `UnauthorizedTokenTransfer` (different variant), creating a wrong mapping that would mislead test diagnostics.

**Disposition:** RESOLVED in commit `c4c4c06`. Both entries stripped; tombstone comment added documenting the deletion.

---

### HIGH #3 — package.json:23-24 references deleted test files

**File:** `package.json:23` (test:onchain) + `:24` (test:onchain:full)

**Defect:** Both scripts referenced `tests/post-assertion-integration.ts` (deleted Phase 1) AND `:24` also referenced `tests/escrow-integration.ts` (deleted pre-V2 Stage 1 escrow demolition). Both scripts would fail-fast with "Cannot find module" on next invocation.

**Disposition:** RESOLVED in commit `c4c4c06`. Stale references stripped from both scripts.

---

### MEDIUM #6 — HARDENED plan says "Next free 6078" but actual is 6079

**File:** `docs/revamp/HARDENED_V2_PROMPT_MAP.md:118-125`

**Defect:** Plan assumed 3 Jupiter variants deleted → post count 78 → next free 6078. Engineer correctly preserved `SlippageBpsTooHigh` per D-5 (only 2 variants deleted) → post count 79 → next free 6079. Phase 2 reservation table would collide with kept `InvalidDestinationMode` at 6078.

**Disposition:** RESOLVED in commit `054cca1`. HARDENED plan reservation table shifted by +1 (6078→6079, 6079→6080, etc.). INTERFACES_V2.md §Error-Code-Allocation mirror also updated.

---

### MEDIUM #5 — agent-errors.ts:8 header doc says "88 codes" still

**File:** `sdk/kit/src/agent-errors.ts:8`

**Defect:** Header comment said `Maps all 88 on-chain error codes (6000-6087)`. Actual: 79 codes at 6000-6078 post-compaction.

**Disposition:** RESOLVED in commit `054cca1`. Header updated: `Maps all 79 on-chain error codes (6000-6078) post Phase 1 compaction (Option A V2; Jupiter swap integration + 2 error variants deleted).`

---

### MEDIUM #1 — Surviving Jupiter constants lack ADR note

**File:** `programs/sigil/src/state/mod.rs:258-303`

**Defect:** `JUPITER_LEND_PROGRAM`, `JUPITER_EARN_PROGRAM`, `JUPITER_BORROW_PROGRAM`, `JUPITER_PERPS_PROGRAM` constants survived Phase 1 with no inline documentation explaining the L-1 carve-out. They're used in `KNOWN_ASYNC_FULFILLMENT_PROGRAMS` (attack-class block) and `is_recognized_defi` (ProtocolMismatch accounting), both of which are defensible under Option A as program-ID identifiers, NOT per-protocol parsers.

**Disposition:** RESOLVED in commit `0fc53a4`. Added ADR-Phase-1 comment block above the 4 constants:

> "JUPITER_LEND/EARN/BORROW_PROGRAM survive as is_recognized_defi markers for ProtocolMismatch + defi_ix_count accounting. JUPITER_PERPS_PROGRAM survives in KNOWN_ASYNC_FULFILLMENT_PROGRAMS (with DRIFT_V2_PROGRAM + DRIFT_JIT_PROXY_PROGRAM) as an attack-class block, not a per-protocol parser. These are program-ID identifiers, NOT Jupiter-routing-format parsers; they comply with Option A L-1 because Sigil does not interpret Jupiter instruction data — only rejects bundles whose target program is in the async-fulfillment list. D-5 / Phase 4 TA-10 hardening will eventually replace these with a generic primitive."

---

### LOW #10 — B3 deletion CU win unverified

**File:** `tests/cu-budget.ts`

**Defect:** Phase B3 CrossFieldLte had its own CU cost. Phase 1 deletion should yield a CU win in `finalize_session` worst case. No pre/post diff measured.

**Disposition:** DEFERRED — Phase 4 TA-10 hardening + Phase 6 Maestro borrows will rebaseline CU measurements anyway. Documented but not fixed.

---

## Attack vector scorecard

| # | Vector | Verdict |
|---|---|---|
| 1 | JUPITER_LEND/EARN/BORROW/PERPS survival | PASS (defensible) → ADR note added (MEDIUM #1) |
| 2 | Test files hardcode old error codes | **FAIL** (CRITICAL #2 + #2b) → RESOLVED |
| 3 | Test-count regression rationale | PARTIAL (substantively correct but procedural deviation past 5-test threshold) |
| 4 | PostAssertionEntryZC padding correctness | PASS — 70 bytes, aligned for u16, SIZE constant correct, IDL regenerated |
| 5 | agent-errors.ts renumbering completeness | PASS with stale-doc nit → RESOLVED (MEDIUM #5) |
| 6 | HARDENED plan vs actual error count | **FAIL** (MEDIUM #6) → RESOLVED |
| 7 | scripts/test-counts.json stale entries | PASS — verify-test-counts.js exits 0; jupiter-integration.ts + jupiter-lend-integration.ts files still exist and still pass |
| 8 | max_slippage_bps preservation | PASS — `initialize_vault.rs:66, 87-88, 142` + validation kept, emits `SigilError::SlippageBpsTooHigh` (code 6031 post-shift) |
| 9 | IDL Jupiter retentions | PASS — 3 intentional doc-only mentions (KNOWN_ASYNC_FULFILLMENT description, max_slippage_bps doc comment, PostAssertionEntryZC historical context); zero accidental leakage |
| 10 | B3 deletion CU win | UNCERTAIN → DEFERRED |

---

## Verdict: FIX-AND-RETEST → RESOLVED

All CRITICAL + HIGH findings closed by commits `ee62125` + `c4c4c06` + `054cca1` + `0fc53a4`. Final state:
- Cargo unit: 111 passing
- agent-middleware pnpm: 131 passing
- sdk/kit pnpm: 1,706 passing
- LiteSVM aggregate: 355 passing / 17 failing (17 failures are all out-of-Phase-1 scope: Phase 2 Signed/Bitmask operators not yet implemented + test-fixture issues in toctou-security.ts)
- One pre-existing TS2589 in surfpool-setup.ts:758 — confirmed unrelated to Phase 1 (existed at baseline `244f465`)

**Cleared for Phase 2 dispatch.**

---

## Lessons baked into future phase prompts

1. **Test-count threshold raised** from "STOP if >5 deleted" to "STOP if >10 deleted that aren't pre-enumerated in the prompt's deletion list" — gives Engineer room for orphan deletions while forcing explicit flagging of anything beyond pre-enumerated.
2. **Mandatory test-suite measurement** — future Engineer prompts will explicitly require: "report exact count from EACH of: `cargo test --lib`, `pnpm test`, `cd sdk/kit && pnpm test`, AND `npx ts-mocha tests/*.ts`". Engineers can no longer omit the LiteSVM suite.
3. **§RP from main thread is mandatory** — Engineer subagent context structurally lacks the Agent tool needed to dispatch pr-review-toolkit subagents. Orchestrator dispatches by default.

---

**END OF Phase 1 silent-failure-hunter transcript**
