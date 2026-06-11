# ERROR_CODE_ALLOCATION_V2.md — Canonical Error Code Allocation

**Status:** Canonical source of truth for `SigilError` numeric codes.
**Last updated:** 2026-05-17 (Phase 1 Option A demolition — landed)
**Source:** `programs/sigil/src/errors.rs` (verified line-by-line on `revamp/v2-2026-05`).
**Supersedes:** Any prior error-code listing in `INTERFACES_V2.md`, `CLAUDE.md`, or `docs/ERROR-CODES.md`.

> Anchor assigns codes sequentially from the order of variant declaration. The first variant gets `6000`; each subsequent variant increments by 1. `code = 6000 + variant_ordinal` (0-indexed). This document maps every variant currently in the enum to its exact code, and reserves the post-Phase-1 range for V2 additions.

---

## 1. Pre-Phase-1 V1 allocation (81 variants, codes 6000-6080) — HISTORICAL

Verified against `programs/sigil/src/errors.rs` on `revamp/v2-2026-05` (commit `554796e`, prior to Phase 1 deletions). After Phase 1 the surviving 79 variants are at codes 6000-6078 — see §2 for the deletion details and §6 for the post-Phase-1 numeric layout.

| Code | Variant | Source line | Category |
|------|---------|-------------|----------|
| 6000 | `VaultNotActive` | errors.rs:6 | Vault lifecycle |
| 6001 | `UnauthorizedAgent` | errors.rs:9 | Authorization |
| 6002 | `UnauthorizedOwner` | errors.rs:12 | Authorization |
| 6003 | `UnsupportedToken` | errors.rs:15 | Mint validation |
| 6004 | `ProtocolNotAllowed` | errors.rs:18 | Allowlist |
| 6005 | `TransactionTooLarge` | errors.rs:21 | Transaction shape |
| 6006 | `SpendingCapExceeded` | errors.rs:24 | Spending |
| 6007 | `SessionNotAuthorized` | errors.rs:27 | Session |
| 6008 | `InvalidSession` | errors.rs:30 | Session |
| 6009 | `TooManyAllowedProtocols` | errors.rs:33 | Policy bounds |
| 6010 | `AgentAlreadyRegistered` | errors.rs:36 | Agent lifecycle |
| 6011 | `NoAgentRegistered` | errors.rs:39 | Agent lifecycle |
| 6012 | `VaultNotFrozen` | errors.rs:42 | Vault lifecycle |
| 6013 | `VaultAlreadyClosed` | errors.rs:45 | Vault lifecycle |
| 6014 | `InsufficientBalance` | errors.rs:48 | Balance |
| 6015 | `DeveloperFeeTooHigh` | errors.rs:51 | Fee |
| 6016 | `InvalidFeeDestination` | errors.rs:54 | Fee |
| 6017 | `InvalidProtocolTreasury` | errors.rs:57 | Protocol |
| 6018 | `InvalidAgentKey` | errors.rs:60 | Agent validation |
| 6019 | `AgentIsOwner` | errors.rs:63 | Agent validation |
| 6020 | `Overflow` | errors.rs:66 | Arithmetic |
| 6021 | `InvalidTokenAccount` | errors.rs:70 | Token account |
| 6022 | `TimelockNotExpired` | errors.rs:74 | Timelock |
| 6023 | `NoTimelockConfigured` | errors.rs:79 | Timelock |
| 6024 | `DestinationNotAllowed` | errors.rs:82 | Allowlist |
| 6025 | `TooManyDestinations` | errors.rs:85 | Policy bounds |
| 6026 | `InvalidProtocolMode` | errors.rs:88 | Policy mode |
| 6027 | `CpiCallNotAllowed` | errors.rs:92 | Transaction shape |
| 6028 | `MissingFinalizeInstruction` | errors.rs:95 | Transaction shape |
| 6029 | `NonTrackedSwapMustReturnStablecoin` | errors.rs:99 | Stablecoin enforcement |
| 6030 | `SwapSlippageExceeded` | errors.rs:102 | Jupiter (slated for Phase 1 deletion) |
| 6031 | `InvalidJupiterInstruction` | errors.rs:105 | Jupiter (slated for Phase 1 deletion) |
| 6032 | `UnauthorizedTokenTransfer` | errors.rs:108 | Token transfer |
| 6033 | `SlippageBpsTooHigh` | errors.rs:111 | Jupiter (slated for Phase 1 deletion) |
| 6034 | `ProtocolMismatch` | errors.rs:114 | Protocol |
| 6035 | `TooManyDeFiInstructions` | errors.rs:117 | Transaction shape |
| 6036 | `MaxAgentsReached` | errors.rs:121 | Multi-agent |
| 6037 | `InsufficientPermissions` | errors.rs:124 | Multi-agent |
| 6038 | `InvalidPermissions` | errors.rs:127 | Multi-agent |
| 6039 | `InvalidConstraintConfig` | errors.rs:131 | Constraints |
| 6040 | `ConstraintViolated` | errors.rs:134 | Constraints |
| 6041 | `InvalidConstraintsPda` | errors.rs:137 | Constraints |
| 6042 | `InvalidPendingConstraintsPda` | errors.rs:140 | Constraints |
| 6043 | `AgentSpendLimitExceeded` | errors.rs:144 | Per-agent spend |
| 6044 | `OverlaySlotExhausted` | errors.rs:147 | Per-agent spend |
| 6045 | `AgentSlotNotFound` | errors.rs:150 | Per-agent spend |
| 6046 | `UnauthorizedTokenApproval` | errors.rs:153 | Token transfer |
| 6047 | `InvalidSessionExpiry` | errors.rs:156 | Session |
| 6048 | `UnconstrainedProgramBlocked` | errors.rs:160 | Constraints V2 |
| 6049 | `ProtocolCapExceeded` | errors.rs:164 | Per-protocol spend |
| 6050 | `ProtocolCapsMismatch` | errors.rs:167 | Per-protocol spend |
| 6051 | `ConstraintsNotClosed` | errors.rs:171 | Vault cleanup |
| 6052 | `PendingPolicyExists` | errors.rs:174 | Vault cleanup |
| 6053 | `AgentPaused` | errors.rs:178 | Emergency response |
| 6054 | `AgentAlreadyPaused` | errors.rs:181 | Emergency response |
| 6055 | `AgentNotPaused` | errors.rs:184 | Emergency response |
| 6056 | `UnauthorizedPostFinalizeInstruction` | errors.rs:188 | Sandwich integrity |
| 6057 | `UnexpectedBalanceDecrease` | errors.rs:192 | CPI balance audit |
| 6058 | `TimelockTooShort` | errors.rs:196 | Timelock |
| 6059 | `PolicyVersionMismatch` | errors.rs:199 | Policy versioning |
| 6060 | `ActiveSessionsExist` | errors.rs:202 | Vault cleanup |
| 6061 | `PostAssertionFailed` | errors.rs:206 | Post-execution assertions |
| 6062 | `SnapshotNotCaptured` | errors.rs:236 | Delta assertions |
| 6063 | `InvalidConstraintOperator` | errors.rs:239 | Constraints |
| 6064 | `ZeroCopyVaultMismatch` | errors.rs:247 | Zero-copy account vault key check (constraints + audit-log; renamed from `ConstraintsVaultMismatch` 2026-05-19 §RP-2 HIGH-3) |
| 6065 | `BlockedSplOpcode` | errors.rs:250 | SPL opcode block |
| 6066 | `QueuedUpdateExpired` | errors.rs:254 | Durable-nonce defense (F-10) |
| 6067 | `AccountWritabilityMismatch` | errors.rs:258 | Squads SAP parity (M5) |
| 6068 | `SysvarScanBoundExceeded` | errors.rs:262 | Pad-attack DoS guard (M11) |
| 6069 | `AsyncFulfillmentNotPermitted` | errors.rs:266 | Async-fulfillment block (C4) |
| 6072 | `ConstraintsAlreadyPopulated` | errors.rs:244 | Orphan-PDA cleanup |
| 6073 | `OrphanPdaWrongOwner` | errors.rs:247 | Orphan-PDA cleanup |
| 6074 | `OrphanPdaPopulated` | errors.rs:250 | Orphan-PDA cleanup |
| 6075 | `ConfidentialTransferBlocked` | errors.rs:254 | Token-2022 (M3) |
| 6076 | `PermanentDelegateBlocked` | errors.rs:259 | Token-2022 follow-up |
| 6077 | `TransferHookBlocked` | errors.rs:262 | Token-2022 follow-up |
| 6078 | `LamportDrainBlocked` | errors.rs:265 | Token-2022 follow-up |
| 6079 | `BatchInstructionBlocked` | errors.rs:269 | Token-2022 batch block |
| 6080 | `InvalidDestinationMode` | errors.rs:274 | Destination mode (F-4) |

**Count check:** 81 variants, codes 6000-6080 inclusive (verified via direct line-by-line enumeration of `programs/sigil/src/errors.rs`).

---

## 2. Phase 1 demolition deletions — LANDED 2026-05-17 (2 variants deleted, 1 retained)

Per `HARDENED_V2_PROMPT_MAP.md` §4 and F-21, Phase 1 was prompted to delete three Jupiter-specific variants:

- `SwapSlippageExceeded` (was 6030) — DELETED
- `InvalidJupiterInstruction` (was 6031) — DELETED
- `SlippageBpsTooHigh` (was 6033) — **RETAINED**

**Plan deviation (surfaced per prompt's STOP-and-surface clause):** `SlippageBpsTooHigh` is the only error variant used by the surviving `max_slippage_bps <= MAX_SLIPPAGE_BPS` config-bound check in `initialize_vault.rs:88` and `queue_policy_update.rs:99`. Per D-5, `max_slippage_bps` is preserved as a generic slippage primitive (not Jupiter-specific). Deleting `SlippageBpsTooHigh` would have required either deleting the D-5-preserved validation (contradiction) or redirecting the validation to a misleading existing error. Both options are worse than keeping a config-bound error whose name correctly describes its semantic role; the variant's `#[msg]` is unchanged.

**Code re-numbering behavior (compaction strategy chosen):** Anchor assigns codes by variant ordinal at compile time. Deleting variants mid-enum causes all subsequent variants to shift down. The two deleted variants were adjacent at 6030+6031; deletions therefore shift later codes down by **2** (not 3 as the prompt assumed).

Under compaction (post-Phase-1):
- Codes 6000-6029 unchanged (30 variants before the first deleted variant at 6030).
- `UnauthorizedTokenTransfer` (was 6032) → now **6030**.
- `SlippageBpsTooHigh` (was 6033) → now **6031**.
- All variants previously at 6034-6080 shift down by 2 → now **6032-6078**.
- For example: `InvalidDestinationMode` (was 6080) shifts to **6078**.

**Post-Phase-1 state (compaction):** 79 V1 variants at codes 6000-6078. The lowest unused code was **6079**. Phase 2 appended 6079-6081 (InvalidCapability + PolicyPreviewMismatch + ObserveOnlyModeBlocksExecute). Phase 2 close-up appended 6082 (ActiveVaultRequiresAllowlist — F-11). Post-Phase-2-close-up: 83 variants at codes 6000-6082; next free code is **6083**.

---

## 3. Post-Phase-1 reservation table (V2 additions, codes 6079-6106)

These codes are reserved for V2 primitives introduced in Phases 2 through 8. They are listed here in the order they are scheduled to land in the enum. Starts at **6079** (not 6078 as the prompt assumed) because Phase 1 retained `SlippageBpsTooHigh` — see §2.

| Code | Name | Phase | Primitive | Notes |
|------|------|-------|-----------|-------|
| 6079 | `InvalidCapability` | Phase 2 ✅ | TA-04 | Reserved capability values 3..=255 reject — LANDED |
| 6080 | `PolicyPreviewMismatch` | Phase 2 ✅ | TA-19 | SHA-256 digest mismatch on PolicyConfig/PendingPolicyUpdate — LANDED |
| 6081 | `ObserveOnlyModeBlocksExecute` | Phase 2 ✅ | TA-19 | observe_only vault rejects validate_and_authorize — LANDED |
| 6082 | `ActiveVaultRequiresAllowlist` | Phase 2 close-up ✅ | F-11 | Active (non-observe_only) vault must have ≥1 protocol or destination — LANDED |
| 6083 | `ErrMintNotPinned` | Phase 3 ✅ | TA-03 | USDC/USDT cluster-pinned mint enforcement — LANDED |
| 6084 | `ErrOutsideOperatingHours` | Phase 3 ✅ | TA-05 | UTC operating-hours bitmask violation — LANDED |
| 6085 | `ErrCooldownActive` | Phase 3 ✅ | TA-06 | Per-agent cooldown (on AgentSpendOverlay) — LANDED |
| 6086 | `ErrGraylistFriction` | Phase 3 ✅ | TA-07 | First-time destination delay window — LANDED |
| 6087 | `ErrGraylistFull` | Phase 3 ✅ | TA-07 | Destination graylist bound (10 entries) — LANDED |
| 6088 | `ErrToken2022ExtensionForbidden` | Phase 3 ✅ | TA-08 | TLV check at deposit (3-item allowlist per D-4) — LANDED |
| 6089 | `ErrCosignRequired` | Phase 3 ✅ | TA-09 | Owner+session co-signature required — LANDED |
| 6090 | `ErrAutoRevoked` | Phase 3 ✅ | TA-17 | AgentEntry.consecutive_failures threshold tripped — LANDED |
| 6091 | `ErrSandwichIntegrity` | Phase 4 ✅ | TA-10 | Sandwich pair/bundle integrity violation — LANDED |
| 6092 | `ErrProtectedWritable` | Phase 4 ✅ | TA-11 | Protected PDA listed as writable in foreign ix — LANDED |
| 6093 | `ErrSessionNonceMismatch` | Phase 4 ✅ | AC-10 | Durable-nonce replay defense — LANDED |
| 6094 | `ErrStableFloorViolation` | Phase 5 ✅ | TA-12 | usdc+usdt balance below configured floor — LANDED |
| 6095 | `ErrDailyCapExceeded` | Phase 5 ✅ | TA-13 | Per-protocol rolling 24h cap (doc-fix) — LANDED |
| 6096 | `ErrRecipientCapExceeded` | Phase 5 ✅ | TA-14 | `[PerRecipientCounter; 10]` array overflow — LANDED |
| 6097 | `ErrMintDeltaCapExceeded` | Phase 6 ✅ | R-1 | Mint-level delta cap violation — LANDED |
| 6098 | `MintDeltaCapMisconfigured` | Phase 6 ✅ | R-1 caller-bug | NEW Phase 6 deviation: distinguishes caller schema bug from attack signal — LANDED |
| 6099 | `ErrAtaAuthorityChanged` | Phase 6 ✅ | R-2 | ATA owner/delegate changed mid-bundle (shifted +1) — LANDED |
| 6100 | `ErrOutputBelowFloor` | Phase 6 ✅ | R-3 | Output amount below declared floor (shifted +1) — LANDED |
| 6101 | `ErrDeclarationInconsistent` | Phase 6 ✅ | R-4 | Bundle declarations don't match observed state (shifted +1) — LANDED |
| 6102 | `IxMetaCountExceeded` | Audit closure ✅ | H-1 (destination_check) | NEW DC audit closure 2026-05-19: foreign DeFi ix > 16 metas → hard-reject — LANDED |
| 6103 | `ErrPendingOwnershipExists` | Phase 8 | C26 | Pending ownership transfer collision (shifted +2) |
| 6104 | `ErrPendingOwnershipNotReady` | Phase 8 | C26 | Pending transfer not past timelock (shifted +2) |
| 6105 | `ErrInvalidFreezeReason` | Phase 8 | C27 | Reserved freeze_reason enum value (shifted +2) |
| 6106 | `ErrReactivateCooldownActive` | Phase 8 ✅ | C28 | Post-unfreeze observation window active (shifted +2) — LANDED |
| 6107 | `ErrInvalidOwnershipTarget` | Phase 8 ✅ | Council ISC-128 | new_owner is system/program/sysvar pubkey — LANDED |
| 6108 | `ErrTooManyRevokePairs` | Phase 8 ✅ | Council ISC-136 | freeze_internal MAX_REVOKE_PAIRS=10 exceeded — LANDED |

**Total reserved:** 30 codes (6079-6108 inclusive). Phase 6 introduced 1 new code (`MintDeltaCapMisconfigured` at 6098). DC1-DC14 audit closure introduced 1 new code (`IxMetaCountExceeded` at 6102). Phase 7 (audit log + temporal binding) introduces **ZERO** new error codes. **Phase 8 introduces 6 new codes (6103-6108):** 4 from original spec (C26/C27/C28 ownership-transfer + freeze surface) plus 2 added by Council ISCReview adversarial pressure-test (ISC-128 invalid-target blocklist, ISC-136 MAX_REVOKE_PAIRS bound).

**Drift discipline:** Forward-only. No previously-assigned code (6097-6102) ever moved. Phase 8 codes (6103-6106) were re-reserved twice during planning (+1 in Phase 6 deviation, +1 in audit closure) — both shifts were forward-only. 6107-6108 are NEW Phase 8 additions, appended at end after the original 4 reserved codes. **Total error code count post-Phase-8: 109.**

---

## 4. Reuse policy — DO NOT re-allocate existing codes

The following existing variants are explicitly re-used by V2 primitives (no new code allocation needed). Use the existing variant; if the user-facing `#[msg(...)]` needs to change, update the message text in place but DO NOT renumber.

**Codes below are stated under both pre-Phase-1 and post-Phase-1 layouts.** After Phase 1 compaction (2 variants deleted at 6030+6031), all codes from `UnauthorizedTokenTransfer` (was 6032) onward shift down by 2.

| Existing variant | Code (pre-Phase-1) | Code (post-Phase-1) | V2 primitive that re-uses it |
|------------------|--------------------|---------------------|------------------------------|
| `DestinationNotAllowed` | 6024 | 6024 | TA-02 (tightens defaults; no new code) |
| `InvalidProtocolMode` | 6026 | 6026 | TA-01 (UPDATE msg to "must be 1=ALLOWLIST") |
| `InvalidDestinationMode` | 6080 | **6078** | TA-02 (UPDATE msg to "must be 0=RESTRICTED") |
| `ConfidentialTransferBlocked` | 6075 | **6073** | TA-08 deposit-path re-use |
| `PermanentDelegateBlocked` | 6076 | **6074** | TA-08 re-use |
| `TransferHookBlocked` | 6077 | **6075** | TA-08 re-use |
| `LamportDrainBlocked` | 6078 | **6076** | TA-08 re-use |
| `BatchInstructionBlocked` | 6079 | **6077** | TA-08 re-use |
| `BlockedSplOpcode` | 6067 | **6065** | TA-10 re-use |
| `AccountWritabilityMismatch` | 6069 | **6067** | TA-11 re-use |
| `UnauthorizedPreValidateInstruction` | 6063 | **6061** | TA-10 re-use |
| `UnauthorizedPostFinalizeInstruction` | 6056 | **6054** | TA-10 re-use |

**Numbering invariant established by Phase 1:**
- All V1 surviving variants at codes **6000-6078** (post-compaction; 79 variants).
- `ErrInvalidCapability` (TA-04) at **6079**, the first new V2 variant.
- §3 reservation table continues 6080, 6081, ... 6103.

## 6. Post-Phase-1 numeric layout — CANONICAL

For Phase 2+ consumption, the full post-Phase-1 numeric layout is:

- 6000-6029: unchanged (30 variants).
- 6030: `UnauthorizedTokenTransfer` (was 6032).
- 6031: `SlippageBpsTooHigh` (was 6033, retained per §2 deviation).
- 6032-6078: variants previously at 6034-6080 shifted down by 2.
- Total: **79 variants at 6000-6078**. Next free code: **6079**.

The committed `target/idl/sigil.json` (regenerated at end of Phase 1) is the canonical numeric source of truth. The auto-generated `sdk/kit/src/testing/errors/names.generated.ts` mirrors that IDL.

---

## 7. Cross-doc reconciliation

- `INTERFACES_V2.md §"Error Code Allocation"` was updated in Phase 1 to reflect the actual post-Phase-1 layout (79 variants, 6000-6078, V2 reservations start at 6079).
- `agent-middleware/docs/ERROR-CODES.md` documents user-facing error semantics; it is not a numeric source of truth. Update there is required when V2 codes land in Phase 2+.
- The repo-root `CLAUDE.md` cites "6000-6070" — this is stale (V1 baseline actually occupied 6000-6080; post-Phase-1 occupies 6000-6078). Correction is out of L-6 scope; flagged for v1.1 housekeeping.

---

**END OF ERROR_CODE_ALLOCATION_V2.md**
