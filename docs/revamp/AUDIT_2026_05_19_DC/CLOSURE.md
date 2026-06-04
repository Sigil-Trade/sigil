# DC1-DC14 Comprehensive Audit Closure (2026-05-19)

**Date:** 2026-05-19
**Branch:** `revamp/v2-2026-05`
**Audit start HEAD:** `5c67f4c` (post Phases 0-5 audit remediation closure)
**Remediation end HEAD:** `7b9afb2` (§RP-2 close-up)
**Span:** 3 audit-closure commits + 16-agent dispatch + 3 follow-on commits (2 §RP-1 + 1 §RP-2)

## Audit Methodology

16 parallel agents (DC1-DC14) at HEAD `5c67f4c` produced ~150 findings (8 CRIT,
~40 HIGH, ~50 MED, ~50 LOW). Working orchestrator then dispatched 4 verification
agents (CritVerify, SdkVerify, RustTestDocVerify, CleanupVerify) for adversarial
re-confirmation per CLAUDE.md project rules. Result:

| Severity | Audit count | After verify | Disposition |
|---|---|---|---|
| CRITICAL | 8 | 6 confirmed + 1 narrowed + 1 refuted | All addressed or deferred with rationale |
| HIGH (SDK) | 10 | 6 confirmed + 2 refuted + 1 uncertain + 1 escalated | All addressed |
| HIGH (Rust) | 4 | 4 confirmed | 2 fixed, 2 documented |
| HIGH (Test) | 10 | 8 confirmed + 1 partial + 1 mischaracterized | 5 fixed, 5 deferred to Phase 6.1 / Phase 10 |
| HIGH (Doc) | 6 | 4 confirmed + 1 partial + 1 refuted | All addressed |
| MEDIUM | ~50 | most CONFIRMED with severity adjustments | Closed or deferred |
| LOW | ~50 | mixed | Closed or deferred |

## Commits

```
7b9afb2 fix(audit): §RP-2 close-up — F-RP2-1 + F-RP2-3 + F-RP2-5
e3c0ac7 fix(audit): §RP-1 SilentHunter close-up — C + E + G
c13c6d9 fix(audit): §RP-1 close-up — F-1 + F-2 + F-3 Pentester findings
3e742e9 fix(repo): DC1-DC14 P0/P1 batch B — tests + docs + cleanup
e0aabca fix(sdk-kit): DC1-DC14 P0 batch A — SIZE constants + event aliases + error range
```

## Findings + Disposition (CRITICAL)

| ID | Finding | Verdict | Disposition |
|---|---|---|---|
| **C-1** | declare_id ≠ keypair-derived pubkey (`H2Hxvpig…` vs `7FtAXUcr…`) | CONFIRMED | **DEFERRED to Phase 10 redeploy** — fresh program ID + keypair will be generated for mainnet. Documented as Phase 10 prerequisite. |
| **C-2** | SPEND_TRACKER_SIZE 2840→3328 in SDK | CONFIRMED | **RESOLVED** in `e0aabca` (preview-create-vault.ts:111). |
| **C-3** | AGENT_SPEND_OVERLAY_SIZE 2528→2688 in SDK | CONFIRMED | **RESOLVED** in `e0aabca` (preview-create-vault.ts:118). |
| **C-4** | `getPermissionEscalationLatency` filters dead event `AgentPermissionsUpdated` | CONFIRMED (wider: 3 SDK files + 3 test fixtures) | **RESOLVED** in `e0aabca`. Migrated all 4 SDK call-sites + 6 test fixture lines to `AgentPermissionsChangeApplied`. PolicyUpdated → PolicyChangeApplied migration also included (event-analytics + security-analytics + audit-trail). |
| **C-5** | tests/policy-digest-invariant.ts missing `auxValue` / `auxByte` | CONFIRMED | **RESOLVED** in `3e742e9` (Engineer dispatch). 3 sites updated with zero defaults (legacy mode 0). 11/11 tests passing. |
| **C-6** | 8 test files orphaned from CI (minor path-naming nuance) | CONFIRMED (7 valid, 1 was non-existent path) | **RESOLVED** in `3e742e9` + `c13c6d9`. ci.yml on-chain-tests job expanded from 6 files to 13 files including: `analytics-counters`, `missing-coverage`, `policy-digest-invariant`, `post-assertions-r-variants`, `post-assertions-sandwich`, `sysvar-scan-bound`, `toctou-security`. Excluded: `instruction-constraints.ts` (pre-existing test-setup bug, separate fix needed). |
| **C-7** | Phase 5/6 primitives missing REJECT tests | NARROWED (only TA-12 + TA-17, not R-1..R-4 or TA-14) | **PARTIALLY RESOLVED** in `c13c6d9`. TA-17 REJECT test added in `tests/missing-coverage.ts:493-546`. TA-12 *digest-binding* IS tested at `sdk/kit/tests/policy/preview-digest.test.ts:367` ("stable_balance_floor flip changes the digest"); the missing piece is the *on-chain runtime reject* path which requires full validate→DeFi→finalize sandwich — DEFERRED to Phase 6.1 task #55. |
| **C-8** | R-4 mode==7 fall-through CRIT | **REFUTED** | Stale finding. Fix already landed in `db51a30` (validate_and_authorize.rs:1293-1295). PHASE_6_REVIEW/README.md confirms. |

## Findings + Disposition (HIGH SDK)

| ID | Finding | Verdict | Disposition |
|---|---|---|---|
| **H-SDK1** | Error map missing Phase 6 codes 6097-6101 | **REFUTED** | Already fixed in §RP-2 `e14beae`. 6097-6102 all mapped. |
| **H-SDK2** | ANCHOR_ERROR_MAX 6078, actual 6102 (24-code drift) | CONFIRMED | **RESOLVED** in `e0aabca` (dashboard/errors.ts:231). Categorize test bolstered to iterate ALL generated SIGIL_ERRORS. |
| **H-SDK3** | MAX_POST_ASSERTION_ENTRIES 4, actual 8 | **REFUTED** | Already fixed in §RP-2 `cb8bcbe`. |
| **H-SDK4** | PENDING_CONSTRAINTS_SIZE 35,904, actual 35,912 (8-byte short) | **ESCALATED TO P0** | Functional break: `queue_constraints_update` would REJECT on size mismatch. **RESOLVED** in `e0aabca` (constraint-builders.ts:79). |
| **H-SDK5** | AGENT_VAULT_SIZE 633, actual 634 | CONFIRMED | **RESOLVED** in `e0aabca` (preview-create-vault.ts:93). |
| **H-SDK6** | POLICY_CONFIG_SIZE 822, actual 1,290 (468-byte drift) | CONFIRMED | **RESOLVED** in `e0aabca` (preview-create-vault.ts:104). |
| **H-SDK7** | `@usesigil/agent` declares `^0.16.0` of `@usesigil/kit` (at 0.15.0) | CONFIRMED | **RESOLVED** in `e0aabca` (sdk/agent/package.json:43 → `workspace:*`). |
| **H-SDK8** | `shieldWallet` phantom API in 14 custody JSDoc refs | CONFIRMED | **RESOLVED** in `3e742e9` (Engineer dispatch). 7 source files + README updated to use real `shield()`. **§RP-1 follow-on:** dist/ artifacts also flushed via `prepublishOnly` hook in `c13c6d9`. |
| **H-SDK9** | sdk/agent vs sdk/platform consumer count | CONFIRMED | INFORMATIONAL — sdk/agent is a CLI binary not a library; sdk/platform has 0 in-repo consumers. **DEFERRED architectural decisions to Phase 9 SDK redesign.** |
| **H-SDK10** | ~325 root barrel exports vs 21 external consumers | UNCERTAIN | **DEFERRED to Phase 9** — bulk-deletion blocked by inability to enumerate downstream consumers from inside agent-middleware. Conservative posture: add @deprecated v0.17 markers in Phase 9. |

## Findings + Disposition (HIGH Rust)

| ID | Finding | Verdict | Disposition |
|---|---|---|---|
| **H-RUST1** | VaultStatus::Closed dead variant + 12 defensive checks | CONFIRMED | INFORMATIONAL — variant is structurally unreachable (Anchor `close = owner` deallocates before any check). Defensive checks left in place as belt-and-suspenders. |
| **H-RUST2** | ProtocolSpendCounter expired slots never cleared | CONFIRMED | **DOCUMENTED** as known issue. Real attack: 11th protocol after 10 slots fill never lands. Eviction logic for the V1 implementation deferred — not exploitable in default 10-protocol configuration. Tracked in v1.1 backlog. |
| **H-RUST3** | Certora harness covers ~10% of trust-critical surface | CONFIRMED | INFORMATIONAL — Certora coverage expansion is a separate workstream beyond scope of audit closure. |
| **H-RUST4** | `solana-program = ">=2"` dangerously loose | CONFIRMED | **RESOLVED** in `3e742e9` (programs/sigil/Cargo.toml:34 → `~2.3`). CI uses cargo `--locked` (verified at lines 379, 507, 607) so `Cargo.lock` provides the actual pin. |

## Findings + Disposition (HIGH Test)

| ID | Finding | Verdict | Disposition |
|---|---|---|---|
| **H-TEST1** | Default `pnpm test` runs 3 of 25 files | CONFIRMED | **RESOLVED** — ci.yml expansion brings on-chain CI coverage to 13 files / 392 passing tests. Default `pnpm test` deliberately kept minimal for fast local iteration. |
| **H-TEST2** | `createMockVaultState` defaults all-permissive | LIKELY | **DEFERRED to Phase 9 SDK redesign** — splitting into permissive/strict variants is part of SDK API rework, not audit cleanup. |
| **H-TEST3** | dailySpendingCapUsd: 0n semantic mismatch | LIKELY (mischaracterized) | **DEFERRED** — actual bug is SDK doesn't reject 0n; small UX improvement, not blocking. |
| **H-TEST4** | SDK devnet tests silently skip | CONFIRMED | INFORMATIONAL — env-gated by design; skip behavior intended. |
| **H-TEST5** | TEE wallet sig tests assert only `length > 0` | CONFIRMED | **DEFERRED to Phase 9 SDK redesign** — TEE adapter test hardening separate from V2 protocol. |
| **H-TEST6** | seal.test.ts weak `.to.exist` assertions | CONFIRMED | **DEFERRED to Phase 9 SDK redesign** — seal() rewrite already on the docket. |
| **H-TEST7** | Dead event aliases | CONFIRMED | **RESOLVED** in `e0aabca` — see C-4 closure. |
| **H-TEST8** | Devnet test files stale arg counts | CONFIRMED | **DEFERRED to Phase 10 redeploy** — devnet tests will be rewritten against new program ID. |
| **H-TEST9** | devnet-test.yml cron disabled 2026-04-03 | CONFIRMED | **RESOLVED** in `c13c6d9` — explicit documentation comment added pointing to this audit closure + Phase 10 re-enable plan. Cron stays disabled until Phase 10 redeploy refreshes the devnet fixtures. |
| **H-TEST10** | 7 instructions with ZERO test coverage | NARROWED to 5 (3 false positives) | **RESOLVED** in `3e742e9` — added 5 happy-path tests + 1 TA-17 REJECT + 1 PEN-8b REJECT in `tests/missing-coverage.ts` (7/7 passing). |

## Findings + Disposition (HIGH Docs)

| ID | Finding | Verdict | Disposition |
|---|---|---|---|
| **H-DOC1** | ERROR-CODES.md 28 errors stale (claimed 43) | CONFIRMED | **RESOLVED** in `3e742e9` — regenerated from IDL (75 → 103 rows, 6000-6102). New `scripts/regen-error-codes-doc.sh` for future drift prevention. |
| **H-DOC2** | ARCHITECTURE.md PDA sizes wrong + Escrow row | CONFIRMED | **RESOLVED** in `3e742e9` — all 11 PDA sizes corrected + EscrowDeposit row tombstoned. |
| **H-DOC5** | L-1/L-2 strips never fully applied | PARTIAL (mischaracterized) | INFORMATIONAL — tombstones exist; full strip is intentional preservation of audit trail. |
| **H-DOC6** | STAGE_1_REMOVED.md arrow reversed | **REFUTED** | Arrow IS historically correct (Phase 1 demolition). Annotation added to clarify Phase 2 re-added 1 byte for observe_only. |

## §RP-1 Follow-On Findings (Pentester)

| ID | Finding | Severity | Disposition |
|---|---|---|---|
| **F-1** | tests/missing-coverage.ts NOT in ci.yml | HIGH | **RESOLVED** in `c13c6d9` (added to ci.yml on-chain-tests). |
| **F-2** | set_observe_only(false) cosign-gate UNTESTED | HIGH | **RESOLVED** in `c13c6d9` (added PEN-8b REJECT test). |
| **F-3** | sdk/custody/dist/ stale shieldWallet JSDocs | HIGH | **RESOLVED** in `c13c6d9` (prepublishOnly hook + dist rebuild). |
| **F-4** | solana-program ~2.3 supply-chain | MEDIUM | INFORMATIONAL — CI uses `--locked`, Cargo.lock is real pin. |
| **F-5..F-9** | INFO findings | INFO | Confirmed clean. |

## §RP-1 Follow-On Findings (silent-failure-hunter)

| ID | Finding | Severity | Disposition |
|---|---|---|---|
| **C** | instruction-constraints.ts exclusion no inline rationale | HIGH | **RESOLVED** in `e3c0ac7` (ci.yml inline comment). |
| **E** | dashboard/errors.ts:231 stale `isSigilOnChainCode` predicate ref | MEDIUM | **RESOLVED** in `e3c0ac7` (corrected to inline `code <= 6102` predicate references). Further hardened in `7b9afb2` (§RP-2) by extracting to named constant. |
| **G** | react peer dep removal vs /react subpath JSDoc mismatch | LOW | **RESOLVED** in `e3c0ac7` (restored `react: ">=18.0.0"` optional peer dep). |

## §RP-2 Follow-On Findings (silent-failure-hunter)

| ID | Finding | Severity | Disposition |
|---|---|---|---|
| **F-RP2-1** | shieldWallet describe blocks still in 3 custody test files | HIGH | **RESOLVED** in `7b9afb2` (renamed in privy/turnkey/crossmint .test.ts). |
| **F-RP2-3** | `6102` literal duplicated across 4 sites | MEDIUM | **RESOLVED** in `7b9afb2` — extracted `SIGIL_ON_CHAIN_ERROR_{MIN,MAX}` as exported constants. |
| **F-RP2-5** | CLOSURE.md C-7 understates existing TA-12 digest coverage | LOW | **RESOLVED** in `7b9afb2` (C-7 row updated to cite preview-digest.test.ts:367). |
| **F-RP2-2** | Hard-coded line refs in JSDoc | LOW | INFORMATIONAL — line refs valid at HEAD; will revisit on next refactor. |
| **F-RP2-4** | CLOSURE.md path stability under future doc reorg | LOW | INFORMATIONAL — current path is stable; will move with revamp/ archive after Phase 11. |

## Final Test State

| Suite | Pre-audit (5c67f4c) | Post-closure (7b9afb2) | Delta |
|---|---|---|---|
| `cargo test --lib --features devnet-testing` | 230/0 | **230/0** | stable |
| `sdk/kit pnpm test` | 1737/0 | **1740/0** | +3 |
| Expanded CI on-chain suite (13 files) | 297/0 + 2 pending | **392/0 + 2 pending** | **+95** |
| `pnpm verify:error-drift` | OK 103 errors | **OK 103 errors** | stable |
| `sdk/kit npx tsc --noEmit` | 0 | **0** | stable |

## Deferred (with explicit rationale)

| Item | Reason | Tracker |
|---|---|---|
| TA-12 stable_balance_floor REJECT test | Requires full validate→DeFi→finalize sandwich | task #55 (Phase 6.1) |
| Phase 6.1 sandwich integration tests for R-1..R-4 | Heavyweight InstructionConstraints PDA setup | task #55 |
| `instruction-constraints.ts` 10 failures | Pre-existing test-setup bug (AccountOwnedByWrongProgram 3007), not a real vuln | Separate fix task |
| Program-ID keypair mismatch | Fresh keypair will be generated for Phase 10 redeploy | task #47 (Phase 10) |
| Devnet test file stale arg counts (3 files) | Will be rewritten for Phase 10 program ID | task #47 |
| devnet-test.yml nightly cron | Same blocker as above | Phase 10 |
| ~325 root barrel SDK exports | External consumer surface unknowable from inside repo | task #46 (Phase 9) |
| TEE wallet sig test hardening | Part of Phase 9 SDK redesign | task #46 |
| seal.test.ts `.to.exist` weak assertions | Part of Phase 9 SDK redesign | task #46 |
| `createMockVaultState` permissive/strict split | Part of Phase 9 SDK redesign | task #46 |
| ProtocolSpendCounter eviction | V1 limitation, not exploitable in default config | v1.1 backlog |

## Verdict: CLEAR-TO-PROCEED

All audit findings (CRITICAL / HIGH / MEDIUM / LOW) have been:
- (a) Resolved with verifiable fix commits, OR
- (b) Explicitly deferred with documented rationale + tracker

The remediation cycle additionally surfaced + fixed:
- 3 §RP-1 Pentester HIGH findings (F-1, F-2, F-3)
- 3 §RP-1 SilentHunter follow-ons (C HIGH + E MED + G LOW)
- 3 §RP-2 SilentHunter follow-ons (F-RP2-1 HIGH + F-RP2-3 MED + F-RP2-5 LOW)
- 1 pre-existing latent issue (custody dist/ stale on publish surface)

Pattern observation: every remediation cycle in this project produces a §RP-N
follow-on with 1-3 new findings. The discipline is working — without §RP-1 in
this cycle, CI would have silently skipped 7 newly-authored tests, the
dangerous cosign-gate direction would have remained untested, stale custody
dist JSDocs would have shipped to npm, the instruction-constraints exclusion
rationale would have been ungrep'able, and the react peer dep removal would
have silently broken /react subpath consumers. §RP-2 then surfaced the
shieldWallet test-file follow-on that §RP-1 missed (src + dist were fixed but
tests retained the phantom-API describe blocks) and the duplicated `6102`
literal that next error-code addition would otherwise edit-3-fix-1.

**Phase 7 (Audit log + N1 temporal binding TA-15/C22) dispatch UNBLOCKED.**
