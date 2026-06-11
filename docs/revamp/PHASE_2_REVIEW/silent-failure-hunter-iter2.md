# Phase 2 §RP-2 — silent-failure-hunter (final iteration)

**Date:** 2026-05-18
**Phase:** 2 — Default-tightening + TA-19 + observe_only (close-up extension + fixture cleanup)
**Dispatched from:** main orchestrator thread
**Tool:** `pr-review-toolkit:silent-failure-hunter`
**HEAD at dispatch:** `12ac275` (post fixture cleanup)
**Verdict:** CLEAR-TO-PROCEED → 1 MEDIUM bonus finding (closed in `5715e48`)

## Scope

22 commits since prior §RP at `3d8c0a9`, covering Phase 2 close-up + orchestrator quick fixes + close-up extension + fixture cleanup:

| Group | Commits |
|---|---|
| Phase 2 close-up | `d36fe40`, `66de976`, `729006b`, `afb4a92`, `7f7f8fd`, `b6c7d89`, `b5e6abb` |
| Orchestrator quick fixes (LC-2/LC-3/CR-3) | `2245342` |
| Close-up extension (PEN-CROSS-2/3/6/7 + CR-2/4 + LC-4/5) | `e79f31b`, `b2bbe94`, `d3fb49a`, `ee01794`, `5acc5e9` |
| Fixture cleanup | `1f2daa0`, `12ac275` |

8 attack vectors run.

## Findings

### MEDIUM (bonus, outside 8 vectors) — F-11 gap at apply_pending_policy

**File:** `programs/sigil/src/instructions/apply_pending_policy.rs`

**Defect:** F-11 ActiveVaultRequiresAllowlist invariant enforced at `initialize_vault.rs` + `set_observe_only.rs` (flip-to-active path), but NOT at `apply_pending_policy.rs`. Owner could queue a policy update that empties both `protocols` and `allowed_destinations` on an active (non-observe_only) vault. TA-19 digest matches the owner-signed digest (digest covers empty state). Apply path lets the vault land in silently-inert state.

**Disposition:** RESOLVED in commit `5715e48`. Added F-11 cross-check immediately before the TA-19 digest recompute. Reject with `ActiveVaultRequiresAllowlist` (6082) when post-merge state has both allowlists empty AND vault is non-observe_only.

Plus the doc-nit `set_observe_only.rs:62` "position 10" → "position 11" (after PEN-CROSS-6 inserted developer_fee_rate at position 4 of canonical encoding).

## Attack vector scorecard

| # | Vector | Verdict |
|---|---|---|
| 1 | PEN-CROSS-6 developer_fee_rate digest binding (position 4, cross-impl byte-equality) | **PASS** |
| 2 | PEN-CROSS-2 created_at_slot replay protection (live `policy.created_at_slot`, NOT Clock::get in apply path) | **PASS** |
| 3 | PEN-CROSS-3 4 sibling handlers require expected_digest (recompute → assert → persist ordering) | **PASS** |
| 4 | set_observe_only correctness (has_one owner, mutates, recomputes, bumps version, emits event, F-11 cross-check) | **PASS** (1 doc nit) |
| 5 | F-13 observe_only position (before constraints PDA load) | **PASS** — saves 10-15K CU on observe-only rejects |
| 6 | Test fixture migration completeness | **PASS** — only allowed pre-existing TS errors remain |
| 7 | HARDENED §6 absorption notes (Phase 4 PEN-CROSS-4/5, Phase 8 PEN-CROSS-1) | **PASS** |
| 8 | PHASE_2_REVIEW disposition completeness | **PASS (acceptably stale)** — orchestrator updates post-§RP-2 |
| Bonus | F-11 gap at apply_pending_policy | **FAIL → FIXED** in `5715e48` |

## Final state

- cargo test --lib: 116/0
- agent-middleware pnpm test: 131/0
- sdk/kit pnpm test: 1715/0
- LiteSVM 2-file subset + digest-invariant: 232+ passing, pre-existing failures unchanged
- PolicyConfig SIZE: 863 (855 + 8 created_at_slot)
- TA-19 canonical encoding: 14 fields (added developer_fee_rate at pos 4, created_at_slot at pos 14)
- 4 sibling handlers require `expected_digest: [u8; 32]` arg

## Verdict: CLEAR-TO-PROCEED

Phase 2 FINAL complete. All §RP-2 findings resolved. Phase 3 dispatch unblocked.

---

**END of Phase 2 §RP-2 transcript**
