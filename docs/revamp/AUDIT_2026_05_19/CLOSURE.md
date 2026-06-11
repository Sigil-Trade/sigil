# Phases 0-5 Comprehensive Audit Remediation — Closure

**Date:** 2026-05-19
**Branch:** revamp/v2-2026-05
**Audit start HEAD:** `43d97e6` (Phase 6 R-1 had just landed; out-of-scope)
**Remediation start HEAD:** `1169668` (Phase 6 error-code drift note)
**Remediation end HEAD:** `363c6b4`
**Span:** 14 commits

## Audit Methodology

18 parallel agents dispatched at HEAD `43d97e6` to verify Phases 0-5 across:
- Per-primitive correctness (TA-01..TA-19, AC-1..AC-11, K1-K7)
- Schema math (8 accounts)
- Error codes (97 variants)
- IDL ↔ types ↔ SDK alignment
- L-1/L-2/L-8 compliance
- §RP transcript completeness
- Cross-doc consistency
- Cosign workflow attack vectors

## Findings + Disposition

### CRITICAL (1 NEW + 2 documented-deferred)

| ID | Finding | Disposition |
|---|---|---|
| **H-2** (NEW) | TA-12 stable_balance_floor reads Anchor-cached `.amount` at finalize_session.rs:633,649. CPI debits vault → cached value reflects PRE-CPI state → floor check passes when it shouldn't. TA-12 invariant defeated on canonical spending path. | **RESOLVED `2fc8f51`** — replaced Sources 1+2 with raw post-CPI bytes parse mirroring `agent_transfer.rs:316-360`. SPL TokenAccount layout: bytes 0..32 mint, 32..64 owner, 64..72 amount u64 LE. |
| **PEN-CROSS-1** | register_agent has no cosign/digest/timelock. Owner-key phishing → instant operator grant. | **PARTIALLY RESOLVED `abb7580`** — interim cosign gate added: when `policy.cosign_required == true` AND no non-owner signer present, reject with `ErrCosignRequired`. Default `cosign_required: false` vaults unaffected. Full digest + timelock fix stays Phase 8. |
| **PEN-8b** | set_observe_only(false) has no cosign check. Phishing on cosign-opted-in vault → flip false → drain. | **PARTIALLY RESOLVED `abb7580`** — same interim gate as register_agent. Direction-aware: only `new_value: false` triggers the gate (flipping ON is always safe). |

### HIGH (5 findings)

| ID | Finding | Disposition |
|---|---|---|
| **H-1** | destination_check.rs:120 `take(MAX_DESTINATION_CHECK_METAS_PER_IX)` silently drops metas 17+. Foreign DeFi ix with 25+ metas (Jupiter v6 max-step) can hide hostile destination. | **RESOLVED `1f569eb`** — replaced with `require!(ix_accounts.len() <= MAX_DESTINATION_CHECK_METAS_PER_IX, IxMetaCountExceeded)`. New error 6102. V1 mitigation = split routes; v1.1 backlog to expand to 32. |
| **H-4** | TA-11 `unwrap_or(true)` with inverted boolean — fail-closed posture structurally non-obvious. Future refactor could silently flip semantics. | **RESOLVED `e45c4f8`** — explicit `match ... None => FAIL_CLOSED_SIGIL_OWNED` with named const documenting the posture. |
| **PEN-7** | apply_pending_policy lacks defense-in-depth ratchet check. If future refactor reintroduces non-digest-bound field, silent bypass possible. | **RESOLVED `62c7262`** — static_assertion `EXPECTED_DIGEST_FIELD_COUNT == POLICY_PREVIEW_FIELD_COUNT` in apply_pending_policy.rs. Adding field #21 without updating both constants breaks `cargo build` with explicit guidance. |
| **agent-errors.ts** predicate stale (3 sites) | Phase 3/4/5 codes 6088-6096 mis-routed as "not Sigil errors" | **RESOLVED `e9c98b9`** — bumped `<=6087 → <=6102`. Header docstring documents maintenance pattern. |
| **L-2/L-8 violations** | REVAMP_PLAN §17/§18, THREAT_MODEL §17, ACCEPTANCE §14.5/§15.3 contain live audit/funding/TierRegistry language deleted under L-2 + L-8 | **RESOLVED `1e4e61a`** — wrapped in `<del>` tombstones preserving audit trail. 8 places fixed. ACCEPTANCE §15.3 wrap completed in `3ab16ae` (§RP-2 M-NEW-2). |

### §RP-2 Discovered (2 HIGH + 4 MEDIUM + 1 LOW)

§RP-2 silent-failure-hunter found additional gaps introduced by the remediation:

| ID | Finding | Disposition |
|---|---|---|
| **H-NEW-1** | `unpause_agent` missing interim cosign gate (P0.1 scope gap). Phished owner could pause→unpause to silently restore agent on cosign-opted-in vault. | **RESOLVED `d5faa2e`** — mirrored register_agent's gate. 3 unit tests added. |
| **H-NEW-2** | agent-errors.ts predicate widened to 6102 but ON_CHAIN_ERROR_MAP only had entries up to 6096. New codes 6097-6102 fell through to "Unknown on-chain error code N" with FATAL category. | **RESOLVED `e14beae`** — added 6 full mappings (MintDeltaCapExceeded, MintDeltaCapMisconfigured, AtaAuthorityChanged, OutputBelowFloor, DeclarationInconsistent, IxMetaCountExceeded) with category + recovery actions. Plus surfaced + fixed pre-existing IDL drift (errors.rs additions never propagated to IDL/types/SDK). 103 errors now aligned across IDL ↔ TS ↔ LiteSVM shim. |
| **M-NEW-1** | INTERFACES_V2.md:86 dangling reference to renamed file | **RESOLVED `3ab16ae`** — `squadsDetection.ts` → `squads-detection.ts` |
| **M-NEW-2** | ACCEPTANCE_V2.md §15.3 TierRegistry body not wrapped in `<del>` (label said deprecated, body still live) | **RESOLVED `3ab16ae`** — body wrapped matching §14.5 pattern |
| **M-NEW-3** | 6089 ErrCosignRequired message only mentioned queue_policy_update; after P0.1+H-NEW-1 it now fires from 4 sites | **RESOLVED `3ab16ae`** — message + recovery expanded to enumerate all 4 sites |
| **L-NEW-1** | PEN-7 ratchet catches "field count drift" but NOT "field encoded ≠ field counted" | **RESOLVED `363c6b4`** — TS-side runtime byte-length assertion derived from `POLICY_PREVIEW_FIELD_COUNT`. Catches encoder/struct mismatch at runtime. |

### MEDIUM (10 items — all closed in `257d39e`)

| ID | Finding | Disposition |
|---|---|---|
| M-1 | TA-09 trigger count drift (6 vs 7) | HARDENED §6 synced to INTERFACES_V2 (7 triggers) |
| M-2 | HARDENED §5 schema math stale | Updated to PolicyConfig 1290, SpendTracker 3328, PostExecutionAssertions 672 |
| M-3 | §RP transcripts missing from PHASE_4 + PHASE_5 | Added explicit notes (ephemeral; README disposition is source of truth) |
| M-4 | code-reviewer.md missing from ALL phase review dirs | Doctrine documented: silent-failure-hunter primary, code-reviewer supplementary |
| M-5 | ProtocolCapExceeded (6058) vs ErrDailyCapExceeded (6095) semantic overlap | Inline docstrings distinguishing the two |
| M-6 | AC-10 nonce dead-code comment (3 lines) | Compressed further; cites G2_DEFERRAL_RATIONALE.md |
| M-7 | kebab-case rename | cosignHelper.ts → cosign-helper.ts, squadsDetection.ts → squads-detection.ts |
| M-8 | cosignDigestsEqual not constant-time | XOR-accumulate, no early exit on mismatch |
| M-9 | TA-14 cursor invariant implicit | debug_assert added at boundary |
| M-10 | Squads V4 bus factor not documented | "Residual trust assumption" section added to G0_MULTISIG_HARDENING.md |

### LOW (closed in `561143e`)

- ComputeBudget program-ID 32-byte literal centralized in `state/mod.rs::COMPUTE_BUDGET_PROGRAM_ID`
- Stale cross-file line-ref at finalize_session.rs corrected
- Glossary TA-01..TA-16 range updated to current (TA-16 deleted)
- L-1 tier-tag vocabulary leak removed from ACCEPTANCE + THREAT_MODEL

### DEFERRED (explicit per audit guidance)

- **P3.5 LiteSVM enforcement-error tests for 10 missing primitives** (TA-03/05/06/07/08/17, AC-10, TA-12, TA-14, PEN-CROSS-4/5) — coverage hardening, not bug fixes. Defer to Phase 6.2 / pre-mainnet test sweep. Tracked in task #55 (Phase 6.1 sandwich tests umbrella).

## Final Test State

| Suite | Pre-audit (43d97e6) | Post-remediation (363c6b4) | Delta |
|---|---|---|---|
| cargo test --lib --features devnet-testing | 218/0 | **230 / 0** | +12 |
| sdk/kit pnpm test | 1737/0 | **1737 / 0** | stable |
| 4-file LiteSVM subset | 297/0 + 2 pending | **297 / 0 + 2 pending** | stable |
| sdk/kit npx tsc --noEmit | 0 errors | **0 errors** | stable |
| pnpm verify:error-drift | FAIL (pre-existing) | **OK: 103 errors aligned** | drift CLOSED |

## Commits

```
363c6b4 fix(policy-digest): §RP-2 L-NEW-1 — TS-side runtime byte-length assertion
3ab16ae docs+fix: §RP-2 MED sweep (M-NEW-1/2/3)
e14beae fix(sdk-kit): §RP-2 H-NEW-2 — add error mappings 6097-6102 + IDL refresh
d5faa2e fix(unpause-agent): §RP-2 H-NEW-1 — interim cosign gate
e974a06 test(litesvm): P0.1 fixup — supply cosign session signer
561143e refactor(state): P3.1 + P3.2 — ComputeBudget program ID single source
257d39e docs+fix: P2 MEDIUM sweep (M-1..M-10)
1e4e61a docs(revamp): P1.3 + P3.3 + P3.4 — tombstone L-2/L-8 sections
e45c4f8 fix(validate-and-authorize): P1.4 H-4 — explicit fail-closed for TA-11
e9c98b9 fix(sdk-kit): P1.2 — bump on-chain error predicate to 6102
1f569eb fix(destination-check): P1.1 H-1 — hard-reject ixs exceeding meta budget
62c7262 fix(apply-pending-policy): P0.2 — defense-in-depth ratchet check
abb7580 fix(register-agent,observe-only): P0.1 — interim cosign gate
2fc8f51 fix(finalize): H-2 CRITICAL — raw post-CPI bytes for TA-12 floor check
```

## Verdict: CLEAR-TO-PROCEED

All audit findings (CRITICAL/HIGH/MEDIUM/LOW) have been:
- (a) Resolved with verifiable fix commits, OR
- (b) Explicitly deferred with documented rationale + tracking task

The remediation cycle additionally surfaced + fixed:
- 1 pre-existing CRITICAL the audit caught (H-2 TA-12 stale `.amount`)
- 2 §RP-2 introduced gaps (H-NEW-1 unpause_agent, H-NEW-2 SDK mapping)
- 1 latent IDL drift (errors.rs not regenerated for 6088-6102)

Pattern observation: every remediation cycle in this project produces a §RP-2 follow-on with 1-2 new findings. The discipline is working — without §RP-2, both H-NEW-1 and the latent IDL drift would have shipped to Phase 7.

Phase 7 (Audit log + N1 temporal binding TA-15/C22) dispatch UNBLOCKED.
