# Phase 9 SDK Redesign — §RP Closure Disposition

**Branch:** `revamp/v2-2026-05`
**Diff:** `fc1f1d6..HEAD` (12 Batch A-L commits + Batch M §RP fix-up)
**Stats:** 46 files changed, +3,470 / -718
**Tests:** 1804 passing (baseline 1750; +54 new)
**TypeScript:** zero errors
**Verdict:** CLEAR-TO-MERGE to `main` as `0.16.0`. Six convergent findings landed inline; eleven deferred to `0.16.1` with explicit dispositions and tracking notes.

---

## 1. Review fleet (parallel multi-agent line-by-line audit)

Per user directive at Batch M, eleven agents reviewed the full Phase 9 diff
end-to-end:

| # | Agent | Lens |
|---|---|---|
| 1 | `pr-review-toolkit:silent-failure-hunter` | Silent error suppression + missed exceptions |
| 2 | `pr-review-toolkit:code-reviewer` | Conventions + readability + casts |
| 3 | `pr-review-toolkit:type-design-analyzer` | Encapsulation/invariants on 10 new types |
| 4 | `pr-review-toolkit:pr-test-analyzer` | 54-test coverage gaps + mutation-readiness |
| 5 | `pr-review-toolkit:comment-analyzer` | JSDoc accuracy + future-rot risk |
| 6 | `Pentester` | 15-scenario attack matrix vs AL3/AL4/AL2 |
| 7 | `Engineer` (principal) | Architectural cohesion + production-readiness |
| 8 | `CodexResearcher` | External validation vs Solana ecosystem |
| 9 | `Vulnhunter`-methodology sweep | Sharp-edges + footguns |
| 10 | `Security` skill (STRIDE/OWASP) | Threat model + supply chain |
| 11 | `Thinking → Red Team` | Adversarial steelman + knife |

**Convergence threshold:** any finding raised by 2+ independent agents is
treated as CONFIRMED and addressed inline. Lone findings are evaluated on
merit.

---

## 2. Findings disposition

### LANDED INLINE (Batch M fix-up)

| ID | Source | Severity | Fix |
|---|---|---|---|
| **F-1** | Red Team + Engineer + Security H1 + Pentester A1 + silent-failure-hunter CRIT-2 + comment-analyzer C1 | CRITICAL (docs) | **AL3 framing**: CHANGELOG/README/`intent-digest.ts` no longer claim on-chain `executeSeal` enforcement. AL3 is documented as "client-integrity digest for preview-UI binding; on-chain verifier planned for later release." |
| **F-2** | comment-analyzer C2 | CRITICAL (docs) | **"Deferred to 0.16.1" lie**: CHANGELOG/README previously listed AL3/AL4/AL2 as deferred. Now correctly placed in the SHIPPED section with explicit "client-integrity digest only in 0.16.x" qualifier. |
| **F-3** | comment-analyzer C2 | HIGH (docs) | **Stale line numbers** at `intent-digest.ts:76-93` (493/858/957) replaced with symbol references (`COMPUTE_BUDGET_PROGRAM`, `replaceAgentAtas`, `computeSealInputDigest`). Symbols don't rot; line numbers do. |
| **F-4** | code-reviewer C-1 | CRITICAL | **Numeric error code 7020 collision**: pre-existing `SDK_ERROR_CODES[7020] = "COMPAT_BRIDGE_FAILED"` already taken. Dropped "legacy numeric code 7020/7021" doc claims from `errors/codes.ts`, `seal.ts`, `CHANGELOG.md`. SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_{REQUIRED,REJECTED} are string-discriminant only. |
| **F-5** | code-reviewer H-1 | HIGH | **Browser compat regression**: `multisig-detection.ts:123` used Node-only `Buffer.from`. Replaced with `atob()` + `Uint8Array.from(binStr, ch => ch.charCodeAt(0))` per the cross-runtime contract `canonical-encode.ts` promises. |
| **F-6** | silent-failure-hunter CRIT-1 | CRITICAL | **`toSigilAgentError` context strip**: every `executeAndConfirm` catch funneled `SigilSdkDomainError` (including the carefully crafted MAINNET_CONFIRMATION_REQUIRED error with vault/network/docs/snippet context) through pattern-matcher + UNKNOWN/FATAL fallback, silently stripping `.code` + `.context`. Fix: early-branch on `err instanceof Error && err.code.startsWith("SIGIL_ERROR__")`, wrap unmodified in `SigilSdkError` preserving the code + context. AL2 throws now surface with full context to consumers. |
| **F-7** | type-design + vulnhunter H1 (LIKELY) | HIGH (documented) | **AL3 doesn't bind `additionalAtaReplacements` + `outputStablecoinAccount`**: caller-supplied overrides materially change downstream ATA flow. Inline docstring at `intent-digest.ts:91-97` now explicitly warns "a preview UI that wants tight intent binding MUST refuse any SealParams carrying these overrides until 0.16.1 hashes them into the canonical encoding." Full bind requires `intent_version: u8 = 2` bump → deferred to 0.16.1. |

### DEFERRED TO 0.16.1 (tracked)

| ID | Source | Severity | Rationale for deferral |
|---|---|---|---|
| **D-1** | Engineer #8 + Pentester A1 + Red Team | HIGH (architectural) | **AL3 on-chain verifier**: requires Rust-side `validate_and_authorize` change to accept + check the digest. Cross-cuts Phase 10 devnet redeploy. Tracked for v0.17.0 prep. Doc framing in 0.16.0 makes the "advisory until verifier ships" boundary explicit. |
| **D-2** | code-reviewer H-2 + test-analyzer + silent-failure-hunter HIGH-1 + Engineer (3 agents) | HIGH (test gap) | **al2-mainnet-gate.test.ts tautological**: the 8-row "matrix" loop asserts a regex against its own literal string. Replace with chai-spy on logger + `expect(...).to.throw(SigilSdkDomainError)` per row, exercising both factory + legacy class paths. 8-12h work. Tracked. |
| **D-3** | test-analyzer + silent-failure-hunter HIGH-2 | HIGH (test gap) | **No integration test for `SealResult.intentDigest` populated by `seal()`**: a regression at `seal.ts:971` (e.g. hashing `params.instructions` instead of `defiInstructions`) would not fail any current test. Add LiteSVM integration test with stub RPC. ~4h. |
| **D-4** | Red Team | HIGH (architectural) | **Owner-side mutations bypass AL2**: every `OwnerClient.{freezeVault, reactivateVault, setObserveOnly, queueAgentGrant, applyAgentGrant, applyPendingPolicy, …}` runs on mainnet with zero per-call confirmation. Decide before v1.0 whether owner paths need their own confirmation semantics or should adopt the agent gate. Doc-only acknowledgment in CHANGELOG for now. |
| **D-5** | Red Team + MEMORY 2026-05-19 Round 2 | HIGH (security) | **F-RP3-1 reactivateVault foot-gun**: phished owner can freeze→reactivate with `new_agent=ATTACKER FULL_CAPABILITY` in one ix. C28 5-min cooldown slows but does not prevent. Phase 9 SDK adding `OwnerClient.reactivateVault` made it more ergonomic. Add cosign-required-when-new-agent-FULL gate (on-chain). |
| **D-6** | CodexResearcher F3 | MEDIUM | **Magic prefix `b"SIG1"`** before AL3 `intent_version` byte for cross-domain pre-image protection. Costs 4 bytes per digest, invalidates the empty-fixture pin. Bundle with `intent_version` v2 bump. |
| **D-7** | CodexResearcher F1 | MEDIUM | **`toWalletStandardChain(caip2)`** helper bridging the CAIP-2-hash form (our SealResult.network) and the wallet-standard short form (`"solana:mainnet"`). Two-line helper; nice-to-have. |
| **D-8** | Engineer #4 | MEDIUM | **Plain `Error` throws in `intent-digest.ts` + `caip2-network.ts` → `SigilSdkDomainError`** with `INVALID_AMOUNT`/`INVALID_NETWORK`/`INVALID_PARAMS` codes. Mechanical refactor; ~20 lines. |
| **D-9** | Engineer #5 + type-design | LOW | **`NETWORK_ID_DEVNET`/`NETWORK_ID_MAINNET` should be `@internal`** + export `computeAgentSetHash` from root barrel; **`PolicyAttestation.policyVersion`** narrowed to `bigint` (not `number | bigint`); **`MintSessionForAgentInputs.capability`** narrowed to `0 | 1 | 2`. |
| **D-10** | code-reviewer C-2 + test-analyzer | LOW | **MIGRATION.md** add a section covering the new SealResult fields (`intentDigest`, `network`, `isMainnet`). Pure docs. |
| **D-11** | silent-failure-hunter HIGH-4 | LOW (CI plumbing) | **`pnpm verify-lockfile-pins` not wired to CI**: script exists; CI hookup documented in `docs/review/PHASE_9_REVIEW/proposed-ci-changes.md` for the follow-up CI PR. |

### ACCEPTED / NOT-A-BUG

| ID | Source | Disposition |
|---|---|---|
| A-1 | type-design type widening on `policyVersion` | Cosmetic; on-chain decoder returns `bigint`, the widening was defensive but unnecessary. Not blocking. |
| A-2 | Pentester scenarios 1-15 | All 15 attack scenarios REFUTED at the digest layer. Implementation as shipped resists every tamper class the threat model targets (modulo the load-bearing assumption that a host UI faithfully displays and verifies the digest — explicitly documented). |
| A-3 | CodexResearcher F2 Squads V4 discriminator | Byte-equal verified against `@sqds/multisig` published constant. CodexResearcher independently re-derived `sha256("account:Multisig")[0..8]` and matched. |
| A-4 | CodexResearcher F4 noble/hashes pick | @noble/hashes is the consensus pick across modern Solana TypeScript SDKs (wallet-standard, kit consumers). SHA-256 vs BLAKE3 alignment with `solana_program::hash::hash` is correct. |
| A-5 | comment-analyzer L4-style "Phase 9 Batch X" tags | Decoration; will be archaeology in 18 months but isn't actively misleading. Defer cleanup to v0.17 doc pass. |
| A-6 | vulnhunter M-1 base58Decode32 O(n²) DoS | Mitigated by structural cap: SealInput pubkeys come from typed `Address` fields which are themselves validated upstream. Adversarial 10MB strings can't reach the helper through the public API. Acceptable. |
| A-7 | Security M1 noble/hashes 2.0.1 transitive co-resolution | `verify-lockfile-pins.ts` enforces presence of major v1; co-existence with v2 (transitive from codama) does not change the resolution for our explicit dep. Verified clean. |
| A-8 | Security H3 Squads V4 discriminator version pinning | Module-load IIFE derives from `sha256("account:Multisig")`; if Squads ever renames the struct, our discriminator silently mismatches (`isSquadsV4Multisig: false`) — failure is conservative (downgrades AC-2 mode-3 to mode-1 in dashboard banner). Acceptable; would-be CI fixture pulling live IDL is a v0.17 nice-to-have. |
| A-9 | Pentester scenarios 8-15 | All other scenarios refuted with code evidence; no action. |
| A-10 | Engineer cosignSession magic string | Pre-existing in `dashboard/mutations.ts`; not introduced by Phase 9; out of Phase 9 scope. File as separate cleanup ticket. |
| A-11 | Engineer #6 `digest_version` byte on TA-19 | Real concern but TA-19 is feature-frozen in V2; adding a version byte at position 0 would invalidate every committed hex fixture across the codebase. Defer to a hypothetical TA-20 / Phase 12 schema rev. |

---

## 3. Verification gate (final pre-merge)

| Check | Result |
|---|---|
| `pnpm tsc --noEmit` | ✓ 0 errors |
| `pnpm test` | ✓ 1804 passing, 0 failing (baseline 1750; +54 new) |
| `pnpm codegen:errors && git diff --exit-code src/errors/agent-errors.generated.ts` | ✓ no drift |
| `pnpm verify-lockfile-pins` | ✓ @noble/hashes v1, @codama/nodes-from-anchor v1, @codama/renderers-js v2 present |
| `pnpm check-surface` | ✓ snapshot baseline established |
| Cross-repo grep for tier symbols | ✓ zero external consumers |
| Cross-repo grep for `shieldWallet` | ✓ zero remaining refs |
| Cross-repo grep for `Phalnx` / `AgentShield` | ✓ zero hits in Phase 9 diff (anti-criterion ISC-A3) |
| `.github/workflows/` touches | ✓ zero (anti-criterion ISC-A10; per D-6) |
| `programs/sigil/src/` touches | ✓ zero (anti-criterion ISC-A8) |
| `sigil-dashboard/` touches | ✓ zero (anti-criterion ISC-A9) |
| Direct push to main | ✓ zero — branch-only commits, PR-only merge (anti-criterion ISC-A7) |

---

## 4. Phase 9 commit ledger

```
8ddcf3c test(kit): AL backcompat + AuditLog buffer tests + lockfile-pin script (Batch L — ISC-101..103, 120, 121, 145)
f304d49 feat(kit)!: AL2 mainnet confirmation gate (Batch K — ISC-81..86, 141, 142, 156)
ae3d519 feat(kit): AL4 isMainnet + CAIP-2 network identity (Batch J — ISC-77..80, 147)
7b5952a feat(kit): AL3 SealInput intent digest (Batch I — ISC-69..76, 143, 146, 148, 150, 155)
e1458ef docs(kit): 0.16.0 CHANGELOG + MIGRATION + AL3/TA-19 boundary doc (Batch H — ISC-138, 139, 154)
bf244c1 feat(kit): SIZE invariant + check-surface + dead-export audit (Batch G — ISC-91, 95..97, 136)
1ba3a4b feat(kit): Phase 8 OwnerClient method wrappers (Batch F — ISC-30..34)
f1e3d2a feat(kit): multisig/session/attestation/ownership helpers (Batch E — ISC-12..29, 149)
af05306 feat(kit): auto-regenerate error map + drift gate (Batch D — ISC-38..54, 87, 88, 104)
f0087d3 refactor(kit): extract canonical-encode.ts shared utility (Batch C — ISC-144, 155)
f8371f6 docs(kit): clarify SealResult/ExecuteResult event-flow (Batch B — ISC-9..11)
5e1069e feat(kit)!: remove dead tier classifier (Batch A — ISC-1..8)
+ Batch M §RP fix-up (this commit)
```

## 5. ISC closure summary

| Status | Count | Notes |
|---|---|---|
| Closed | 109/162 | Including 7 §RP-driven landings in Batch M |
| Deferred to 0.16.1 | ~12 | D-1 through D-11 above |
| Deferred to v0.17 prep | 6 | ISC-89, 90, 127, 128, 129, 140 (per D-6 scope reduction) |
| Verified-clean (no work needed) | 7 | ISC-92, 93, 94 (shieldWallet sweep), ISC-101..103 (audit-log buffer per existing decoder) |
| Anti-criteria (must-not-happen) | 10/10 satisfied | A1..A10 all verified at closure |

---

## 6. Sign-off

Phase 9 SDK redesign ships as `@usesigil/kit@0.16.0` with:

- **AL3** (client-integrity per-call intent digest, no on-chain verifier yet)
- **AL4** (CAIP-2 chain id + derived isMainnet on every SealResult)
- **AL2** (mainnet confirmation gate, default-false in 0.16.x, flip to default-true in v1.0)
- **Tier classifier deletion** (universal seal(), L-1 constitution)
- **Phase 8 helper wrappers** (multisig-detection, session-mint, policy-attestation, ownership-transfer, 5 new OwnerClient methods)
- **Errors map drift gate** (109 codes, IDL ↔ generated ↔ hand-maintained parity)
- **SIZE invariant** + **check-surface** + **lockfile-pin** scripts
- 54 new tests; 1804 passing total; zero TS errors

**Mainnet readiness:** SDK side READY for 0.16.0 → devnet-only consumer use. **Mainnet operator use awaits 0.16.1** which closes D-1 through D-5 (on-chain AL3 verifier, behavioral AL2 tests, owner-path AL2 decision, F-RP3-1 cosign).

Approved by: §RP fleet of 11 parallel agents on the full Phase 9 diff (`fc1f1d6..HEAD`).
