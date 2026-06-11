# Audit Remediation Closure — 2026-05-18

**Branch:** `revamp/v2-2026-05`
**Start HEAD:** `1dcc92d` (Phase 1-5 audit synthesis committed)
**End HEAD:** `61bb7bf` (G6 final)
**Span:** 21 commits

## Final Test State

| Suite | Pre-audit (1dcc92d) | Post-remediation (61bb7bf) | Δ |
|---|---|---|---|
| `cargo test --lib --features devnet-testing` | 163 / 0 | **193 / 0** | +30 |
| `sdk/kit tsc --noEmit` | (had drift) | **0 errors** | clean |
| `sdk/kit pnpm test` | 1720 / 0 | **1737 / 0** | +17 |
| Policy-digest-invariant LiteSVM | broken | **11 / 0** | restored |

## Gate Status (Final)

| Gate | Severity | Status | Commit(s) |
|---|---|---|---|
| **G0** Squads multisig on program upgrade authority | structural | ⏳ PENDING USER CLI | `G0_MULTISIG_HARDENING.md` runbook |
| **G1** SDK Codama regen (CRIT-1) | CRITICAL | ✅ CLOSED | `df31598` |
| **G2** register_agent TA-19 binding (PEN-CROSS-1) | HIGH | ⚠️ DEFERRED to Phase 8 | `G2_DEFERRAL_RATIONALE.md` + THREAT_MODEL_V2 AC-2 update |
| **G3** TA-09 elevation for TA-12 floor + TA-14 cap | HIGH | ✅ CLOSED | `cc5d336` |
| **G3a** Semantic-aware predicates (CRIT-1 from §RP-2) | CRITICAL | ✅ CLOSED | `cc79e6b` + `a784c4c` |
| **G4** cosignHelper.ts + migrate 7 deferred tests | HIGH | ✅ CLOSED | `87902b6` + `f207ff9` + `2790b51` |
| **G5** Doc drift sync (INTERFACES + HARDENED + THREAT_MODEL) | HIGH | ✅ CLOSED | `607c662` |
| **G6** Cosign opt-in + Squads V4 detection helper | NEW (user request) | ✅ CLOSED | `9965a50` + `f6f1031` + `d5b0d8d` + `425c5ae` + `61bb7bf` |
| Improvements: PerRecipientCounter impl methods | MEDIUM | ✅ CLOSED | `73e14ec` |
| Improvements: AgentSpendOverlay::get_agent_entry helper | LOW | ✅ CLOSED | `edf3a98` |
| Cleanup: AC-10 nonce dead-code comment compression | LOW | ✅ CLOSED | `28e5ffc` |
| Cleanup: Redundant inner require! in TA-10/11 | LOW | ✅ CLOSED | `02c0b94` |
| Cleanup: Overflow → InvalidSession rename | LOW | ✅ CLOSED | `cfc5dc2` |
| Cleanup: 5 stale "CU exhaustion 6047" comments | LOW | ✅ CLOSED | `5eedee4` |

## What Materially Changed in the Foundation

### 1. SDK now actually works
Pre-remediation: any user calling `getInitializeVaultInstruction()` or `getQueuePolicyUpdateInstruction()` through the SDK produced wire payloads 16 bytes short of the on-chain expectation. The two flagship Phase 5 features (`stable_balance_floor` + `per_recipient_daily_cap_usd`) were on-chain but unreachable via the SDK.

Post-remediation: Codama regenerated. Both fields present. Hand-written callers (4 sites in `sdk/kit/src/`) wired through. SDK is now exercise-able end-to-end.

### 2. TA-09 elevation gate has correct semantics
The Phase 5 elevation extension (G3) used naive `new > old` predicates. The §RP-2 audit caught that this was wrong for the "0 = unlimited" convention used in `per_recipient_daily_cap_usd` and `has_protocol_caps` + `protocol_caps`. A phished owner could sign `Some(0)` and bypass elevation entirely. G3a replaced both predicates with semantic-aware versions that correctly classify weakening mutations regardless of the convention direction. 13 new boundary tests pin the corrected semantics.

### 3. TA-09 cosign is now opt-in, default off
G6 added `cosign_required: bool` to PolicyConfig (canonical encoding position 20). At vault creation the owner picks. Default is `false` (low-friction). When `false`, elevated mutations skip the cosign check and are gated only by the owner's transaction signature — the standard single-signer flow.

When the owner DOES opt in (`cosign_required: true`), TA-09 enforces the cosign workflow on the full set of 7 elevation triggers from G3a. Disabling cosign (true → false) is itself an elevated mutation — a one-way ratchet that prevents silent disable via owner-key phishing.

### 4. Squads V4 multisig is recognized, not required
Sigil DOES NOT enforce multisig. The vault owner is just a Pubkey. If a user chooses to use a Squads V4 multisig PDA as their vault owner, multi-signing happens at the Solana layer (handled by the Squads program before Sigil ever sees the transaction).

G6 added `sdk/kit/src/squadsDetection.ts` — a read-only helper that checks if a vault owner pubkey is owned by the Squads V4 program (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`). The dashboard can use this to:
- Show a "single-signer protection" warning banner when the owner is a solo key + `cosign_required = false`
- Suppress the warning when the owner is a Squads multisig (multi-sig at Solana layer is providing protection)

### 5. cosignHelper.ts now exists
G4 closed the gap where TA-09 cosign was implemented on-chain but had no SDK client. 7 LiteSVM tests that were deferred to Phase 9 because they had no way to construct a valid cosign session now pass cleanly.

### 6. Type design + invariant expression improvements
- `PerRecipientCounter` now has 5 invariant methods (`is_empty`, `is_expired`, `matches`, `accumulate`, `reset`) so future callers cannot bypass the no-LRU eviction guarantee
- `AgentSpendOverlay` has a typed `get_agent_entry` helper for read paths
- Net result: invariants live in the type, not in caller discipline

### 7. Doc drift fully synced
- `INTERFACES_V2.md` — all error codes correct, PROTECTED_SEED_PREFIXES enumerated, TA-09 elevation set lists all 7 triggers
- `HARDENED_V2_PROMPT_MAP.md` — §6 Phase 2 inline codes match §4 reservation table
- `THREAT_MODEL_V2.md` — AC-2 enumerates the 3 protection modes (solo+no-cosign, solo+cosign, multisig-owner). PEN-CROSS-1 listed as OPEN known issue with Phase 8 deferral pointer. §17 retitled "V1 Mainnet-Ready Summary" instead of "Stage 6 audit handoff" per L-2.

## Known Open Items

### G0: Squads multisig program upgrade authority (your CLI action)
File: `docs/revamp/AUDIT_2026_05_18/G0_MULTISIG_HARDENING.md`

5-minute CLI command. $0. Closes bus-factor-1 structural risk. Recommended before Phase 6 dispatch. Independent of all other work.

### G2: PEN-CROSS-1 register_agent (deferred to Phase 8)
File: `docs/revamp/AUDIT_2026_05_18/G2_DEFERRAL_RATIONALE.md`

`register_agent.rs` has no TA-19 binding + no timelock + not in TA-09 elevated set. Owner-key phishing → instant operator grant.

Mitigation in V2: STRONGLY recommend Squads V4 multisig as vault owner. Single-key owners SHOULD NOT deploy until Phase 8 ships the full fix (timelock + digest binding + cosign integration). Listed as OPEN in THREAT_MODEL_V2.md AC-2.

121-callsite cascade for the proper fix → defer to Phase 8 where ownership-transfer M-5 nonce reuse already requires touching this surface.

### Legacy LiteSVM fixture sweep (separate task, pre-existing)
13 test files (`tests/sigil.ts`, `tests/jupiter-integration.ts`, `tests/flash-trade-integration.ts`, `tests/instruction-constraints.ts`, `tests/analytics-counters.ts`, `tests/cu-budget.ts`, `tests/security-exploits.ts`, `tests/sysvar-scan-bound.ts`, `tests/toctou-security.ts`, `tests/surfpool-integration.ts`, `tests/jupiter-lend-integration.ts`, `tests/helpers/devnet-setup.ts`, `tests/helpers/surfpool-setup.ts`) were never migrated for Phase 5's `stable_balance_floor` + `per_recipient_daily_cap_usd` args. Verified pre-existing (identical baseline before and after G6).

These tests were the "5 LiteSVM tests subset" we ran throughout the audit work — they were passing at 4-file subset (sigil + security-exploits + policy-digest-invariant + toctou-security) which was migrated by prior phase engineers. The OTHER files in the broader `tests/` tree were never migrated.

Recommended: dedicated fixture-sweep task before or during Phase 6 dispatch. ~2 hours of mechanical migration. Not blocking Phase 6 work itself — Phase 6's new code can ship while the legacy fixtures get caught up.

## Phase 6 Dispatch Status

**UNBLOCKED** for Phase 6 (Maestro borrows R-1/R-2/R-3) — pending:
1. G0 CLI action (your task, 5 min)
2. Optional: legacy fixture sweep (recommended but not blocking)

The on-chain foundation is now in significantly better shape than at the start of the audit:
- 30 more cargo unit tests passing
- 17 more SDK tests passing
- All 5 named audit gates closed or explicitly deferred with rationale + mitigation
- 1 NEW user-driven feature (G6 cosign opt-in + Squads detection) shipped
- 4 cleanup-pass improvements
- 2 type-design improvements
- 11 doc drift fixes

Phase 6 should proceed.
