# Phase 5 §RP Review — Summary

**Phase:** 5 — Post-execution invariants (TA-12 stable_balance_floor + TA-14 per-recipient cap + TA-13 ratification)
**Date:** 2026-05-18
**Verdict:** **CLEAR-TO-PROCEED** (after §RP-1 fix-up cycle)

## Phase 5 commits

| # | Subject | SHA |
|---|---|---|
| 0 | HARDENED §6 inline code-fix (6092-94 → 6094-96) | `2e53015` |
| 1 | TA-12 stable_balance_floor + canonical digest extension | `0578e5e` |
| 2 | TA-14 per-recipient cap (fixed-size array, age-based eviction) | `3c5a165` |
| 3 | TA-13 ratify per-protocol cap enforcement + 5-scenario regression test | `0698ed2` |
| 4 | §RP-1 V1 fix — TA-12 floor enforcement on agent_transfer.rs | `48c6239` |
| 5 | §RP-1 V5 fix — SDK error 6094/6095/6096 mappings + 6047 description flip | `98a9a13` |

## §RP-1 findings + dispositions

| ID | Severity | Title | Fix commit |
|---|---|---|---|
| V1 | HIGH | TA-12 stable_balance_floor missing on agent_transfer.rs | `48c6239` — block at agent_transfer.rs:316-424 mirroring finalize_session pattern + 4 cargo unit tests |
| V5 | HIGH | SDK error code drift (6047 description stale + 6094/6095/6096 missing) | `98a9a13` — all 4 SDK files updated; codama regenerated; names.generated.ts picked up 15 missing entries |
| V2-V4, V6-V10 | NONE | Vector verifications all CLEAR | — |
| V8 (Gap 2) | MEDIUM | No LiteSVM e2e for TA-12/TA-14 | DEFERRED to Phase 9 (needs vault helpers + mock DeFi ix scaffolding; documented inline at agent_transfer.rs:336-340) |

## Final state

- `cargo test --lib --features devnet-testing`: **163 / 0** (+6 from Phase 4 baseline 157)
- `sdk/kit pnpm test`: **1,720 / 0**
- `sdk/kit tsc --noEmit`: clean
- 4-file LiteSVM subset: **285 passing / 7 failing / 2 pending** (7 = deferred TA-09 cosign)

## Schema math

| Account | Pre-Phase-5 | Post-Phase-5 | Δ |
|---|---|---|---|
| PolicyConfig | 1273 | **1289** | +16 (stable_balance_floor u64 + per_recipient_daily_cap_usd u64) |
| SpendTracker | 2840 | **3328** | +488 (per_recipient[10] zero-copy array + count u8 + padding[7]) |
| PendingPolicyUpdate | 8363 | **8381** | +18 (Option<u64> × 2 for new fields) |
| AgentVault | 634 | **634** | 0 |
| SessionAuthority | 383 | **383** | 0 |

Error codes: **94 → 97** (6094 ErrStableFloorViolation, 6095 ErrDailyCapExceeded, 6096 ErrRecipientCapExceeded).

TA-19 canonical encoding: **17 → 19** fields (position 18 = stable_balance_floor, position 19 = per_recipient_daily_cap_usd).

## Cross-impl status

- Rust + SDK + LiteSVM-helper encoders byte-equal for 19-field canonical digest
- New cross-impl HEX pins: `HEX_MINIMAL = 45c51e8d...6a46`, `HEX_REALISTIC = 67c7cde9...810f`
- Property test (100 random fixtures) green

## Error code split (TA-13 ratification semantic)

- **6047 ProtocolCapExceeded** — now ONLY from `state/tracker.rs:313` for slot-allocation-exhausted (max 10 protocols tracked)
- **6095 ErrDailyCapExceeded** — from `finalize_session.rs:327 + :418` for rolling-24h-cap-hit

SDK descriptions flipped to match the split. Off-chain monitors can now disambiguate the two semantic cases.

## Honest gaps deferred to Phase 9

1. **No LiteSVM e2e for TA-12 + TA-14** — needs vault helpers + mock DeFi ix scaffolding
2. **TA-09 cosign doesn't include "lower stable_balance_floor" or "raise per_recipient_daily_cap_usd" as elevated** — Engineer disclosed
3. **Rust errors.rs 6047 msg text** — still reads "Per-protocol rolling 24h spending cap..." in the Rust source; SDK telemetry text intentionally diverges per Phase 5 §RP-1 V5 disposition (the Rust msg flip cascaded into 12+ codama files which Engineer reverted to avoid scope creep)

## Dispatch context

- §RP-1 dispatched from main orchestrator thread post `0698ed2`
- Tool: `pr-review-toolkit:silent-failure-hunter`
- Verdict: FIX-AND-RETEST → 2 HIGH (V1 + V5) + 1 MEDIUM (V8 deferred)
- Both HIGH findings resolved in fix-up commits `48c6239` + `98a9a13`
- No §RP-2 needed — engineer's report end-to-end verified by orchestrator

## Invocation log

| Attempt | Timestamp | Commits at dispatch | Verdict |
|---|---|---|---|
| 1 | 2026-05-18 (post `0698ed2`) | 3 Phase 5 commits | FIX-AND-RETEST |
| Close-up | 2026-05-18 (post `98a9a13`) | 5 Phase 5 commits + 2 fix-up | CLEAR-TO-PROCEED |

## §RP transcript disposition (audit M-3 + M-4, 2026-05-19)

**§RP discipline used:** silent-failure-hunter as primary reviewer (the
load-bearing transcript per phase, when written); code-reviewer was
supplementary, used phase-by-phase based on attack-vector overlap, not a
doctrine requirement.

**Phase 5 specific:** the silent-failure-hunter transcript for §RP-1 was
ephemeral (consumed inline during the §RP-1 → fix-up cycle that landed
the post-execution invariant fixes). It was not persisted to
`PHASE_5_REVIEW/silent-failure-hunter.md`. The finding disposition
table above (with explicit RESOLVED-in-SHA annotations) is the
source-of-truth for Phase 5. code-reviewer was not invoked for
Phase 5 (attack-vector focus was post-execution invariants TA-12/13/14,
fully covered by silent-failure-hunter's ephemeral pass).

Future phases (Phase 7+) MUST persist the silent-failure-hunter
transcript to maintain consistency with Phase 1/2/3/6 — Phase 4 + 5
remain the documented exception.
