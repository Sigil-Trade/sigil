# Phase 3 §RP — silent-failure-hunter (iter 1)

**Date:** 2026-05-18
**Phase:** 3 — Pre-execution guards (TA-03/05/06/07/08/09/17)
**Dispatched from:** main orchestrator thread
**Tool:** `pr-review-toolkit:silent-failure-hunter`
**HEAD at dispatch:** `5b527cc`
**Verdict:** **CLEAR-TO-PROCEED** (1 LOW + 1 MEDIUM, both closed)

## Scope

10 commits since Phase 2 close (`f1511c8`):

| Group | Commits |
|---|---|
| HARDENED §6 inline code-fix | `c5e4aa2` |
| Phase 3 TA implementations | `9fca361`, `393bb3b`, `d3b56f9`, `3da5fa4`, `4f538b0`, `2eb9760`, `1d109a9` |
| Test fixture migration | `935bf70`, `5711cba`, `5b527cc` |

10 attack vectors run. All 7 TAs (TA-03/05/06/07/08/09/17) verified field-by-field against `HARDENED_V2_PROMPT_MAP.md` §6 Phase 3 contract.

## Findings

### LOW — Vector 7: AgentEntry doc drift

`programs/sigil/src/state/vault.rs:18-25` claimed `consecutive_failures` "Incremented in finalize_session" — stale claim. The increment lives in the new owner-only ix `record_agent_violation` (Engineer's honest-gap pivot for Solana's atomic-or-none execution model). No security impact, doc-only.

**Disposition:** RESOLVED in commit `1c5ec4f`. Docstring rewritten to describe the actual off-chain-monitor model.

### MEDIUM — Vector 9: toctou-security test expectation surfaced post-Phase-2

`tests/toctou-security.ts:587` expected `policyVersion == 1` after the `create_instruction_constraints + apply_constraints_update` pair. Phase 2 PEN-CROSS-3 made `create_instruction_constraints` bump `policy_version` (sibling-handler digest re-bind), so the pair now bumps 0→1→2. This is pre-existing Phase 2 behavior that surfaced after Phase 3 fixture migration touched the file.

**Disposition:** RESOLVED in commit `1c5ec4f`. Expectation updated to `equal(2)` with inline comment explaining the create+apply double-bump intent.

## Attack vector scorecard

| # | Vector | Verdict |
|---|---|---|
| 1 | TA-03 USDC/USDT mint pinning (constants, rejection order, devnet-testing gate) | **PASS** |
| 2 | TA-05 operating_hours bitmask (rem_euclid, F-13 ordering, upper-8-bit reject) | **PASS** |
| 3 | TA-06 per-agent cooldown (PER-AGENT storage, F-16 regression-clean) | **PASS** |
| 4 | TA-07 graylist friction (bounded ≤10, owner-only promote, digest exclusion) | **PASS** |
| 5 | TA-08 Token-2022 TLV ALLOWLIST (real TLV parse, forward-secure reject, ≤64 iter) | **PASS** |
| 6 | TA-09 cosign workflow (digest binding, signer required, owner!=cosign) | **PASS** |
| 7 | TA-17 auto-revoke (numeric-range filter, threshold floor/ceiling, reset path) | **PASS** (1 LOW doc) |
| 8 | TA-19 digest extension (17 fields, cross-impl byte-equality) | **PASS** |
| 9 | Honest-gap regressions (toctou + 3 retuned timelock tests) | **PASS** (1 MEDIUM closed) |
| 10 | F-16 regression guard (no per-vault cooldown anywhere) | **PASS** |

## Final state (post fix-up)

- `cargo test --lib --features devnet-testing`: 157/0
- `pnpm test` (workspace): 1718/0
- `tests/sigil.ts + tests/security-exploits.ts + tests/policy-digest-invariant.ts`: 271/0 passing (7 pre-existing Signed/Bitmask sequencing fails predating V2 — not Phase 3)
- PolicyConfig SIZE: 863 → **1273** bytes (+410 Phase 3: operating_hours u32 + graylist Vec<Entry,10> + auto_promote_grays bool + auto_revoke_threshold u8)
- AgentSpendOverlay SIZE: 2528 → **2688** bytes (+160 Phase 3: cooldown_seconds[10] + last_action_unix[10])
- AgentVault SIZE: 634 → **634** bytes (TA-17 absorbed 1 byte from `_reserved[7]` → `_reserved[6]`)
- TA-19 canonical encoding: 14 → **17** fields (positions 15/16/17 = operating_hours, auto_promote_grays, auto_revoke_threshold)
- 83 → **91** error codes (6000-6090; 6083-6090 are Phase 3)
- 8 new ix added or modified: 7 new pre-exec guards + `record_agent_violation`, `promote_graylist_destination`, `set_observe_only` (Phase 2 still)

## Verdict: CLEAR-TO-PROCEED

Phase 3 FINAL complete. All §RP findings closed. Phase 4 dispatch unblocked.

---

**END of Phase 3 §RP-1 transcript**
