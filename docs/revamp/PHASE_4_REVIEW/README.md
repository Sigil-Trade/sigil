# Phase 4 §RP Review — Summary

**Phase:** 4 — Bundle integrity (TA-10 hardening + TA-11 + AC-10 nonce + PEN-CROSS-4/5 absorption)
**Date:** 2026-05-18
**Verdict:** **CLEAR-TO-PROCEED** (after one fix-up cycle resolving 2 fixture artifacts + 3 doc gaps)

## Phase 4 commits

| # | Group | Subject | SHA |
|---|---|---|---|
| 0 | Inline code-fix | HARDENED §6 Phase 4 error codes 6089-91 → 6091-93 | `3b767f6` |
| 1 | AC-10 | session.rs nonce field + expected_nonce ix arg | `54ac36b` |
| 2 | TA-10 | sandwich integrity uniqueness | `5d34aec` |
| 3 | TA-11 | dynamic seed-prefix family check + owner verify | `9f8edda` |
| 4 | PEN-CROSS-4 | destination_check program_id pre-filter | `71bf164` |
| 5 | PEN-CROSS-5 + T-DoS-3 | policy_version bump + ALT paragraph + fixture refresh | `735b200` |
| 6 | §RP-1 partial | SESSION_SIZE 375→383 + F-10 args | `478bdb0` |
| 7 | §RP-1 close-up | AC-10 forward-compat clarification + TA-11 prefix count + has_one cosmetic | `cdb20f8` |

## §RP-1 findings + dispositions

| ID | Severity | Title | Disposition |
|---|---|---|---|
| Vec-1 | MEDIUM | AC-10 spec doc overstates V2 role | RESOLVED in `cdb20f8` — clarified V2 active defense is policy_version; AC-10 is forward-compat for Phase 8 M-5 |
| Vec-3 | MEDIUM | TA-11 docstring count off | RESOLVED in `cdb20f8` — 12 active + 4 forward-compat = 16 PROTECTED_SEED_PREFIXES; 12 + 1 sentinel = 13 runtime array |
| Vec-6 | LOW | `has_one = vault` cosmetic | RESOLVED in `cdb20f8` — clarifying comment added on register_agent.rs noting PDA-seeds-derivation is functionally equivalent |
| Vec-8 | HIGH | Test fixture incomplete (claimed F-10 fixtures missing 2 args) | RESOLVED in `478bdb0` — added operating_hours + cosign_session positions to 2 F-10 queue calls; underlying test classification (TA-09 cosign-required) confirmed deferred to Phase 9 |
| Fix-up | — | F2-H1 freeze_vault regression | RESOLVED — was a stale binary artifact (target/deploy/sigil.so didn't reflect PEN-CROSS-5 changes); `anchor build --no-idl` rebuilt cleanly, no source change needed |
| Fix-up | — | SDK type drift claim | RESOLVED — was a stale LSP snapshot; SDK codama-generated types already incorporate Phase 4 args/accounts at HEAD `478bdb0`. tsc --noEmit clean. |

## Final state

- `cargo test --lib --features devnet-testing`: **157 / 0**
- `sdk/kit pnpm test`: **1,718 / 0**
- `sdk/kit tsc --noEmit`: clean (zero errors)
- 4-file LiteSVM subset (sigil + security-exploits + policy-digest-invariant + toctou-security): **280 passing / 7 failing / 2 pending**

The 7 failing are ALL TA-09 cosign-required tests in `security-exploits.ts` — they exercise elevated policy mutations (raise daily_cap, expand destinations, raise max_tx) which TA-09 correctly rejects with `ErrCosignRequired` (6089). The tests don't supply a cosign session. **Deferred to Phase 9 SDK redesign** which will ship cosign helpers; fixing fixtures by hand now would block on architecture decisions that belong in Phase 9. Phase 4 implementation is correct.

## Schema math

| Account | Pre-Phase-4 | Post-Phase-4 | Δ |
|---|---|---|---|
| SessionAuthority | 375 | **383** | +8 (AC-10 nonce u64 APPEND) |
| PolicyConfig | 1273 | **1273** | 0 (policy_version field pre-existing) |
| AgentSpendOverlay | 2688 | **2688** | 0 (per-agent cooldown landed Phase 3) |
| AgentVault | 634 | **634** | 0 |

Error codes: **91 → 94** (6091 ErrSandwichIntegrity, 6092 ErrProtectedWritable, 6093 ErrSessionNonceMismatch).

New ix accounts: `register_agent`, `revoke_agent`, `pause_agent`, `unpause_agent` all gained `policy: Account<PolicyConfig>` for the PEN-CROSS-5 OCC bump.

New ix arg: `validate_and_authorize` gained `expected_nonce: u64` (AC-10).

## AC-10 disposition (V2 vs Phase 8)

AC-10 is **forward-compatible structural infrastructure for Phase 8 M-5 ownership-transfer replay protection**, not the active V2 defense against durable-nonce replay. The active V2 defense is the `policy_version` equality check at `validate_and_authorize.rs:172-175` — a pre-signed durable-nonce tx replayed after the owner bumps policy_version (via apply_pending_policy, register_agent, set_observe_only, etc.) rejects with `PolicyVersionMismatch`. AC-10 closes the spec contract so Phase 8 can extend without state-shape migration.

Inline clarification at `state/session.rs:65-103` documents the semantics. HARDENED §6 Phase 4 task 1 now opens with this clarification per §RP-1 V1.

## TA-11 prefix scope

`PROTECTED_SEED_PREFIXES` (state/mod.rs) has 16 entries — all from HARDENED §6 line 811-815. The runtime `protected: [Pubkey; 13]` array in validate_and_authorize.rs has 12 real keys + 1 `Pubkey::default()` sentinel slot. The 4 entries (audit_success, audit_rejected, cosign, recipient) are forward-compat documentation — Phase 7+ ships these PDAs, so they have no live derivation in V2. Clarified docstring landed at `cdb20f8`.

## Honest gaps deferred

1. **7 TA-09 cosign-required test failures** (deferred to Phase 9 SDK redesign — needs cosign helper API)
2. **Pre-existing 2 pending tests** (Signed/Bitmask test sequencing, predates V2)

## Dispatch context

- §RP-1 dispatched from main orchestrator thread post `735b200`
- Tool: `pr-review-toolkit:silent-failure-hunter`
- Verdict: FIX-AND-RETEST → 1 HIGH (fixture migration debt) + 2 MEDIUM + 1 LOW
- All findings resolved through 2 commits (`478bdb0` partial fix + `cdb20f8` fix-up close)
- §RP-2 NOT dispatched — fix-up engineer verified all gates green end-to-end

## Invocation log

| Attempt | Timestamp | Commits at dispatch | Verdict |
|---|---|---|---|
| 1 | 2026-05-18 (post `735b200`) | 5 Phase 4 commits | FIX-AND-RETEST |
| (close-up) | 2026-05-18 (post `cdb20f8`) | 7 Phase 4 commits + 2 close-up | CLEAR-TO-PROCEED |

## §RP transcript disposition (audit M-3 + M-4, 2026-05-19)

**§RP discipline used:** silent-failure-hunter as primary reviewer (the
load-bearing transcript per phase, when written); code-reviewer was
supplementary on phases with overlapping attack-vector surfaces — its
use varied phase-by-phase based on review focus, not a doctrine
requirement.

**Phase 4 specific:** the silent-failure-hunter transcript for §RP-1 was
ephemeral (consumed inline during the §RP-1 → fix-up cycle that
landed `478bdb0` + `cdb20f8`). It was not persisted to
`PHASE_4_REVIEW/silent-failure-hunter.md`. The Vec-1 / Vec-3 / Vec-6 /
Vec-8 finding table above (with explicit RESOLVED-in-SHA annotations)
+ "Fix-up engineer verified all gates green end-to-end" line in §RP-2
NOT dispatched is the source-of-truth disposition for Phase 4.
code-reviewer was not invoked for Phase 4 (the attack-vector focus
was bundle integrity, fully covered by silent-failure-hunter's
ephemeral pass).

Future phases (Phase 7+) MUST persist the silent-failure-hunter
transcript to maintain consistency with Phase 1/2/3/6 — Phase 4 + 5
remain the documented exception.
