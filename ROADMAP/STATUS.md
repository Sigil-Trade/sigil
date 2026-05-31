# Sigil On-Chain Roadmap — Status Ledger

**Created:** 2026-05-30 · **Branch (planned):** `revamp/onchain-m1` · **Program ID:** `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` (upgrade-in-place, no new ID)

## Plan approval
- [ ] Master roadmap approved by Kaleb
- [ ] M1 PRDs approved
- [ ] M2 design-level PRDs approved
- [ ] 5 resolved content-forks accepted (see 00_ROADMAP §3)

## Baseline (filled by M1-00)
- Baseline SHA: (pending)
- Test count: (pending)
- F-4 WIP committed: (pending)
- Stashes triaged: (pending)
- Docs archived: (pending)

## M1 progress
| Item | Status | PR | Notes |
|---|---|---|---|
| M1-00 baseline | PLANNED | — | — |
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
