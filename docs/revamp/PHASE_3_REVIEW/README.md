# Phase 3 §RP Review — Summary

**Phase:** 3 — Pre-execution guards (TA-03 / TA-05 / TA-06 / TA-07 / TA-08 / TA-09 / TA-17)
**Date:** 2026-05-18
**Verdict:** **CLEAR-TO-PROCEED** (1 LOW + 1 MEDIUM, both closed)

## Phase 3 commits

| # | TA | Subject | SHA |
|---|---|---|---|
| 0 | — | HARDENED §6 inline error-code fix | `c5e4aa2` |
| 1 | TA-03 | USDC/USDT mint pinning | `9fca361` |
| 2 | TA-05 | operating_hours UTC bitmask | `393bb3b` |
| 3 | TA-06 | per-agent cooldown | `d3b56f9` |
| 4 | TA-07 | destination graylist + auto_promote_grays | `3da5fa4` |
| 5 | TA-08 | Token-2022 extension ALLOWLIST (3-item) | `4f538b0` |
| 6 | TA-09 | cosign workflow for elevated mutations | `2eb9760` |
| 7 | TA-17 | auto-revoke on policy-violation consecutive_failures | `1d109a9` |
| 8 | fixtures | policy-digest-invariant Phase 3 args + queue_agent_perms owner | `935bf70` |
| 9 | fixtures | autoSiblingHandlerDigest helper Phase 3 args | `5711cba` |
| 10 | fixtures | toctou-security Phase 3 args | `5b527cc` |

## §RP findings + dispositions

| ID | Severity | Title | Fix commit |
|---|---|---|---|
| Vec-7 | LOW | AgentEntry docstring claimed "Incremented in finalize_session" (stale; actually `record_agent_violation`) | `f5d3ce3` |
| Vec-9 | MEDIUM | toctou-security:587 expected policyVersion==1 but Phase 2 PEN-CROSS-3 made create_instruction_constraints bump | `f5d3ce3` |

§RP-1 attack vector scorecard: 10/10 PASS (verbatim transcript at [silent-failure-hunter.md](./silent-failure-hunter.md)).

## Final state

- `cargo test --lib --features devnet-testing`: **157 / 0**
- `pnpm test` (workspace SDK): **1,718 / 0**
- `tests/sigil.ts + tests/security-exploits.ts + tests/policy-digest-invariant.ts`: **271 passing / 7 failing / 2 pending**
- `tests/toctou-security.ts`: **7 / 0** (was 6/1 pre-fix)

The 7 failing in the broader subset are pre-existing Signed/Bitmask sequencing fails predating the V2 revamp (Phase 2 baseline). Not Phase 3 regressions.

## Schema math

| Account | Pre-Phase-3 | Post-Phase-3 | Δ |
|---|---|---|---|
| PolicyConfig | 863 | **1273** | +410 |
| AgentSpendOverlay | 2528 | **2688** | +160 |
| AgentVault | 634 | **634** | 0 (TA-17 absorbed `_reserved[7]` → `_reserved[6]`) |
| PendingPolicyUpdate | 8294 | **8363** | +69 |
| PendingAgentPermissionsUpdate | 113 | **121** | +8 |

TA-19 canonical encoding: **14 → 17** fields (operating_hours at 15, auto_promote_grays at 16, auto_revoke_threshold at 17).

Error codes: **83 → 91** (6000-6090; 6083-6090 = Phase 3 inserts).

## New ix added in Phase 3

1. `promote_graylist_destination` — owner-only, fast-track graylist entry to unlocked
2. `record_agent_violation` — owner-only, off-chain-monitor-driven TA-17 increment (Engineer's pivot for Solana atomic-or-none execution model)

## Honest gaps (deferred or documented)

1. **TA-17 in-band increment** — HARDENED spec text said "increment in finalize_session"; Engineer correctly identified that Solana's atomic-or-none execution rolls back any state mutation inside a failing tx, so self-increment is impossible. Pivot to owner-only `record_agent_violation` ix called by off-chain monitor. Documented inline at `state/vault.rs:18-30` and at the ix docblock.

2. **TA-09 cosign as Pubkey + remaining_accounts** — HARDENED spec said `Option<UncheckedAccount>`; Engineer found Anchor 0.32 optional-account marshalling interfered with arg deserialization (false-positive elevated detection on non-elevated queues). Functionally identical guarantees: cosign != default, cosign != owner, signer presence, digest binding.

3. **3 timelock tests retuned** — `cancel pending policy succeeds`, `only one pending update at a time`, `lowering timelock back to MIN` originally used incidental cap-RAISE queues that TA-09 now correctly flags as elevated. Retuned to use lower caps so tangential assertions still exercise. Core invariants preserved.

4. **No LiteSVM end-to-end tests added for Phase 3 error codes (6083-6090)** — Coverage is at the cargo unit level (157 tests including 43 Phase 3) + property tests for cross-impl invariants. Deferred LiteSVM coverage absorbed into Phase 8 (ownership/freeze theme already has LiteSVM-heavy spec).

## Dispatch context

- Dispatched from: main orchestrator thread
- Tool used: `pr-review-toolkit:silent-failure-hunter`
- Single dispatch; no retry needed.

## Invocation log

| Attempt | Timestamp | Commits at dispatch | Verdict |
|---|---|---|---|
| 1 | 2026-05-18 (post `5b527cc`) | 10 Phase 3 commits | CLEAR-TO-PROCEED (1 LOW + 1 MEDIUM, both closed) |

## On code-reviewer absence

Same rationale as Phase 2: silent-failure-hunter's 10 attack vectors covered the same surface a code-reviewer dispatch would have hit (numerics ranges, TLV parsing correctness, account constraint completeness, error-code allocation drift, cross-impl encoding parity). A separate code-reviewer dispatch on Phase 3 would have been redundant work against the same code surface.
