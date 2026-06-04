# Sigil V2 Hardened Execution Prompt Map (FINAL)

**For:** Engineer-agent dispatches, phase by phase, against `revamp/v2-2026-05`.
**Branch state at start:** commit `554796e`, 8 commits ahead of `main`.
**Repo:** `/Users/kalebrupe/Downloads/Middleware-Agent-Layer/agent-middleware/` only.
**Devnet V1 (untouched):** `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK`.

Three independent audits + Maestro re-verification + Solana-runtime verification produced ~45 patches against the prior plan map. This document is the consolidated, hardened version. All known plan defects fixed. Ready for execution.

---

## §1 Locked decisions (L-1..L-15)

| ID | Decision | Source |
|---|---|---|
| **L-1** | Option A — pure generic guardrails. NO tiers (T1/T2/T3 deleted everywhere). NO per-protocol parsers. NO Jupiter slippage verifier. NO Phase B3 CrossFieldLte. | User 2026-05-17 |
| **L-2** | NO external audit, NO bug bounty, NO funding gate in V1 scope. Strike all such language from docs. | User 2026-05-17 |
| **L-3** | NO backwards compatibility. Devnet only. Existing devnet vaults can become orphaned. | User 2026-05-17 |
| **L-4** | Frontend out of scope. `dashboard/` + `Sigil-Smart-Wallet/` untouched. SDK read helpers in `sdk/kit/src/dashboard/` may be updated. | User 2026-05-17 |
| **L-5** | NO push to remote without explicit per-push consultation. NO `--no-verify`. NO `--no-gpg-sign`. | Standing |
| **L-6** | NO work outside `agent-middleware/`. **Exception:** memory writes to `~/.claude/projects/-Users-kalebrupe/memory/project_sigil_*.md` are permitted and required under L-9. No other paths outside. | Standing + Audit #2 F-28 |
| **L-7** | NO upgrade in-place of devnet program `7FtAXUcr…`. Fresh program ID at Phase 10. | Schema-shift safety |
| **L-8** | Devnet only. No mainnet transactions of any kind. | Standing |
| **L-9** | Docs + memory updated phase-by-phase, not at the end. | User 2026-05-17 |
| **L-10** | TA-17 = AgentEntry.consecutive_failures auto-revoke (NOT SessionAuthority). | Audit #1 C-8 |
| **L-11** | TA-18 = Squads V4 SDK detection helper (off-chain only). | Older-draft harvest |
| **L-12** | AgentVault stays small (~640 bytes); audit log is a SEPARATE PDA at `[b"audit_success", vault]` (8,192 bytes) + `[b"audit_rejected", vault]` (4,096 bytes). | D-3 decision |
| **L-13** | NM-E mode-1/mode-2 dropped. Mode-0 generic offset-on-any-account stays. | This plan |
| **L-14** | TA-19 = policy_preview_digest (NEW from Audit #3). Lands in Phase 2 alongside default-tightening. | D-6 decision + Audit #3 |
| **L-15** | Templates + Intent Compiler DEFERRED to v1.1 (MCP-server territory, not SDK). | User 2026-05-17 |
| **L-16** | **Narrow L-6 widening:** one-line schema-math corrections to repo-root `CLAUDE.md` when the doc cites V1 sizes that contradict current code, narrowly bounded to `AgentVault`, `PolicyConfig`, `SpendTracker`, and `InstructionConstraints` size constants. Scope strictly to numeric correction of those four; no other changes to repo-root `CLAUDE.md` permitted under this exception. | User 2026-05-17 (Phase 0.5 audit F-3 resolution) |

---

## §2 Universal constraints — embedded in every phase prompt

```
- Work in agent-middleware/ ONLY. Memory writes to ~/.claude/projects/-Users-kalebrupe/memory/
  are allowed (L-6 exception under L-9). Nothing else outside.
- Branch: revamp/v2-2026-05. Do not push. Do not create PRs.
- No --no-verify, no --no-gpg-sign, no force-push, no rebase against published commits.
- No audit-pending language, no funding language, no bug-bounty language (L-2).
- No T1/T2/T3 tier language, no parser_version, no per-protocol code (L-1).
- Use Edit for file changes; Write only for new files.
- Build → IDL-restore → test pipeline after every Rust edit:
  - anchor build --no-idl
  - For intentional IDL changes (Phases 1, 2, 3, 4, 5, 6, 7, 8): regenerate via
    RUSTUP_TOOLCHAIN=nightly anchor idl build, then ship it.
  - Otherwise: git checkout -- target/idl/ target/types/
- Test gates (baseline minimum, NO regression unless explicitly noted):
  - Rust: cargo test --lib → 140 passing
  - agent-middleware: pnpm test → 140 passing
  - sdk/kit: pnpm test → 1,812 passing
- Security tooling gates (FREE only, per L-2):
  - npm run security:xray (Sec3 X-Ray) → must pass
  - npm run security:fuzz (Trident) → must not produce reproducer
  - Skip Certora (paid; v1.1 candidate)
- §RP review MANDATORY: silent-failure-hunter + code-reviewer agents both run.
  Fix every CRITICAL and HIGH. Document MEDIUM deferrals with rationale.
- One commit per logical change; multiple small commits per phase preferred.
- Between every two phases: tag `phase-N-baseline` for git revert targeting.
- Report under 600 words: commit SHAs, test counts before/after, files by category,
  §RP findings, anomalies, confirm-no-push, confirm-no-other-folders.
```

---

## §3 TA-NN final allocation (post naming hygiene)

| ID | Primitive | Phase | New / Existing |
|---|---|---|---|
| TA-01 | Per-vault protocol allowlist | Phase 2 tightens defaults | Existing (PolicyConfig.protocols) |
| TA-02 | Wallet destination allowlist | Phase 2 tightens + wires enforcement | Existing (PolicyConfig.allowed_destinations) |
| TA-03 | USDC/USDT mint pinning at deposit | Phase 3 | NEW |
| TA-04 | Per-agent capability split (DISABLED/OBSERVER/OPERATOR) | Phase 2 reject 3..=255 | Existing (AgentEntry.capability) |
| TA-05 | Operating hours UTC bitmask | Phase 3 | NEW |
| TA-06 | Per-agent cooldown (moved from per-vault per F-16) | Phase 3 | NEW (on AgentSpendOverlay) |
| TA-07 | First-time-destination graylist + auto_promote_grays | Phase 3 | NEW |
| TA-08 | Token-2022 dangerous-extension blocklist at deposit (TLV check). 3-item ALLOWLIST per D-4: MemoTransfer, MetadataPointer, NonTransferable. All others reject. | Phase 3 | NEW (ADDITIVE to existing validate-time opcode blocklist at validate_and_authorize.rs:417-429) |
| TA-09 | Cosign workflow for elevated mutations | Phase 3 | NEW |
| TA-10 | Sandwich integrity (instructions-sysvar) hardening | Phase 4 | Existing (validate_and_authorize forward/backward scan) |
| TA-11 | Protected-writable deny-list (dynamic seed-prefix family check) | Phase 4 | NEW |
| TA-12 | Stablecoin balance floor | Phase 5 | NEW |
| TA-13 | Rolling 24h tracker (RATIFY existing wiring, NOT unlock) | Phase 5 | Existing (SpendTracker.protocol_counters) |
| TA-14 | Per-recipient daily cap (`[PerRecipientCounter; 10]` array, NOT Vec) | Phase 5 | NEW |
| TA-15 | Audit-log separate PDAs (success + rejected) with slot+blockhash binding | Phase 7 | NEW |
| TA-16 | DROPPED (was T1 parser_version under tier model — incompatible with L-1) | — | DELETED in Phase 1 |
| **TA-17** | **Auto-revoke on N consecutive failures (AgentEntry.consecutive_failures)** | Phase 3 | NEW. Configurable per D-2: `floor=3, ceiling=20, default=5`. Filter to `SigilError::*` policy-violation codes only — external causes (CU exhaustion, network) don't increment. |
| **TA-18** | **Squads V4 SDK detection helper (off-chain only)** | Phase 9 | NEW (SDK only) |
| **TA-19** | **policy_preview_digest (NEW per Audit #3)** | Phase 2 | NEW. SHA-256 of canonical-encoded policy form, on PolicyConfig + PendingPolicyUpdate. Handler recomputes + asserts. |

---

## §4 Error code allocation (canonical, post-F-2 correction)

**Current:** errors.rs has **81 variants** occupying codes **6000-6080** (Audit #2 F-2 verified, INTERFACES_V2's "88 variants" was stale).

**Reuse existing variants (12+ overlaps caught):**

| Existing variant | Code | Phase that uses it |
|---|---|---|
| `DestinationNotAllowed` | 6082* | Phase 2 (line 82 — needs verify exact code) |
| `InvalidProtocolMode` | 6088* | Phase 2 (line 88 — UPDATE msg to "must be 1=ALLOWLIST") |
| `InvalidDestinationMode` | exists | Phase 2 (UPDATE msg to "must be 0=RESTRICTED") |
| `ConfidentialTransferBlocked` | exists | TA-08 deposit path reuses |
| `PermanentDelegateBlocked` | exists | TA-08 reuses |
| `TransferHookBlocked` | exists | TA-08 reuses |
| `LamportDrainBlocked` | exists | TA-08 reuses |
| `BatchInstructionBlocked` | exists | TA-08 reuses |
| `BlockedSplOpcode` | exists | TA-10 reuses |
| `AccountWritabilityMismatch` | exists | TA-11 reuses |
| `UnauthorizedPreValidateInstruction` | exists | TA-10 reuses |
| `UnauthorizedPostFinalizeInstruction` | exists | TA-10 reuses |

*Phase 0.5 task: produce authoritative error-allocation table by reading errors.rs top-to-bottom, mapping every variant to its numeric code. Save as `docs/revamp/ERROR_CODE_ALLOCATION_V2.md`.

**Net new variants needed (post-Phase-1 deletions):**

Phase 1 deletes 2 Jupiter-specific error variants (`SwapSlippageExceeded`, `InvalidJupiterInstruction` per F-21). `SlippageBpsTooHigh` is KEPT per D-5 (generic `policy.max_slippage_bps` config primitive preserved; runtime slippage enforcement moves off-chain). Post-Phase-1 count: **79 variants, codes 6000-6078**.

New variants append starting at 6079:

| Code | Name | Phase |
|---|---|---|
| 6079 | `ErrInvalidCapability` (reserved values 3..=255) | Phase 2 — LANDED |
| 6080 | `ErrPolicyPreviewMismatch` (TA-19) | Phase 2 — LANDED |
| 6081 | `ErrObserveOnlyModeBlocksExecute` | Phase 2 — LANDED |
| 6082 | `ErrActiveVaultRequiresAllowlist` (F-11 close-up) | Phase 2 close-up — LANDED |
| 6083 | `ErrMintNotPinned` (TA-03) | Phase 3 |
| 6084 | `ErrOutsideOperatingHours` (TA-05) | Phase 3 |
| 6085 | `ErrCooldownActive` (TA-06) | Phase 3 |
| 6086 | `ErrGraylistFriction` (TA-07) | Phase 3 |
| 6087 | `ErrGraylistFull` (TA-07) | Phase 3 |
| 6088 | `ErrToken2022ExtensionForbidden` (TA-08) | Phase 3 |
| 6089 | `ErrCosignRequired` (TA-09) | Phase 3 |
| 6090 | `ErrAutoRevoked` (TA-17) | Phase 3 |
| 6091 | `ErrSandwichIntegrity` (TA-10 tightening) | Phase 4 |
| 6092 | `ErrProtectedWritable` (TA-11) | Phase 4 |
| 6093 | `ErrSessionNonceMismatch` (AC-10) | Phase 4 |
| 6094 | `ErrStableFloorViolation` (TA-12) | Phase 5 |
| 6095 | `ErrDailyCapExceeded` (TA-13 doc-fix) | Phase 5 |
| 6096 | `ErrRecipientCapExceeded` (TA-14) | Phase 5 |
| 6097 | `ErrMintDeltaCapExceeded` (R-1) | Phase 6 — LANDED |
| 6098 | `MintDeltaCapMisconfigured` (R-1 caller-bug variant; NEW in Phase 6) | Phase 6 — LANDED |
| 6099 | `ErrAtaAuthorityChanged` (R-2) | Phase 6 — LANDED (shifted +1 from prior 6098 plan) |
| 6100 | `ErrOutputBelowFloor` (R-3) | Phase 6 — LANDED (shifted +1 from prior 6099 plan) |
| 6101 | `ErrDeclarationInconsistent` (R-4) | Phase 6 — LANDED (shifted +1 from prior 6100 plan) |
| 6102 | `IxMetaCountExceeded` (H-1 audit P1.1; foreign-ix meta budget overflow) | Audit closure 2026-05-19 — LANDED |
| 6103 | `ErrPendingOwnershipExists` (C26) | Phase 8 — shifted +2 from original 6101 plan |
| 6104 | `ErrPendingOwnershipNotReady` (C26) | Phase 8 — shifted +2 |
| 6105 | `ErrInvalidFreezeReason` (C27) | Phase 8 — shifted +2 |
| 6106 | `ErrReactivateCooldownActive` (C28) | Phase 8 — shifted +2 |

**Phase 6 deviation (2026-05-19):** Engineer added `MintDeltaCapMisconfigured` at 6098 to distinguish caller-supplied schema bug from attack signal (`ErrMintDeltaCapExceeded`). Useful for off-chain monitor triage. Code allocation shifted Phase 7/8 codes +1. Forward-only — no previously assigned code (6097, 6098) ever moved.

**Audit closure deviation (2026-05-19, post DC1-DC14):** H-1 audit fix added `IxMetaCountExceeded` at 6102 (destination_check hard-reject on >16 metas). Phase 8 codes shifted an additional +1 to 6103-6106. Forward-only — Phase 6 codes (6097-6101) remained stable. Phase 7 (this phase) allocates NO new error codes — see §6 Phase 7 body for full scope.

**G6 audit fix 2026-05-18 (cosign opt-in):** uses NO new error code. The existing `ErrCosignRequired` (6089) handles all rejection cases: missing cosign on an elevated mutation, default cosign pubkey on an elevated mutation, owner-same cosigner, AND the new "disabling cosign on a live policy where `cosign_required: true`" elevation case. The `cosign_required: bool` field on `PolicyConfig` + `Option<bool>` on `PendingPolicyUpdate` are pure schema growth — they extend TA-19 canonical digest encoding to position 20 but do not require a new failure mode (the field's mutation is gated by the existing 6089). See [§6 Phase 6 post-audit absorption](#post-phase-5-deliverable-summary) below for the full G6 deliverable list.

Phase 0.5 docs commit makes ERROR_CODE_ALLOCATION_V2.md the canonical source.

---

## §5 Schema math (canonical, post-F-13 correction)

**V1 baseline (verified against code):**

| Account | Current SIZE | Source |
|---|---|---|
| AgentVault | 633 bytes (post-escrow removal) | state/vault.rs |
| PolicyConfig | **823 bytes** (NOT 817 as stale CLAUDE.md says) | state/policy.rs |
| SpendTracker | **2,840 bytes** (8 + 32 + 16·144 + 48·10 + 8 + 1 + 7) | state/tracker.rs |
| PostExecutionAssertions (pre-Phase 6) | 352 bytes (8 + 32 + 76·4 + 1 + 1 + 6) — superseded post-Phase-6, see growth table below | state/post_assertions.rs |
| InstructionConstraints | 35,888 bytes | state/constraints.rs |
| SessionAuthority | 375 bytes (post is_spending removal) | state/session.rs |

**V2 schema growth (append-only):**

| Phase | Account | Δ bytes | Resulting size |
|---|---|---|---|
| 2 | PolicyConfig | +32 (policy_preview_digest) | 855 |
| 2 | PendingPolicyUpdate | +32 (new_policy_preview_digest) | (varies) |
| 2 | AgentVault | +1 (observe_only) | 634 |
| 3 | PolicyConfig | +4 (operating_hours u32) | 859 |
| 3 | PolicyConfig | +(4 + 10·40) = +404 (destination_graylist) + 1 (auto_promote_grays) | 1,264 |
| 3 | AgentSpendOverlay | +(per-agent cooldown_seconds u32 + last_action_unix i64) × MAX_AGENTS slots | TBD-phase-3 |
| 3 | AgentEntry | +1 (consecutive_failures) → fits in `_reserved` | unchanged |
| 4 | SessionAuthority | +8 (nonce u64) | 383 |
| 5 | PolicyConfig | +8 (stable_balance_floor) + 8 (per_recipient_daily_cap_usd) + 1 (auto_revoke_threshold realised in Phase 3 — counted here for table-completeness) | 1,281 |
| 5 | SpendTracker | +(4 + 48·10 = +484) materializes as **+488** with explicit `per_recipient_count: u8` + `_padding_recipient: [u8; 7]` per the code layout at state/tracker.rs:212-214 | 3,328 |
| 6 | PostExecutionAssertions | Phase 6 rebuilt for R-1..R-4: entries grew to 78 bytes × 8 entries (= 624) + disc 8 + vault 32 + len 1 + version 1 + padding 6 → **672 bytes total** (NOT 352 — that was pre-Phase-6) | 672 |
| 6 | PolicyConfig | +1 (G6 cosign_required `bool`) — audit 2026-05-18 cosign opt-in | **1,290** |
| 7 | AuditLogSuccess PDA (NEW) | 8 + 32 + (64·128) + 1 + 1 + 6 = 8,240 | — |
| 7 | AuditLogRejected PDA (NEW) | 8 + 32 + (64·64) + 1 + 1 + 6 = 4,144 | — |
| 8 | AgentVault | +9 (frozen_at_timestamp i64 + freeze_reason u8) | 643 |
| 8 | PendingOwnershipTransfer (NEW) | ~120 bytes | — |

**M-2 schema-math sweep (audit 2026-05-19):**
- PolicyConfig: prior table cell said 1,280 — actual `pub const SIZE` at
  `state/policy.rs:323-350` evaluates to **1,290** post-G6 (the prior
  1,280 number itself was off-by-10 vs the realized layout: Phase 3
  added `auto_revoke_threshold: u8` and Phase 5 + G6 each added 1 +
  8 + 8 + 1 bytes respectively). Table updated.
- SpendTracker: prior table cell said 3,324 — actual `pub const SIZE`
  at `state/tracker.rs:205-214` evaluates to **3,328** including the
  explicit `per_recipient_count: u8` byte and `_padding_recipient:
  [u8; 7]`. The discrepancy was a 4-byte miscount of the recipient
  trailer fields. Table updated.
- PostExecutionAssertions: prior table cell said 352 (the pre-Phase-6
  shape) — Phase 6 rebuilt entries from 76 bytes to 78 bytes (R-1
  added `scope` + `aux_value` fields) and shifted to fixed-size array
  layout. Actual is **672 bytes** per `state/post_assertions.rs:185-199`.
  Table updated.

**Net AgentVault end-state: ~643 bytes.** Massive growth avoided by separate-PDA audit-log design (L-12).

Total new rent per vault: ~0.088 SOL (audit log PDAs + pending-ownership). Owner-paid.

---

## §6 Per-phase prompts

### Phase 0.5 — Documentation Consolidation + Memory Refresh

```
WORKING ON: revamp/v2-2026-05 in agent-middleware/. Pre-Phase-1 consolidation.

GOAL: Clean docs and memory before Phase 1. Resolve naming hygiene (TA-17/18/19 final
allocation). Harvest only true deltas from older drafts. Build authoritative error
allocation table. Refresh stale memory.

PRE-STATE: 3 untracked V2 drafts at docs/ (ACCEPTANCE_V2, REVAMP_PLAN, THREAT_MODEL).
5 V1 docs already deleted in working tree (RFC-ACTIONTYPE-ELIMINATION, SDK-REDESIGN-PLAN,
SECURITY-FINDINGS-2026-04-07, V1-LAUNCH-NOTES, V1-LAUNCH-RUNBOOK). T-21 already present
34× in docs/revamp/THREAT_MODEL_V2.md.

TASKS:

1. Build canonical docs/revamp/ERROR_CODE_ALLOCATION_V2.md by reading errors.rs
   top-to-bottom. Map every variant to numeric code (6000+line_offset). Document
   the post-Phase-1 reservation table (6079-6106 enumerated in §4 of the prompt map).

2. Resolve naming hygiene in INTERFACES_V2.md:
   - TA-16: mark as DELETED (was T1 parser_version, incompatible with L-1).
   - TA-17: lock as AgentEntry.consecutive_failures auto-revoke. Filter to
     SigilError::* policy-violation codes only. Configurable threshold (floor 3,
     ceiling 20, default 5). State location is AgentEntry (NOT SessionAuthority — 
     sessions are ephemeral).
   - TA-18: Squads V4 SDK detection helper, OFF-CHAIN ONLY. Document in §4.4
     "Off-chain SDK helpers (no on-chain enforcement)" framing.
   - TA-19: NEW — policy_preview_digest. SHA-256 of canonical-encoded policy form.
     On PolicyConfig + PendingPolicyUpdate. Handler recomputes + asserts.

3. Harvest deltas (NOT duplicates) per Audit #2 F-25:
   - T-21 is already 34× present in THREAT_MODEL_V2.md. Do NOT re-add. Verify
     coverage of T-21a (user authorship), T-21b (template authorship — deferred
     to v1.1 per L-15), T-21c (intent-compiler authorship — deferred).
   - §4.4 "Off-chain SDK helpers" framing — already partially in ACCEPTANCE_V2.md
     and INTERFACES_V2.md. Add the explicit category header if missing.

4. Delete 3 untracked root drafts:
   - docs/ACCEPTANCE_V2.md (rm — untracked)
   - docs/REVAMP_PLAN.md (rm)
   - docs/THREAT_MODEL_V2.md (rm)

5. Stage and commit 5 already-deleted V1 docs:
   - docs/RFC-ACTIONTYPE-ELIMINATION.md
   - docs/SDK-REDESIGN-PLAN.md
   - docs/SECURITY-FINDINGS-2026-04-07.md
   - docs/V1-LAUNCH-NOTES.md
   - docs/V1-LAUNCH-RUNBOOK.md

6. Update docs/ARCHITECTURE.md line 320 row referencing the deleted RFC. Change
   description to "(deleted — see git history)" or remove the row entirely.

7. Refresh memory at ~/.claude/projects/-Users-kalebrupe/memory/:
   - project_sigil_v2_revamp_briefing.md: REWRITE to Option A locks. Strip "21 TA
     constraints", "Mainnet 8-12wk post-audit", "audit non-negotiable", C23 entries,
     C25 entries, T1/T2/T3 references. Add Option A direction header with L-1..L-15
     summary.
   - Verify project_actiontype_elimination_progress.md was already corrected
     (2026-05-17 update) — no further changes needed.

8. Correct stale schema math in CLAUDE.md if it references SpendTracker (=2,840
   not 2,832), PolicyConfig (=823 not 817), InstructionConstraints (=35,888 not
   8,318). Source: code, not stale notes.

9. Document L-6 memory exception explicitly in REVAMP_PLAN.md preamble:
   "L-6 exception: writes to ~/.claude/projects/-Users-kalebrupe-Downloads-Middleware-Agent-Layer/
    memory/project_sigil_*.md are allowed and required under L-9. No other paths
    outside agent-middleware/ may be touched."

BUILD+TEST: anchor build --no-idl (sanity); no test changes expected (docs only).

§RP REVIEW (scope: INTERFACES_V2.md naming hygiene ONLY — body-level tier-model
strip across REVAMP_PLAN / THREAT_MODEL / ACCEPTANCE bodies is explicitly Phase 1
task 3 per §6 Phase 1 of this document; do NOT verify those here):
- silent-failure-hunter prompt: "Verify INTERFACES_V2.md TA-16 is properly marked
  DELETED with no active claims. Verify TA-17 / TA-18 / TA-19 entries in
  INTERFACES_V2.md match the final allocation in this commit (TA-17 AgentEntry
  placement + threshold + filter; TA-18 OFF-CHAIN ONLY; TA-19 policy_preview_digest
  on PolicyConfig + PendingPolicyUpdate). Find any cross-doc link from revamp/
  to a deleted root-level draft (the 5 V1 docs). Verify memory file refresh
  actually strips the stale claims listed in task 7 (tombstones acceptable;
  active claims contradicting Option A are findings). Body-level tier-model
  cleanup in REVAMP_PLAN/THREAT_MODEL/ACCEPTANCE is OUT OF SCOPE — verified by
  Phase 1 §RP, not Phase 0.5 §RP."
- code-reviewer prompt: "Verify ERROR_CODE_ALLOCATION_V2.md numerics match
  errors.rs line-by-line. Find any orphaned doc reference to a deleted V1 path
  that would break a build/CI link-check. Verify the strategy (compaction vs
  deprecation-placeholder) is consistently stated across canonical doc +
  INTERFACES_V2.md §Error-Code-Allocation preamble."

COMMITS (3 expected):
- docs(stage-0.5): canonical error code allocation + TA-17/18/19 naming hygiene
- docs(cleanup): delete superseded V1 docs + older V2 root drafts
- chore(memory): refresh project_sigil_v2_revamp_briefing.md to Option A locks

OUT OF SCOPE: any Rust changes, any test changes, any SDK changes.

Report: 500 words.
```

### Phase 0.6 — CI + Skill Lock Hardening

```
WORKING ON: revamp/v2-2026-05 in agent-middleware/. Pre-Phase-1 CI hardening.

GOAL: Pin CI supply chain, fix surfpool boot race, add free-tier security tooling
gates, pin pr-review-toolkit skills. ~50 min of focused work.

PRE-STATE: agent-middleware/.github/workflows/revamp-ci.yml landed in commit f3cdd71
uses mutable @v4 / @master refs (15+ instances). surfpool-tests job at lines 292-297
has race condition (& background + sleep 5 + ||).

TASKS:

1. Pin every GitHub Action `uses:` reference to a 40-char SHA in
   agent-middleware/.github/workflows/revamp-ci.yml:
   - actions/checkout@v4 → actions/checkout@<sha>
   - pnpm/action-setup@v4 → pnpm/action-setup@<sha>
   - actions/setup-node@v4 → actions/setup-node@<sha>
   - actions/upload-artifact@v4 → actions/upload-artifact@<sha>
   - dtolnay/rust-toolchain@master → dtolnay/rust-toolchain@<sha>
   Use the same SHAs as the existing agent-middleware/.github/workflows/ci.yml
   which already follows this pattern. List each SHA + version it pins to in a
   comment above the `uses:` line.

2. Add CI lint step that fails on mutable refs:
   - Job: `ci-lint`
   - Step: `find .github/workflows/ -name '*.yml' -exec grep -HnE 'uses: [^@]+@[^0-9a-f]{40}' {} \;`
   - Fail if any match.

3. Fix surfpool boot race at revamp-ci.yml:292-297:
   - Replace `npm run surfpool:start &` + `sleep 5` + `npm run test:surfpool || (kill $SURFPOOL_PID; exit 1)`
   - With:
     ```
     set -euo pipefail
     npm run surfpool:start &
     SURFPOOL_PID=$!
     trap "kill $SURFPOOL_PID 2>/dev/null || true" EXIT
     # Wait up to 30s for surfpool to be ready
     for i in {1..30}; do
       if curl -sf http://127.0.0.1:8899/health > /dev/null 2>&1; then
         echo "surfpool ready after ${i}s"
         break
       fi
       sleep 1
     done
     # Confirm still running before tests
     if ! kill -0 $SURFPOOL_PID 2>/dev/null; then
       echo "::error::surfpool died before tests could run"
       exit 1
     fi
     npm run test:surfpool
     ```

4. Add cargo audit + pnpm audit gates as Phase 10 deploy prerequisites in
   revamp-ci.yml:
   - Job: `dependency-audit`
   - Steps:
     ```
     - run: cargo install cargo-audit --locked --version 0.21.x
     - run: cargo audit --deny warnings
     - run: pnpm audit --prod --audit-level=high
     ```
   - Make this job a `needs:` of any deploy job (when added in Phase 10).

5. Add security-tooling step that runs free tools (per L-2 — no Certora):
   - Job: `security-static-analysis`
   - Steps:
     ```
     - run: npm run security:xray  # Sec3 X-Ray free tier
     - run: npm run security:fuzz  # Trident
     ```
   - Skip `npm run security:verify` (Certora — paid, deferred to v1.1).

6. Pin pr-review-toolkit skills in skills-lock.json (per Audit #2 F-26):
   - Read current ~/.claude/skills/pr-review-toolkit/silent-failure-hunter and
     code-reviewer skill content.
   - Compute SHA-256 of each.
   - Add entries to agent-middleware/skills-lock.json (or whatever path the
     existing pinning uses) so skill version bumps invalidate prior phase
     reviews.

BUILD+TEST: Push a draft PR (do NOT merge) to trigger CI; verify all jobs pass.
Alternatively run jobs locally via `act` if available. If CI cannot be triggered
without push, document the verification step that user will perform.

§RP REVIEW:
- silent-failure-hunter prompt: "Verify the surfpool boot fix actually fails
  loudly when surfpool dies vs silently passes. Find any other CI workflow file
  in the repo using mutable @v4 / @master refs (check all of .github/workflows/).
  Verify the cargo audit + pnpm audit gates are wired as `needs:` for any deploy
  workflow, not just listed."
- code-reviewer prompt: "Verify every SHA pinned is a real commit on the upstream
  repo (spot-check 3). Verify the security-tooling job doesn't accidentally invoke
  Certora (security:verify) per L-2. Verify skills-lock.json hashes match the
  actual skill content on disk."

COMMITS (4 expected):
- ci: pin every GitHub Action uses: to 40-char SHA
- ci: add lint step rejecting mutable refs
- ci: fix surfpool boot race (set -euo + readiness probe + alive check)
- ci: add cargo audit + pnpm audit + free-tier security gates

OUT OF SCOPE: any Rust changes, any test logic changes, any SDK changes.

Report: 500 words.
```

### Phase 1 — Complete Demolition

```
WORKING ON: revamp/v2-2026-05 post Phase 0.6.

GOAL: Delete all per-protocol code, all tier-flavored primitives, all audit/funding
language. Pure deletion + doc rewriting. No new code.

PRE-STATE: revamp/v2-2026-05 head. is_spending field already deleted. Phase 0.5
docs consolidated. Phase 0.6 CI hardened. Jupiter integration still present at
programs/sigil/src/instructions/integrations/jupiter.rs (~781 LOC). Phase B3
CrossFieldLte still present at state/post_assertions.rs:74-90 + lines 80-89 +
finalize_session.rs:567-598.

TASKS:

1. Delete Jupiter integration surgically — KEEP max_slippage_bps (it's a generic
   slippage primitive per D-5, not Jupiter-specific):
   - DELETE: programs/sigil/src/instructions/integrations/jupiter.rs (~781 LOC)
   - DELETE: `pub mod jupiter;` from programs/sigil/src/instructions/integrations/mod.rs
   - DELETE: JUPITER_PROGRAM constant in programs/sigil/src/state/mod.rs
   - DELETE: enforce_jupiter_slippage_if_jupiter helper + its 3 call sites in
     validate_and_authorize.rs (lines 491, 557, 611)
   - DELETE: 3 Jupiter-specific error variants in errors.rs (lines 101, 105, 111)
   - KEEP: max_slippage_bps field on PolicyConfig (state/policy.rs:47)
   - KEEP: MAX_SLIPPAGE_BPS constant
   - KEEP: max_slippage_bps validation in initialize_vault.rs:87, queue_policy_update.rs,
     apply_pending_policy.rs:76-77
   - KEEP: max_slippage_bps ix args in lib.rs:34, 47, 133, 148

2. Delete Phase B3 CrossFieldLte entirely:
   - state/post_assertions.rs: delete fields cross_field_flags (line 86-89),
     offset_b (line 74-75), value_len_b if exists, cross_field_multiplier_bps
     (line 80-84). Update PostAssertionEntryZC SIZE constants.
   - finalize_session.rs: delete the cross-field comparison block at lines 567-598.
   - Update any PostExecutionAssertions invariant test that referenced these fields.

3. Strip tier model from every doc in agent-middleware/docs/revamp/:
   - REVAMP_PLAN.md: DELETE §5 entire tier model section. DELETE every
     "Tiers: T1, T2, T3" footer on TA-NN entries.
   - INTERFACES_V2.md: DELETE every "Tiers: ..." line. DELETE §5 tier-model
     references.
   - THREAT_MODEL_V2.md: DELETE §5.1 T1 Verified section. Keep T-21 references
     intact (Phase 0.5 verified they don't need changes).
   - ACCEPTANCE_V2.md: DELETE §3.1 (external audit), §3.5 (bug bounty), §4
     (funding plan). REPLACE with one paragraph:
     "V1 ships under devnet redeploy at Stage 10. Mainnet is not in scope for V1.
     §RP review pipeline (silent-failure-hunter + code-reviewer + free-tier
     security tooling: Sec3 X-Ray + Trident fuzz) is the V1 acceptance gate."

4. Delete docs/revamp/tier-model.mmd (mermaid diagram).

5. Strip K7 NM-E mode-1 (fixed-array) and mode-2 (vec-prefixed) references from
   REVAMP_PLAN.md + INTERFACES_V2.md (per L-13). KEEP mode-0 generic
   offset-on-any-account language. Update K7 description to:
   "K7 — Generic byte-offset assertion (mode-0 only). T1-flavored fixed-array
   (mode-1) and vec-prefixed (mode-2) modes dropped under Option A."

6. Strip TA-16 / C23 (T1 parser_version) from INTERFACES_V2.md §Tier A primitives
   (per L-1). Already absent from the post-Phase-0.5 allocation table; verify.

7. Strip ACCEPTANCE_V2.md any "audit-pending at Stage 0" status language from
   every section.

8. Strip D-04 funding gate decision from REVAMP_PLAN.md §10 + INTERFACES_V2.md
   Decision Register. Mark as "(deprecated 2026-05-17 — Option A removes audit
   gate per L-2)" rather than renumbering remaining D-NN.

9. Drop the Phase 1 task referencing agent-middleware/CLAUDE.md — file doesn't
   exist (Audit #1 AUD10-F7 verified). Repo-root CLAUDE.md is outside L-6 scope;
   leave unchanged. If it contains tier-model language, document the gap as
   v1.1 follow-up.

BUILD+TEST:
- anchor build --no-idl → pass
- RUSTUP_TOOLCHAIN=nightly anchor idl build → regenerate IDL (jupiter ix gone,
  CrossFieldLte gone)
- Verify target/idl/sigil.json no longer references jupiter or CrossFieldLte
- cargo test --lib → all passing (CrossFieldLte tests DELETED, not skipped)
- pnpm test → 140 passing or new baseline
- sdk/kit pnpm test → 1,812 passing or new baseline
- Security gates: npm run security:xray, npm run security:fuzz (free tier only)

§RP REVIEW:
- silent-failure-hunter prompt: "Verify NO remaining call site to deleted Jupiter
  verifier silently allows a swap that should now be caught by generic post-exec
  balance check (Phase 5 TA-12 + Phase 6 R-1 will close, but Phase 1 leaves a
  gap that Phase 5/6 must close — confirm gap is documented). Find any test that
  was 'passing' because a CrossFieldLte assertion never fired. Find any IDL
  reference to jupiter that wasn't regenerated."
- code-reviewer prompt: "Find any doc reference to T1/T2/T3, parser_version,
  tier_registry, or D-04 funding that wasn't deleted. Find any error-code table
  that still lists the 3 deleted Jupiter error variants. Find any SDK type that
  still imports from the deleted Jupiter integration."

COMMITS (5 expected, per F-21):
- refactor(jupiter): delete jupiter.rs integration + JUPITER_PROGRAM constant
- refactor(jupiter): remove enforce_jupiter_slippage_if_jupiter from validate path
- refactor(jupiter): delete 3 Jupiter-specific error variants
- refactor(crossfield): delete Phase B3 CrossFieldLte (state + finalize)
- docs(revamp): strip T1/T2/T3 + audit/funding + tier-model.mmd

OUT OF SCOPE: max_slippage_bps removal (KEEP per D-5), any new TA primitive,
any new error code, schema additions.

Report: 600 words.
```

### Phase 2 — Default-Tightening + TA-19 policy_preview_digest + observe_only

```
WORKING ON: revamp/v2-2026-05 post Phase 1.

GOAL: Force default-deny modes, reject reserved capability values, wire missing
enforcement paths, add TA-19 policy_preview_digest, add observe_only vault flag.

PRE-STATE: PolicyConfig has protocol_mode (ALL=0, ALLOWLIST=1, DENYLIST=2),
destination_mode (RESTRICTED=0, OPEN_WITH_CAP=1), allowed_destinations,
protocols. AgentEntry.capability:u8 supports 0,1,2 but silently treats >2 as 0.
allowed_destinations checked only in agent_transfer; not in spending paths.
No policy_preview_digest on PolicyConfig or PendingPolicyUpdate. No observe_only
on AgentVault.

TASKS:

1. state/policy.rs: delete PROTOCOL_MODE_ALL (0) and PROTOCOL_MODE_DENYLIST (2)
   constants. UPDATE existing InvalidProtocolMode (errors.rs:88) #[msg] to
   "must be 1 (ALLOWLIST)". Reject any policy with protocol_mode != 1.

2. state/policy.rs: delete DESTINATION_MODE_OPEN_WITH_CAP (1) constant. UPDATE
   existing InvalidDestinationMode (errors.rs:274) #[msg] to "must be 0
   (RESTRICTED)". Reject destination_mode != 0.

3. state/policy.rs is_protocol_allowed(): remove the ProtocolMode::All branch
   entirely. Simplify to "if protocol in protocols list, allow; else reject".

4. state/policy.rs is_destination_allowed(): remove the OPEN_WITH_CAP branch.

5. state/vault.rs: AgentEntry.capability stays u8 with values 0-2. Add explicit
   reject of values 3..=255 in:
   - instructions/register_agent.rs (line 43 area — check exists, strengthen)
   - instructions/queue_agent_permissions_update.rs
   - instructions/apply_agent_permissions_update.rs (per F-4 — pending→applied
     path also needs the bound)
   Add new error code 6079 ErrInvalidCapability for the explicit reject.

6. Wire allowed_destinations enforcement into spending paths:
   - Create utils/destination_check.rs helper that takes the DeFi ix's account
     metas + token mint, resolves token-account owner via token-account data
     read, checks against policy.allowed_destinations.
   - Call from instructions/validate_and_authorize.rs in BOTH branches:
     stablecoin input spending path AND non-stablecoin input spending path.
   - Reject with existing DestinationNotAllowed (errors.rs:82).

7. ADD TA-19 policy_preview_digest:
   - state/policy.rs: add `pub policy_preview_digest: [u8; 32]` field. Append
     to end (APPEND-ONLY rule per F-14).
   - state/pending_policy.rs: add `pub new_policy_preview_digest: [u8; 32]`.
   - instructions/initialize_vault.rs: accept new arg `preview_digest: [u8; 32]`.
     Handler computes SHA-256 of canonical BorshSerialize encoding of:
     (daily_spending_cap_usd, max_transaction_size_usd, max_slippage_bps,
      protocol_mode, protocols, destination_mode, allowed_destinations,
      timelock_duration, session_expiry_seconds, observe_only, has_constraints,
      has_post_assertions). Field order is FIXED (document in policy.rs).
     Assert recomputed == preview_digest. Reject with new error 6080
     ErrPolicyPreviewMismatch (G5 audit fix 2026-05-18: prior "6081" in
     this §6 body was reversed against §4 reservation table — §4 is
     authoritative).
   - instructions/queue_policy_update.rs: same digest enforcement on pending.
   - instructions/apply_pending_policy.rs: RE-ASSERT pending.new_policy_preview_digest
     matches recomputed digest of fields being copied to live (defense against
     pending-account tampering between queue and apply).

8. ADD observe_only vault mode:
   - state/vault.rs: add `pub observe_only: bool` to AgentVault. Append.
   - instructions/initialize_vault.rs: accept observe_only param. Validate
     consistency: if observe_only=true, allowlists may be empty; if false,
     non-empty allowlists required (or queue policy update can be empty for
     ramp-up).
   - instructions/validate_and_authorize.rs: at entry, if vault.observe_only,
     reject with new error 6081 ErrObserveOnlyModeBlocksExecute (G5 audit
     fix 2026-05-18: prior "6080" in this §6 body was reversed against §4
     reservation table — §4 is authoritative).

   **Phase 2 close-up addition (F-12, landed post-Phase-2 dispatch):**
   - instructions/set_observe_only.rs: NEW direct owner-only flip ix.
     User-approved Option (a) — no timelock; mirrors freeze_vault simplicity
     since observe_only is a low-stakes mutation (only enables/disables
     execution; if owner key leaks attacker can do strictly worse via
     existing surfaces). Recomputes policy_preview_digest + bumps
     policy_version (OCC). Emits ObserveOnlyChanged event. F-11 consistency
     enforced: cannot flip to active (false) when both allowlists are empty.
   - Phase 2 close-up also added the F-11 ActiveVaultRequiresAllowlist
     check (error 6082) at initialize_vault: active vaults must have at
     least one protocol or destination on the allowlist; observe_only=true
     skips the check (inert by design).

9. SDK side (in sdk/kit/src/policy/):
   - Add computePolicyPreviewDigest(policy_fields) → Uint8Array. Use same
     BorshSerialize encoding as on-chain.
   - Add unit test verifying SDK and on-chain compute same digest from same
     fields (use a test fixture).

10. Update all tests that constructed policies with permissive modes:
    - tests/instruction-constraints.ts
    - tests/security-exploits.ts
    - sdk/kit/tests/dashboard/*
    - tests/cu-budget.ts
    Delete tests for ProtocolMode::All / DestinationMode::OPEN_WITH_CAP if no
    longer reachable.

BUILD+TEST: full pipeline. Verify SchemaInvariants.
- PolicyConfig new SIZE: old 823 + 32 (digest) + (other Phase 2 additions
  computed in §5) = 855 base; verify via cargo unit test.
- AgentVault new SIZE: old 633 + 1 (observe_only) = 634; verify.

§RP REVIEW:
- silent-failure-hunter prompt: "Find any code path that still treats
  protocol_mode==0 or destination_mode==1 as valid. Find any destination-flow
  in spending paths that doesn't hit the new helper. Find any policy mutation
  path that can persist without digest verification (initialize, queue, apply).
  Verify TA-19 digest encoding is deterministic — same fields produce same
  bytes 100% of the time (try variations in HashMap iteration order, vec
  ordering of identical bytes)."
- code-reviewer prompt: "Verify error codes 6079, 6080, 6081 are the next free
  per the post-Phase-1 allocation. Verify the new destination-check helper has
  measured CU overhead and doesn't introduce quadratic scan. Verify TA-19
  digest field order in encoding matches the doc-comment in policy.rs.
  Verify apply_agent_permissions_update.rs gets the capability bound (it was
  missed in original plan per F-4)."

COMMITS (6 expected):
- refactor(policy): force ALLOWLIST + RESTRICTED defaults (drop permissive modes)
- feat(capability): explicit reject of reserved AgentEntry.capability values
- feat(validate): wire allowed_destinations enforcement into spending paths
- feat(policy): TA-19 policy_preview_digest on PolicyConfig + PendingPolicyUpdate
- feat(vault): add observe_only mode flag
- feat(sdk): computePolicyPreviewDigest helper + cross-impl test

OUT OF SCOPE: new fields beyond the 4 listed (policy_preview_digest, observe_only,
new_policy_preview_digest, capability bound), graylist (Phase 3), cooldown (Phase 3),
operating hours (Phase 3), audit log (Phase 7).

Report: 700 words.
```

### Phase 3 — Pre-execution guards (TA-03/05/06/07/08/09/17)

```
WORKING ON: revamp/v2-2026-05 post Phase 2.

GOAL: Seven new pre-execution guards. All fire BEFORE the DeFi instruction.
All generic (no protocol-specific code).

PRE-STATE: Phase 2 tightened defaults. TA-19 digest enforced. observe_only mode
present.

TASKS:

1. TA-03 USDC/USDT mint pinning at deposit:
   - constants.rs: add USDC_MINT_MAINNET, USDT_MINT_MAINNET, USDC_MINT_DEVNET as
     build-time Pubkey constants. With `devnet-testing` cargo feature, allow any
     mint (extend existing pattern at state/mod.rs:168-176).
   - instructions/deposit_funds.rs: assert mint matches a pinned constant. Reject
     with 6083 ErrMintNotPinned.

2. TA-05 operating_hours bitmask:
   - state/policy.rs: append `pub operating_hours: u32` (24-bit UTC). Default
     0xFFFFFF — but the Phase 2 TA-19 digest now bound this, so new vaults set
     explicitly (the digest enforces what the user signed; back-compat
     consideration removed per L-3).
   - validate_and_authorize.rs: assert clock.unix_timestamp's UTC hour is set
     in the bitmask. Reject with 6084 ErrOutsideOperatingHours.

3. TA-06 PER-AGENT cooldown (moved from per-vault per F-16):
   - state/agent_spend_overlay.rs: add per-agent cooldown_seconds and
     last_action_unix tuple. Fit in existing slots if possible; grow if needed.
     Document the +size delta.
   - validate_and_authorize.rs: load AgentSpendOverlay, check
     (now - agent.last_action_unix) >= agent.cooldown_seconds. Reject with
     6085 ErrCooldownActive.
   - After successful validate, write last_action_unix = now.

4. TA-07 first-time-destination friction (graylist):
   - state/policy.rs: append
     `pub destination_graylist: Vec<(Pubkey, i64)>` bounded ≤10,
     `pub auto_promote_grays: bool` default false.
   - utils/destination_check.rs (extending Phase 2's helper): if destination
     in graylist AND now < unlock_unix, reject with 6086 ErrGraylistFriction.
   - When new destination added to allowed_destinations: enters graylist with
     unlock_unix = now + 86400. Reject if graylist full with 6087 ErrGraylistFull.
   - Add ix promote_graylist_destination (owner-only, fast-track to active
     allowlist before 24h).

5. TA-08 Token-2022 dangerous-extension blocklist at deposit (ALLOWLIST PER D-4):
   - instructions/deposit_funds.rs: parse mint TLV blob, ALLOW ONLY these 3
     extensions: MemoTransfer, MetadataPointer, NonTransferable. Reject ALL
     OTHER Token-2022 extensions (TransferFee, TransferHook, PermanentDelegate,
     DefaultAccountState::Frozen, MintCloseAuthority, InterestBearingMint,
     ConfidentialTransfer, any future-added extension) with 6088
     ErrToken2022ExtensionForbidden.
   - This is ADDITIVE to existing validate-time opcode blocklist at
     validate_and_authorize.rs:417-429 (per F-5). DO NOT remove or modify the
     runtime blocks. Both layers required.

6. TA-09 cosign workflow for elevated mutations:
   - Identify elevated ops (7 triggers, post-G3a/G6 audit 2026-05-18 — see
     INTERFACES_V2.md §TA-09 for the canonical authoritative list and the
     "0 = unlimited"/"0 = no floor" semantics):
     a) Raise daily_spending_cap_usd (`Some(new) > live`)
     b) Raise max_transaction_amount_usd (`Some(new) > live`)
     c) Expand allowed_destinations (more entries OR any pubkey not in live)
     d) Expand allowed_protocols (more entries OR any pubkey not in live)
     e) Lower stable_balance_floor (`Some(new) < live`; "0 = no floor"
        convention handled — `0 < live_non_zero` = weakening; raising = strengthen)
     f) Weaken per_recipient_daily_cap_usd (G3a §RP-2 CRIT-1: `Some(0)`
        when live > 0 OR `Some(new) > live` when both bounded)
     g) Weaken protocol_caps (G3a §RP-2 HIGH-1: `has_protocol_caps:
        Some(false)` master-switch disable OR per-protocol cap shrinking to 0
        from non-zero OR per-protocol cap growing larger)
   - **observe_only toggle removed** as a trigger (audit M-1 2026-05-19):
     the toggle was absorbed into G3a — observe_only flipping is now
     gated by `set_observe_only` (F-12 audit fix) which recomputes the
     TA-19 digest + bumps policy_version on every flip. The standalone
     trigger entry above was stale.
   - instructions/queue_policy_update.rs: if any elevated op detected, require
     owner+session co-signature. Add cosign_session: Option<Pubkey> param;
     verify the session signed the same instruction-data hash.
   - Per D-2 default Q-1: lock cosign scope to "any owner-signed session within
     vault validity window" (not "same session" — operationally lethal at
     session expiry).
   - Reject with 6089 ErrCosignRequired.
   - **G6 opt-in (audit 2026-05-18):** the entire 7-trigger check
     short-circuits when `policy.cosign_required == false` (default). When
     true, the gate fires as above. See `PolicyConfig.cosign_required`
     doc-comment for one-way-ratchet semantics on the field's own mutation.

7. TA-17 auto-revoke on N consecutive failures (per L-10 + D-2):
   - state/vault.rs: AgentEntry adds consecutive_failures: u8. Fit in existing
     `_reserved: [u8; 7]` — use 1 byte, document 6 remaining.
   - state/policy.rs: append `pub auto_revoke_threshold: u8` (default 5, floor
     3 enforced at write time, ceiling 20).
   - finalize_session.rs: on session-finalize where the reject reason is a
     SigilError::* policy-violation code (NOT external causes like CU
     exhaustion, network), increment agent.consecutive_failures. On successful
     seal, reset to 0.
   - Threshold gate: if consecutive_failures >= policy.auto_revoke_threshold,
     set agent.capability = DISABLED, emit AutoRevokedEvent. Subsequent seal
     attempts reject with 6090 ErrAutoRevoked.
   - Owner can re-enable via existing queue_agent_permissions_update.
   - Filter list of "policy violation codes that count" — document
     authoritatively (any error in 6083-6100 range counts; external errors
     6047/6048 do NOT — those are external causes like CU exhaustion / nonce
     desync, not policy violations).

BUILD+TEST: full pipeline. AgentVault size unchanged (capability uses _reserved).
PolicyConfig grows by ~415 bytes (operating_hours u32 + graylist Vec + auto_promote
+ auto_revoke_threshold). AgentSpendOverlay grows per agent slot.

§RP REVIEW:
- silent-failure-hunter prompt: "Find any seal() path that doesn't hit ALL seven
  new guards in the correct order (TA-03 deposit-time, TA-08 deposit-time,
  TA-05/06/07/09/17 entry-guard). Verify TA-17 increment is not skipped on
  partial failures (panics, CU exhaustion mid-validate). Verify TA-08 actually
  parses the TLV blob — not just the mint type byte. Verify TA-09 cosign scope
  binds the INSTRUCTION DATA HASH, not just presence of a signer. Verify
  graylist promotion auth: only owner, not agent, not session."
- code-reviewer prompt: "Verify the auto_revoke_threshold floor (3) and ceiling
  (20) are enforced at policy-write time, not just at use-time. Verify TA-17
  reset on successful seal — search for the reset call. Verify the SigilError::*
  filter actually filters by error code numeric range, not by string match.
  Verify TA-06 cooldown is loaded from AgentSpendOverlay (per-agent), NOT
  PolicyConfig (per-vault — would re-introduce F-16 DoS)."

COMMITS (7 expected, one per TA):
- feat(deposit): TA-03 USDC/USDT mint pinning
- feat(policy): TA-05 operating_hours UTC bitmask
- feat(overlay): TA-06 per-agent cooldown
- feat(policy): TA-07 destination graylist + auto_promote_grays
- feat(deposit): TA-08 Token-2022 extension ALLOWLIST (MemoTransfer + MetadataPointer + NonTransferable)
- feat(policy): TA-09 cosign workflow for elevated mutations
- feat(vault): TA-17 auto-revoke on policy-violation consecutive_failures

OUT OF SCOPE: bundle integrity (Phase 4), post-exec invariants (Phase 5),
audit log (Phase 7), SDK changes (Phase 9).

Report: 900 words (this is the biggest phase).
```

### Phase 4 — Bundle integrity (TA-10 hardening + TA-11 + AC-10 nonce)

```
WORKING ON: revamp/v2-2026-05 post Phase 3.

GOAL: Tighten TA-10 sandwich integrity. Add TA-11 protected-writable deny-list
via DYNAMIC seed-prefix family check (not static list — per F-20). Add session
nonce closing AC-10 durable-nonce replay (per Audit #1 C-1).

PRE-STATE: validate_and_authorize.rs has existing sysvar scans (280-285, 292-316,
496-614). finalize_session.rs has post-finalize scan (700-741). All bounded by
MAX_SYSVAR_SCAN_ITERATIONS=64. SessionAuthority has NO nonce field.

TASKS:

1. AC-10 session.nonce closure (per Audit #1 C-1):

   FORWARD-COMPAT NOTE (§RP-1 clarification, 2026-05-18): In V2 the active
   defense against the documented durable-nonce replay attack class is the
   `policy_version` check at validate_and_authorize.rs:172-175 — every
   successful agent-mutation (register/revoke/pause/unpause) bumps
   `policy.policy_version`, and validate_and_authorize hard-fails with
   `ErrPolicyVersionMismatch` when the caller's `expected_policy_version`
   doesn't match. AC-10 closes the spec contract and is forward-compat for
   Phase 8 M-5 (ownership-transfer replay) where the session PDA may be
   re-used via `init_if_needed`. AC-10 is NOT load-bearing for the
   documented attack class in V2 because the session PDA uses `init`
   (not `init_if_needed`) — every successful validate creates a fresh
   nonce=0 SessionAuthority. The two defenses are intentionally
   independent: policy_version invalidates stale validates at the policy
   layer, while AC-10 binds replay protection into the session lifetime
   for Phase 8.

   - state/session.rs: append `pub nonce: u64` to SessionAuthority. APPEND-ONLY.
   - instructions/validate_and_authorize.rs: accept new arg expected_nonce: u64.
     If session exists (re-use case): require session.nonce == expected_nonce.
     Reject with 6093 ErrSessionNonceMismatch. If session is new: store
     expected_nonce = 0 initially, increment on each successful seal.
   - instructions/finalize_session.rs: increment session.nonce on successful
     finalize. Persist.
   - INTERFACES_V2 K2 description: update to reflect nonce actually exists.

2. TA-10 hardening:
   - validate_and_authorize.rs: ensure at most ONE validate_and_authorize ix
     per (vault, agent, mint) tuple per transaction. Currently the forward scan
     finds finalize but doesn't enforce uniqueness of validate.
   - Keep "immediate-next instruction is allowed protocol" check. Continue
     allowing ComputeBudget + SystemProgram interleave (operational flexibility,
     documented choice per Q-6 default).
   - Reject sandwich-shape violations with 6091 ErrSandwichIntegrity.

3. TA-11 DYNAMIC seed-prefix family check (per F-20):
   - Define the protected seed-prefix set in constants.rs:
     PROTECTED_SEED_PREFIXES = [b"vault", b"policy", b"tracker", b"session",
       b"post_assertions", b"audit_success", b"audit_rejected", b"cosign",
       b"recipient", b"pending_policy", b"pending_constraints",
       b"pending_agent_perms", b"pending_close_constraints",
       b"pending_owner", b"constraints", b"agent_spend"].
   - validate_and_authorize.rs: AFTER the forward scan, iterate every
     instruction in the transaction. For each ix's account metas:
     a) If meta.is_writable == false: continue.
     b) Try to derive the meta.pubkey as PDA from (prefix, owner, [vault_id|
        additional seeds]) for each prefix in PROTECTED_SEED_PREFIXES. If
        ANY prefix derivation matches: reject as protected-writable with
        6092 ErrProtectedWritable.
   - ADDITIONALLY: verify account.owner == sigil_program_id for discriminator-
     based identification (per F-30 — prevents attacker-deployed program from
     spoofing discriminator).
   - Performance budget: ~90K CU worst case (per CU-budget analyst). Measure
     in benchmark test.

4. ALT documentation (no code change required — verified by ALT verifier):
   - Add THREAT_MODEL_V2 T-DoS-3 paragraph (verbatim drop-in below — paste
     into the threat model under §6 or §2 environmental hazards).

   T-DoS-3 paragraph:
   """
   ALT writable-flag preservation. Solana's instructions sysvar correctly
   preserves is_writable=true for accounts loaded via
   MessageAddressTableLookup.writable_indexes. The SVM constructs the sysvar
   by calling SVMMessage::is_writable(account_index), which routes through
   LoadedMessage::is_writable_index for v0 transactions (solana-message
   v0/loaded.rs:118-136). Position-based indexing into the
   [static, ALT-writable, ALT-readonly] concatenation makes the writable
   distinction structural, not advisory. TA-11 therefore functions correctly
   with ALTs: a foreign instruction that includes a Sigil PDA via ALT
   writable_indexes will appear in load_instruction_at_checked(i).accounts[j]
   with is_writable=true, and the entry guard's writability scan will reject
   the bundle. Defense-in-depth: Solana's BPF loader still enforces the
   runtime owner-check — only Sigil can mutate Sigil-owned PDA data
   regardless of writable flag. Verified against solana-svm v2.3.13
   account_loader.rs:880-908, solana-instructions-sysvar/src/lib.rs:117-119,
   and Anchor 0.32.1 sysvar re-export.
   """

BUILD+TEST: full pipeline. SessionAuthority new SIZE: 375 + 8 (nonce) = 383.
CU benchmark for TA-11 worst case. Adversarial tests CRITICAL — write at least 6:
- [validate, drain_program_ix_writing_to_SpendTracker, finalize] →
  expect ErrProtectedWritable
- [validate, ix_writing_to_PolicyConfig_via_pseudo_program, finalize] →
  expect ErrProtectedWritable
- Two validate ixs for same (vault, agent, mint) in one tx → expect
  ErrSandwichIntegrity
- Foreign ix passing PolicyConfig as read-only → expect ALLOW
- Pre-signed tx with stale nonce replayed → expect ErrSessionNonceMismatch
- ALT-loaded writable Sigil PDA in foreign ix → expect ErrProtectedWritable

§RP REVIEW:
- silent-failure-hunter prompt: "Find any way to write to a Sigil PDA from a
  foreign instruction that bypasses TA-11 (try: discriminator-only spoofing
  WITHOUT owner check — verify the owner check is enforced). Find any
  account-meta-set where writable flag could be flipped between client
  construction and on-chain validation. Verify nonce increment is atomic with
  finalize success — if finalize partial-fails, does the nonce roll back or
  permanent-increment? Verify ALT-loaded Sigil PDAs are caught (cross-check
  against T-DoS-3 paragraph)."
- code-reviewer prompt: "Verify CU cost of TA-11 scan is bounded and measured.
  Verify the PROTECTED_SEED_PREFIXES list covers EVERY Sigil PDA type, including
  pending_* and overlay accounts. Verify nonce semantics: new session starts
  at 0, increments on every successful finalize. Verify no false-positive
  rejection of legitimate read-only access to Sigil PDAs."

COMMITS (3 expected):
- feat(session): AC-10 closure — add nonce field + expected_nonce ix arg
- feat(validate): TA-10 tighten sandwich integrity uniqueness
- feat(validate): TA-11 dynamic seed-prefix family check + owner verify

ABSORPTION NOTES (Phase 2 close-up extension, 2026-05-18):
- Task X: PEN-CROSS-4 absorption — pre-filter `destination_check` helper
  iteration list by `program_id` byte-read (avoid full TokenAccount
  deserialization on every meta); cap iterations at 16 metas/ix. CU savings
  ~5K per agent_transfer.
- Task X: PEN-CROSS-5 absorption — bump `policy_version` on
  `register_agent` / `revoke_agent` / `pause_agent` / `unpause_agent`. Phase 2
  close-up surfaced ~80 hardcoded `expected_policy_version: new BN(0)` test
  fixtures that would need refresh against the bumped value. Existing
  `vault.is_agent` / `is_agent_paused` constraints already reject the TOCTOU
  window, so this is a defense-in-depth OCC improvement, not a closure of an
  open exploit. Bundle the bump with the Phase 4 TA-10 sandwich-integrity
  work so the test-fixture refresh lands once for both. NEW Accounts struct
  field: `policy: Account<PolicyConfig>` on all 4 agent-mutation ix.

OUT OF SCOPE: post-execution stuff (Phase 5), Maestro borrows (Phase 6),
audit log (Phase 7), ownership transfer (Phase 8 — but Phase 8 reuses nonce
for ownership-transfer replay protection per M-5).

Report: 700 words.
```

### Phase 5 — Post-execution invariants (TA-12 + TA-14 + TA-13 ratification)

```
WORKING ON: revamp/v2-2026-05 post Phase 4.

GOAL: TA-12 stable balance floor. TA-14 per-recipient daily cap (fixed-size array,
not Vec — per F-14). Ratify existing TA-13 per-protocol cap enforcement (delete
misleading "no enforcement yet" comment per F-15).

PRE-STATE: SpendTracker has 144 × 10-min epoch buckets + protocol_counters[10]
with FULL rolling window logic at lines 74-200. finalize_session.rs:313-322 +
401-411 already enforces per-protocol caps when has_protocol_caps=true.
tracker.rs:29 comment claims "reserved, no enforcement yet" — STALE.

TASKS:

1. TA-12 stable_balance_floor:
   - state/policy.rs: append `pub stable_balance_floor: u64` (6-decimal USDC
     face value). Default 0.
   - finalize_session.rs: AFTER existing CPI balance audit (lines 231-242), add:
     assert (vault_usdc_balance + vault_usdt_balance) >= policy.stable_balance_floor.
     Reject with 6094 ErrStableFloorViolation.
   - This is the HARD reserve — no combination of attacks drains below this.

2. TA-14 per-recipient daily cap (FIXED-SIZE ARRAY per F-14 + Audit #1 AUD2-F5):
   - state/tracker.rs: SpendTracker is zero-copy; Vec NOT permitted. Append:
     ```
     pub per_recipient: [PerRecipientCounter; MAX_PER_RECIPIENT_ENTRIES],
     pub per_recipient_count: u8,
     ```
     where MAX_PER_RECIPIENT_ENTRIES=10 and:
     ```
     #[zero_copy]
     #[repr(C)]
     pub struct PerRecipientCounter {
         pub recipient: [u8; 32],     // Pubkey as bytes for Pod compatibility
         pub window_start: i64,
         pub window_spend_usd: u64,
     }  // = 48 bytes
     ```
   - state/policy.rs: append `pub per_recipient_daily_cap_usd: u64`.
   - finalize_session.rs: on every spending finalize, for each recipient touched
     by the DeFi ix's account metas:
     a) Resolve recipient pubkey (token-account owner).
     b) Compute outflow_to_this_recipient.
     c) If recipient not in per_recipient: add entry (or evict oldest finished
        window — reject with 6096 if no slot can be evicted via age).
     d) Increment rolling 24h amount via same epoch-bucket math.
     e) Assert rolling_24h_to_recipient <= policy.per_recipient_daily_cap_usd.
   - Reject with 6096 ErrRecipientCapExceeded.

3. TA-13 ratification (per F-15):
   - state/tracker.rs:29: DELETE the "Reserved per-protocol spend counters
     (zeroed, no enforcement yet)" comment. Replace with: "Per-protocol rolling
     24h counters. Enforcement wired in finalize_session.rs:313-322 (stablecoin
     input) and lines 401-411 (non-stablecoin input). See policy.protocol_caps
     for the cap values."
   - Add 6095 ErrDailyCapExceeded error variant (or reuse existing if found —
     run grep first).
   - VERIFY finalize_session.rs:313-322 + 401-411 actually compare against
     policy.protocol_caps when has_protocol_caps=true. If incomplete, finish
     the wiring (NOT duplicate it).
   - Add regression test: vault with daily_cap=$1000 + protocol_caps[Jupiter]=$500
     can spend $500 on Jupiter, then blocked from more Jupiter even though
     global cap has $500 remaining. Total of 5 test scenarios per F-15.

BUILD+TEST: full pipeline. SpendTracker new SIZE: 2,840 + (4 + 48·10) = 3,324
+ 8 (per_recipient_daily_cap_usd) wait — that's on PolicyConfig, not tracker.
- Tracker: 2,840 + 480 (per_recipient array) + 1 (count) + padding = ~3,324
- PolicyConfig: + 8 (stable_balance_floor) + 8 (per_recipient_daily_cap_usd) = +16

§RP REVIEW:
- silent-failure-hunter prompt: "Find any spending path that doesn't hit
  stable_balance_floor check (search every finalize path). Find any
  recipient-resolution logic that resolves to wrong pubkey (e.g., parses ATA
  pubkey instead of owner field). Verify per-recipient eviction doesn't allow
  attacker to sidestep cap by churning recipients to recycle slots
  (verify eviction policy is age-based, not LRU)."
- code-reviewer prompt: "Verify per_recipient_daily_cap_usd lives on
  PolicyConfig so owner controls it. Verify rolling window math reuses existing
  epoch-bucket pattern, doesn't introduce new math primitives. Verify CU cost
  of per-recipient scan is bounded by ≤10 fixed iterations. Verify TA-13
  ratification doesn't DUPLICATE the existing require! call (read existing
  finalize_session.rs:313-322 BEFORE writing)."

COMMITS (3 expected):
- feat(policy): TA-12 stable_balance_floor
- feat(tracker): TA-14 per-recipient cap (fixed-size array)
- refactor(tracker): TA-13 ratify per-protocol cap enforcement + delete stale comment

OUT OF SCOPE: Maestro borrows (Phase 6), audit log (Phase 7).

Report: 700 words.
```

### Post-Phase-5 audit-absorption deliverable summary (G1..G6, 2026-05-18)

Audit work landed between Phase 5 close and Phase 6 start. Recorded here so future readers can map the audit findings to the commits that closed them:

| Gate | Finding | Closure |
|---|---|---|
| **G1** | Schema regen drift after Phase 5 lands — Codama types lagging behind Rust struct fields | Codama regen + hand-written caller-site wiring across all SDK files (`create-vault.ts`, `dashboard/mutations.ts`, `testing/{devnet,mock-state}.ts`) |
| **G2** | (reserved — historical placeholder; no audit fix shipped under this ID) | n/a |
| **G3** | TA-09 elevated set did NOT cover TA-12 stable_balance_floor LOWERING or TA-14 per_recipient_daily_cap_usd RAISING. Hostile policy mutations that weakened these post-execution invariants passed without cosign | Extended `is_elevated` predicate in `queue_policy_update.rs` to detect `lowers_floor` + `raises_per_recipient_cap`; cosignHelper.ts surfaces both for client-side elevation detection |
| **G3a** | §RP-2 follow-up: G3's `new > live` predicate missed "0 = unlimited / off" convention. `Some(0)` for per-recipient cap DISABLES enforcement (strictly weaker) but `0 > live_non_zero` evaluates false. Same for `has_protocol_caps: Some(false)` + individual protocol-cap shrink-to-zero | New `weakens_per_recipient_cap_predicate` + `weakens_protocol_caps_predicate` honor the "0 = unlimited" convention. Extracted as pub fn for unit-test boundary coverage |
| **G4** | TA-09 cosign workflow lived only on the on-chain side — SDK had no client-side path to produce a valid cosign session + digest | `sdk/kit/src/cosignHelper.ts` ships `buildCosignBundle()` mirroring on-chain `compute_cosign_digest` byte-for-byte. Cross-impl property test + truth-table coverage |
| **G5** | Documentation drift: §RP transcripts not persisted; INTERFACES_V2 TA-09 listed only 4 of the 6 elevation triggers; error code references reversed (6080 ↔ 6081) | Persisted §RP review transcripts at `docs/revamp/PHASE_N_REVIEW/`; INTERFACES_V2 TA-09 updated to list all 6 (then 7 after G3a) triggers; HARDENED §4 error reservation table reconciled with `ERROR_CODE_ALLOCATION_V2.md` |
| **G6** | TA-09 cosign was unconditional on elevated mutations — created real UX friction for solo founders + AI-agent automation + vaults owned by Squads V4 multisig PDAs (multisig at the Solana layer already enforces multi-signer auth, making Sigil cosign redundant) | (a) `PolicyConfig.cosign_required: bool` opt-in flag (default false); (b) `queue_policy_update` elevation gate now gates on `policy.cosign_required` (the live value); (c) one-way ratchet: disabling cosign on a live `cosign_required: true` policy is itself elevated regardless of any other trigger; (d) `PendingPolicyUpdate.cosign_required: Option<bool>` for queue/apply flow; (e) TA-19 canonical digest extended to 20 fields (cosign_required at position 20) — bound digest defends against silent SDK flip; (f) read-only `detectSquadsV4Owner()` SDK helper (`sdk/kit/src/squadsDetection.ts`) lets dashboard recognize multisig-owner mode and suppress the warning banner. No new error code (reuses 6089 `ErrCosignRequired`) |

The G6 closure ships under commits 9965a50 (on-chain) + f6f1031 (SDK + Codama regen) + d5b0d8d (Squads detection helper). Post-G6 baseline: `cargo test --lib --features devnet-testing` = 193/0, `npx tsc --noEmit` in `sdk/kit/` = 0 errors, SDK `pnpm test` policy subset = 31 passing including cross-impl byte-equality with the Rust digest fixtures.

### Phase 6 — Maestro borrows (R-1 / R-2 / R-3 / R-4)

```
WORKING ON: revamp/v2-2026-05 post Phase 5.

GOAL: Four protocol-agnostic assertion variants on PostExecutionAssertions PDA.
All extend existing snapshot/compare machinery.

PRE-STATE: PostExecutionAssertions PDA exists with 4-entry capacity
(MAX_POST_ASSERTION_ENTRIES=4), 32-byte value size (MAX_CONSTRAINT_VALUE_LEN=32),
4 modes (Absolute=0, MaxDecrease=1, MaxIncrease=2, NoChange=3). Phase 1 deleted
Phase B3 CrossFieldLte; no other variants exist post-Phase-1.

TASKS:

1. R-1 MintDeltaCap (Maestro spending.rs:208-250 — CITATIONS VERIFIED):
   - New variant on PostAssertionEntry: assertion_mode=4 MintDeltaCap.
   - Schema fields: { mint: Pubkey (32), max_net_decrease: u64 (8),
     scope: u8 (1) }. Scope=0 = "all vault-owned ATAs of mint, DERIVED
     ON-CHAIN" (per F-17 fix — NOT "visible in tx"); scope=1 = "specific
     token_account in entry's target_account field".
   - validate_and_authorize.rs snapshot phase: for each MintDeltaCap entry
     with scope=0: derive vault's ATAs for this mint via ATA-PDA derivation
     (cap at MAX_ATAS_PER_MINT=5 to bound CU). Sum balances. Store pre-snap
     sum in session.assertion_snapshots[i] as u64 LE.
   - finalize_session.rs verify phase: recompute post sum; assert
     (pre_sum - post_sum) <= max_net_decrease. Reject with 6097
     ErrMintDeltaCapExceeded.

2. R-2 AtaAuthorityPin (Maestro spending.rs:115-128 — CITATIONS VERIFIED):
   - New variant: assertion_mode=5 AtaAuthorityPin.
   - PER D-4: default-on. For each vault-owned ATA visible in tx, post-CPI
     assert token_account.data bytes 32..64 == vault PDA.
   - Pair with MintDeltaCap (per F-18 close-and-recreate evasion): if a vault
     ATA gets closed (data length=0) or re-initialized (bytes 32..64 != vault),
     reject. The pairing means: AtaAuthorityPin detects authority change,
     MintDeltaCap detects balance change — together cover close+drain+recreate.
   - Reject with 6098 ErrAtaAuthorityChanged.

3. R-3 OutputBalanceFloor (Maestro spending.rs:131-141 — CITATIONS VERIFIED;
   Maestro defined but DOESN'T USE this — Sigil first to wire):
   - New variant: assertion_mode=6 OutputBalanceFloor.
   - Schema: { token_account: Pubkey, mint: Pubkey, min_increase: u64 }.
   - validate_and_authorize.rs snapshot phase: read token_account balance,
     store pre-snap.
   - finalize_session.rs verify phase: read post; assert
     (post - pre) >= min_increase. Reject with 6099 ErrOutputBelowFloor.

4. R-4 DeclarationConsistency (NEW — Maestro verify_cpi_token_accounts at
   spending.rs:151-204; surfaced by Maestro re-verification, missed by both
   prior audits):
   - New variant: assertion_mode=7 DeclarationConsistency.
   - Schema: { declared_recipient: Pubkey, declared_mint: Pubkey,
     account_meta_index: u8 }.
   - At validate time, Sigil already accepts a recipient/mint declaration from
     the agent (authorized_token, output_mint fields on SessionAuthority).
     This variant asserts that the corresponding CPI account metas match the
     declaration: the account at remaining_accounts[account_meta_index] is a
     token account whose mint==declared_mint AND owner==declared_recipient.
   - Closes "declaration dishonesty" attack: agent declares "recipient: alice"
     to satisfy allowlist check, but provides attacker_ata in CPI metas.
   - Reject with 6100 ErrDeclarationInconsistent.

5. Grow MAX_POST_ASSERTION_ENTRIES from 4 to 8 (decision locked):
   - state/post_assertions.rs: const MAX_POST_ASSERTION_ENTRIES=8 (was 4).
   - state/session.rs: assertion_snapshots: [[u8; 32]; 8] (was 4),
     snapshot_lens: [u8; 8] (was 4).
   - Update PostExecutionAssertions SIZE constant: 8 + 32 + (76 · 8) + 1 + 1 + 6
     = 656 bytes (was 352).
   - Update SessionAuthority SIZE: + 132 bytes for the doubled snapshot arrays.

BUILD+TEST: full pipeline. Adversarial tests:
- MintDeltaCap scope=0 catches multi-ATA drain that scope=1 would miss
- AtaAuthorityPin catches mid-tx SetAuthority CPI
- AtaAuthorityPin + MintDeltaCap together catch close+drain+recreate
- OutputBalanceFloor catches dust-fill on swap output
- DeclarationConsistency catches recipient/mint declaration vs CPI meta mismatch
- ALL FOUR PASS tests (Audit #2 F-15 noted Phase 6 had 3 REJECT, 0 PASS — fix)

§RP REVIEW:
- silent-failure-hunter prompt: "Find any case where MintDeltaCap scope=0
  misses an ATA — verify on-chain ATA derivation actually enumerates all
  possible ATAs (single ATA per [vault, mint] pair; verify the cap of 5 is
  defensible). Find any way to evade AtaAuthorityPin via close+recreate (verify
  the data length=0 path is rejected). Find any race condition where
  OutputBalanceFloor reads stale balance. Find any way to construct a CPI
  where account_meta_index resolves to a token account whose data layout
  isn't standard SPL (Token-2022 with extension headers — verify R-4 parses
  correctly)."
- code-reviewer prompt: "Verify each new mode has explicit numeric assignment
  (4, 5, 6, 7 — no overlap with 0-3). Verify the assertion enumeration in
  finalize_session.rs matches the assignment. Verify all four new error codes
  (6097-6100) are in the post-Phase-1 reservation range."

COMMITS (4 expected, one per variant + capacity grow combined with R-1):
- feat(post-assertions): R-1 MintDeltaCap + grow capacity 4→8
- feat(post-assertions): R-2 AtaAuthorityPin (default-on, paired with R-1)
- feat(post-assertions): R-3 OutputBalanceFloor (slippage floor)
- feat(post-assertions): R-4 DeclarationConsistency (declaration vs actual)

OUT OF SCOPE: audit log (Phase 7), ownership transfer (Phase 8).

Report: 700 words.
```

### Phase 7 — Audit log SEPARATE PDAs (TA-15 + N1 temporal binding)

```
WORKING ON: revamp/v2-2026-05 post Phase 6.

GOAL: Two separate audit-log PDAs (per L-12 + D-3 + C-9 disposition). AgentVault
stays small. Closes durable-nonce replay forensics + audit-log spam.

PRE-STATE: AgentVault ~643 bytes after Phases 2-6. K6 events fire via emit!()
but not stored on-chain queryable state.

TASKS:

1. Create AuditLogSuccess PDA at [b"audit_success", vault]:
   - state/audit_log_success.rs (new file):
     ```
     #[account]
     pub struct AuditLogSuccess {
         pub vault: Pubkey,                  // 32
         pub entries: [AuditEntry; 128],     // 128 · 64 = 8,192
         pub head: u8,                        // 1
         pub count: u8,                       // 1
         pub _padding: [u8; 6],              // 6 for alignment
         pub bump: u8,                        // 1
     }
     // SIZE = 8 + 32 + 8192 + 1 + 1 + 6 + 1 = 8,241

     #[zero_copy]
     #[repr(C)]
     pub struct AuditEntry {
         pub discriminator: u8,               // 1 — see allocation below
         pub _pad0: [u8; 7],                 // 7 padding for alignment
         pub target_protocol: [u8; 32],       // 32 — Pubkey as bytes
         pub balance_delta_in: i64,           // 8
         pub balance_delta_out: i64,          // 8
         pub timestamp: i64,                  // 8
         pub slot_hash: [u8; 4],              // 4 — first 4 bytes of slot_hashes[0]
         pub blockhash: [u8; 3],              // 3 — first 3 bytes of recent slot_hashes[0]
         pub _pad1: u8,                       // 1
     }
     // 64 bytes per entry
     ```
   - Discriminator allocation:
     0 = reserved
     1 = validate (paired with 2)
     2 = finalize_success
     3 = deposit
     4 = withdraw
     5 = freeze
     6 = reactivate
     7 = ownership_initiate
     8 = ownership_accept
     9 = ownership_cancel
     10 = pause_agent
     11 = unpause_agent
     12 = revoke_agent
     13 = register_agent
     14 = policy_apply
     15 = constraints_apply
     16-255 = reserved (extensible — fixes Audit #1 M-4 non-extensibility)

2. Create AuditLogRejected PDA at [b"audit_rejected", vault]:
   - state/audit_log_rejected.rs (new file): SAME shape but 64 entries,
     SIZE = 8 + 32 + 4096 + 1 + 1 + 6 + 1 = 4,145 bytes.
   - Separation closes Audit #2 F-19 (audit log spam wipes legitimate entries):
     permissionless-crank rejected finalizes go to the rejected buffer; success
     finalize go to the success buffer. Attacker cannot displace legitimate
     success history.

3. Initialization:
   - instructions/initialize_vault.rs: allocate BOTH PDAs at vault creation.
     Owner pays rent (~0.058 SOL/vault combined). Failing to allocate aborts
     the vault create.
   - Add helper to derive both PDAs in SDK.

4. Sysvar choice (per Audit #1 AUD3-F5):
   - Use slot_hashes_sysvar + Clock::get().slot, NOT deprecated
     recent_blockhashes_sysvar (deprecated in Solana 1.18+).
   - slot_hash field = first 4 bytes of slot_hashes_sysvar[0].slot (most
     recent slot).
   - blockhash field = first 3 bytes of slot_hashes_sysvar[0].hash.

5. Write entries:
   - finalize_session.rs SUCCESS path: write to AuditLogSuccess at head index;
     increment head modulo 128; saturate count at 128.
   - finalize_session.rs REJECT path: write to AuditLogRejected with same
     pattern, modulo 64.
   - deposit_funds.rs: write to AuditLogSuccess with discriminator=3.
   - withdraw_funds.rs: discriminator=4.
   - freeze_vault.rs: discriminator=5.
   - reactivate_vault.rs: discriminator=6.
   - Ownership transfer instructions (added Phase 8): discriminator=7/8/9.
   - Other (per discriminator allocation above): write as appropriate.

6. K6 emit ordering (per my M-3 finding):
   - In every instruction handler that writes to AuditLog: call emit!() AFTER
     all assertions pass AND AFTER the audit-log entry is written. This ensures
     event log and on-chain state are aligned.

7. SDK helpers (Phase 9 will expand; bootstrap here):
   - sdk/kit/src/audit-log.ts (new): fetchAuditLogSuccess(rpc, vault),
     fetchAuditLogRejected(rpc, vault). Decodes the circular buffer into
     ordered Vec<AuditEntry>.

BUILD+TEST: full pipeline. AgentVault size: unchanged at ~643. NEW PDAs total
~12,386 bytes per vault. Adversarial tests:
- 128 success finalizes → buffer wraps correctly, last 128 retained
- 64 rejected finalizes → rejected buffer wraps, success buffer untouched
- Attacker triggers 64 expired-finalize cranks → rejected buffer wraps, success
  history retained (closes F-19)
- Each discriminator emits to the right buffer

§RP REVIEW:
- silent-failure-hunter prompt: "Find any instruction that mutates vault state
  but doesn't write an audit entry. Verify head wraparound is correct under
  count==128 (full) AND count<128 (partial). Verify slot_hash + blockhash are
  read FRESH from sysvar each ix, not cached. Verify the success vs rejected
  routing — a rejected finalize MUST NOT write to success buffer. Verify
  permissionless-finalize cannot displace success history."
- code-reviewer prompt: "Verify the circular buffer rollover math is correct
  (head = (head + 1) % SIZE). Verify rent calculation for both PDAs is
  correct. Verify the discriminator enum has explicit numeric assignments
  0-15 with 16-255 reserved (M-4 extensibility). Verify SDK decoder handles
  count==0 (empty log) without crash."

COMMITS (3 expected):
- feat(audit-log): create AuditLogSuccess + AuditLogRejected PDAs
- feat(audit-log): write entries from all 14 mutating instructions
- feat(sdk): fetchAuditLogSuccess + fetchAuditLogRejected helpers

OUT OF SCOPE: ownership transfer ix (Phase 8 — but Phase 8 wires audit-log
entries for transfer ixs).

Report: 700 words. Include exact AuditLogSuccess + AuditLogRejected SIZE
arithmetic + rent math.
```

### Phase 8 — Ownership transfer + freeze C26-C28

```
WORKING ON: revamp/v2-2026-05 post Phase 7.

GOAL: C26 transfer_vault_ownership (3 ix + PendingOwnershipTransfer PDA + Squads
V4 multisig variant). C27 freeze_reason. C28 5-min observation cooldown. Wire
audit log entries. Shared freeze helper.

TASKS:

1. C26 ownership transfer with timelock + Squads V4 support (per F-9):
   - state/pending_ownership_transfer.rs (new): PendingOwnershipTransfer PDA at
     [b"pending_owner", vault]. Fields:
     ```
     pub vault: Pubkey,                    // 32
     pub current_owner: Pubkey,            // 32
     pub new_owner: Pubkey,                // 32
     pub queued_at: i64,                   // 8
     pub min_delay_seconds: u64,           // 8 — default 172,800 (48h, matches PolicyConfig)
     pub is_multisig_target: bool,         // 1 — TRUE if new_owner is Squads V4 PDA
     pub bump: u8,                         // 1
     pub _padding: [u8; 6],                // 6
     ```
     SIZE = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 6 = 128

   - instructions/initiate_ownership_transfer.rs (new): owner-only signer.
     Creates PDA. Reject if PendingOwnershipTransfer already exists with
     6103 ErrPendingOwnershipExists. (Was 6099 in original plan; shifted to
     6103 by Phase 6 deviation +1 and audit closure +1 — see §4 reservation
     table.) Reject AC-10 replay via session.nonce (per M-5).

   - instructions/accept_ownership_transfer.rs (new): standard variant.
     new_owner: Signer. Asserts timelock expired (now - queued_at >=
     min_delay_seconds). Transfers AgentVault.owner = new_owner. Closes
     PendingOwnershipTransfer (rent to new owner).

   - instructions/accept_ownership_transfer_multisig.rs (new — per F-9):
     For Squads V4 multisig targets. Takes the multisig PDA as
     UncheckedAccount. Verifies multisig.owner == SQUADS_V4_PROGRAM_ID
     (SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf). Verifies pending.new_owner
     == multisig_pda. Verifies pending.is_multisig_target == true.
     Transfers AgentVault.owner = multisig_pda. Closes pending.

   - instructions/cancel_ownership_transfer.rs (new): current owner-only.
     Closes PendingOwnershipTransfer without transfer.
     Reject with 6104 ErrPendingOwnershipNotReady if attempted by non-owner.
     (Was 6100; shifted to 6104 — see §4 reservation table.)

2. Shared freeze helper (per F-7):
   - utils/freeze_helper.rs (new):
     ```
     pub fn freeze_internal(
         vault: &mut AgentVault,
         reason: FreezeReason,
         clock: &Clock,
         revoke_session_pairs: &[(Pubkey, Pubkey)], // (agent, token_mint) to revoke
     ) -> Result<()>
     ```
     Sets vault.status = Frozen, vault.frozen_at_timestamp = clock.unix_timestamp,
     vault.freeze_reason = reason as u8. Cancels any PendingOwnershipTransfer
     (close PDA, return rent to current_owner). Revokes SPL token delegations
     for the given pairs.
   - instructions/freeze_vault.rs: extract logic to call freeze_internal.
   - instructions/revoke_agent.rs:53-55: WHEN auto-freezing (last agent removed),
     call freeze_internal with reason=FreezeReason::AutoRevoke. THIS CLOSES F-7.

3. C27 freeze_reason on AgentVault:
   - state/vault.rs: AgentVault adds frozen_at_timestamp: i64 + freeze_reason: u8.
     APPEND-ONLY: total +9 bytes (i64 + u8). SIZE: 634 → 643.
   - FreezeReason enum:
     - Manual = 0 (set by freeze_vault from owner)
     - AutoRevoke = 1 (set by revoke_agent auto-freeze)
     - EmergencyBoard = 2 (reserved for future emergency-board pattern; if
       unused in V1, document as dead code with v1.1 activation path —
       addresses Audit #2 F-1's dead-code concern)
   - Validate reason ∈ {0, 1, 2} at write time. Reject with 6105
     ErrInvalidFreezeReason for any other value. (Was 6101; shifted to 6105 by
     Phase 6 deviation +1 and audit closure +1 — see §4 reservation table.)

4. C28 5-min observation cooldown on reactivate (per F-8 DOCUMENT the close+reinit
   bypass):
   - instructions/reactivate_vault.rs: reject if (now - frozen_at_timestamp) <
     300 seconds. Reject with 6106 ErrReactivateCooldownActive. (Was 6102;
     shifted to 6106 — see §4 reservation table.)
   - DOCUMENT in THREAT_MODEL_V2 T-19 (drop-in paragraph below):

   T-19 paragraph (per F-8 disposition):
   """
   C28 reactivation cooldown bypass via close+reinit. The 5-minute
   observation cooldown on reactivate_vault protects against fat-finger
   unfreeze and brief panic-then-reactivate workflows. It does NOT protect
   against an adversarial owner who close_vault's the frozen vault and
   subsequently initialize_vault's a fresh PDA. The fresh PDA has
   frozen_at_timestamp = 0, vacuously passing the cooldown gate. This is an
   accepted limitation in V1; the cooldown is a UX safety net, not an
   adversarial defense. Mitigation considered but deferred to v1.1: move
   cooldown to an owner-keyed PDA at [b"freeze_cooldown", owner] that
   persists across vault lifecycle. V1 accepts the bypass given solo-founder
   simplicity (per L-2 no-additional-rent-cost preference).
   """

5. Wire audit log entries (per Phase 7 discriminator allocation):
   - initiate_ownership_transfer.rs: write entry with discriminator=7
   - accept_ownership_transfer*.rs: write entry with discriminator=8
   - cancel_ownership_transfer.rs: write entry with discriminator=9

BUILD+TEST: full pipeline. AgentVault new SIZE: 634 + 9 = 643. Test fixtures:
- Full ownership-transfer lifecycle (initiate → wait → accept).
- Freeze cancels in-flight ownership transfer atomically.
- Revoke last agent → vault frozen with freeze_reason=AutoRevoke AND
  delegations revoked (closes F-7 fixture).
- 5-min cooldown enforcement (try reactivate at +299s → reject; at +300s → ok).
- Close+reinit bypass: documented in T-19, not actively defended against.
- Squads V4 multisig acceptance (mock multisig PDA).

§RP REVIEW:
- silent-failure-hunter prompt: "Find any race where current owner is lost
  during accept (e.g., owner becomes new_owner, cancel attempt fails because
  current_owner is no longer signer). Find any way for revoke_agent auto-freeze
  to skip the shared freeze_internal helper. Verify Squads V4 multisig variant
  actually checks SQDS4ep... program ID, not just ANY owner program. Verify
  cancel can only be called by CURRENT owner, not by new_owner."
- code-reviewer prompt: "Verify accept_ownership_transfer correctly updates
  AgentVault.owner AND has_one constraints on dependent PDAs (PolicyConfig,
  SpendTracker, etc. — verify there's no has_one = owner that would still
  point at old owner). Verify freeze_reason enum exhaustiveness — what
  happens with value 3+? Verify timelock default (172,800) matches PolicyConfig
  pattern. Verify audit-log discriminator allocation matches Phase 7 §1."

COMMITS (5 expected):
- feat(freeze): shared freeze_internal helper (closes F-7 auto-freeze gap)
- feat(ownership): C26 initiate/accept/cancel ownership transfer
- feat(ownership): C26 Squads V4 multisig acceptance variant (F-9)
- feat(freeze): C27 freeze_reason u8 enum on AgentVault
- feat(reactivate): C28 5-min observation cooldown + T-19 documentation

ABSORPTION NOTES (Phase 2 close-up extension, 2026-05-18):
- Task X: PEN-CROSS-1 absorption — add timelock-gated path for
  `CAPABILITY_OPERATOR` (capability=2) grants in `register_agent` + expand
  TA-19 digest scope to cover `vault.agents` pubkey + capability. Today
  register_agent admits an Operator-class agent immediately on owner
  signature; the digest does not bind the agent pubkey, so a compromised
  owner-signer can blind-sign a new agent. Two-part fix:
    1. State change: rename `register_agent` to handle Observer-class
       grants directly, and split CAPABILITY_OPERATOR registration into
       `queue_agent_grant` → `apply_agent_grant` (timelock-gated, default
       MIN_TIMELOCK_DURATION=1800s) so the owner has the same observation
       window as policy updates.
    2. Digest scope: append `agent_set_hash: [u8; 32]` to TA-19
       PolicyPreviewFields canonical encoding at position 15 (after
       created_at_slot). Compute as SHA-256 over the Borsh encoding of
       `vault.agents.iter().map(|a| (a.pubkey, a.capability)).collect()`.
       Bind every existing handler that touches digest.

OUT OF SCOPE: SDK ergonomic wrappers for ownership transfer (Phase 9).

Report: 700 words.
```

### Phase 9 — SDK Redesign

```
WORKING ON: revamp/v2-2026-05 post Phase 8.

GOAL: Bring SDK fully in sync with V2 Rust schema. Drop tier-related code per
F-24. Add TA-18 Squads V4 detection + Session-Mint Helper + Attestation Reader.
Regenerate event decoders. Auto-regenerate errors map.

PRE-STATE: SDK has protocol-tier.ts, protocol-registry/, ProtocolTier types,
PROTOCOL_ANNOTATIONS, VERIFIED_PROGRAMS, lookupProtocolAnnotation — ALL get
deleted (F-24). SDK has capabilityTier (V1 agent permissions, different concept)
— PRESERVE.

TASKS:

1. Delete tier-related SDK code (PRECISE list per F-24):
   - sdk/kit/src/protocol-tier.ts: DELETE
   - sdk/kit/src/protocol-registry/: DELETE entire directory
   - sdk/kit/src/index.ts exports: REMOVE ProtocolTier, resolveProtocolTier,
     ProtocolTrustTier, PROTOCOL_ANNOTATIONS, VERIFIED_PROGRAMS,
     lookupProtocolAnnotation. KEEP capabilityTier, capabilityTierToNames.
   - Grep for all imports of deleted symbols; verify zero remaining references
     before commit.

2. Finalize universal seal() pattern:
   - sdk/kit/src/seal.ts: already takes arbitrary instructions; verify no
     T1-specific branching remains (grep "tier", "T1", "T2", "T3" — expect zero).
   - Update SealResult type to reflect new event shapes (post Phase 7 + 8
     additions).

3. TA-18 Squads V4 owner detection (per L-11):
   - sdk/kit/src/multisig-detection.ts (new):
     ```
     export const SQUADS_V4_PROGRAM_ID = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');

     export async function isSquadsV4Owned(
         vault: AgentVault,
         rpc: Rpc
     ): Promise<{
         isSquadsMultisig: boolean;
         threshold?: number;
         members?: Pubkey[];
     }>
     ```
   - Implementation: fetch owner account info; if owner.owner == SQUADS_V4_PROGRAM_ID,
     decode multisig account, return threshold + members. Gracefully fallback
     to { isSquadsMultisig: false } for non-multisig (no throw — per Audit #2
     F-9 false-positive defense).

4. NEW: Session-Mint Helper (per Audit #3):
   - sdk/kit/src/session-mint.ts (new):
     ```
     export async function mintSessionForAgent(
         vault: Address,
         agent_identity: Address,
         capability: 'DISABLED' | 'OBSERVER' | 'OPERATOR',
         mint: Address,
         options?: { spending_limit_usd?: bigint }
     ): Promise<Transaction>
     ```
   - Returns unsigned register_agent + validate_and_authorize transaction.
   - Agent generates its own keypair off-chain (Sigil never sees secret).
   - User signs as owner; this is just an ergonomic wrapper.

5. NEW: Attestation Reader (per Audit #3 reframed):
   - sdk/kit/src/policy-attestation.ts (new):
     ```
     export async function getLatestPolicyAttestation(
         rpc: Rpc,
         vault: Address
     ): Promise<{
         policy_version: bigint;
         policy_preview_digest: Uint8Array;
         protocol_mode: number;
         destination_mode: number;
         daily_cap: bigint;
         stable_balance_floor: bigint;
         observe_only: boolean;
         allowed_protocols_count: number;
         allowed_destinations_count: number;
         operating_hours: number;
         cooldown_seconds: number;
         auto_revoke_threshold: number;
     }>
     ```
   - Reads PolicyConfig PDA directly (NOT events — per K-8 reframe). Returns
     decoded current state in one RPC call.

6. NEW: SDK helper for AuditLog (Phase 7 bootstrap):
   - sdk/kit/src/audit-log.ts (new): fetchAuditLogSuccess(rpc, vault),
     fetchAuditLogRejected(rpc, vault). Decode the circular buffer into ordered
     Vec<AuditEntry>. Handle empty case (count==0) without crash.

7. NEW: SDK helpers for ownership transfer (Phase 8 wrappers):
   - sdk/kit/src/ownership-transfer.ts (new): buildInitiateOwnershipTransferIx,
     buildAcceptOwnershipTransferIx, buildAcceptOwnershipTransferMultisigIx,
     buildCancelOwnershipTransferIx.

8. NEW: computePolicyPreviewDigest (Phase 2 bootstrap):
   - Already added in Phase 2 commit; verify the cross-impl test still passes.

9. Regenerate event decoders for new event shapes:
   - AutoRevokedEvent (Phase 3)
   - SandwichIntegrityViolation, ProtectedWritableRejected (Phase 4 — emit only
     on reject; document choice)
   - StableFloorViolation, RecipientCapExceeded (Phase 5)
   - MintDeltaCapExceeded, AtaAuthorityChanged, OutputBelowFloor,
     DeclarationInconsistent (Phase 6)
   - OwnershipTransferInitiated/Accepted/Cancelled (Phase 8)
   - FreezeVaultEvent.freeze_reason addition (Phase 8 update)
   - All on-chain audit-log entries don't need events (state is on-chain queryable).

10. Auto-regenerate errors map from IDL (per Audit #2 F-26 mechanism):
    - sdk/kit/scripts/gen-error-map.ts (new): reads target/idl/sigil.json,
      extracts errors array, emits sdk/kit/src/agent-errors.generated.ts.
    - Hook into pnpm pretest. NO hand-maintained 88-code table (or 81, or
      whatever the final count is).
    - Adopt M-6: this auto-regen handles Phase 2-8 errors automatically; no
      manual SDK error-code maintenance.

11. Update sdk/kit/src/dashboard/reads.ts to match new schemas:
    - PolicyConfig new fields: policy_preview_digest, operating_hours,
      cooldown_seconds (per-vault wrapper? — no, cooldown is on overlay per
      F-16), destination_graylist, auto_promote_grays, stable_balance_floor,
      per_recipient_daily_cap_usd, auto_revoke_threshold.
    - AgentVault new fields: observe_only, frozen_at_timestamp, freeze_reason.
    - SessionAuthority new field: nonce.
    - SpendTracker new field: per_recipient array.
    - AuditLogSuccess + AuditLogRejected accessors.
    - PendingOwnershipTransfer accessor.

BUILD+TEST: full SDK pipeline. New tests for:
- Squads V4 detection (mock Squads PDA + non-multisig owner — both paths).
- mintSessionForAgent returns correct ix bytes.
- getLatestPolicyAttestation returns decoded current state.
- computePolicyPreviewDigest matches on-chain enforcement (cross-impl test).
- AuditLog decoders handle empty + partial + full buffer states.
- Auto-regenerated errors map matches on-chain enum exactly (drift gate).

§RP REVIEW:
- silent-failure-hunter prompt: "Find any SDK function that still imports from
  a deleted tier module (grep ProtocolTier, protocol-tier — expect zero hits).
  Find any decoder that silently returns default values for missing fields
  instead of throwing. Verify auto-regenerated errors map matches on-chain
  exactly — no drift. Verify Squads V4 detection has graceful non-multisig
  fallback (returns isSquadsMultisig: false, no throw — F-9 defense)."
- code-reviewer prompt: "Verify SDK exports surface area matches consumer
  needs (no dead exports). Verify no SDK function hardcodes a program ID —
  all paths use createSigilClient injected ID. Verify gen-error-map.ts handles
  the field name format from IDL (camelCase vs snake_case). Verify the
  cross-impl test for computePolicyPreviewDigest is in CI."

COMMITS (5 expected):
- refactor(sdk): delete all tier-related code (protocol-tier, protocol-registry)
- feat(sdk): TA-18 Squads V4 owner detection helper
- feat(sdk): session-mint + attestation-reader + audit-log + ownership-transfer wrappers
- chore(sdk): auto-generate agent-errors from IDL
- refactor(sdk): regenerate event decoders + update dashboard reads for V2 schema

OUT OF SCOPE: dashboard/ UI, Sigil-Smart-Wallet/, devnet redeploy (Phase 10).

Report: 800 words.
```

### Phase 10 — Devnet Redeploy

```
WORKING ON: revamp/v2-2026-05 post Phase 9.

GOAL: Deploy V2 to devnet under fresh program ID. Existing devnet 7FtAXUcr…
untouched as V1 reference.

TASKS:

1. Generate fresh program keypair:
   ```
   solana-keygen new --no-bip39-passphrase --outfile target/deploy/sigil-keypair.json
   solana address --keypair target/deploy/sigil-keypair.json
   ```
   Save as NEW_PROGRAM_ID.

2. Update declare_id! in programs/sigil/src/lib.rs to NEW_PROGRAM_ID.

3. Update Anchor.toml — BOTH sections (per F-23):
   - [programs.devnet] sigil = "<NEW_PROGRAM_ID>"
   - [programs.localnet] sigil = "<NEW_PROGRAM_ID>"
   - Verify no [programs.mainnet] section exists or is added.

4. Add compile_error! guard using PROPER syntax (per F-22):
   In programs/sigil/src/lib.rs after declare_id!:
   ```
   const V1_PROGRAM_ID_BYTES: [u8; 32] = [
       /* 32 bytes of "7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK" — compute via:
          solana-keygen pubkey can decode bs58 if needed, OR hardcode the bytes
          from the Solana toolchain pubkey output */
   ];

   const _: () = {
       let our_bytes = ID.to_bytes();
       let mut i = 0;
       let mut matches = true;
       while i < 32 {
           if our_bytes[i] != V1_PROGRAM_ID_BYTES[i] {
               matches = false;
           }
           i += 1;
       }
       if matches {
           panic!("V2 cannot deploy under V1 program ID — would corrupt PDAs");
       }
   };
   ```
   ALSO add shell-level guard as belt-and-suspenders in scripts/deploy-devnet.sh:
   ```
   if grep -q '7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK' programs/sigil/src/lib.rs; then
     echo "REFUSE deploy with V1 ID"
     exit 1
   fi
   ```

5. Build: anchor build --no-idl (stable Rust).

6. Generate IDL: RUSTUP_TOOLCHAIN=nightly anchor idl build > target/idl/sigil.json.
   anchor idl type target/idl/sigil.json > target/types/sigil.ts.

7. Run dependency audits BEFORE deploy (per Audit #2 F-27):
   - cargo audit --deny warnings
   - pnpm audit --prod --audit-level=high

8. Deploy: solana program deploy target/deploy/sigil.so --url devnet
   --keypair target/deploy/sigil-keypair.json --with-compute-unit-price 100000
   --max-sign-attempts 50. Use owner keypair as upgrade authority for V1 (per Q-10
   default — solo founder; Squads V4 rotation deferred to v1.1).

9. Persist deployment record:
   ```
   {
       "program_id": "<NEW_PROGRAM_ID>",
       "deploy_tx": "<deploy_tx_signature>",
       "deploy_slot": <slot>,
       "idl_sha256": "<sha256 of target/idl/sigil.json>",
       "deployed_at": "<ISO8601 timestamp>",
       "upgrade_authority": "<deployer_keypair_pubkey>",
       "upgrade_authority_note": "Solo founder keypair per Q-10. Squads V4 rotation deferred to v1.1."
   }
   ```
   Save as deployment-record.json.

10. Cache IDL: cp target/idl/sigil.json cached-idls/<NEW_PROGRAM_ID>-DEVNET-LIVE.json.

11. Update SDK consumers: createSigilClient({ programId: NEW_PROGRAM_ID, ... }).

12. End-to-end smoke test:
    - initialize_vault under new program ID with TA-19 preview_digest
    - register_agent with capability=OPERATOR
    - create_instruction_constraints
    - create_post_assertions with MintDeltaCap + AtaAuthorityPin + OutputBalanceFloor
    - validate_and_authorize + DeFi swap + finalize_session → SUCCESS
    - Sandwich injection attempt → expect ErrSandwichIntegrity
    - Graylist-fresh-destination → expect ErrGraylistFriction
    - Cap exceeded → expect ErrDailyCapExceeded or ErrRecipientCapExceeded
    - Post-assertion violation → expect ErrMintDeltaCapExceeded
    - Replay with stale nonce → expect ErrSessionNonceMismatch

13. Verify on-chain via solana program show <NEW_PROGRAM_ID>:
    - executable: true
    - owner: BPFLoaderUpgradeable
    - account size > 100KB

14. Upgrade authority rotation runbook (per Audit #1 AUD7-F10):
    - Add scripts/upgrade-authority-runbook.md (NEW): documents how to rotate
      upgrade authority to Squads V4 multisig when ready (post-V1). Includes
      gotchas: must use upgrade ix not transferAuthority, must test on devnet
      first, must verify new authority is the multisig PDA not a member.

§RP REVIEW:
- silent-failure-hunter prompt: "Verify NO SDK consumer hardcodes the old V1
  program ID. Verify the compile_error! guard fires if declare_id! is set to
  7FtAXUcr... (test by temporarily setting it back, observe build failure).
  Verify the shell-guard in deploy-devnet.sh actually exits non-zero. Verify
  deployment record captures everything needed to reproduce the deploy."
- code-reviewer prompt: "Verify Anchor.toml [programs.localnet] AND
  [programs.devnet] both updated. Verify upgrade authority is the solo
  founder keypair (Q-10 ack — accepted as DEEP-9 risk per L-2 no-multisig-V1).
  Verify cached IDL filename convention matches existing cached-idls/."

COMMITS (3 expected):
- chore(deploy): fresh program keypair + declare_id! + compile_error! guard
- chore(deploy): Anchor.toml devnet + localnet update
- chore(deploy): devnet deployment record + cached IDL + upgrade-authority runbook

PUSH POLICY: NO push. The deploy itself is on-chain (immutable record on devnet)
but commits stay local until user authorizes.

OUT OF SCOPE: mainnet (L-8), audit (L-2), Squads V4 rotation (v1.1).

Report: 800 words. Include NEW_PROGRAM_ID, deploy tx signature, IDL sha256,
end-to-end smoke test results.
```

### Phase 11 — Final Sync + Baseline Tag

```
WORKING ON: revamp/v2-2026-05 post Phase 10.

GOAL: Cross-check every doc claim against running V2 code on the new devnet
program. Refresh memory. Tag the baseline. Final summary.

TASKS:

1. Cross-check every doc claim against current code state:
   - PROJECT.md, ARCHITECTURE.md, INSTRUCTIONS.md, SECURITY.md, ERROR-CODES.md,
     ONCHAIN-FEATURE-INVENTORY.md, COMMANDS-REFERENCE.md
   - All revamp/ docs: REVAMP_PLAN.md, INTERFACES_V2.md, THREAT_MODEL_V2.md,
     ACCEPTANCE_V2.md, STAGE_1_REMOVED.md (consider rename to DEMOLITION_LOG.md),
     HARDENED_V2_PROMPT_MAP.md (THIS document — verify nothing in it is now
     out of date).
   - For each: grep for stale file:line citations, dead doc links, old program
     ID references, T1/T2/T3 leftovers, CrossFieldLte, jupiter_slippage,
     parser_version, audit-pending language.
   - Update against current code state.

2. Memory refresh:
   - project_sigil_v2_revamp_briefing.md: replace with final V2 state. All 13
     phases landed. New program ID = <NEW_PROGRAM_ID>. Link to
     deployment-record.json. Baseline tag = v2-baseline. Strip all stale
     pre-Option-A claims.
   - project_actiontype_elimination_progress.md: verify current.
   - project_sigil_living_masterplan.md: refresh with V2 state.
   - Drop any memory file contradicted by V2 reality.

3. Reproducibility test (per Audit #1 AUD7-F11):
   - Run from a clean clone:
     ```
     git clone <repo>
     cd Middleware-Agent-Layer/agent-middleware
     pnpm install
     anchor build --no-idl
     pnpm test
     ```
     Verify all tests pass. Document any prerequisite (Rust version, Anchor
     CLI version, Node version) in COMMANDS-REFERENCE.md.

4. Tag git baseline:
   ```
   git tag -a v2-baseline -m "V2 baseline — Option A pure generic guardrails. \
   Devnet program: <NEW_PROGRAM_ID>. \
   13 phases landed. \
   All Phase 0.5 → 11 documented in HARDENED_V2_PROMPT_MAP.md."
   ```

5. Final summary report to user.

§RP REVIEW:
- silent-failure-hunter prompt: "Find any doc that still claims a feature
  exists which doesn't, or vice versa. Find any code file with doc-comment
  pointing to a now-deleted doc. Verify reproducibility test passes from a
  literal fresh clone (run it)."
- code-reviewer prompt: "Verify every TA-NN entry in INTERFACES_V2.md has a
  corresponding implementation citation in REVAMP_PLAN.md, and vice versa.
  Verify the error code list in ERROR-CODES.md matches the on-chain enum
  exactly (re-run the gen-error-map.ts script and diff)."

COMMITS (3 expected):
- docs(v2): final cross-check across all docs
- chore(memory): refresh memory to final V2 state
- chore(baseline): tag v2-baseline

Report: 800 words. Final summary.
```

---

## §7 V1.1 deferred items (recorded; not in V1 scope)

| Item | Source | Defer reason |
|---|---|---|
| SDK Template library (5 personas) | Audit #3 | User L-15: out of scope for SDK; better fit for future MCP server |
| SDK Intent Compiler | Audit #3 | Pairs with templates |
| Certora formal verification gate | L-2 (paid tool) | No funding in V1 |
| Squads V4 upgrade authority rotation | Q-10 | Solo founder for V1; runbook documented in Phase 10 |
| Move C28 cooldown to owner-keyed PDA | F-8 disposition | V1 accepts close+reinit bypass; documented in T-19 |
| ConfigurabilityT-21a/b/c sub-class enforcement | Audit #3 partial | Mental model framing; not on-chain primitive |
| InterestBearingMint extension v1.1 reconsideration | F-31 | Currently rejected via TA-08 allowlist; revisit if users need it |
| Empirical ALT exploit test in protocol-scalability-tests | ALT verifier | Folder out of scope L-6; regression guard for v1.1 |

---

## §8 Execution mechanism

| Step | Mechanism |
|---|---|
| **Dispatch** | Engineer agent in-thread via Agent tool, ONE per phase, `run_in_background: true` (per algorithmic preference) |
| **Verification between phases** | Conversation Claude verifies returned diff before dispatching next phase |
| **§RP review** | Embedded in each Engineer prompt; silent-failure-hunter + code-reviewer fixed before commit |
| **Docs+memory sync** | Conversation Claude writes post-phase docs+memory updates as separate commit (keeps Engineer commits clean) |
| **Phase tagging** | `phase-N-baseline` git tag between every two phases for rollback target |
| **Push** | Consultation-gated. Engineer NEVER pushes. User authorizes push between phases or all-at-end. |

---

**END OF HARDENED V2 PROMPT MAP.** Ready to dispatch Phase 0.5 on user signal. Estimated end-to-end: 13 phases × ~1-3 hours each = ~25-35 hours of Engineer time + ~5 hours of orchestration Claude verification + docs writing.
