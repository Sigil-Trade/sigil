# Phase 8 §RP Review — Summary

**Phase:** 8 — C26 ownership transfer + C27 freeze_reason + C28 reactivate cooldown + PEN-CROSS-1 absorption
**Date:** 2026-05-19
**Status:** IN PROGRESS — implementation batches landing in sequence

## Council ISCReview pre-build (2026-05-19, before BUILD)

Per CLAUDE.md mandate ("we keep having these audit issues"), Council ISCReview ran BEFORE any code landed. 4-perspective adversarial review (Security Engineer, On-chain Rust Engineer, Test Architect, Audit Methodology) added **21 blind spots + 6 amendments** to the original ISC criteria:

| Council Perspective | Findings Added |
|---|---|
| Security Engineer | 6 blind spots — invalid-target blocklist, cosign-on-initiate, reject-when-frozen, is_multisig_target attack vectors, PEN-CROSS-2 post-size re-verify |
| On-chain Rust Engineer | 6 blind spots — APPEND-ONLY migration, SIZE math vs repr(C), CU bound post-agent_set_hash, MAX_REVOKE_PAIRS, PDA seed collision, atomic reentrancy |
| Test Architect | 6 blind spots — boundary off-by-one, freeze→initiate sequence, agent_set_hash mid-flight, empty Vec determinism, multisig replay, CU regression |
| Audit Methodology | 6 blind spots — file enumeration for line-by-line, F19 pattern blocked, F-AT-1 walker dedup, verbatim transcripts, F-RP3-2 sibling drift, every cached-deser re-validation |

**ALL council findings folded into ISC criteria** (ISC-128..148 + anti-criteria A7-A9). Pre-build pressure-test discipline applied.

## Phase 8 commits (in flight)

| # | Type | Subject | SHA |
|---|---|---|---|
| 1 | Foundation | feat(schema): Phase 8 Batch 1 — AgentVault +9 bytes + FreezeReason + 6 error codes | `0cf6b9a` |
| 2 | Helper | feat(freeze): Phase 8 Batch 2 — shared freeze_helper (closes F-7) | `028f83f` |
| 3 | C26 owner-side | feat(ownership): Phase 8 Batch 3 — pending PDA + initiate/accept/cancel | TBD |
| 4 | C26 multisig | feat(ownership): Phase 8 Batch 4 — Squads V4 multisig variant | TBD |
| 5 | C28 + T-19 | feat(freeze): Phase 8 Batch 5 — reactivate cooldown + T-19 doc | TBD |
| 6 | PEN-CROSS-1 | feat(security): Phase 8 Batch 6 — Operator timelock + TA-19 agent_set_hash | TBD |
| 7 | §RP + closure | docs(phase-8): Phase 8 Batch 7 — §RP verdicts + closure | TBD |

## Past-mistake guardrails applied this phase

1. **Spec-vs-code drift caught BEFORE code landed** — Phase 8 spec said `agent_set_hash` at PolicyPreviewFields position 15; code state showed positions 15-20 occupied. Corrected to position 21 APPEND-ONLY in ISC-66 before Batch 6 dispatch.
2. **F19 cached-deserialization pattern blocked** — freeze_helper.rs::parse_token_account_raw reads (mint, owner, amount) via `try_borrow_data()`, not Anchor `.amount`. ISC-137 + Anti-criterion A8 enforced.
3. **F-RP3-2 sibling-handler-drift blocked** — FreezeReason as typed compile-time argument forces every freeze caller to declare reason explicitly. ISC-138 propagation verified at queue_agent_permissions_update (Batch 6).
4. **Sequential batches** — 7 batches forced strict sequential execution to avoid parallel-agent merge conflicts on 6 shared files. ISC-A multi-agent coordination explicit.
5. **Round 2 line-by-line discipline IN-PHASE** — ISC-112 enumerates files for line-by-line audit; ISC-113 requires VERBATIM transcripts (not summaries) in PHASE_8_CLOSURE.md.

## §RP findings + final verdict

See `CLOSURE.md` for full disposition of all 22 findings (5 CRITICAL + 7 HIGH + 5 MEDIUM + 5 LOW). All CRITICAL/HIGH fixed; MEDIUM/LOW either fixed or explicitly documented with deferral rationale.

**Verdict: CLEAR-TO-MAINNET on the on-chain layer.** Phase 9 (SDK redesign) and Phase 10 (devnet fresh redeploy) proceed unblocked.
