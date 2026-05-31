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
| M1-01 HIGH destination-allowlist | PLANNED | — | — |
| M1-02 HIGH frozen-accept | PLANNED | — | — |
| M1-03 systemic frozen-gate | PLANNED | — | — |
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

## Open decisions to lock at each item's design-review
- M1-01: fix approach A / B / A+B (default B)
- M1-03: exact gate-vs-exception handler membership
- M1-04: error-code renumber vs reserve-in-place; assertions module location
- M1-06: MED-2 fix A (rolling) vs B (accept)
- M2-04: relationship to existing spend caps (avoid duplication)
