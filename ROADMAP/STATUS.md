# Sigil On-Chain Roadmap — Status Ledger

**Created:** 2026-05-30 · **Branch (planned):** `revamp/onchain-m1` · **Program ID:** `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` (upgrade-in-place, no new ID)

## Plan approval
- [x] Master roadmap approved by Kaleb (2026-05-30)
- [x] M1 PRDs approved
- [x] M2 design-level PRDs approved
- [x] 5 resolved content-forks accepted (see 00_ROADMAP §3)

## Baseline (filled by M1-00) — COMPLETE 2026-05-30
- Branch: `revamp/onchain-m1` (off `fc03d47a`)
- Baseline SHA: `47252b67` (HEAD); F-4 fix = `82259fbc`
- Build: `anchor build --no-idl` exit 0; IDL restored
- Tests: `anchor test` = **148 passing / 2 pending / 0 failing** (exit 0) — green reference for teardown diff
- F-4 WIP committed: YES (`82259fbc`, 3 files, saturating_sub→checked_sub)
- Session on-chain artifacts committed: YES (`47252b67` — ROADMAP + AGNOSTIC_ASSERTION_MODEL + research)
- SDK/docs/workflow churn: STASHED (`stash@{0}` "onchain-m1-baseline…"), preserved not discarded
- On-chain post-assertions WIP: preserved at `stash@{1}` (tag for M2-01/M2-03 review)
- Working tree: CLEAN (dirty count 0, verified)
- Docs archive (DOCS_CLEANUP_MAP): DEFERRED to a focused commit (non-blocking; tree already clean)

## M1 progress
| Item | Status | PR | Notes |
|---|---|---|---|
| M1-00 baseline | **DONE** | (branch commits) | green 148/2/0; tree clean; churn stashed |
| M1-agnostic-protocol (`is_recognized_defi` removal) | **DONE** | `e94ba539` | adversarial review PASSED 2026-05-31 (no blocking; 6/6 vectors disproven); defi_ix_count + ProtocolMismatch now agnostic to all allowlisted protocols; 3 tests; suite 9/9 + 148/2/0 |
| M1-01 HIGH destination-allowlist | PLANNED | — | design decision A/B/A+B still open |
| M1-02 HIGH frozen-accept | **DONE** | — | both accept-handler gates applied (EOA :118, MS :136); 4 tests (3 single-sig 9500/01/02 + 1 multisig 9300); GREEN: ownership-transfer.ts 18/0, ownership-transfer-multisig.ts 6/0, all 4 M1-02 ✔; RED-proven load-bearing (gates git-stashed while UNCOMMITTED → exactly the 2 EXPLOIT-BLOCKED tests fail "null≠6000"; REGRESSION+REACTIVATION stay green); adversarial review PASSED (no blocking; complete owner-mutation surface; freeze_helper sets vault.status=Frozen which the gate reads); build+IDL clean |
| M1-03 systemic frozen-gate | **DONE** | — | 8 additive owner handlers gated → VaultNotActive 6000 (apply_pending_policy, apply_agent_permissions_update, queue_policy_update, queue_agent_permissions_update, register_agent, unpause_agent, promote_graylist_destination, set_observe_only[OFF-dir]); subtractive/defensive stay allowed while frozen (revoke/pause/cancel_*/deposit/record_violation); cancel_ownership_transfer stays ==Active per PEN-04; constraints pipeline deferred to M1-04. **Tests `tests/m1-03-frozen-gate.ts` 14/14**: 8 GATED reject-6000 + 5 EXCEPTION succeed-while-frozen + 1 ANTI-BRICK (revoke-last→auto-frozen→register rejected→reactivate restores Active). RED-proven load-bearing (gates reverted to a07c4811 + recompiled ungated → exactly the 8 GATED fail, 5 EXCEPTION pass). audit-log-burst MED-1 ×2 FIXED (rolling-agent, never hits zero mid-loop; 5/0). Adversarial review PASSED (no CRIT/HIGH/MED; completeness CONFIRMED — no additive mutator missed; brick REFUTED — reactivate_vault is the owner-only recovery). Principle: project_sigil_frozen_gate_principle_2026_05_31 |
| M1-04 constraints teardown | PLANNED | — | — |
| M1-05 promote agnostic primitives | PLANNED | — | — |
| M1-06 mediums | PLANNED | — | — |
| M1 EXIT devnet+adversarial | PLANNED | — | — |

## M2 progress
| Item | Status | PRD written | Notes |
|---|---|---|---|
| M2-01 universal-offset catalog | DESIGN | design-level | — |
| M2-02 token-2022 gating | DESIGN | design-level | — |
| M2-03 integrity assertions | DESIGN | design-level | — |
| M2-04 balance-delta metering | DESIGN | design-level | — |
| M2-05 universal slippage (stable/round-trip) | DESIGN | design-level | — |

## Test-suite reality (measured 2026-05-31 — CORRECTS the "148/2/0" baseline)
- **`anchor test` is NOT the full suite.** Its `[scripts] test` runs only 4 files (sigil, jupiter-integration, flash-trade-integration, missing-coverage) → 148/2/0. CI's `test:onchain:full` is broader but STILL deliberately excludes `tests/instruction-constraints.ts` (`ci.yml:417` note). So "148/2/0 green" never exercised the constraints/audit/cu-budget suites.
- **Full LiteSVM run (24 top-level files, excl. devnet*/surfpool* which need live infra): 544 passing / 12 failing / 5 pending.** The 12 failures are PRE-EXISTING (reproduce identically 78/12 on clean HEAD `e94ba539` with all M1-02 work stashed) and TEST-ONLY — none are vulnerabilities, none caused by M1-02:
  - **10 × instruction-constraints** — **RESOLVED by M1-04 4b**: `tests/instruction-constraints.ts` (the engine's own test) was DELETED with the engine. Not patched — gone.
  - **1 × cu-budget** "ComputeBudget×28 pad" (Scenario 6) — `RangeError: encoding overruns Uint8Array` at client serialization (oversized tx >1232B). **STILL PRESENT** — pre-existing, test-only, NOT constraint-related, NOT caused by M1-04 (Scenarios 4/5 which tested the constraint scan were deleted in 4b; Scenario 6 is the non-constraint ComputeBudget-pad baseline that has the serialization bug). Fix tracked separately.
  - **1 × audit-log** "slot/blockhash read FRESH" — STALE TEST, **FIXED** (VIEWER capability) — audit-log.ts 10/0.
- **M1-04 4b prune result (measured 2026-06-01):** the broad pruned LiteSVM slice = **413 passing / 4 pending / 1 failing**; the 1 failing is the pre-existing cu-budget Scenario 6 serialization bug above. All 14 constraint-scaffolding failures are gone (15→1). Net delta accounted for: deleted `instruction-constraints.ts` (whole file) + `close-vault-pending-drain.ts` (whole file, single removed-feature test; close_vault still covered in sigil/audit-log/security-exploits) + 11 constraint-only `it()` blocks across 6 files (security-exploits ×5, policy-digest-invariant ×3, toctou-security ×1, audit-log-coverage ×2 [disc 15/21]) + cu-budget Scenarios 4/5 + sandwich-integration's `freshVault` constraint scaffolding stripped (0 tests lost — all 9 kept).
- **M1 EXIT gate must redefine "green"** = the real full suite. Remaining: the 1 cu-budget Scenario 6 serialization bug (test-only). FLAGGED follow-up: dead constraint-helper *definitions* in `tests/helpers/litesvm-setup.ts` (zero live callers) + orphaned raw-encoders in cu-budget.ts — harmless dead test code, prune in a focused cleanup.

## Open decisions to lock at each item's design-review
- M1-01: fix approach A / B / A+B (default B)
- M1-03: exact gate-vs-exception handler membership
- M1-04: error-code renumber vs reserve-in-place; assertions module location
- M1-06: MED-2 fix A (rolling) vs B (accept)
- M2-04: relationship to existing spend caps (avoid duplication)
