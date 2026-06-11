# Phase 2 §RP Review — Summary

**Phase:** 2 — Default-tightening + TA-19 policy_preview_digest + observe_only
**Date:** 2026-05-18
**Verdict (initial dispatch):** FIX-AND-RETEST → 1 HIGH + 2 MEDIUM + 1 LOW
**Final state:** RESOLVED — Phase 2 FINAL cleared for Phase 3 dispatch (post §RP-2 iter-2 + close-up extension + fixture cleanup, 2026-05-18)

## Close-up extension findings (cross-phase audit 2026-05-18 → addressed in extension commits)

| ID | Severity | Title | Fix commit |
|---|---|---|---|
| LC-2 | HIGH | HARDENED §4 reservation table 6080/6081 swap | `2245342` |
| LC-3 | HIGH | SDK agent-errors.ts header out by 1 | `2245342` |
| CR-3 | MEDIUM | InvalidSessionExpiry msg wrong units | `2245342` |
| PEN-CROSS-6 | MEDIUM | developer_fee_rate not in TA-19 digest | `e79f31b` |
| PEN-CROSS-2 | MEDIUM | close+reinit replay via missing created_at_slot | `b2bbe94` |
| CR-4 | MEDIUM | apply_pending_policy digest positive test missing | `b2bbe94` |
| PEN-CROSS-3 | HIGH | 4 sibling handlers state-mirror not auth gate | `d3fb49a` |
| PEN-CROSS-7 | MEDIUM | Cross-impl encoding parity drift silent | `ee01794` |
| CR-2 | MEDIUM | Stale protocol_mode doc-comment | `ee01794` |
| LC-4 | MEDIUM | 2 stale T1 references in REVAMP_PLAN | `ee01794` |
| LC-5 | MEDIUM | 2 stale audit refs in ACCEPTANCE_V2 | `ee01794` |
| Fixture cleanup | — | 15 TS strict sites (sibling handlers + init args) | `1f2daa0` + `12ac275` |
| §RP-2 bonus | MEDIUM | F-11 gap at apply_pending_policy | `5715e48` |

## Deferred items (absorbed into later phases)

| ID | Original severity | Absorbed into | Rationale |
|---|---|---|---|
| PEN-CROSS-1 | CRITICAL | **Phase 8** (ownership/freeze theme) | register_agent timelock + TA-19 vault.agents coverage; natural fit with C26/C27 timelock-gated owner-state mutations |
| PEN-CROSS-4 | HIGH | **Phase 4** (TA-11 sandwich integrity) | destination_check CU pre-filter; TA-11 already needs bundle-introspection hardening |
| PEN-CROSS-5 | MEDIUM | **Phase 4** (TA-10/11 work) | policy_version bumps in register_agent/revoke/pause/unpause; cascades into ~80 test fixtures, batch with TA-10 fixture refresh |

## Final test counts

- `cargo test --lib`: **116/0**
- agent-middleware `pnpm test`: **131/0**
- `cd sdk/kit && pnpm test`: **1,715/0**
- LiteSVM 2-file + digest-invariant: 232 passing / 3 pending / 8 failing (8 pre-existing Signed/Bitmask test-sequencing — predates V2)

## Schema math (final)

- PolicyConfig: **863** bytes (855 + 8 for created_at_slot)
- AgentVault: **634** bytes (+ 1 for observe_only)
- TA-19 canonical encoding: 14 fields (developer_fee_rate at position 4, created_at_slot at position 14)
- 4 sibling handlers require `expected_digest: [u8; 32]` arg

## Findings summary

| ID | Severity | Title | Fix commit |
|---|---|---|---|
| HIGH | HIGH | TA-19 digest silently broken by 4 sibling handlers | `13a217a` (Rust) + `cce9d17` (regression tests) |
| MED-1 | MEDIUM | Engineer's failure count was wrong (15 claimed, 32 actual); several are real assertion-text regressions | `64d710e` (9 mechanical + 4 assertion fixes; 8 pre-existing untouched) |
| MED-2 | MEDIUM | tests/toctou-security.ts has stale `, false` strict_mode args | `d4a44eb` (2 sites stripped + broader grep) |
| LOW-1 | LOW | TS2589 in surfpool-setup.ts:773 (line shift from pre-existing Anchor depth issue) | `d4a44eb` (DOCUMENTED with inline comment; deferred to v1.1) |
| LOW-2 (close-time) | LOW | TS-strict operator type mismatch in new policy-digest-invariant.ts test fixtures | DEFERRED to v1.1 SDK cleanup (tests pass at runtime) |

## Artifacts

- [silent-failure-hunter.md](./silent-failure-hunter.md) — full §RP transcript with all 8 attack vectors

## Dispatch context

- Dispatched from: main orchestrator thread
- Tool used: `pr-review-toolkit:silent-failure-hunter`
- First dispatch hit `Server is temporarily limiting requests` rate limit; retry succeeded.

## Invocation log

| Attempt | Timestamp | Commits at dispatch | Verdict |
|---|---|---|---|
| 1 | 2026-05-18 (post `e821f9c`) | First 8 Phase 2 commits | RATE LIMITED — no result |
| 2 | 2026-05-18 (immediately after) | Same | FIX-AND-RETEST |

## Process note

This is the FIRST phase using the post-F-4 convention of persisting §RP transcripts to `docs/revamp/PHASE_N_REVIEW/` at time of dispatch (not retroactively). Phases 0.5 / 0.6 / 1 transcripts were retro-persisted in commit `96ed5a2`; from Phase 2 forward, this directory is created with the §RP transcript at dispatch time.

## On code-reviewer.md absence (F-8 audit note)

The auditor flagged that this directory contains only `silent-failure-hunter.md` and not a separate `code-reviewer.md`. That was intentional: the attack vectors dispatched to `silent-failure-hunter` covered the same surface that a code-reviewer dispatch would have hit (numerics, encoding correctness, helper-function invariants, error-code allocation drift, IDL/types/SDK reconciliation). A separate code-reviewer dispatch on Phase 2 would have been redundant work against the same code surface.

Future phases may dispatch both tools when their attack-vector coverage diverges (e.g. a phase with significant new compute-budget surface area, where the code-reviewer's static numerics analysis is load-bearing in a way that silent-failure-hunter's runtime-vector framing doesn't replicate). For Phase 2 (default-tightening + TA-19 digest + observe_only), one dispatch was sufficient.
