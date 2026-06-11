# Phase 1 §RP Review — Summary

**Phase:** 1 — Complete demolition (Jupiter integration + Phase B3 CrossFieldLte + tier-model docs)
**Date:** 2026-05-17
**Verdict:** FIX-AND-RETEST → RESOLVED

## Findings summary

| ID | Severity | Title | Fix commit |
|---|---|---|---|
| CRITICAL #2 | CRITICAL | Test runtime broken: 46+ runtime failures + 68+ tsc errors from hardcoded code literals | `ee62125` |
| CRITICAL #2b | CRITICAL | Deleted Jupiter error names referenced as string literals | `ee62125` |
| HIGH #2c | HIGH | surfpool-setup.ts stale 6030/6031 mappings | `c4c4c06` |
| HIGH #3 | HIGH | package.json references deleted test files | `c4c4c06` |
| MEDIUM #6 | MEDIUM | HARDENED plan says "Next free 6078" but actual is 6079 | `054cca1` |
| MEDIUM #5 | MEDIUM | agent-errors.ts header doc says "88 codes" | `054cca1` |
| MEDIUM #1 | MEDIUM | Surviving Jupiter constants lack ADR note | `0fc53a4` |
| LOW #10 | LOW | B3 deletion CU win unverified | DEFERRED to Phase 4/6 |

## Artifacts

- [silent-failure-hunter.md](./silent-failure-hunter.md) — full §RP transcript with all 10 attack vectors, evidence, and dispositions

## Dispatch context

- Dispatched from: main orchestrator thread
- Tool used: `pr-review-toolkit:silent-failure-hunter`
- code-reviewer NOT dispatched separately (the silent-failure-hunter prompt was thorough enough; would have been redundant)

## Invocation log

| Timestamp | Commits at dispatch | Verdict |
|---|---|---|
| 2026-05-17 (post `3c44009`) | `2a27f96` + `1b173e0` + `383b1ee` + `3c44009` | FIX-AND-RETEST |
| (post-fix verification) | + `ee62125` + `c4c4c06` + `054cca1` + `0fc53a4` | CLEAR-TO-PROCEED |

## Process note

Per Phase 0.5 audit (2026-05-17) F-4: this transcript was originally not persisted to the repo at the time of §RP dispatch. The §RP review DID run from the main thread, but the audit-trail artifacts (this directory) were created retroactively. Going forward, §RP transcripts are persisted to `docs/revamp/PHASE_N_REVIEW/` directories at the time of dispatch.

## Critical recovery — the Engineer's misleading test-count claim

Phase 1 was the **highest-leverage §RP find** in the V2 revamp so far. The Engineer's initial report cited "131 pnpm tests / 1706 sdk-kit tests passing" — both green — and proposed Phase 1 was complete. The §RP discovered:

- The LiteSVM on-chain suite (`tests/instruction-constraints.ts`, `tests/security-exploits.ts`, `tests/sigil.ts` — ~346 tests) was OMITTED from the Engineer's measurement
- 46+ tests in `instruction-constraints.ts` alone FAILED at runtime due to hardcoded error-code literals not matching the post-compaction SDK types
- 75 tests broken total across the LiteSVM suite

Without §RP, Phase 1 would have "completed" with 75 silently-broken tests — a 21% LiteSVM regression undetected. The fix-and-retest cycle restored: 355 LiteSVM passing / 17 failing (the 17 are all explicitly out-of-Phase-1 scope: Phase 2 Signed/Bitmask operators not implemented + pre-existing test-fixture issues).

This finding is why the orchestrator-thread §RP dispatch pattern is now mandatory for every phase (Phase 2 onward), and why Engineer prompts now require explicit per-suite test count reporting.

## Final test-count state at Phase 1 close

| Suite | Pre-Phase-1 | Post-Phase-1 + fix-and-retest | Delta | Rationale |
|---|---|---|---|---|
| cargo unit | 140 | 111 | -29 | Deleted: 22 jupiter inline tests + 7 Phase B3 CrossFieldLte tests (orphans tied to deleted code) |
| pnpm (agent-middleware) | 140 | 131 | -9 | Deleted: 9 tests in `post-assertion-integration.ts` (CrossFieldLte-dependent file deleted) |
| sdk/kit pnpm | 1,812 | 1,706 | -106 | Deleted: 4 SDK test files testing deleted CrossFieldLte / post-assertion-validation primitives |
| LiteSVM aggregate | 283 passing / 92 failing | 355 / 17 | +72 passing, -75 failing | 165 `expectSigilError` literal drops + 3 orphan `it()` deletions |

All 144 deleted tests were orphans tied to deleted primitives; no test of surviving code was dropped.

## §RP discipline (audit M-4, 2026-05-19)

silent-failure-hunter was the primary reviewer for Phase 1; code-reviewer
was not invoked. Phase 1's primary attack-vector surface was Option A
demolition (deletion of T1 deep-parsing modules + tier registry +
strict_mode dual-mode) — silent-failure-hunter's "what got missed" framing
fits demolition phases better than code-reviewer's "what's broken" framing
(nothing was broken; everything was being removed). The convention going
forward is silent-failure-hunter primary, code-reviewer supplementary when
attack-vector overlap is partial. Phase 2 + 3 README sections explicitly
document the same rationale.
