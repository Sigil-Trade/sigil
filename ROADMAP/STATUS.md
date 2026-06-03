# Sigil On-Chain Roadmap — Status Ledger

**Created:** 2026-05-30 · **Branch (planned):** `revamp/onchain-m1` · **Program ID:** `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` (upgrade-in-place, no new ID)
**Last reconciled:** 2026-06-02 (HEAD `bedd7dfe`). NOTE: two roadmap framings now coexist — this ledger's original `M1-XX` items, and the 2026-06-01 audit's `F-Qx` items in `ENFORCEMENT_MODEL.md` (the authoritative enforcement spec). The mapping is noted inline (M1-01=F-Q1a, M1-05≈F-Q8, M1-06≈F-Q4); a full structural merge of the two framings is pending doc-debt.

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
| M1-01 HIGH destination-allowlist (= F-Q1a) | **DONE** | WIP `3ed911bd` (branch; no PR yet) | "Honest F-Q1a": completeness invariant (fail-closed `DestinationAccountUnresolvable` 6105) + seal() satisfier (revives per-recipient cap) + writable-meta cap (24 — real Jupiter routes pass) + sink-scoped skip (swaps survive). A/B/A+B SUPERSEDED — hard WHERE-allowlist is undecidable on swaps (pool conduits are byte-identical to exfil) → kept on `agent_transfer`; swap path enforces completeness + conservation. Evidence: 154 cargo + 1847 SDK + 445 litesvm green (1 PRE-EXISTING cu-budget overrun, §below); error-drift OK (106 codes); 2 adversarial reviews → no CRIT/HIGH. |
| M1-02 HIGH frozen-accept | **DONE** | — | both accept-handler gates applied (EOA :118, MS :136); 4 tests (3 single-sig 9500/01/02 + 1 multisig 9300); GREEN: ownership-transfer.ts 18/0, ownership-transfer-multisig.ts 6/0, all 4 M1-02 ✔; RED-proven load-bearing (gates git-stashed while UNCOMMITTED → exactly the 2 EXPLOIT-BLOCKED tests fail "null≠6000"; REGRESSION+REACTIVATION stay green); adversarial review PASSED (no blocking; complete owner-mutation surface; freeze_helper sets vault.status=Frozen which the gate reads); build+IDL clean |
| M1-03 systemic frozen-gate | **DONE** | — | 8 additive owner handlers gated → VaultNotActive 6000 (apply_pending_policy, apply_agent_permissions_update, queue_policy_update, queue_agent_permissions_update, register_agent, unpause_agent, promote_graylist_destination, set_observe_only[OFF-dir]); subtractive/defensive stay allowed while frozen (revoke/pause/cancel_*/deposit/record_violation); cancel_ownership_transfer stays ==Active per PEN-04; constraints pipeline deferred to M1-04. **Tests `tests/m1-03-frozen-gate.ts` 14/14**: 8 GATED reject-6000 + 5 EXCEPTION succeed-while-frozen + 1 ANTI-BRICK (revoke-last→auto-frozen→register rejected→reactivate restores Active). RED-proven load-bearing (gates reverted to a07c4811 + recompiled ungated → exactly the 8 GATED fail, 5 EXCEPTION pass). audit-log-burst MED-1 ×2 FIXED (rolling-agent, never hits zero mid-loop; 5/0). Adversarial review PASSED (no CRIT/HIGH/MED; completeness CONFIRMED — no additive mutator missed; brick REFUTED — reactivate_vault is the owner-only recovery). Principle: project_sigil_frozen_gate_principle_2026_05_31 |
| M1-04 constraints teardown | **DONE** | `7a9a6b7d` / `7f3e895f` / `c2ac2cb8` | full cross-layer teardown: dead error codes removed + renumbered (Step 6); `close_vault` constraints-drain removed (04b); protected-denylist seeds + dead test scaffolding stripped (04c); IDL/SDK/digest surfaces pruned. M1-04 design decision (renumber vs reserve-in-place) → resolved as full renumber. |
| M1-05 promote agnostic primitives | **PARTIAL** | `bedd7dfe` | **F-Q8 output-ATA pin SHIPPED** (`bedd7dfe`): finalize `require_keys_eq!`s the measured stablecoin ATA == the validate-pinned pubkey, closing the substituted-vault-ATA spoof on the non-stablecoin-input path (input ATA already pinned via `delegation_token_account`). RED-proven test + kit codec regen (SessionAuthority SIZE 515→547 + `outputStablecoinAccount`); adversarial review no CRIT/HIGH. **REFRAMED (agnostic-ethos):** the min-out / dust-return (F-Q8 gap #1) is the oracle-free **valuation-wall residual** — NOT patched. Sigil bounds custody + stablecoin flow, never trade price or what an agent holds (round-trip-only / min-return-floor REJECTED as scope/oracle creep). **F-Q8 intent-digest fold: MOOT** — its only payload (`min_stablecoin_out` + `max_input_amount`, parts B/C) was REJECTED by the agnostic-ethos reframe, so nothing remains to bind; the full meta+data digest is the separate **F-Q1b @ M2**. **F-Q9: CODE FIXED `76e0ccc7`** — `finalize_session.rs:335` `saturating_sub`→checked-revert (err 6110 `SpendAccountingUnderflow`), closing the silent under-count; the Certora conservation proof (rule I1 NO-UNDERCOUNT) remains **M2**. **STILL OPEN (deferred):** non-stablecoin-branch upper bound (M1-06) + Certora I1 (M2). |
| M1-06 mediums | PLANNED | — | re-scoped by `ENFORCEMENT_MODEL` → **F-Q4** (Token-2022: block NonTransferable(9); extend extension-allowlist to the finalize typed chokepoint). Not started. |
| M1 EXIT devnet+adversarial | PLANNED | — | "green" must = the real full LiteSVM suite (§Test-suite reality), modulo the 1 pre-existing cu-budget overrun |

## Post-M1-04: enforcement-model audit + on-chain validation (2026-06-01 .. 06-02)

- **Full first-principles enforcement audit + 5-perspective council + my verification** (2026-06-01)
  → `ENFORCEMENT_MODEL.md` + `ENFORCEMENT_MODEL_DECISIONS.md` (authoritative spec; DRAFT, untracked).
  Re-grounds M1-01..M2 as `F-Qx`. Kaleb ratified Q1-Q9 with overrides; verification right-sized
  inflated severities (F-Q2 refuted-as-drain → deferred; F-Q6 HIGH-not-CRIT; F-Q9 LOW).
- **F-Q1a shipped** = the M1-01 row above (commit `3ed911bd`).
- **On-chain model first-principles validation** (2026-06-02; 9 research agents) → VERDICT: the
  atomic sandwich is the correct core (**#1** for the JTBD; nothing strictly dominates it). Sigil is
  a **LAYERED** model — agnostic read-only sandwich BASE (today) + optional curated premium layers
  (SOL-valuation side-cap; CPI-interposition) as **roadmap, not foundations**. Async-settlement
  blindness is **bounded** (capital-at-risk is already measured in-tx; close it with read-only
  owner-pins + floor) → see **M3**. Corrections logged: CPI depth-8 is ACCEPTED but **NOT yet live**
  (~Agave 4.1 / Alpenglow Q3 2026), not "live since Aug 2025"; web3.js v2 = `@solana/kit`, SDK-only,
  parked. PRD: `~/.claude/MEMORY/WORK/20260602-110403_onchain-model-first-principles-validation/`.
- **F-Q8 output-ATA pin shipped** (2026-06-02, commit `bedd7dfe`) — the M1-05 row above. finalize
  pins the measured stablecoin ATA by pubkey (custody-integrity of the conservation measurement).
  The dust-dump / min-out (F-Q8 gap #1) was REFRAMED, not patched: it is the oracle-free
  valuation-wall residual — Sigil bounds custody + stablecoin flow, not trade price or what an agent
  holds (agnostic-ethos correction). PRD: `~/.claude/MEMORY/WORK/20260602-123931_implement-fq8-output-ata-pin/`.

## M3 progress (NEW — async/perps custody hardening; read-only)
| Item | Status | PR | Notes |
|---|---|---|---|
| M3-01 floor catastrophic backstop | PLANNED | — | default-on/forced + complete combined-stablecoin sum on seal; tier-1; lands first; depends on F-Q1a (done) |
| M3-02 per-protocol custody owner-pin | PLANNED | — | finalize-time; extend `verify_ata_authority_pin` to perp Position structs (Jupiter Perps `Position.owner`, Drift `User.authority`); new err `ErrPositionOwnerMismatch` |
| M3-03 retire denylist (per protocol) | PLANNED | — | STRICTLY gated — only after each protocol's M3-02 pin lands; keep fail-closed default for un-pinned async programs |
| M3-04 honest scope-line + cap-coverage audit | PLANNED | — | publish "bounds capital-committed (=max-loss isolated margin) + custody, NOT MTM PnL"; verify all collateral movements hit caps |

Plan: `ROADMAP/M3_ASYNC_HARDENING.md`. OUT-of-scope (tracked, NOT M3): CPI-interposition (gated on
depth-8 ~Q3 2026 — verify the on-chain feature gate first), SOL-valuation side-cap (gated on
terminal-holds decision), MTM/leverage caps (advisory only), cross-ledger bridges (out-of-domain).

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

## Open decisions

**Resolved (items now DONE):**
- M1-01: RESOLVED — "Honest F-Q1a" (completeness + satisfier + writable-cap + sink-scoped; hard WHERE-allowlist only on `agent_transfer`). Shipped `3ed911bd`.
- M1-03: RESOLVED — gate-vs-exception handler membership locked (see M1-03 row).
- M1-04: RESOLVED — full error-code renumber; assertions live in `utils/post_assertion_helpers.rs`.

**Open:**
- M1-06 (now F-Q4): MED-2 fix A (rolling) vs B (accept) — revisit under the F-Q4 Token-2022 re-scope.
- M2-04: relationship to existing spend caps (avoid duplication).
- M3: cross-margin (Drift) conservative-vs-exclude; v1 scope (all M3-01..04 vs subset); per-protocol owner-field offsets (verify vs Jupiter-Perps / Drift IDLs); limit/trigger escrow timing (gap vs covered).
- Out-of-scope but owed: definitive on-chain feature-gate check for CPI depth-8 (SIMD-0268) before any interposition work is treated as real.
