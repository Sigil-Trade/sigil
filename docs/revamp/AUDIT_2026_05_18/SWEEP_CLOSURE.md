# LiteSVM Sweep + Post-Sweep §RP Closure — 2026-05-18

**Branch:** `revamp/v2-2026-05`
**Start HEAD:** `d8aa88e` (audit-remediation closure)
**End HEAD:** `053ee06` (P2 cosign coverage close)
**Span:** 9 commits (7 sweep + 2 P2 fix)

## What This Closed

### Phase 1: LiteSVM Fixture Sweep (7 commits, `306488b` → `bdccead`)

Migrated 145+ callsites across 12 LiteSVM test files to the post-G6 ix arg surface:
- `initialize_vault` 17 args → **18 args** (`cosign_required` added)
- `queue_policy_update` 17 args → **18 args** (`cosign_required` Option added)
- `validate_and_authorize` 4 args → **5 args** (`expected_nonce` per AC-10)
- `PolicyPreviewFields` 19 fields → **20 fields** (`cosign_required` at position 20)

**Files migrated:**

| Commit | Files | Callsites |
|---|---|---|
| `306488b` | `tests/sigil.ts` | 56 |
| `ca85bf6` | `tests/security-exploits.ts` | 43 |
| `92a3fc8` | `tests/toctou-security.ts` + `tests/helpers/litesvm-setup.ts` | 5 + helper |
| `e359b36` | `tests/jupiter-integration.ts` | 3 + 1 helper |
| `e813f2f` | `tests/flash-trade-integration.ts` + `tests/instruction-constraints.ts` | 13 + 3 validate-and-authorize fixes |
| `464af08` | `tests/analytics-counters.ts` + `tests/cu-budget.ts` + `tests/sysvar-scan-bound.ts` + `tests/jupiter-lend-integration.ts` | 6 + 2 helpers |
| `bdccead` | `tests/surfpool-integration.ts` | 10 + 2 queue + 20 validate-and-authorize |

**Bonus fixes the sweep Engineer surfaced:**
- 6 `validateAndAuthorize` callsites were at 4 args but IDL requires 5 (AC-10 stale fixture drift)
- `tests/helpers/litesvm-setup.ts::autoSiblingHandlerDigest` was missing G6 position 20 — would have caused silent digest mismatches in sibling-handler tests

### Phase 2: Post-Sweep §RP CRITICAL Closure (2 commits, `c78c64f` + `053ee06`)

Both silent-failure-hunter and Pentester independently caught: the sweep used `cosign_required: false` default at every vault init, which meant **the entire G6 elevation gate had zero LiteSVM coverage**. Tests labeled "ELEVATED" silently passed through the non-elevated branch.

Fix:
- 5 new tests added under `"G6 cosign opt-in enforcement (audit §RP-2 P2 coverage)"` block
- 3 vault inits flipped to `cosignRequired: true` to actually exercise the elevation gate
- 2 sites annotated as decorative (where flipping would have broken unrelated tests sharing a helper)

The 5 new tests:
1. Opted-in vault rejects elevated mutation without cosign session → `ErrCosignRequired`
2. Opted-in vault accepts elevated mutation with valid cosign → succeeds, digest binds correctly
3. Opted-in vault rejects owner self-cosign → `ErrCosignRequired` (covers `require_keys_neq!(cosign_session, owner.key())`)
4. Opted-in vault rejects disable-cosign without cosign session → `ErrCosignRequired` (one-way ratchet)
5. Non-opted-in vault accepts enable-cosign without cosign session → succeeds (enabling is free)

## Final Test State

| Suite | Pre-sweep (d8aa88e) | Post-sweep + P2 (053ee06) | Δ |
|---|---|---|---|
| `cargo test --lib --features devnet-testing` | 193 / 0 | **193 / 0** | stable |
| `sdk/kit tsc --noEmit` | 0 errors | **0 errors** | stable |
| `sdk/kit pnpm test` | 1737 / 0 | **1737 / 0** | stable |
| 4-file LiteSVM subset | 285 / 7 (deferred TA-09) | **297 / 0** | +12 passing, **all 7 TA-09 deferrals now closed** |
| Full LiteSVM tree | broken (~0 passing) | **404 / 10** | +404 passing; 10 remaining are pre-existing Phase 2 Signed/Bitmask sequencing (unrelated to sweep/G6) |
| security-exploits.ts | 154 / 7 | **166 / 0** | +12 passing, 0 failing |

## Pre-Existing Failures Still Open (Pre-Phase-2 Signed/Bitmask)

10 failures remain in `tests/instruction-constraints.ts` — all are constraint-operator decoding/validation in `programs/sigil/src/state/constraints.rs:258-275`. Documented in `project_sigil_phase_2_audit_2026_05_18.md` MEMORY as HIGH Signed/Bitmask sequencing.

None of these touch `cosign_required`, `stable_balance_floor`, or `per_recipient_daily_cap_usd` codepaths. They are pre-existing — verified by the sweep Engineer via `git stash` comparison.

**Recommendation:** Address in a dedicated Phase 7 or Phase 11 cleanup pass alongside the audit log + temporal binding work.

## Post-Sweep §RP Verdicts (Both Verdicts CLEAR after P2 fix)

### silent-failure-hunter
| ID | Severity | Finding | Status |
|---|---|---|---|
| V1 | LOW | expected_nonce migration audit | CLEAR — `init` zero-fills, fresh sessions are always nonce=0 |
| V2 | CRITICAL | G6 cosign gate has zero LiteSVM coverage | **CLOSED** via P2 fix |
| V3 | — | Sibling-handler digest + G6 position 20 | CLEAR |
| V4 | — | 10 Signed/Bitmask failures | CLEAR — pre-existing constraint operator decoding |
| V5 | — | Surfpool consistency | CLEAR |
| V6 | — | autoSiblingHandlerDigest byte-equality | CLEAR |
| V7 | — | Live policyVersion fetch correctness | CLEAR |

### Pentester
| ID | Severity | Finding | Status |
|---|---|---|---|
| P1 | HIGH | Dashboard has zero cosign UI surface | **DEFERRED to dashboard repo** (task #54 tracking) — must land before V1 |
| P2 | HIGH | Elevation gate has zero LiteSVM coverage | **CLOSED** via P2 fix |
| P3 | MEDIUM | Cosign only protects `queue_policy_update` triggers, not destructive paths (set_observe_only / freeze_vault / withdraw_funds / close_vault) | **DEFERRED to Phase 7/8** (task #54 tracking) — V1 mitigation = Squads multisig as vault owner |
| P4 | LOW | Squads detection trust assumption | CLEAR — fail-safe to false on RPC failure, no caching |
| P5 | LOW | Cross-impl digest stability | CLEAR — HEX pins byte-equal across all 3 encoders |
| P6 | INFO | PEN-CROSS-1 register_agent still open | CLEAR (deferral documented per G2) |
| P7 | INFO | TA-10/11 sandwich integrity preserved | CLEAR |
| P8 | INFO | G6 one-way ratchet verified | CLEAR — 8 unit tests cover all 4 spec cases |

## Deferred Items (Tracking Task #54)

### P1: Dashboard cosign UI (Different Repo)
The G6 `cosign_required` field exists on PolicyConfig, is bound by TA-19, and is exposed by the SDK — but the `../dashboard/` repo has zero references. Owners using the dashboard cannot:
- See or choose the `cosignRequired` toggle at vault creation
- See a "single-signer protection" warning when they choose to leave it off
- Benefit from the `detectSquadsV4Owner` helper that would suppress the warning when owner is already a multisig

**Must land before V1 release.** Scope is in the separate dashboard repo, not blocking Phase 6 work.

### P3: Cosign Coverage of Destructive Paths
G6 cosign only gates the 7 elevation triggers in `queue_policy_update`. A phished owner with `cosign_required: true` can still single-signer-execute:
- `set_observe_only` — bypass execution lock
- `freeze_vault` / `reactivate_vault`
- `withdraw_funds` — actual drain path
- `close_vault` — destructive close

**V1 mitigation:** STRONGLY recommend Squads V4 multisig as vault owner. When `vault.owner` is a Squads PDA, the Solana layer enforces multi-signing on every owner action including these destructive paths. Sigil cosign is the per-mutation-elevation layer; Squads is the per-owner-action layer.

**Phase 7/8 architectural decision:** Either extend cosign to those 4 destructive ix (additive, ~1-2 days), or document as known limitation (recommended for V1).

## Phase 6 Status

**FULLY UNBLOCKED.** Foundation is materially better than at audit start:
- 193 cargo unit tests passing (was 163)
- 1737 SDK tests passing (was 1720)
- Full LiteSVM tree green except 10 pre-existing Phase 2 Signed/Bitmask
- All 5 named audit gates closed (G2 deferred with rationale + threat-model update)
- G3a CRIT-1 + 4 §RP-2 HIGHs closed
- G6 cosign opt-in shipped with full LiteSVM coverage
- 4 cleanup-pass improvements
- 2 type-design refactors
- 11 doc drift fixes synced

Phase 6 can dispatch. Recommended pre-dispatch: complete G0 (Squads multisig on program upgrade authority) — your CLI action.
