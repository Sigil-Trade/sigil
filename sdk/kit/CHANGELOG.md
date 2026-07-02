# @usesigil/kit

## 0.24.1

### Patch Changes

- [#422](https://github.com/Sigil-Trade/sigil/pull/422) [`8f435ef`](https://github.com/Sigil-Trade/sigil/commit/8f435ef2a5adfaf9ceb33526d98d455515c26ed5) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Regenerate codama output so the generated `PolicyConfig` JSDoc reflects the corrected `ErrReactivateCosignRequiredForFullCapability` (6104) citation (was a stale 6114 in the source comment that flowed through the IDL). Generated-code/doc only.

- [#418](https://github.com/Sigil-Trade/sigil/pull/418) [`9ecbeb2`](https://github.com/Sigil-Trade/sigil/commit/9ecbeb286493e1b27b7456923ad639ff2553b840) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Fix `previewCreateVault` understating rent: `POLICY_CONFIG_SIZE` was 1329 but the on-chain `PolicyConfig::SIZE` is 1649 (the verified-build `protocol_hashes` array added 320 bytes). The cost/rent shown to a human before signing the vault-creation tx was understated by ~0.0022 SOL. The size regression test is now a cross-language guard that parses the Rust `assert!(<Type>::SIZE == N)` pins for all four preview PDAs, so it can't silently drift again.

- [#420](https://github.com/Sigil-Trade/sigil/pull/420) [`6402b94`](https://github.com/Sigil-Trade/sigil/commit/6402b94b95089641d12ed6c98a6bf4258cd100a8) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Document Sigil's honest security guarantee + boundary on `seal()`: it ENFORCES no-theft (output stays vault-owned), spend caps, allowlist, and the verified-build gate — but is value-blind (an agent can waste value within caps) and cannot generically verify ongoing custody of venue positions (perps/lending/LP). Surfacing this prevents over-implying value-conservation to users and agents (M3 of the foundation review).

## 0.24.0

### Minor Changes

- [#412](https://github.com/Sigil-Trade/sigil/pull/412) [`2722dbc`](https://github.com/Sigil-Trade/sigil/commit/2722dbc6dfbd1fb54147b15c3fed7baf35299384) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Production protocol-sync upgrade.

  New:
  - `computeVerifiedBuildHash(rpc, programId)` — hash-only helper an owner uses to
    arm the verified-build gate.
  - `PolicyChanges.protocolHashes?: ReadonlyMap<Address, Uint8Array | "disarm">` —
    arms/disarms `PolicyConfig.protocol_hashes` through the shared
    `buildPolicyUpdateIx` merge path (seed-from-live whole-array replace; the same
    array feeds both the ix and the TA-19 digest, so the owner's signed digest
    matches on-chain byte-for-byte). Rejects combining `protocolHashes` with
    `approvedApps` in one update, and routes a cosign-required disarm to the
    elevated path.
  - `approvePendingPolicy` / `buildApprovePendingPolicy` (+ `OwnerClient`
    methods) — completes the 2-of-2 cosign flow; the build variant surfaces the
    decoded pending policy for cosigner review.
  - `promoteGraylistDestination` / `recordAgentViolation` (+ `OwnerClient`
    methods) — owner-signed graylist promotion and agent-violation recording.

  Fixed:
  - `findVaultsByOwner` decoded `vault_authority` at a fixed offset (644), which
    only held for a full-10-agent vault. Sub-10-agent vaults serialize the
    `agents` Borsh Vec shorter, so the field sat earlier and the fixed read
    returned zero-padding — silently dropping ownership-transfer-received vaults
    on real RPCs. Now decoded via the generated Borsh decoder.

  Also in this release: the `agent_transfer` wrapper (`SigilClient.transfer` /
  `buildAgentTransfer` + SAK wiring) already landed on this branch.

## 0.23.0

### Minor Changes

- [#402](https://github.com/Sigil-Trade/sigil/pull/402) [`1fea858`](https://github.com/Sigil-Trade/sigil/commit/1fea858a3218a0325e813367a0648dda37be7335) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix(C-1): relocate fee collection to finalize (security)

  `seal()` now attaches the protocol-treasury and developer fee-destination token
  accounts to the `finalize_session` instruction instead of `validate_and_authorize`,
  matching the on-chain C-1 fix. Fees are collected at finalize on the MEASURED
  spend (inside the spend caps), not upfront on the agent-declared amount. This
  closes a tier-1 fee-cap-bypass drain where a compromised agent could declare a
  huge amount so the upfront fee (a percentage of the declared amount) drained
  ≈100% of the vault to the protocol treasury in a single transaction while every
  spend cap saw only a dust spend.

  Consumer impact: the composed-transaction account layout changed — the two fee
  token accounts moved from the validate instruction to the finalize instruction.
  Callers using `seal()` need no changes (handled internally). Callers building the
  `validate_and_authorize` / `finalize_session` instructions manually via the
  generated builders must move `protocolTreasuryTokenAccount` and
  `feeDestinationTokenAccount` to the finalize instruction.

## 0.22.0

### Minor Changes

- [#396](https://github.com/Sigil-Trade/sigil/pull/396) [`b281088`](https://github.com/Sigil-Trade/sigil/commit/b281088c48cb137169b908d7059e95f2ddb0caae) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - feed surfaces policy-blocked attempts reconstructed from failed-tx logs

  `getVaultActivity` now reconstructs a single "blocked" activity item from a
  failed transaction whose program logs carry a Sigil policy-block error code.
  A Sigil block does `return Err` → the whole tx reverts → no event is emitted,
  so the attempt previously never reached the activity feed. The new failed-tx
  branch parses the Sigil error code from the runtime `Program <id> failed:` line
  (top-level invoke depth only), maps it to its error name via the generated IDL
  error map, and recovers agent/protocol/amount by decoding the
  `validate_and_authorize` instruction. `buildActivityRows` already renders a
  `success:false` item as a `blocked` row. Reconstructed fields are null when they
  cannot be verified (the agent is kept only when it is the sole tx signer, to
  avoid impersonation); no extra RPC is issued (the already-fetched tx is reused).

  Only **agent policy-block** error categories surface as blocked attempts
  (`SPENDING_CAP`, `POLICY_VIOLATION`, `PROTOCOL_NOT_SUPPORTED`, `RATE_LIMIT`,
  `ESCALATION_REQUIRED`). Owner-auth (`PERMISSION`, e.g. `UnauthorizedOwner`),
  internal (`FATAL`), config (`INPUT_VALIDATION`), transient, and resource errors
  are excluded, so a failed owner transaction never appears as a "blocked attempt".

## 0.21.0

### Minor Changes

- [#385](https://github.com/Sigil-Trade/sigil/pull/385) [`0f33ebd`](https://github.com/Sigil-Trade/sigil/commit/0f33ebdb26a8f75323192d297e346a7a54ab3e4b) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Add `getProgramDataHash(rpc, programId)` — computes the SHA-256 of a deployed program's executable ELF from its BPFLoaderUpgradeable `ProgramData` account. This is the value an owner pins into `PolicyConfig.protocol_hashes` for the upcoming verified-build gate (Item 3), so authorization can reject a target protocol whose on-chain build no longer matches the audited one. Also exports `getProgramDataAddress`, `BPF_LOADER_UPGRADEABLE_PROGRAM_ID`, and `PROGRAM_DATA_HEADER_LEN`. Mirrors the on-chain hash offset (the 45-byte `ProgramData` header) byte-for-byte so a hash pinned via this helper matches the on-chain recomputation.

### Patch Changes

- [#379](https://github.com/Sigil-Trade/sigil/pull/379) [`509c71a`](https://github.com/Sigil-Trade/sigil/commit/509c71a335381413212703e1d58636c0c4406881) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Add agent-error mappings for on-chain errors 6113 (`ErrFinalizeMetaUnresolvable`) and 6114 (`ErrDeFiInstructionNotAdjacentToFinalize`) — the F-Q1b finalize-side completeness check plus the DeFi↔finalize adjacency invariant. These close a value-attribution leak where a writable DeFi account meta could be omitted from `finalize_session` (or the counted DeFi instruction displaced from immediately before finalize) to dodge the per-recipient cap, output-ownership, and stable-floor walks.

- [#381](https://github.com/Sigil-Trade/sigil/pull/381) [`97de831`](https://github.com/Sigil-Trade/sigil/commit/97de831b15d84356ebd490ca9d3167919dd507c4) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Add agent-error mapping for on-chain error 6115 (`ErrUnmeasurableSpend`) — the require-measurable-outcome invariant. A spending session that produces no measurable in-transaction vault outcome (no stablecoin movement out of the vault and no vault-owned acquisition increase) is now rejected, closing the async/CPI/data-mode cap-accounting bypass where a deferred-settlement action would otherwise slip through at dust-fee cost without binding the spending caps.

## 0.20.0

### Minor Changes

- [#367](https://github.com/Sigil-Trade/sigil/pull/367) [`f32e527`](https://github.com/Sigil-Trade/sigil/commit/f32e527ea781c95dc1c33ddf1913622ec82ec041) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - seal(): `outputSwapMint` satisfier for the M1 output-ownership gate (on-chain error 6112)

  The on-chain M1 closure makes `finalize_session` MANDATE that a stablecoin-input acquiring swap land its output in a vault-owned account that strictly increases. `seal()` now accepts an `outputSwapMint` (the mint being acquired): it derives and pins the vault's canonical ATA on `validate_and_authorize` + `finalize_session` and rewrites the DeFi swap's output destination to that vault account.

  **Breaking (behavioral):** a stablecoin-input acquiring swap that omits `outputSwapMint` now throws `SIGIL_ERROR__SDK__INVALID_PARAMS` (fail-loud) — Sigil never infers what the agent is buying. Declare the acquired mint to migrate. Non-stablecoin-input swaps and transfers are unaffected. Also adds the 6112 error mapping and bumps the recognized on-chain error range to 6112.

## 0.19.0

### Minor Changes

- [#352](https://github.com/Sigil-Trade/sigil/pull/352) [`3738b41`](https://github.com/Sigil-Trade/sigil/commit/3738b41d92f08a4fa9fa4729f6926aa95cec74f1) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Cosign 2-of-2 hardening — SDK lockstep with the on-chain program:
  - Add six partial-sign elevated owner-op builders for vaults with `cosign_required`: `buildCancelAgentGrantElevated`, `buildCancelAgentPermissionsElevated`, `buildCancelPendingPolicyElevated`, `buildApplyAgentPermissionsElevated`, `buildApplyPendingPolicyElevated`, and `buildCloseVaultElevated` (plus the matching `OwnerClient` methods). Each returns a `CosignedActionBundle` — the owner-partial-signed wire transaction with the bound cosigner appended as a required signer, for a genuine 2-of-2 co-sign — and rejects a cosigner equal to the owner.
  - Export the `CosignedActionBundle` type.
  - Correct `ErrCosignRequired` to error code **6080** (was mislabeled 6089, which is `MintDeltaCapMisconfigured`) across the cosign helper, the cosign-digest module, and the error map.
  - Regenerate the codama client against the hardened program: adds `cancelAgentPermissionsUpdate`, and `agentTransfer` now carries the auto-resolved `audit_log_success` PDA + slot_hashes sysvar.

  Note: on a cosign-required vault the program now rejects these owner-ops unless the bound cosigner co-signs — callers must use the `*Elevated` builders for those vaults.

## 0.18.0

### Minor Changes

- [#343](https://github.com/Sigil-Trade/sigil/pull/343) [`969c38b`](https://github.com/Sigil-Trade/sigil/commit/969c38bcb1e530a99b3b055f006d8a89516ccdc6) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Elevated-cosign SDK surface + TA-19 policy-preview digest fixes (security audit 2026-06-11/12).

  New — elevated-cosign productization (for `cosign_required` vaults, where raising an agent's capability/limit or making an elevated policy change requires a cosigner):
  - `OwnerClient.queueAgentPermissionsElevated` / `queuePolicyElevated` — single-builder dual-sign: pass the cosigner as a `TransactionSigner`; the tx is signed by `[owner, cosigner]` and sent.
  - `OwnerClient.buildQueueAgentPermissionsElevated` / `buildQueuePolicyElevated` — partial-sign handoff: returns an `ElevatedCosignBundle` `{ partialTransactionBase64, cosignSession, cosignDigest }` (owner-signed; the cosigner completes + sends out-of-band — true 2-of-2).
  - `computeAgentPermsCosignDigest` (+ `AgentPermsCosignDigestFields`) — mirrors the on-chain agent-perms cosign digest byte-for-byte (cross-impl pinned).
  - `PolicyChanges` gains `stableBalanceFloor`, `perRecipientDailyCapUsd`, `cosignRequired`, `cosignSessionPubkey`, `operatorGrantDelaySeconds`. These are settable on either the non-elevated (`queuePolicyUpdate`) or elevated (`queuePolicyElevated`) path — elevation is direction-dependent (raising a cap is elevated, lowering isn't), not a per-field property; see the `PolicyChanges` docs for routing.

  Fixes:
  - The TA-19 policy-preview digest now binds the per-protocol spend caps (`has_protocol_caps` + `protocol_caps`, canonical positions 23-24), so a tampered SDK or pending-PDA mutation cannot alter caps without diverging the owner-signed preview.
  - The dashboard sibling-handler and `queuePolicyUpdate` digests no longer omit `agent_set_hash` / `operator_grant_delay_seconds` / `cosign_session_pubkey`. They previously defaulted those fields, producing a `PolicyPreviewMismatch` (on-chain) on any vault with one or more registered agents — i.e. every real vault — making `createPostAssertions`, `closePostAssertions`, and `queuePolicyUpdate` unusable via the dashboard.
  - Added cross-impl pins (byte-identical Rust ↔ TypeScript) for the populated `agent_set_hash`, populated `protocol_caps`, and agent-perms cosign digests.

## 0.17.0

### Minor Changes

- [#327](https://github.com/Sigil-Trade/sigil/pull/327) [`46a2f26`](https://github.com/Sigil-Trade/sigil/commit/46a2f265dde096872751b5314a99156814b3beca) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Lane A — FE↔BE contract v2.2 commitments C2 + C5.

  > NOTE 2026-05-20 (Phase 9 Batch A): The C6 (Protocol registry + tier
  > resolver primitives) portion of this changeset has been removed.
  > `PROTOCOL_ANNOTATIONS`, `VERIFIED_PROGRAMS`, `lookupProtocolAnnotation`,
  > `resolveProtocolTier`, and the associated trust-tier types
  > (`ProtocolAnnotation`, `ProtocolTrustTier`, `ConstrainabilityResult`,
  > `CheckConstrainabilityFn`, `NonConstrainableReason`, `IdlSource`) were
  > deleted per the L-1 generic constitution as part of the Phase 9 SDK
  > redesign. A separate Phase 9 changeset will narrate the removal.

  ### C2 — DxError.onChainReverted + categorizeDxError
  - `DxError` gains a required `onChainReverted: boolean` field. Always
    populated by `toDxError()`; set true when the resolved code falls in
    the Anchor on-chain range [6000, 6074]. FE renders specific
    "vault's rules prevented this" messaging when true, generic error
    otherwise.
  - `categorizeDxError(e): DxErrorCategory` — helper mapping code to one
    of four stable strings: `"program" | "user" | "network" | "unknown"`.
    Named `categorizeDxError` (not `categorizeError`) to avoid collision
    with the pre-existing `categorizeError(AgentError): SigilErrorCategory`
    at `src/agent-errors.ts`.
  - `isOnChainReverted(code): boolean` — public helper for the specific
    6000-range check.
  - `DX_ERROR_CODE_UNMAPPED` now re-exported from `@usesigil/kit/dashboard`.
  - `PostAssertionValidationError` + `FlashTradeLeverageOutOfRangeError`
    classes gained `onChainReverted: false` (they're client-side
    validation errors, thrown before any RPC round-trip).

  ### C5 — composeAgentBootstrap + getHandoffPromptTemplate
  - `composeAgentBootstrap(config): AgentBootstrap` — fills the canonical
    handoff-prompt template with vault-specific data. Returns
    `{ agentWallet, vaultPubkey, onboardingPrompt, capabilities }`.
    Deterministic: same input → byte-identical output.
  - `getHandoffPromptTemplate(): string` — returns the raw template with
    `${placeholder}` slots. For callers doing their own substitution.
  - `capabilityTierToNames(tier): readonly string[]` — maps the 0/1/2
    capability tier to friendly names. Exported from what was previously
    an unexported internal constant in `advanced-analytics.ts`.
  - `AgentBootstrap` + `AgentBootstrapConfig` types.

  Template is prompt-injection safe — single-pass regex substitution
  blocks both `$&`-style back-reference attacks AND `${placeholder}`
  nested-value attacks. Validated with adversarial tests.

  ### Breaking
  - **`engines.node`** bumped from `>=18.0.0` to `>=20.10.0`. Node 18 is
    EOL upstream (April 2025) and several modern Solana ecosystem deps
    (codama, @solana/kit consumers) require Node 20+.
  - **`DxError.onChainReverted`** is a new required field. All internal
    kit callers route through `toDxError()` which sets it; external
    consumers constructing `DxError` literals (none found in audit) must
    add the field. Two sibling classes (`PostAssertionValidationError`,
    `FlashTradeLeverageOutOfRangeError`) updated in this release.
  - **`ConstrainabilityResult`** is now a discriminated union on
    `constrainable`. Consumers constructing results must provide
    `idlSource` when `constrainable: true` and `reason` when
    `constrainable: false`. Compile-time enforcement of the iff-invariant
    the prose docstring previously described.

  ### Test coverage

  57 new tests in `sdk/kit/tests/`:
  - `dashboard/errors-categorize.test.ts` (32) — DxError range boundaries
  - `agent-bootstrap.test.ts` (25) — template determinism + substitution +
    injection resistance + input validation

  (Originally the C6 protocol-registry + protocol-tier suites added another
  22 tests; those were removed in Phase 9 Batch A along with the modules.)

  Counts manifest + CI updated.

- [#327](https://github.com/Sigil-Trade/sigil/pull/327) [`46a2f26`](https://github.com/Sigil-Trade/sigil/commit/46a2f265dde096872751b5314a99156814b3beca) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Phase 7 (audit log + N1 temporal binding) + §RP-2 breaking rename:

  **Breaking (rename, code unchanged):**
  - `SigilError::ConstraintsVaultMismatch` (code 6064) → `ZeroCopyVaultMismatch`.
    Generic message "Zero-copy account vault key mismatch (defense-in-depth)"
    now applies to BOTH `InstructionConstraints` zero-copy paths AND the
    new `AuditLogSuccess`/`AuditLogRejected` zero-copy paths. Error code
    number unchanged at 6064; only the variant name + message text changed.
    Affects: `sdk/kit/src/agent-errors.ts`,
    `sdk/kit/src/generated/errors/sigil.ts`,
    `sdk/kit/src/testing/errors/names.generated.ts`. If consumers imported
    the symbol by name, rename to `ZeroCopyVaultMismatch`.

  **Breaking (field rename):**
  - `AuditEntry.target_protocol` → `AuditEntry.subject` (32-byte raw pubkey).
    The field is semantically polymorphic per discriminator (mint for
    deposit/withdraw, vault for freeze/reactivate/policy/constraints, agent
    for pause/unpause/revoke/register, protocol for finalize). Codama
    regenerated the SDK type; consumers must read `entry.subject` instead of
    `entry.targetProtocol`. A deprecated `targetProtocolBytes()` helper is
    retained for one release; `subjectBytes()` is the canonical accessor.

  **Additive (new APIs):**
  - `fetchAuditLogSuccess(rpc, vault)`, `fetchAuditLogRejected(rpc, vault)`
  - `subjectBytes(entry)` — canonical accessor for the renamed field
  - `AUDIT_DISC_*` constants (0..=16) — discriminator labels
  - `AUDIT_DISC_FINALIZE_REJECT = 16` — NEW, for expired-finalize cranks
    on the REJECT path (was incorrectly reusing disc=1 in Phase 7 initial
    ship; fixed §RP-1 HIGH-1).

  **Operational:**
  - `prepublishOnly` build hook added to sdk/kit/package.json (and sibling
    sdk/platform, sdk/agent, packages/plugins) to prevent stale dist on
    next publish. Caught by §RP-2 CRIT-2 in the prior audit closure cycle
    for sdk/custody and now generalized.

- [#327](https://github.com/Sigil-Trade/sigil/pull/327) [`46a2f26`](https://github.com/Sigil-Trade/sigil/commit/46a2f265dde096872751b5314a99156814b3beca) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Phase 9 SDK redesign — bring the SDK fully in sync with the on-chain
  layer (V2 Phases 1-8), delete the tier classifier, ship the Phase 8
  ownership/freeze/observe-only helpers, and stage the canonical-encoder
  shared utility that AL3/AL4/AL2 envelope intent-binding will consume
  in 0.16.1.

  See `CHANGELOG.md` for the full surface diff and `MIGRATION.md` for
  breaking-change recipes (notably the upcoming
  `requireMainnetConfirmation` default flip in v1.0).

- [#327](https://github.com/Sigil-Trade/sigil/pull/327) [`46a2f26`](https://github.com/Sigil-Trade/sigil/commit/46a2f265dde096872751b5314a99156814b3beca) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - refactor(sigil): delete `SessionAuthority.is_spending` field (Option A V2)

  The `is_spending: bool` field on `SessionAuthority` was redundant —
  it was always set to `authorized_amount > 0` at validate time. All
  consumers now derive directly from `authorized_amount`. The
  `ActionAuthorized` and `SessionFinalized` events lose the same field;
  off-chain consumers should check `amount > 0` instead.

  This is a breaking event/account change. Shipped under the V2 program
  ID at Stage 6 (no in-place upgrade of devnet `7FtAXUcr...`).

  The SDK `isSpendingAction()` and `ACTION_TYPE_NAMES_BY_INDEX` helpers
  were also deleted — they were marked zombie code for legacy indexer
  compatibility, and Option A removes zombie code.

### Patch Changes

- [#337](https://github.com/Sigil-Trade/sigil/pull/337) [`09906b0`](https://github.com/Sigil-Trade/sigil/commit/09906b0a9a96e74c9827647e8f7e6c74fdf49374) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Fix `createVault` to default to a V2-valid policy and fail fast on inert configs:
  - `protocolMode` now defaults to `1` (ALLOWLIST) instead of `0`. Phase 2
    Option A deleted the permissive ALL (0) / DENYLIST modes; the on-chain
    `initialize_vault` handler hard-rejects any `protocol_mode != 1`. The old
    default of `0` built an initialize instruction the deployed program reverts
    on, so any caller that didn't pass an explicit `protocolMode` produced an
    un-landable transaction.
  - `createVault` now throws `INVALID_PARAMS` up front when an active
    (non-`observeOnly`) vault is given no protocols AND no destinations on its
    allowlist. The on-chain program rejects that as inert
    (`ActiveVaultRequiresAllowlist`, 6073); failing fast in the SDK surfaces an
    actionable message before the owner signs. `observeOnly` vaults (explicitly
    inert) are exempt. `previewCreateVault` surfaces this via its existing
    throw-propagation path.

- [#334](https://github.com/Sigil-Trade/sigil/pull/334) [`b59818b`](https://github.com/Sigil-Trade/sigil/commit/b59818b0918358d8368b128a92e508302a7abf20) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix(kit): make `findVaultsByOwner` resilient when an RPC restricts `getProgramAccounts`

  A devnet / public RPC that excludes a high-account-count program from its
  secondary index can silently return `[]` from `getProgramAccounts` (Strategy
  A) instead of erroring. Previously `findVaultsByOwner` returned that `[]`
  verbatim, so `discoverVaults` reported "no vaults" for an owner that actually
  has them — a silent under-reporting bug that surfaced as a flaky devnet CI
  failure (`dashboard-integration › finds vaults` got length 0 despite ~30
  vaults existing for the wallet at ids ≥ 1,000,000).

  `findVaultsByOwner` now runs the Strategy B PDA-probing safety-net whenever
  Strategy A yields **zero** verified vaults (not only when it throws a
  gpa-unsupported error). Probing is PDA-authoritative — every returned address
  is re-derived client-side from `(owner, vaultId)`, so it can only ADD real
  low-id vaults the restricted gPA hid; it never fabricates a vault and returns
  `[]` for a genuinely vault-less owner. Rate-limit (429) and network errors
  still propagate unchanged.

  Also adds an optional `vaultId` to the `provisionVault` devnet test helper so
  callers can provision a vault at a deterministic id (used by the
  dashboard-integration test to pin a low-id vault that PDA probing reliably
  discovers regardless of the RPC's gPA support).

- [#335](https://github.com/Sigil-Trade/sigil/pull/335) [`e681e12`](https://github.com/Sigil-Trade/sigil/commit/e681e12f481842d942471ef4c5fb475532775068) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Fix transaction signing for partial signers, and enable operator-grant test provisioning:
  - `signAndEncode` now correctly signs a compiled transaction with a
    `TransactionPartialSigner` (e.g. a `@solana/kit` KeyPairSigner). It previously
    assumed the signer returned a signed transaction, but a partial signer returns
    a `SignatureDictionary` (a signature map with no `messageBytes`), so
    `getBase64EncodedWireTransaction` threw `TypeError: Cannot read properties of
undefined (reading 'length')` — breaking `executeTransaction` and any
    programmatic `seal()` / `createVault` caller that passes a bare keypair. It now
    delegates to `signTransactionWithSigners`, the canonical Kit primitive that
    handles both partial and modifying signers and asserts full-signedness. Error
    codes (`SIGNER_INVALID` / `SIGNATURE_INVALID`) are preserved.
  - `provisionVault` (testing helper) now seats OPERATOR-capability agents through
    the on-chain queue → timelock → apply path. V2 rejects an instant OPERATOR
    grant on a single-key vault with `ErrOperatorGrantRequiresTimelock` (6107), so
    the helper queues the grant, waits out the on-chain delay against the cluster
    clock, then applies it (observer/disabled grants stay instant). It also
    tolerates transient public-devnet RPC 429s on its reads (test-only retry).

- [#327](https://github.com/Sigil-Trade/sigil/pull/327) [`46a2f26`](https://github.com/Sigil-Trade/sigil/commit/46a2f265dde096872751b5314a99156814b3beca) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Fix devnet test-helper + RPC error reporting against the V2 program:
  - `sendAndConfirmTransaction` no longer masks on-chain errors that carry BigInt
    fields. A failed transaction whose `status.err` contained a u64 (e.g. an
    instruction index) previously threw `TypeError: Do not know how to serialize a
BigInt` from the error path itself, hiding the real `Custom` program code.
  - `sendAndConfirmTransaction` / `sendKitTransaction` accept a `skipPreflight`
    option. Slot-bound transactions (e.g. `initialize_vault`'s PEN-CROSS-2 preview
    digest, which binds the execution slot) cannot be preflight-simulated: the sim
    runs at the current slot and rejects the future-slot digest with
    `PolicyPreviewMismatch` before the tx can land.
  - `provisionVault` (testing helper) now works against the live program: it
    retries the slot-bind (`PolicyPreviewMismatch` 6071) with `skipPreflight`, and
    accepts a `protocols` allowlist so callers can create a non-inert ACTIVE vault
    that passes the F-11 init guard (6073) and the M-9 reactivate guard
    (`ActiveVaultRequiresAllowlist`).

- [#327](https://github.com/Sigil-Trade/sigil/pull/327) [`46a2f26`](https://github.com/Sigil-Trade/sigil/commit/46a2f265dde096872751b5314a99156814b3beca) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix(kit): seal() resolves vault-owned Token-2022 output mints (F-Q4 honest path)

  `seal()` now auto-resolves the mints of vault-owned Token-2022 token accounts the
  sandwiched DeFi instruction writes and feeds them into `validate_and_authorize`'s
  `remaining_accounts`. Previously a legitimate swap delivering a Token-2022 token
  into a pre-existing vault ATA reverted on-chain with
  `ErrToken2022OutputMintUnresolvable` (6106) because the on-chain F-Q4 gate could
  not resolve the mint to vet its extensions. The honest path now succeeds while the
  on-chain gate remains the sole, non-omittable enforcer (a PermanentDelegate /
  TransferHook / ConfidentialTransfer mint is still rejected on-chain).
  - New exported pure helper `resolveT22OutputMintMetas()` mirrors the on-chain
    demand exactly (Token-2022-owned + account length >= 72 + token-account
    authority == vault) and appends each distinct mint as a READONLY meta to
    `validate` only (`finalize_session` does not run the gate).
  - A batched `getMultipleAccounts` fetch runs only when the Token-2022 program
    appears in the bundle — classic-SPL swaps are unaffected (no extra round-trip).
    The fetch fails closed with a contextual error on RPC failure.
  - Completes the SDK propagation of error 6106 (the hand-maintained
    `ON_CHAIN_ERROR_MAP`, `SIGIL_ON_CHAIN_ERROR_MAX`, and the Codama
    `generated/errors/sigil.ts` now all carry `ErrToken2022OutputMintUnresolvable`).

- [#327](https://github.com/Sigil-Trade/sigil/pull/327) [`46a2f26`](https://github.com/Sigil-Trade/sigil/commit/46a2f265dde096872751b5314a99156814b3beca) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix(kit): add error 6106 (ErrToken2022OutputMintUnresolvable) to the error maps

  The on-chain program gained error 6106 for the F-Q4 Token-2022 swap-path
  extension gate — a vault-owned Token-2022 output ATA whose mint is absent from
  `remaining_accounts` (or is not Token-2022-owned) fails closed so its mint
  extensions can be vetted. Regenerated the kit error projections
  (`agent-errors.generated.ts`, `names.generated.ts`) so SDK error
  decoding/classification recognizes 6106. Additive, non-breaking.

  Note: the SDK `seal()` output-mint satisfier (which feeds the vault-owned
  Token-2022 output mints into `remaining_accounts` on the honest path) is a
  separate follow-on change; the on-chain gate is fail-closed-safe without it.

- [#327](https://github.com/Sigil-Trade/sigil/pull/327) [`46a2f26`](https://github.com/Sigil-Trade/sigil/commit/46a2f265dde096872751b5314a99156814b3beca) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix(kit): regenerate the SessionAuthority codec for the F-Q8 output-stablecoin-ATA pin

  The on-chain `SessionAuthority` account gained an appended
  `output_stablecoin_account: Pubkey` field (F-Q8: `finalize_session` now pins
  the measured stablecoin ATA by pubkey, blocking substitution of a different
  vault-owned stablecoin ATA on the non-stablecoin-input spend path). SIZE grew
  515 → 547.

  Regenerated `sdk/kit/src/generated/accounts/sessionAuthority.ts` via Codama so
  the kit codec matches the program:
  - `getSessionAuthoritySize()` now returns `547` (was `515`).
  - The decoder/encoder include the new `outputStablecoinAccount: Address` field.

  This fixes a latent session-discovery break: `findSessionsByVault()`
  (`state-resolver.ts`) filters `getProgramAccounts` on `{ dataSize:
getSessionAuthoritySize() }`. Against the upgraded program (547-byte sessions),
  the stale 515-byte filter would have matched zero accounts, silently returning
  no sessions. Additive, non-breaking for consumers (new field on decoded
  SessionAuthority objects).

## 0.16.0

### Phase 9 SDK redesign — engineering notes

Phase 9 of the Sigil V2 program brings the SDK fully in sync with the
on-chain layer (Phases 1-8) and stages the AL3/AL4/AL2 envelope
intent-binding pattern. This is a deprecation-staging release for the
`requireMainnetConfirmation` default flip planned for v1.0; nothing
breaks for existing mainnet integrations in 0.16.x.

### Breaking changes

- **Tier-classifier deletion** — `protocol-tier.ts`, `protocol-registry/`
  and their 6 named exports (`resolveProtocolTier`,
  `PROTOCOL_ANNOTATIONS`, `VERIFIED_PROGRAMS`, `lookupProtocolAnnotation`,
  `ProtocolAnnotation`, `ProtocolTrustTier`) are removed per the L-1
  universal-`seal()` constitution. See `MIGRATION.md` for the
  recipe. The `ProtocolTier` enum on `protocol-resolver.ts` (vault
  allowlist tier — KNOWN / DEFAULT / NOT_ALLOWED) is a different concept
  and stays.

### New surface

- `canonical-encode.ts` — shared Borsh-style encoder primitives
  (`base58Decode32`, `writeU8/16Le/32Le/64Le/Bool`, `sha256`,
  `digestsEqual`). TA-19 policy preview digest refactored to consume
  this module; AL3 SealInput intent digest also consumes it.
- `multisig-detection.ts` — `isSquadsV4Owned(rpc, owner)` strict
  detection that verifies BOTH the Squads V4 program ID match AND the
  Anchor account discriminator.
- `session-mint.ts` — `mintSessionForAgent(...)` thin wrapper around
  the generated `register_agent` instruction.
- `policy-attestation.ts` — `getLatestPolicyAttestation(rpc, pda)`
  reads the current PolicyConfig PDA + hoists the `policyVersion`.
- `ownership-transfer.ts` — `buildInitiateOwnershipTransferIx`,
  `buildAcceptOwnershipTransferIx`,
  `buildAcceptOwnershipTransferMultisigIx`,
  `buildCancelOwnershipTransferIx` for Phase 8 owner-rotation
  instructions.
- `OwnerClient` methods: `reactivateVault` (alias for `resumeVault`),
  `setObserveOnly`, `queueAgentGrant`, `applyAgentGrant`,
  `cancelAgentGrant`. Existing `freezeVault` and `resumeVault` retained.

### Errors

- Phase 8 codes 6103-6108 now have full
  `{ category, retryable, recovery_actions[] }` entries in
  `ON_CHAIN_ERROR_MAP`.
- New auto-generated `src/errors/agent-errors.generated.ts` projection
  of the IDL error surface (109 codes).
- New drift gate `tests/error-map-drift.test.ts` ensures IDL ↔
  generated ↔ hand-maintained stay in sync.

### Tooling

- `pnpm codegen:errors` — regenerates `agent-errors.generated.ts` from
  `target/idl/sigil.json`. Wired into `pretest`.
- `pnpm check-surface` — emits a `etc/kit.api.txt` snapshot of every
  named export from every published subpath. `--check` mode for CI
  drift detection. Lightweight alternative to `@microsoft/api-extractor`.
- `tests/pending-constraints-size.invariant.test.ts` — SIZE ratchet
  for PENDING_CONSTRAINTS_SIZE (35_912 bytes) against the on-chain
  handler assertion.

### AL3 + AL4 + AL2 envelope intent-binding (this release)

- **AL3** `computeSealInputDigest()` — per-call SHA-256 over a canonical
  Borsh encoding of (vault, agent, mint, amount, target_protocol,
  network, instructions[]). Surfaced on every `SealResult.intentDigest`.
  Reserves `intent_version: u8 = 1` at canonical position 1 for future
  format evolution. **Client-integrity digest only in 0.16.x** — no
  on-chain verifier yet; the value is for preview-UI binding and
  client-side telemetry/audit logging.
- **AL4** `SealResult.network: SigilCaip2Chain` (CAIP-2 mainnet/devnet
  literal) + `SealResult.isMainnet: boolean` (derived; strict ===
  match on the canonical mainnet-beta chain id).
- **AL2** `SigilClientConfig.requireMainnetConfirmation?: boolean` +
  `ClientSealOpts.mainnetConfirmed?: boolean`. Default `false` in
  0.16.x (back-compat); SDK emits a structured-logger warning on
  mainnet `executeAndConfirm` calls without explicit confirmation.
  **v1.0 will flip the default to `true`** — mainnet calls without
  `mainnetConfirmed: true` will throw
  `SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED` (legacy 7020).

### Deferred to 0.16.1 / v0.17 prep

- `dashboard/reads.ts` V2 schema sync (14 new fields).
- `@deprecated` tagging pass on the 54 root-barrel exports
  enumerated in the Phase 9 dead-export audit.
- On-chain AL3 verifier (post_assertions extension carrying the
  digest input) — until this lands, AL3 is a client-integrity
  primitive, not a chain-enforced one.
- Symmetric AL2 gating on owner-side mutations (`OwnerClient.*`
  methods currently bypass the mainnet confirmation gate — agent-call
  paths only). Decide before v1.0 whether owner paths need separate
  confirmation semantics or should adopt the agent gate.

### Minor Changes

- [#280](https://github.com/Sigil-Trade/sigil/pull/280) [`f320582`](https://github.com/Sigil-Trade/sigil/commit/f320582eba9331c7d5c61ebae502cf42487753bd) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - feat(kit): C1 — `previewCreateVault(config)` typed SDK primitive

  Single SDK call that wraps the existing `buildOwnerTransaction()` +
  `createVault()` primitives and returns everything the dashboard
  split-screen `/onboard` page needs to render rent + cost + PDA list AND
  hand the FE the unsigned transaction in one call.

  Returns `CreateVaultPreview`:
  - `pdaList` — the 4 PDAs `initialize_vault` creates (AgentVault,
    PolicyConfig, SpendTracker, AgentSpendOverlay), each with address,
    bump, sizeBytes mirrored from `<Account>::SIZE`, and rentLamports.
  - `rentLamports` — sum of pdaList rents.
  - `computeUnits` — defaults to `CU_VAULT_CREATION` (400,000).
  - `feeLamports` — `priorityFeeMicroLamports × computeUnits / 1_000_000n`
    via explicit BigInt math (no number/bigint mixing).
  - `totalCostUsd` — `(rentLamports + feeLamports) × solPriceUsd / 1e9n`
    in 6-decimal USD base units; mul-before-divide preserves precision.
  - `vaultAddress` — same as `pdaList[0].address`.
  - `unsignedTxBytes` — wire-encoded versioned transaction; pass to wallet
    adapter for signing.
  - `txSizeBytes` — byte size of the wire tx; ≤ 1232 (Solana hard limit).
  - `lastValidBlockHeight` — FE detects stale blockhash before sign.
  - `warnings?` — soft signals (`daily_cap_zero`, `daily_cap_unusually_high`,
    `no_protocols_approved`, `max_tx_exceeds_daily_cap`); sorted by code
    ascending so React keys stay stable on re-type. Returns `undefined`
    when none fire.

  API takes `Address` (not `TransactionSigner`) for both `owner` and
  `agentAddress` — preview never signs. Internally constructs
  `createNoopSigner` to satisfy `buildOwnerTransaction`.

  `solPriceUsd: bigint` (6-decimal USD per SOL) is REQUIRED — kit has no
  oracle, and a hidden default would silently misrepresent total cost.

  Hard on-chain limits surface as early `RangeError` throws (not warnings):
  `timelockDuration < 1800`, `developerFeeRate > 500`, `protocols.length > 10`,
  `allowedDestinations.length > 10`. Negative bigints throw `RangeError`.
  Bad RPC responses (`getMinimumBalanceForRentExemption` returning 0n /
  non-bigint) throw typed `SigilSdkDomainError`.

  The returned object is `Object.freeze`d; nested arrays are also frozen.
  Two parallel previews share `altCache` + `getBlockhashCache` without
  corruption.

  Closes FE↔BE Contract v2.2 commitment **C1**. Unblocks the dashboard
  split-screen `/onboard` (PR [#38](https://github.com/Sigil-Trade/sigil/issues/38)).

  60 new tests in `sdk/kit/tests/preview-create-vault.test.ts` covering
  public surface, PDA derivation, account sizes, cost math, warning
  rules, input validation, determinism + immutability, tx integrity, and
  RPC failure handling. Total kit suite now 1,673 tests (was 1,613).

- [#278](https://github.com/Sigil-Trade/sigil/pull/278) [`007a504`](https://github.com/Sigil-Trade/sigil/commit/007a504758286f71f3e8c15409e70c97a92de893) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Lane A — FE↔BE contract v2.2 commitments C6 + C2 + C5.

  ### C6 — Protocol registry + tier resolver primitives

  New public surface on `@usesigil/kit`:
  - `PROTOCOL_ANNOTATIONS: readonly ProtocolAnnotation[]` — 7 hand-curated
    Verified-tier protocol annotations (Jupiter, Flash Trade, Jupiter
    Lend/Earn/Borrow, Drift, Kamino). Migrated byte-identical from the
    dashboard's local registry so the dashboard can swap its import in a
    one-line change.
  - `VERIFIED_PROGRAMS: ReadonlySet<string>` — O(1) membership helper
    derived from the annotations at module load.
  - `lookupProtocolAnnotation(programId): ProtocolAnnotation | null` —
    sync registry lookup.
  - `resolveProtocolTier(programId, checkConstrainability): Promise<ProtocolTrustTier>` —
    composed three-tier resolver. Verified programs short-circuit
    synchronously; unknown programs fall through to a caller-injected
    async probe (returns `"unverified"` when constrainable, otherwise
    `"non-constrainable"`).
  - `ProtocolAnnotation`, `ProtocolTrustTier`, `ConstrainabilityResult`
    (discriminated union), `CheckConstrainabilityFn`,
    `NonConstrainableReason`, `IdlSource` types.

  Kit does NOT depend on `@sigil-trade/constraints` — the constrainability
  check is caller-injected. Dashboard / MCP / mobile / CLI each wire
  their own IDL-fetch backend; kit ships the classification logic.

  ### C2 — DxError.onChainReverted + categorizeDxError
  - `DxError` gains a required `onChainReverted: boolean` field. Always
    populated by `toDxError()`; set true when the resolved code falls in
    the Anchor on-chain range [6000, 6074]. FE renders specific
    "vault's rules prevented this" messaging when true, generic error
    otherwise.
  - `categorizeDxError(e): DxErrorCategory` — helper mapping code to one
    of four stable strings: `"program" | "user" | "network" | "unknown"`.
    Named `categorizeDxError` (not `categorizeError`) to avoid collision
    with the pre-existing `categorizeError(AgentError): SigilErrorCategory`
    at `src/agent-errors.ts`.
  - `isOnChainReverted(code): boolean` — public helper for the specific
    6000-range check.
  - `DX_ERROR_CODE_UNMAPPED` now re-exported from `@usesigil/kit/dashboard`.
  - `PostAssertionValidationError` + `FlashTradeLeverageOutOfRangeError`
    classes gained `onChainReverted: false` (they're client-side
    validation errors, thrown before any RPC round-trip).

  ### C5 — composeAgentBootstrap + getHandoffPromptTemplate
  - `composeAgentBootstrap(config): AgentBootstrap` — fills the canonical
    handoff-prompt template with vault-specific data. Returns
    `{ agentWallet, vaultPubkey, onboardingPrompt, capabilities }`.
    Deterministic: same input → byte-identical output.
  - `getHandoffPromptTemplate(): string` — returns the raw template with
    `${placeholder}` slots. For callers doing their own substitution.
  - `capabilityTierToNames(tier): readonly string[]` — maps the 0/1/2
    capability tier to friendly names. Exported from what was previously
    an unexported internal constant in `advanced-analytics.ts`.
  - `AgentBootstrap` + `AgentBootstrapConfig` types.

  Template is prompt-injection safe — single-pass regex substitution
  blocks both `$&`-style back-reference attacks AND `${placeholder}`
  nested-value attacks. Validated with adversarial tests.

  ### Breaking
  - **`engines.node`** bumped from `>=18.0.0` to `>=20.10.0`. Required
    because `with { type: "json" }` import attributes (used by the
    protocol-registry) are a SyntaxError on Node < 20.10. Node 18 is
    EOL upstream (April 2025) so this matches the runtime floor anyway.
  - **`DxError.onChainReverted`** is a new required field. All internal
    kit callers route through `toDxError()` which sets it; external
    consumers constructing `DxError` literals (none found in audit) must
    add the field. Two sibling classes (`PostAssertionValidationError`,
    `FlashTradeLeverageOutOfRangeError`) updated in this release.
  - **`ConstrainabilityResult`** is now a discriminated union on
    `constrainable`. Consumers constructing results must provide
    `idlSource` when `constrainable: true` and `reason` when
    `constrainable: false`. Compile-time enforcement of the iff-invariant
    the prose docstring previously described.

  ### Test coverage

  79 new tests in `sdk/kit/tests/`:
  - `protocol-registry.test.ts` (15) — registry structural integrity
  - `protocol-tier.test.ts` (7) — tier resolver behavior + error propagation
  - `dashboard/errors-categorize.test.ts` (32) — DxError range boundaries
  - `agent-bootstrap.test.ts` (25) — template determinism + substitution +
    injection resistance + input validation

  Baseline 1590 → 1613 → 1613 (after union narrowing) → 1675 passing.

  Counts manifest + CI updated.

- [#275](https://github.com/Sigil-Trade/sigil/pull/275) [`c3760ae`](https://github.com/Sigil-Trade/sigil/commit/c3760ae28857f3295637e16ef5efa651127082da) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Add post-execution assertion mutation surface (Phase 2 phantom cleanup).

  New public APIs on `@usesigil/kit`:
  - **`createPostAssertions(rpc, vault, owner, network, entries, opts)`** —
    writes a `PostExecutionAssertions` PDA with 1..=4 entries. Validates
    client-side before the RPC round-trip; invalid input throws
    `PostAssertionValidationError` with typed `validationCode` + `entryIndex`
    so FE callers can pinpoint the bad entry.
  - **`closePostAssertions(rpc, vault, owner, network, opts)`** — closes the
    PDA and refunds rent. After close, `has_post_assertions` flips 0 on
    PolicyConfig and `finalize_session` skips the post-assertion scan.
  - **`validatePostAssertionEntries(entries)`** — pure client-side validator
    mirroring on-chain `validate_entries()`. Exported from
    `@usesigil/kit/dashboard`.
  - **`PostAssertionValidationError`** — structurally DxError-compatible
    (`code: number = 7008`, `message`, `recovery: string[]`) plus typed
    `validationCode` + `entryIndex`. The mutation wrappers do NOT wrap via
    `toDxError` — FE receives typed fields intact.

  New `@usesigil/kit/post-assertions` subpath:
  - **`leverageCapLteBps({ ... })`** — generic CrossFieldLte builder. Enforces
    `field_A × 10000 ≤ maxBps × field_B` on-chain (u128 safe math, no division).
  - **`JupiterPerpsPostAssertionUnsupportedError`** — thrown at authoring time
    when the target account is owned by Jupiter Perpetuals. Jupiter Perps uses
    a 2-tx keeper-fulfillment model that silently bypasses post-execution
    assertions. Jupiter Perps remains fully supported via pre-execution
    `InstructionConstraints` (via `@sigil-trade/constraints`).
  - **`flashTradeLeverageCap({ positionAccount, maxLeverage })`** —
    one-call convenience for Flash Trade leverage caps. Offsets pinned to the
    `flash-sdk@^15.14.1` Perpetuals IDL with a drift-check unit test that
    fails on any flash-sdk bump that shifts `size_usd` or `collateral_usd`.

  No breaking changes. Existing mutation + authoring surfaces unchanged.

- [#314](https://github.com/Sigil-Trade/sigil/pull/314) [`6810d4b`](https://github.com/Sigil-Trade/sigil/commit/6810d4bf8bb67329da4054e5ce418b4ac7593e39) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - feat(kit): buildUnsigned() composer for offline signing (S21)

  A new public composer that builds an unsigned Solana transaction from
  plain instructions and a `feePayer: Address` (no `TransactionSigner`
  required). Fills the gap between `buildOwnerTransaction` (requires a
  signer) and the multisig / CLI / cost-preview use cases that need raw
  unsigned bytes.

  **API**

  ```typescript
  import { buildUnsigned } from "@usesigil/kit";

  const result = await buildUnsigned({
    rpc,
    feePayer: payerAddress,
    instructions,
    // Optional:
    computeUnitLimit,
    computeUnitPrice,
    addressLookupTables,
    blockhash,
    simulate: true, // populates estimatedComputeUnits
  });

  result.unsignedTxBytes; // Uint8Array — ready for offline signer
  result.instructions; // by-reference (do not mutate)
  result.estimatedComputeUnits; // present iff simulate=true succeeded
  result.feePayer;
  result.recentBlockhash;
  result.lastValidBlockHeight;
  result.message; // decoded compiled message for inspection
  ```

  **Three primary use cases**
  1. **Squads multisig** — submit `unsignedTxBytes` as a Squad proposal;
     signers from the multisig sign asynchronously.
  2. **CLI cold-key signing** — pipe the buffer to `solana sign-tx` for
     offline signing.
  3. **Client-side cost preview** — caller decodes the buffer / reads
     `estimatedComputeUnits` to estimate CU + fee before submission.

  **How this differs from `buildOwnerTransaction`**
  - `buildOwnerTransaction` requires a `TransactionSigner` for the owner;
    `buildUnsigned` accepts a plain `Address` (uses `createNoopSigner`
    internally).
  - `buildOwnerTransaction` returns `{ transaction, txSizeBytes,
wireBase64, blockhash }`; `buildUnsigned` returns `unsignedTxBytes`
    (decoded) + the original `instructions[]` + a decoded `message`
    for inspection.

  11 unit tests cover wire layout, decode round-trip, simulate behavior,
  and signature-slot zeroing.

- [#313](https://github.com/Sigil-Trade/sigil/pull/313) [`339855c`](https://github.com/Sigil-Trade/sigil/commit/339855c14679c514aad4c0b07993baee486bae72) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - feat(kit): OwnerClient.getAgentDetail / getRiskMetrics / getAuditTrail (S10/S11/S12)

  Three new read-method wrappers on `OwnerClient` for the AgentShield V1
  dashboard surface. Each is a thin convenience layer over an existing SDK
  function — no new RPC patterns, no new on-chain reads.

  **S10 — `getAgentDetail(agent: Address): Promise<AgentData>`**
  Single-agent detail wrapper around `getAgentProfile()` (from
  `agent-analytics.ts`) + the same 100-event activity enrichment fetch
  used by `getAgents()`. Returns the dashboard-friendly `AgentData` shape
  for one agent (same fields as one entry in `getAgents()`). Throws via
  `toDxError` mapped from `SIGIL_ERROR__SDK__INVALID_PARAMS` when the
  agent is not registered in the vault. Activity enrichment fails open to
  empty last-action fields, matching the existing `getAgents()` pattern.

  **S11 — `getRiskMetrics(): Promise<RiskMetrics>`**
  Combines `getSpendingVelocity()` + `evaluateAlertConditions()` into a
  single risk-tilt summary. Returns:
  - `capVelocity` — % of daily cap projected to be consumed in 24h at the
    current rate (0 when no cap configured).
  - `spendingVelocity` — current rate in 6-decimal USD base units / hour.
  - `riskLevel` — four-level UI badge (`low` / `elevated` / `high` /
    `critical`) derived from the highest-severity active alert.
  - `isAccelerating` / `timeToCapSeconds` — passed through from
    `getSpendingVelocity`.

  One state resolution. No activity fetch.

  **S12 — `getAuditTrail(opts?): Promise<AuditTrailEntry[]>`**
  Filters `getVaultActivity()` to the governance/security subset
  (`policy` / `agent` / `security` / `escrow` categories — trades,
  deposits, withdrawals, and fee accruals are excluded). Each entry
  exposes `timestamp` (Unix ms), `eventType`, `eventName`, `actor`,
  `details`, `txSignature`, plus `toJSON()`. Optional `{ limit, since }`
  controls fetch size and post-filter timestamp lower bound (Unix ms).

  Three new test files (`get-agent-detail.test.ts`, `get-risk-metrics.test.ts`,
  `get-audit-trail.test.ts`) covering the pure `build*` helpers plus
  `OwnerClient` method wiring — 36 new tests total, kit suite now 1,781
  passing (was 1,745).

- [#295](https://github.com/Sigil-Trade/sigil/pull/295) [`a6b7731`](https://github.com/Sigil-Trade/sigil/commit/a6b77319b7f2a76e27a47969318bc65cd2737b7b) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - refactor(sigil): delete `is_spending` byte from ConstraintEntry (M2 Option A)

  The `is_spending: u8` field on `ConstraintEntry` was effectively dead
  code at runtime — `validate_and_authorize.rs:134` derives spending
  classification from `amount > 0`, never reading the per-entry field.
  The Borsh-struct field is removed; the corresponding zero-copy byte
  at offset 554 is renamed to `_reserved_was_is_spending` to preserve
  the 560-byte `ConstraintEntryZC` size invariant. Existing on-chain
  PDAs are unaffected (the byte is now ignored runtime-wide).

  **Side effect / latent fix:** 21 previously-broken tests in
  `tests/instruction-constraints.ts` now pass (29→50). They were
  failing because they constructed entries without the `is_spending`
  field, hitting the now-removed validator at `state/constraints.rs:309-312`.

  **Codama regen impact:** `sdk/kit/src/generated/types/constraintEntry.ts`
  no longer has `isSpending: number`; codama also produced 16 new
  PDA-derivation helpers in `sdk/kit/src/generated/pdas/` (unrelated
  positive cosmetic refactor from the regen).

  **Coordination with PR 9** (`feat/sigil-account-constraint-writable-required`):
  PR 9 was branched off this PR; merge order is mandatory **PR 8 → PR 9**
  to avoid `state/constraints.rs` conflict. PR 9 has been pre-rebased
  locally onto this PR's amend (Jupiter slippage non-spending bypass fix).

  **Follow-up amend on this branch (`a24d0a2`):** closes a Pentester MED
  finding — the non-spending forward scan in `validate_and_authorize.rs`
  was missing the `verify_jupiter_slippage` call. Now `enforce_jupiter_slippage_if_jupiter`
  is called from BOTH spending and non-spending forward-scan branches.

  No SDK API surface change. The `ConstraintEntry` Borsh layout shrinks
  by 1 byte at the encoder level; codama-generated codecs handle this
  transparently for all consumers.

## 0.15.0

### Minor Changes

- [#258](https://github.com/Sigil-Trade/sigil/pull/258) [`20bd7ec`](https://github.com/Sigil-Trade/sigil/commit/20bd7ec8637b29308b0a1b1f38e717d4a848b027) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - BREAKING: Remove position counter system per council decision (9-1 vote, 2026-04-19).

  **Removed types / helpers:**
  - `PositionEffect` type and `getPositionEffect()` helper
  - `PositionsSynced` event type and its decoder
  - `syncPositions()` instruction builder and `OwnerClient.syncPositions()` method
  - `ActivityType` literals `"open_position"` and `"close_position"` (trade events now collapse to `"swap"`)

  **Removed fields (accounts + instructions + events):**
  - `AgentVault.openPositions` (u8)
  - `PolicyConfig.canOpenPositions` (bool) and `PolicyConfig.maxConcurrentPositions` (u8)
  - `PendingPolicyUpdate.canOpenPositions` and `PendingPolicyUpdate.maxConcurrentPositions` (both `Option<T>`)
  - `SessionAuthority.positionEffect` (u8)
  - `SessionFinalized.positionEffect` (u8)
  - `VaultActivityItem.positionEffect`
  - `VaultHealth.openPositions`
  - `InscribeOptions.maxConcurrentPositions`, `CreateVaultOptions.maxConcurrentPositions`
  - `PolicyData.canOpenPositions`, `PolicyData.maxConcurrentPositions` and their serialized counterparts

  **Removed error codes:**
  - 6008 `TooManyPositions`
  - 6009 `PositionOpeningDisallowed`
  - 6012 `OpenPositionsExist`
  - 6032 `NoPositionsToClose`

  **Error-code renumber cascade** (Anchor auto-assigns 6000+index):
  - 6000-6007: unchanged
  - 6008-6009: was 6010-6011 (shift -2)
  - 6010-6028: was 6013-6031 (shift -3)
  - 6029-6080: was 6033-6084 (shift -4)
  - Total codes: 85 -> 81; max code: 6084 -> 6080

  **Migration notes:**
  - Consumers who used `maxConcurrentPositions` or `canOpenPositions` to limit agent behavior should rely on spending caps (`dailySpendingCapUsd`, `maxTransactionSizeUsd`), per-protocol caps, and the instruction-constraints PDA — these are the load-bearing guardrails.
  - Dashboard `mapCategory()` now returns `"swap"` for all trade events that previously returned `"open_position"` / `"close_position"`. The `"lend"` category is preserved for deposit/withdraw flows that match action-type heuristics.
  - Legacy JSON snapshots with `positionEffect`, `openPositions`, or `maxConcurrentPositions` keys still deserialize — unknown keys are silently ignored by `vaultStateFromJSON` / `policyFromJSON`.

  Depends on the on-chain Rust deletion shipped in Sigil PR [#258](https://github.com/Sigil-Trade/sigil/issues/258).

## 0.13.0

### Minor Changes

- [#255](https://github.com/Sigil-Trade/sigil/pull/255) [`f8e2869`](https://github.com/Sigil-Trade/sigil/commit/f8e2869166ac95570ebcb001882ff3e0c93601e3) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - **v0.13.0 — Sprint 1 barrel closeout.** Removes 54 internal utilities from the root barrel of `@usesigil/kit` per the zero-consumer audit. Pre-1.0, no external consumers — verified repo-wide before the audit.

  **What's hidden from `@usesigil/kit` root** (source files remain; reachable only by relative imports inside the SDK):
  - **Internal RPC plumbing (15):** `BlockhashCache`, `getBlockhashCache`, `AltCache`, `mergeAltAddresses`, `SIGIL_ALT_DEVNET`, `SIGIL_ALT_MAINNET`, `getSigilAltAddress`, `signAndEncode`, `sendAndConfirmTransaction`, `composeSigilTransaction`, `validateTransactionSize`, `measureTransactionSize`, `toInstruction`, `bytesToAddress`, `resolveAccounts` — plus types `ComposeTransactionParams`, `Blockhash`, `SendAndConfirmOptions`, `ResolveAccountsInput`, `ResolvedAccounts`.
  - **Policy engine internals (10):** `evaluatePolicy`, `enforcePolicy`, `recordTransaction`, `toCoreAnalysis`, `ShieldStorage`, `SpendEntry`, `TxEntry`, `VelocityTracker`, `VelocityConfig`, `SpendStatus`. Consumers use `shield()` and `vault.budget()` instead.
  - **TEE internal plumbing (10):** `AttestationCache`, `DEFAULT_CACHE_TTL_MS`, `clearAttestationCache`, `deleteFromAttestationCache`, `WalletLike`, `AttestationConfig`, `AttestationLevel`, `AttestationMetadata`, `NitroPcrValues`, `TurnkeyAttestationBundle`. Consumers use `verifyTurnkey()` / `verifyTeeAttestation()`.
  - **Redundant vault creation (8):** `inscribe`, `withVault`, `mapPoliciesToVaultParams`, `findNextVaultId` + their types. Consumers use `createAndSendVault` / `createVault`.
  - **Internal constants (10):** `EPOCH_DURATION`, `NUM_EPOCHS`, `OVERLAY_EPOCH_DURATION`, `OVERLAY_NUM_EPOCHS`, `ROLLING_WINDOW_SECONDS`, `PROTOCOL_TREASURY`, `PROTOCOL_FEE_RATE`, `MAX_DEVELOPER_FEE_RATE`, `FEE_RATE_DENOMINATOR`, `ON_CHAIN_ERROR_MAP`. `toAgentError()` replaces the error map; others are internal implementation detail.
  - **Duplicate TransactionExecutor (4):** `TransactionExecutor`, `ExecuteTransactionParams`, `ExecuteTransactionResult`, `TransactionExecutorOptions`. Consumers use `createSigilClient().executeAndConfirm()`.

  **Migrated (not hidden): `custodyAdapterToTransactionSigner` + `CustodyAdapter`.** Moved from `@usesigil/kit` to `packages/plugins/src/sak/signer.ts` where its only consumer lives. `sdk/kit/src/custody-adapter.ts` source file deleted. Custody-adapter unit tests (8) moved with it to `packages/plugins/tests/custody-signer.test.ts`.

  **Preserved:** All Sprint 1 + Sprint 2 public surface stays — `Sigil` facade, `SigilVault`, `createSigilClient`, `createSigilClientAsync`, `SigilClient` (deprecated but still exported, private-ctor guarded), `SealHooks`, `SigilPolicyPlugin`, `parseUsd`, `initializeVaultAtas`, `VAULT_PRESETS`, `SAFETY_PRESETS`, account decoders, public TEE verification (`verifyTurnkey` etc.), `shield()`, `toAgentError()`, and the `/react`, `/errors`, `/dashboard`, `/x402`, `/testing`, `/testing/devnet` subpaths.

  **Surface size:** 388 → ~334 root exports (−54). Further cuts (generated account decoder sprawl — `decodeX`, `fetchAllX`, `fetchMaybeX`, `getXCodec`/`Encoder`/`Size`) are the remaining gap to the ≤125 plan target; they carry dashboard build-verification risk and land in a future "generated surface trim" PR.

  **Migration guide for consumers (none exist pre-1.0, documented for 1.0 readiness):**

  ```diff
  - import { BlockhashCache, AltCache } from "@usesigil/kit";
  + // These are now private. Use createSigilClient() — it manages caches
  + // internally. Call client.invalidateCaches() to reset.

  - import { evaluatePolicy } from "@usesigil/kit";
  + import { shield } from "@usesigil/kit";

  - import { ON_CHAIN_ERROR_MAP, parseOnChainErrorCode } from "@usesigil/kit";
  + import { toAgentError } from "@usesigil/kit";
  + // Handles on-chain and SDK errors uniformly.

  - import { inscribe } from "@usesigil/kit";
  + import { createAndSendVault } from "@usesigil/kit";

  - import { TransactionExecutor } from "@usesigil/kit";
  + import { createSigilClient } from "@usesigil/kit";
  + const client = createSigilClient(config);
  + await client.executeAndConfirm(instructions, opts);

  - import { custodyAdapterToTransactionSigner } from "@usesigil/kit";
  + import { custodyAdapterToTransactionSigner } from "@usesigil/plugins/sak";
  + // Bridge helper moved to the plugin that actually uses it.
  ```

  **No `@usesigil/plugins` changeset.** The SAK plugin's `custodyAdapterToTransactionSigner` import site moves from `@usesigil/kit` to a local `./signer.js`; zero public API change for plugin consumers. 8 unit tests moved with the helper (`@usesigil/plugins` test count: 6 → 14).

## 0.12.0

### Minor Changes

- [#252](https://github.com/Sigil-Trade/sigil/pull/252) [`3e60589`](https://github.com/Sigil-Trade/sigil/commit/3e60589091883a765b972f28431428833ad3169d) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - **v0.12.0 — Sprint 2 finish: wire plugin runner + `onBeforeSign` hook into `seal()`.** Closes the two API-contract gaps from Sprint 2 (`@usesigil/kit@0.11.0`) where `SigilPolicyPlugin` and `SealHooks.onBeforeSign` were exported + documented but never actually invoked.

  **What now works that didn't before:**
  - **`SigilPolicyPlugin.check()` actually fires** — previously dead API. Plugins register via `SigilClientConfig.plugins` / `Sigil.quickstart({ plugins })` / `Sigil.fromVault({ plugins })` and run inside `seal()` after `resolveVaultState` + vault-active/agent-registered/agent-not-paused gates. First `{ allow: false }` short-circuits with `SigilSdkDomainError(SIGIL_ERROR__SDK__PLUGIN_REJECTED)`.
  - **`SealHooks.onBeforeSign` actually fires** — previously unwired. Invoked once per seal, after transaction compose + size-check, before return. Same composed-hooks propagation as the other four hooks.
  - **Three additional gaps closed in the same PR:**
    - `Sigil.quickstart` / `Sigil.fromVault` now forward `plugins` + `hooks` to the underlying `SigilClient.create()` (previously stored in `SigilVaultInternalState` but never reached the client).
    - `createSigilClient(config)` now calls `validatePluginList(config.plugins)` (previously only the facade path validated; direct factory path would fail lazily at first seal).
    - `PluginContext` gains a required `state` field (redacted snapshot — budget + vault status + agent capability — no owner pubkey, no agents roster, no vault_id; frozen via `Object.freeze`).

  **Run order inside `seal()` (now documented correctly in `plugin.ts`):**

  ```
  1. Parameter validation
  2. onBeforeBuild hook (may abort via { skipSeal: true })
  3. resolveVaultState (RPC)
  4. Vault-active + agent-registered + agent-not-paused gates
  5. Plugin checks (first { allow: false } throws)         ← NEW
  6. Constraint check + transaction assembly
  7. onBeforeSign hook (observe-only, pre-return)           ← NEW
  ```

  Plugins run AFTER state resolution because 2 of 3 real use cases (rate limiting, compliance) need state input. Consumers wanting stateless early-exit use `onBeforeBuild` with `{ skipSeal: true, reason }` — that path still runs before any RPC.

  **Breaking changes:** None to public API shape — `PluginContext.state` is additive. But any consumer who registered a `SigilPolicyPlugin` previously was getting silent no-op; now the plugin actually runs. If the plugin has bugs (e.g., always returns `{ allow: false }`), it will now reject real transactions. Re-test registered plugins end-to-end before upgrading.

  **Security:**
  - Plugin context state is **redacted** — no `owner`, no `agents[]`, no `vault_id`, no raw SpendTracker epochs
  - Plugin context state is **frozen** (outer + nested) — mutation attempts throw in strict mode or silently discard in sloppy; neither is a working bypass
  - Plugin throws are **not swallowed** (unlike observe-only hook throws) — treated as hard rejection with the error message preserved in the rejection reason

  **Test delta:** +8 integration tests in `sdk/kit/tests/sprint2-hook-integration.test.ts` covering the 8 assertions from the plan (allow path, reject path, throw path, multi-plugin short-circuit, state visibility, no-plugins no-op, correlationId plumbing between `onBeforeBuild` and `onBeforeSign`). Kit total: 1453 → 1461.

  **Migration:** No consumer code changes required. If you were registering plugins before, they'll now actually run — test first.

## 0.11.0

### Minor Changes

- [#244](https://github.com/Sigil-Trade/sigil/pull/244) [`5faa5a9`](https://github.com/Sigil-Trade/sigil/commit/5faa5a959d79d88648f5bcb10e18b16b064dadb0) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - **v0.11.0 — Sprint 2: Sigil facade + SigilVault + hooks + plugins + `/react`.** Additive convenience layer on top of Sprint 1 primitives, plus the long-planned removal of the deprecated sync `SigilClient` constructor.

  **New public surface:**
  - **`Sigil` facade (`import { Sigil } from "@usesigil/kit"`)** — frozen namespace with four entry points:
    - `Sigil.quickstart(opts)` — provision a new vault + optional initial funding + returns a `SigilVault` handle in one call
    - `Sigil.fromVault({ rpc, address, agent, owner?, network })` — bind a handle to an existing vault
    - `Sigil.discoverVaults(rpc, owner, network)` — enumerate an owner's vaults
    - `Sigil.presets` — groups `SAFETY_PRESETS` + `VAULT_PRESETS` + helpers under one namespace
  - **`SigilVault` handle** — private-constructor class obtained via the facade factories. Methods: `execute()`, `overview()`, `budget()`, `freeze()`, `fund()`. Owner-only methods throw `SIGIL_ERROR__SDK__OWNER_REQUIRED` when called on an agent-only handle with the method name in context.
  - **`SealHooks` lifecycle observability** — five observe-only hooks (`onBeforeBuild`, `onBeforeSign`, `onAfterSend`, `onError`, `onFinalize`) fire at documented stages of `seal()` + `executeAndConfirm()`. Throws are swallowed + logged via the injected logger — they never corrupt `seal()`'s atomic-transaction guarantee. `onBeforeBuild` uniquely may return `{ skipSeal: true, reason }` to abort cleanly via `SigilSdkDomainError(SIGIL_ERROR__SDK__HOOK_ABORTED)` before any RPC round-trip. Client-level hooks compose with per-call hooks via `composeHooks()`.
  - **`SigilPolicyPlugin` rejection surface** — async `check()` returns `{ allow: true }` or `{ allow: false, reason, code? }`. First rejection short-circuits `seal()` with `SigilSdkDomainError(SIGIL_ERROR__SDK__PLUGIN_REJECTED)`. Plugins that take >1s log a latency warning. Plugin names must be unique; `validatePluginList()` catches malformed lists at client construction.
  - **`/react` subpath** — four TanStack Query hooks (`useVaultBudget`, `useVaultState`, `useOverview`, `useExecute`) + `sigilQueryKey` helper. React + `@tanstack/react-query` declared as **optional** peer dependencies — consumers who don't use React see no warnings. Query keys namespaced under `"sigil"` to prevent app-level TanStack cache collisions.

  **Breaking changes:**
  1. **Sync `new SigilClient(config)` constructor is now `private`.** TypeScript callers get a compile error; JS callers who cast through `any` trigger a runtime `SigilSdkDomainError(INVALID_CONFIG)` with a clear migration message.

     **Migration:**

     ```diff
     - const client = new SigilClient({ rpc, vault, agent, network });
     + const client = await SigilClient.create({ rpc, vault, agent, network });
     // or for test / mock harnesses:
     + const client = createSigilClient({ rpc, vault, agent, network });
     ```

     `SigilClient.create()` is the recommended path — it runs the genesis-hash assertion from Sprint 1. `createSigilClient()` is the lightweight factory that skips the assertion (suitable for test stubs that don't honor `getGenesisHash()`).

  2. **Three new `SIGIL_ERROR__SDK__*` codes** in `/errors` subpath (total: 49 → 52):
     - `SIGIL_ERROR__SDK__HOOK_ABORTED` — `onBeforeBuild` returned `{ skipSeal: true }`
     - `SIGIL_ERROR__SDK__PLUGIN_REJECTED` — a plugin returned `{ allow: false }`
     - `SIGIL_ERROR__SDK__OWNER_REQUIRED` — owner-only `SigilVault` method called agent-only

  **Non-breaking additions** to existing types:
  - `SealParams`: `hooks?`, `correlationId?`
  - `SigilClientConfig`: `hooks?`, `plugins?`
  - `ClientSealOpts`: `hooks?`, `correlationId?`

  Passing `undefined` or omitting these fields preserves pre-v0.11 behavior exactly. No consumer code needs to change unless they want to opt in to the new surface.

  **Test delta:** 1,401 → 1,487 kit SDK (+86 new tests). Grand total 2,253 → 2,299.

  **README:** new sections for Sigil Facade, Lifecycle Hooks, Policy Plugins, React Hooks. Migration guide for v0.10 → v0.11 and repeated grep table for the removed sync ctor.

## 0.10.0

### Minor Changes

- [#238](https://github.com/Sigil-Trade/sigil/pull/238) [`85c64c6`](https://github.com/Sigil-Trade/sigil/commit/85c64c66db7afda16a98c11b885ba7d4d6bb2021) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - **v0.9.0 — Sprint 1 SDK surface fix.** Breaking but pre-1.0: closes Pentester findings F1, F3, F5, F7, F8, F10.

  **New entry points (recommended):**
  - `SigilClient.create(config)` async factory — asserts the RPC's genesis hash matches the configured network before returning. 3-retry 200 ms exponential backoff; cached per-RPC-instance.
  - `SigilLogger` pluggable logger interface + `NOOP_LOGGER` default + `createConsoleLogger()` + module-level install via `SigilClient`/`OwnerClient` constructors.
  - `SAFETY_PRESETS` (development, production) orthogonal to the existing `VAULT_PRESETS`; compose via `applySafetyPreset`.
  - `parseUsd("$100")` strict BigInt USD parser — no `parseFloat`, no leading-zero input, throws `SIGIL_ERROR__SDK__INVALID_AMOUNT` on malformed input.
  - `initializeVaultAtas({ vault, payer, mints, allowedMints })` — manual ATA-program `CreateIdempotent` instruction builder with caller-asserted allowlist check.
  - `validateAgentCapAggregate({ vaultDailyCap, existingAgentCaps, newAgentCap })` — rejects when sum of per-agent caps exceeds vault cap.
  - `/errors` subpath — all 49 `SIGIL_ERROR__*` discriminants now live at `@usesigil/kit/errors`.
  - `SOLANA_DEVNET_GENESIS_HASH` and `SOLANA_MAINNET_GENESIS_HASH` constants for caller-side cluster assertions.

  **Breaking changes:**
  1. `createVault` now requires three fields that previously had silent defaults:
     - `spendingLimitUsd` (was default `0n`)
     - `dailySpendingCapUsd` (was default `500_000_000n`)
     - `timelockDuration` (was default `0`)
       Explicit `0n` is still accepted for the Observer-agent case; set all three or spread `SAFETY_PRESETS.development` / `applySafetyPreset("production", {...})`.
  2. Sync `new SigilClient(config)` constructor is `@deprecated`. It still works for back-compat and for tests using stubbed RPCs, but emits a warning through the injected logger on every call. Migrate to `await SigilClient.create(config)`. Removal scheduled for Sprint 2.
  3. The 49 `SIGIL_ERROR__*` code constants moved from the root barrel to the `./errors` subpath:
     ```diff
     - import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "@usesigil/kit";
     + import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "@usesigil/kit/errors";
     ```
  4. Root barrel dropped ~325 exports. Removed: 37 Codama instruction builders (consumers use `seal()` / `createVault()` / `OwnerClient`), 82 hex error constants (internal-only), 60+ generated event and struct types (internal-only), the on-chain Anchor `SigilError` enum (internal-only). Kept: 12 account decoders (the supported RPC-read path), `SIGIL_PROGRAM_ADDRESS`, all public APIs.
  5. Every internal `console.warn`/`console.error`/`console.debug` in the SDK now routes through the injected logger. Production consumers who want stderr output must pass `logger: createConsoleLogger()` to `SigilClient.create()` / `createSigilClient()` / `OwnerClient`. `NOOP_LOGGER` is the silent default.

  **Security fixes:**
  - F10 (cluster mismatch): `SigilClient.create()` asserts `rpc.getGenesisHash()` matches the canonical devnet / mainnet hash before returning. Bypass via `skipGenesisAssertion: true` is supported only for local test harnesses and logs a warning.
  - F3 (aggregate cap): SDK now rejects `sum(per-agent caps) > vault daily cap` at `createVault` time.
  - F5 (silent daily cap default): the $500/day default is gone. Callers must supply `dailySpendingCapUsd` explicitly or use a `SAFETY_PRESETS` entry.
  - F7 (silent timelock default): the 0-second default is gone. `timelockDuration` is required.
  - F1 (USD parse rounding): `parseUsd()` uses BigInt arithmetic only; no `parseFloat` path exists.

  **Migration guide:** see `sdk/kit/README.md` "v0.8 → v0.9 migration" section and the grep table for every symbol removed.

  **Test delta:** +135 new tests (1,314 → 1,449 kit SDK) across `parse-usd.test.ts`, `ata.test.ts`, `logger.test.ts`, `validate-cap-aggregate.test.ts`, `seal-genesis.test.ts`, `public-surface.test.ts`, `create-vault.test.ts` additions, and `presets.test.ts` SAFETY_PRESETS suite.

## 0.8.1

### Patch Changes

- [#232](https://github.com/Sigil-Trade/sigil/pull/232) [`29a1385`](https://github.com/Sigil-Trade/sigil/commit/29a1385ebc7d72b74d698d2e4e3704d09da2bf20) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Complete audit follow-up: shield.ts import ordering, createOwnerClient + SUPPORTED_PROTOCOLS root barrel exports, priority-fees.ts registry-driven CU estimation, branded-types tests, README sections for Branded Types and MCP Round-Trip.

## 0.8.0

### Minor Changes

- [#224](https://github.com/Sigil-Trade/sigil/pull/224) [`2c73c71`](https://github.com/Sigil-Trade/sigil/commit/2c73c710236d248ef51bc875e9bb1ff5dd5e0e92) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Factory migration + fromJSON MCP round-trip + x402 documentation (PR 3.A).

  **BREAKING:** `SigilClient` and `OwnerClient` classes are **deprecated**. Use the new factory functions:

  ```ts
  // Before:
  const client = new SigilClient({ rpc, vault, agent, network });
  const owner = new OwnerClient({ rpc, vault, owner: signer, network });

  // After:
  const client = createSigilClient({ rpc, vault, agent, network });
  const owner = createOwnerClient({ rpc, vault, owner: signer, network });
  ```

  Both factory functions return the same API surface — same method names, same signatures. The factories carry context in closures (no `this` binding). Classes remain available for one minor as a migration ramp; removed at v1.0.

  **Why factory over class:** Tree-shakeable, no `this` footguns, composable, testable, aligned with @solana/kit v2 and viem patterns. The /fns subpath compromise was rejected in favor of the principled architecture.

  ### New: fromJSON MCP round-trip

  10 `fromJSON` functions for dashboard type deserialization:

  ```ts
  import { overviewDataFromJSON } from "@usesigil/kit/dashboard";

  // AI agent receives JSON from MCP tool → rehydrates typed object
  const overview = overviewDataFromJSON(jsonFromMcpTool);
  overview.spending.global.cap; // bigint (was string in JSON)
  ```

  Essential for MCP-based AI agent workflows where data round-trips through JSON tool responses.

  ### New: x402 documentation

  `@usesigil/kit/x402` subpath now documented in README with usage example. `shieldedFetch()` handles HTTP 402 payment negotiation with vault policy enforcement.

  ### Migration
  1. Replace `new SigilClient(...)` → `createSigilClient(...)`
  2. Replace `new OwnerClient(...)` → `createOwnerClient(...)`
  3. All method calls remain identical — no other changes needed

## 0.7.1

### Patch Changes

- [#223](https://github.com/Sigil-Trade/sigil/pull/223) [`84163f8`](https://github.com/Sigil-Trade/sigil/commit/84163f83c07b1454afc0f7dd0a9bef27cae3ae97) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Kit adapter barrel — centralize @solana/kit imports (PR 2.C).

  Internal refactor: all 52 source files now import from `src/kit-adapter.ts` instead of directly from `@solana/kit`. No public API changes. Future Kit v7/v8 migration is now a 1-file diff.

## 0.7.0

### Minor Changes

- [#222](https://github.com/Sigil-Trade/sigil/pull/222) [`bab2ea0`](https://github.com/Sigil-Trade/sigil/commit/bab2ea0583135c147a3c3af10bb15be714814fec) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Branded types + type consolidation (PR 2.B).

  **BREAKING:**
  - `addAgent()`, `queueAgentPermissions()`, `CreateVaultOptions` — `permissions` parameter is now `CapabilityTier` (was `bigint`). Use `capability(2n)` instead of `2n`.
  - `CreateVaultOptions` USD fields (`dailySpendingCapUsd`, `maxTransactionSizeUsd`, `spendingLimitUsd`) are now `UsdBaseUnits` (was `bigint`). Use `usd(500_000_000n)` instead of `500_000_000n`.
  - `DiscoveredVault` renamed to `VaultLocator`. Deprecated alias preserved for one minor.
  - New peer dependency: `@solana/errors@^6.2.0`.

  **New exports:**
  - `UsdBaseUnits`, `CapabilityTier`, `Slot` — branded bigint types (zero runtime cost)
  - `usd()`, `capability()`, `slot()` — constructor helpers
  - `VaultLocator` — renamed from `DiscoveredVault`

  **Migration:**

  ```ts
  import { usd, capability } from "@usesigil/kit";

  // Before: addAgent(vault, owner, "devnet", agent, 2n, 500_000_000n)
  // After:
  addAgent(vault, owner, "devnet", agent, capability(2n), usd(500_000_000n));
  ```

## 0.6.0

### Minor Changes

- [#220](https://github.com/Sigil-Trade/sigil/pull/220) [`06eb0d8`](https://github.com/Sigil-Trade/sigil/commit/06eb0d890aef7e91efa8555909cb1f186e381ccb) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Error taxonomy unification — single `SigilError` (publicly `SigilKitError`) base class for the entire SDK.

  **BREAKING:** Several focused breaks documented per category below. Pre-1.0 minor bump per project convention; review the migration notes before upgrading.

  ### What's new
  - **`SigilError` base class** (exported publicly as `SigilKitError`) with viem-style fields: `shortMessage`, `details`, `version`, `code`, `context`, `docsPath`, `metaMessages`, `cause`, `walk()`. The `.message` field is formatted with the short message plus a Version footer; `.shortMessage` carries the original verbatim.
  - **Six domain subclasses** under `SigilError`: `SigilShieldError`, `SigilTeeError`, `SigilX402Error`, `SigilComposeError`, `SigilSdkDomainError`, `SigilRpcError`.
  - **47 canonical `SIGIL_ERROR__<DOMAIN>__<DESCRIPTOR>` string-literal codes** + per-domain code unions (`SigilShieldErrorCode`, `SigilTeeErrorCode`, etc.).
  - **Type-safe `SigilErrorContext` map**: each code is bound at compile time to its required context shape (kit-style discriminated map).
  - **Per-module discriminated-union ErrorType exports** (viem pattern): `ShieldErrorType`, `TeeErrorType`, `X402ErrorType`, `ComposeErrorType`.
  - **`walkSigilCause(err, predicate?)` helper** for traversing `cause` chains with cycle protection (max-depth 10).

  All twelve existing error classes (`ShieldDeniedError`, `ShieldConfigError`, `ComposeError`, `X402ParseError`, `X402PaymentError`, `X402UnsupportedError`, `X402DestinationBlockedError`, `X402ReplayError`, `TeeAttestationError`, `AttestationCertChainError`, `AttestationPcrMismatchError`, `SigilSdkError`) are preserved as subclasses of their domain class. Existing `instanceof OldName` checks continue to work.

  ### BREAKING — `ShieldDeniedError`

  The duplicate definition in `src/shield.ts` was collapsed into the canonical version in `src/core/errors.ts`. The `code?: number` second constructor argument is **removed**. Replace:

  ```ts
  // Before:
  new ShieldDeniedError(violations, 7021);
  err.code === 7021; // numeric on the legacy shield.ts version

  // After:
  new ShieldDeniedError(violations); // 1-arg only
  err.code === SIGIL_ERROR__SHIELD__POLICY_DENIED; // canonical SigilErrorCode
  ```

  `PolicyViolation.suggestion` is now **required** (was optional in `shield.ts`). All existing throw sites in `shield.ts` author meaningful `.suggestion` text. Test fixtures must include it.

  The canonical `PolicyViolation.rule` type is widened from a closed enum to `PolicyRule` — an open string-literal union with a `(string & {})` escape hatch. Existing rule values are listed; new values are permitted but should follow the snake_case convention.

  ### BREAKING — X402 numeric `.code` migration

  Per UD1 (single canonical `.code`), the historical numeric `.code` fields on the X402 family (7024–7028) are replaced by the canonical `SigilErrorCode` string. The numeric values are preserved as `.legacyNumericCode` getters for one-minor migration ramp; deletion targeted at v1.0.

  ```ts
  // Before:
  new X402ParseError("...").code === 7024; // numeric

  // After (preferred):
  new X402ParseError("...").code === SIGIL_ERROR__X402__HEADER_MALFORMED;

  // After (transitional, deprecated, removed at v1.0):
  new X402ParseError("...").legacyNumericCode === 7024;
  ```

  All five X402 leaf classes follow the same pattern.

  ### BREAKING — `ComposeError.code` migration

  Same pattern as X402. The historical `ComposeErrorCode` string union (`"missing_param"`, `"invalid_bigint"`, `"unsupported_action"`) on `.code` is replaced by the canonical `SigilErrorCode` string. The original is preserved as `.legacyComposeCode`. The internal translation map is `COMPOSE_LEGACY_TO_SIGIL`.

  ### BREAKING — `.message` format

  The `SigilError` base appends a Version footer (`"\n\nVersion: @usesigil/kit@<version>"`) to `.message` per the viem pattern. Tests asserting `.message === "..."` exactly must switch to `.message.includes("...")` or read `.shortMessage` for the verbatim message.

  ### Limitation — `SigilSdkError` not (yet) under `SigilError`

  The existing `SigilSdkError` (in `src/agent-errors.ts`) implements the `AgentError` interface, whose `.code: string` is wider than `SigilErrorCode`. TypeScript property variance blocks shadowing the base `.code` with a wider type. Per UD3 (defer AgentError class promotion):
  - `instanceof SigilSdkError` still works.
  - `instanceof Error` still works.
  - `instanceof SigilError` (or `SigilKitError`) returns **`false`** for `SigilSdkError` instances.

  For new SDK-domain throws where AgentError conformance is not required, use the new `SigilSdkDomainError` class (also exported). A follow-up PR will promote `AgentError` to `SigilAgentError` class and unify the two SDK error classes under one hierarchy.

  ### Migration cheat sheet

  ```ts
  // Old: per-class catch
  catch (e) {
    if (e instanceof ShieldDeniedError) { ... }
    if (e instanceof X402ParseError) { ... }
  }

  // New: domain-level catch + code discrimination
  catch (e) {
    if (e instanceof SigilShieldError) {
      if (e.code === SIGIL_ERROR__SHIELD__POLICY_DENIED) { ... }
    }
    if (e instanceof SigilX402Error) {
      if (e.code === SIGIL_ERROR__X402__HEADER_MALFORMED) { ... }
    }
  }

  // Or use the per-module discriminated union (viem pattern)
  catch (e) {
    const err = e as ShieldErrorType;
    if (err instanceof ShieldDeniedError) console.error(err.violations);
  }
  ```

  ### Naming note — `SigilKitError`

  The base class is named `SigilError` internally but exposed publicly as `SigilKitError` to avoid a name collision with the on-chain Anchor error enum (`SigilError` from `generated/errors/sigil.ts`). Internal SDK code uses `SigilError`; consumers see `SigilKitError`. A future cleanup PR can rename the internal class and remove the alias.

  ### Inspired by
  - viem's `BaseError` ([source](https://github.com/wevm/viem/blob/main/src/errors/base.ts))
  - `@solana/kit`'s `SolanaError` + numeric code map ([source](https://github.com/anza-xyz/kit/tree/main/packages/errors/src))

  Triage research and council pressure-test in `~/.claude/MEMORY/WORK/20260414-071941_sdk-full-spectrum-audit/` and `Plans/patient-coiling-ledger.md`.

## 0.5.0

### Minor Changes

- [#218](https://github.com/Sigil-Trade/sigil/pull/218) [`06e2e3b`](https://github.com/Sigil-Trade/sigil/commit/06e2e3b62ba7a13ee6a11eb9f175311ad114291d) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Silent-failure hardening + TEE fail-closed (PR 1.B safety lockdown).

  ### Behavior change (read this before upgrading)

  **`verifyTeeAttestation(wallet)` now defaults to `requireAttestation: true`.** A call with no config throws `TeeAttestationError` on any non-verified status (including `Failed` from a custody-API error, `Unavailable` from a non-TEE wallet, and unmet minimum levels). Previously the function returned silently with a degraded status, which allowed default-path callers to treat the wallet as fine without inspecting `.status` — the silent-degradation vector this release closes.

  `TeeAttestationError` now carries the full `AttestationResult` as a `.result` property. `Sentry.captureException(err)` auto-serializes `err.result.status`, `.provider`, `.publicKey`, and `.metadata.verifiedAt` with zero callsite instrumentation.

  #### Migration

  Callers who genuinely want the forgiving behavior must opt in explicitly AND supply `onDegraded` — omitting the callback is treated as the silent-degradation vector this default prevents and throws:

  ```ts
  await verifyTeeAttestation(wallet, {
    requireAttestation: false,
    onDegraded: (r) => Sentry.captureMessage("tee-degraded", { extra: r }),
  });
  ```

  ### TEE provider-trusted tightening

  When `verifyProviderCustody()` throws in the Crossmint and Privy providers, the SDK now returns `AttestationStatus.Failed` with a structural transport classification (`rawAttestation.transport: boolean`) and a redacted cause (`rawAttestation.cause`). Previously this path silently downgraded to `ProviderTrusted`, allowing any consumer with `minAttestationLevel: "provider_trusted"` to pass attestation during a transport failure, DNS outage, or MitM intercept.

  The dispatcher's former `isCustodyFallback` cache-skip branch (`verify.ts:137–150` pre-release) is removed — `Failed` is already excluded from the cache-eligible status set, so the branch became unreachable.

  ### Typed `isAccountNotFoundError`

  `getPolicy`, `getOverview`, and `getVaultSummary` now classify account-not-found errors via `isSolanaError(err, CODE)` across four `@solana/errors` codes:
  - `SOLANA_ERROR__NONCE_ACCOUNT_NOT_FOUND` (3)
  - `SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND` (3230000)
  - `SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND` (7050003)
  - `SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_ACCOUNT_NOT_FOUND` (7050004)

  The predicate is a true type guard (`err is SolanaError<Code>`), so matched branches retain Kit's typed context without casts. Legacy web3.js 1.x substring matching (`"could not find"` / `"Account does not exist"`) is preserved as a fallback and can be dropped in a follow-up once transitive web3.js 1.x usage is confirmed gone.

  ### Additional silent-failure sites hardened

  Six additional bare-catch sites now emit redacted diagnostics instead of swallowing errors silently:
  - `dashboard/mutations.ts` — `close_vault` existence check logs RPC failure instead of silently omitting a PDA from `remaining_accounts` (which surfaced downstream as an opaque `AccountMissing`).
  - `dashboard/discover.ts` — vault decode failures log instead of silently dropping the vault from discovery results (previously hid data corruption from the owner).
  - `priority-fees.ts` — Helius and RPC fee-estimation failures log so API-shape drift is detectable instead of silently falling through to the default fee.
  - `x402/facilitator-verify.ts` — settlement-verification warnings now include the redacted cause.
  - `seal.ts` — output-stablecoin ATA existence RPC failure pushes a diagnostic warning; ALT cache-verify retries log the eviction reason.
  - `vault-analytics.ts` — `getVaultSummary`'s `getPendingPolicyForVault(rpc, vault).catch(() => null)` now re-throws non-account-not-found errors rather than collapsing every failure to "no pending update."

  ### New exported helpers

  ```ts
  import {
    isAccountNotFoundError,
    isTransportError,
    redactCause,
  } from "@usesigil/kit";
  ```

  `isTransportError` is a structural classifier (no message regex) covering POSIX codes, undici's `UND_ERR_*` set, TLS errors, HTTP/2 stream/session resets, DOMException `AbortError`/`TimeoutError`, `AggregateError` recursion, and `statusCode`-tagged HTTP 5xx responses. The provider-denial denylist (`ProviderDeniedError`, `CustodyDeniedError`, etc.) short-circuits to `false` so business denials aren't retry-classified.

  `redactCause` returns a safe `{ name?, message?, code? }` projection. Every property access is try-guarded, `.stack` is never read (may embed URLs/tokens), Proxy/null-prototype/throwing-getter inputs yield `{}` rather than throwing through, and cyclic cause chains are broken via `WeakSet`.

  ### Peer dep added

  `@solana/errors` is now a peer dependency, tracking `@solana/kit`'s declared range:

  ```bash
  pnpm add @usesigil/kit @solana/kit @solana/errors
  ```

  Inside a pnpm workspace, the transitive copy of `@solana/errors` installed by `@solana/kit` will satisfy the new peer automatically. External consumers must add the package explicitly. The peer declaration expresses a **contract** — "this package expects `@solana/errors` to resolve alongside `@solana/kit`" — it does NOT guarantee deduplication. A consumer whose transitive graph pins `@solana/errors` to a different version than `@solana/kit`'s exact pin can still end up with duplicate `SolanaError` classes across the install tree, breaking `instanceof` narrowing.

  To preserve the narrowing guarantee, install `@solana/errors` at the same version `@solana/kit` pins (inspect `pnpm view @solana/kit@<version> dependencies`), or use a package-manager resolution override if you have conflicting transitive constraints. `isAccountNotFoundError`'s substring fallback keeps the function working when class identity is lost, but the typed narrowing branch relies on a single `SolanaError` copy.

  ### Additional notes for migrators
  - `SealResult.warnings` gained a new warning class for the output-stablecoin ATA RPC-failure path (distinct from the pre-existing "ATA does not exist" warning, which meant "create the ATA"). The two warnings carry **inverted remediations** — if you pattern-match on warning text, treat the new "existence check failed due to RPC error" warning as "retry later," not as "create the ATA." Text-matching is advisory; a future release may introduce a structured `warning.kind` discriminator.
  - `getVaultSummary` now re-throws non-account-not-found errors from `getPendingPolicyForVault` instead of collapsing every failure to `pendingPolicy: null`. Callers that weren't catching from `getVaultSummary` will now see RPC transport errors surface — wrap in try/catch if you were previously relying on the silent-null behavior.

## 0.4.0

### Minor Changes

- [#212](https://github.com/Sigil-Trade/sigil/pull/212) [`1ed3499`](https://github.com/Sigil-Trade/sigil/commit/1ed3499f04e55d97e4906bac9c7dbd8a452e7737) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Phase 1 safety lockdown (PR 1.A — quick wins) — 6 targeted fixes addressing the full-spectrum SDK audit:
  - **Fix broken `VAULT_PRESETS` capability values.** All four presets (`jupiter-swap-bot`, `perps-trader`, `lending-optimizer`, `full-access`) now use `FULL_CAPABILITY` (= `2n`, Operator) for both `capability` and `permissions`. Previous values used the legacy 21-bit permission bitmasks (`SWAP_ONLY`, `PERPS_FULL | SWAP_ONLY`, `LENDING_PERMISSIONS`) which either registered agents as Observer (cannot execute anything — silently wrong) or exceeded the on-chain `capability <= 2n` invariant and were rejected with `InvalidArgument`.
  - **Remove the pre-v6 permission API from the public root export.** `SWAP_ONLY`, `PERPS_ONLY`, `TRANSFER_ONLY`, `ESCROW_ONLY`, `PERPS_FULL`, `ACTION_PERMISSION_MAP`, `hasPermission`, `permissionsToStrings`, `stringsToPermissions`, and `PermissionBuilder` are no longer re-exported from `@usesigil/kit`. They encoded a pre-v6 permission model the on-chain program replaced with a 2-bit capability enum. `FULL_CAPABILITY` / `FULL_PERMISSIONS` (both `2n`) remain the canonical spending-agent capability. The identifiers still exist inside `src/types.ts` for internal use but are no longer part of the public surface.
  - **Stop silencing stablecoin-ATA decode errors.** `resolveVaultState` used a bare `try/catch` around USDC and USDT balance parsing that swallowed both legitimate "account missing" and actual decode failures. Downstream, `seal.ts` uses `stablecoinBalances` as the drain-detection baseline — a spurious zero silently disabled the `LARGE_OUTFLOW` / `FULL_DRAIN` gates. Missing-ATA still returns `0n` (the `.exists` guard handles it); genuine parse errors now propagate so callers refuse to transact on unknown state instead of transacting on zero.
  - **Per-RPC blockhash cache (SDK-wide).** Three module-level `BlockhashCache` singletons (`dashboard/mutations.ts`, `seal.ts`, `owner-transaction.ts`) all shared state across every consumer — a dashboard that switches `devnet ↔ mainnet`, a CLI `--network` flag, or an MCP server multiplexing tenants would pull a blockhash fetched against one RPC and send it against another, producing intermittent `BlockhashNotFound` that the 30s TTL then hid. A new `getBlockhashCache(rpc)` helper in `rpc-helpers.ts` hands out caches keyed by RPC-client identity via `WeakMap<Rpc, BlockhashCache>`: consumers who reuse an RPC client keep the perf win; distinct RPCs stay isolated; short-lived RPC handles can be garbage-collected. The per-instance cache inside `SigilClient` is unaffected (already correctly scoped). Exported from `@usesigil/kit` so consumers can call `.invalidate()` explicitly when needed.
  - **Guard `buildHealth` against partial `OverviewContext`.** Matches the three peer `build*` helpers — emits a labeled `[dashboard/reads] OverviewContext.state.vault is required but missing` error instead of a cryptic NPE when a test fixture or custom composition passes a context without `state.vault`. The guard only fires when the helper actually needs to touch `state.vault` (non-memoized path); consumers that pre-populate `ctx.posture` and `ctx.alerts` — the whole reason for `OverviewContext` — still work.
  - **Mark S14 composition primitives `@experimental`.** The six `build*` helpers (`buildVaultState`, `buildAgents`, `buildSpending`, `buildHealth`, `buildPolicy`, `buildActivityRows`), plus `OverviewData` and `GetOverviewOptions`, now carry `@experimental` JSDoc. Their field shapes and memoization pipeline may shift before v1.0; pin your SDK version if you depend on this surface.
  - **Fix misleading SPL-Token-Transfer error message in `seal.ts`.** The top-level Transfer block no longer advises consumers to "Use the Transfer ActionType instead" (`ActionType` was removed in v6). The message now reflects the current API: transfers must route through an approved DeFi program's CPI; for owner-initiated withdrawals, use `OwnerClient.withdraw()`.

  **Breaking:** removal of the legacy permission re-exports from the package root. Third-party consumers of `OwnerClient` / `SigilClient` / presets / vault-creation are unaffected — the only outward change is that agents registered via presets now actually execute.

  **Migration guidance — do NOT treat `FULL_CAPABILITY` as a drop-in for `SWAP_ONLY`.** The v6 on-chain model replaced the 21-bit permission bitmask with a 2-bit capability enum:
  - `0` = Disabled (no execution)
  - `1` = Observer (read-only, cannot sign anything)
  - `2` = Operator (full spending authority) — exported as `FULL_CAPABILITY`

  There is **no middle ground**. Granular per-action restriction ("can swap but cannot transfer", "can open positions but cannot add collateral") no longer lives on the capability field — it moved to on-chain `InstructionConstraints`. If your previous code imported `SWAP_ONLY` (= `1n`) intending "agent can swap," the faithful replacement is `FULL_CAPABILITY` (= `2n`) _combined with_ a constraints policy that only allows your chosen DeFi programs. Using `FULL_CAPABILITY` alone gives the agent full spending authority bounded only by the vault's spending caps and protocol allowlist.

  `createVault()` now validates this client-side: passing any `permissions` value outside `[0n, 2n]` throws a descriptive error before any RPC roundtrip, catching the common "I imported `PERPS_FULL | SWAP_ONLY` and things look fine" mistake immediately.

## 0.3.0

### Minor Changes

- [#205](https://github.com/Sigil-Trade/sigil/pull/205) [`d11d0e3`](https://github.com/Sigil-Trade/sigil/commit/d11d0e34cca1c83d17f6fb144470a5dde332e4e5) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - **S14 — `OwnerClient.getOverview()` single-call convenience + shared-context refactor**

  Adds `OwnerClient.getOverview(options?)` that returns all five existing dashboard view types (`vault`, `agents`, `spending`, `health`, `policy`) plus an unfiltered `activity: ActivityRow[]` list in one call. Resolves vault state exactly once — calling the five individual reads separately duplicates the resolution up to five times.

  **New public API:**
  - `OwnerClient.getOverview(options?)` — method on the class.
  - `getOverview(rpc, vault, network, options?)` — free-function variant.
  - Types: `OverviewData`, `OverviewContext`, `GetOverviewOptions`, `SerializedOverviewData`.
  - `GetOverviewOptions` fields: `includeActivity?: boolean` (default `true`), `activityLimit?: number` (default `DEFAULT_OVERVIEW_ACTIVITY_LIMIT` = 100).
  - Constant: `DEFAULT_OVERVIEW_ACTIVITY_LIMIT`.
  - Pure helper: `getVaultPnLFromState(state)` — computes `VaultPnL` from an already-resolved state without issuing an RPC. `getVaultPnL()` (the RPC variant) now delegates to it.
  - **`@experimental`** composition helpers exposed from `@usesigil/kit/dashboard`: `buildVaultState`, `buildAgents`, `buildSpending`, `buildHealth`, `buildPolicy`, `buildActivityRows`. These are for advanced consumers (custom dashboards, MCP servers, test harnesses) that want to share one pre-fetched context across multiple views. The `OverviewContext` field shape — particularly the three memoized derivations (`posture`, `breakdown`, `alerts`) — may change without a major bump while the composition surface is iterated on.

  **Refactor (behavior-preserving):**
  - All five existing reads (`getVaultState`, `getAgents`, `getSpending`, `getHealth`, `getPolicy`) now delegate to the new `build*` helpers. Signatures unchanged. Output byte-identical. Existing tests pass unchanged.
  - `getActivity` extracted the raw → `ActivityRow[]` mapping into `buildActivityRows`, then filters as before.
  - Shared `isAccountNotFoundError` helper replaces two near-duplicate substring-matching catches in `getPolicy` and `getOverview`.

  **RPC-cost honesty:**

  `getOverview` resolves state once and derives PnL from that state synchronously — net-1 state resolution vs. the original PR implementation (which re-resolved via `getVaultPnL`). `resolveVaultStateForOwner`, `getVaultActivity`, and `getPendingPolicyForVault` are fanned out in a single `Promise.all`. The activity fetch (`getSignaturesForAddress` + up to `activityLimit` sequential `getTransaction` calls) dominates wall time when `includeActivity: true`; tune with `activityLimit` or skip entirely with `includeActivity: false`.

  **Known degradation paths:**
  - `includeActivity: false` → `activity: []` AND `agents[*].lastAction*` fields empty (JSDoc now warns).
  - Activity fetch failure → logs via `console.warn`, returns `activity: []` (matches `getAgents` pattern, references `docs/SECURITY-FINDINGS-2026-04-07.md` Finding 5).
  - Pending-policy account-not-found → `policy.pendingUpdate: undefined`. Any other `getPendingPolicyForVault` error propagates; the same asymmetry exists in `getPolicy`.

  **Guards added:**
  - `buildVaultState` / `buildAgents` / `buildPolicy` now fail fast with labeled errors when `state.vault` or `state.policy` are null/undefined, instead of the cryptic "cannot read properties of null" TypeError.

  **Tests added:** fixture-based unit tests for `buildActivityRows`, `buildVaultState` (with posture/pnl memoization), `buildAgents` (activity honored + includeActivity:false path), `buildSpending` (breakdown memoization), `buildHealth` (alerts + posture memoization), `buildPolicy` (pendingPolicy null vs undefined), state-missing guards on three helpers, and `OverviewData.toJSON()` delegation. `OwnerClient` method-count test updated from 6 → 7 reads.

## 0.2.3

### Patch Changes

- [#203](https://github.com/Sigil-Trade/sigil/pull/203) [`4209b98`](https://github.com/Sigil-Trade/sigil/commit/4209b98de517acd95fee08be366b8d1b2e03a4b4) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Phase 1 SDK convenience layer (trivial items):
  - **S19** — Export `toUsdNumber` (renamed from private `usdToNumber`) and add inverse `fromUsdNumber` with NaN/Infinity `TypeError` guard plus magnitude `RangeError` guard at the documented precision ceiling. Also export `FROM_USD_NUMBER_MAX` so consumers can pre-validate without redefining the constant. `toUsdNumber` now throws `RangeError` on negative input to make its "non-negative" precondition a runtime contract instead of a docstring-only hint.
  - **S5** — Replace 5 `:any` callback params in `dashboard/reads.ts` with concrete types (`SecurityCheck`, `Alert`, `SpendingBreakdown["byProtocol"][number]`, `unknown`).
  - **S7** — Add optional `type?: ActivityType` filter to `ActivityFilters`; applied in `getActivity`. Also fixes the post-ActionType-elimination silent-failure where `mapCategory` could not produce `open_position`/`close_position` for v6 events: `positionEffect` is now plumbed through and used as the primary discriminator.
  - **S8** — Add client-side bounds validation to `queuePolicyUpdate`: `approvedApps.length ≤ MAX_ALLOWED_PROTOCOLS` and `maxConcurrentPositions` via existing `requireU8` (0-255, on-chain u8 type). New `MAX_ALLOWED_PROTOCOLS` constant exported from the SDK's main entry.

  **S8 scope note:** Pre-validation intentionally covers only these 2 fields plus existing `timelock`/`dailyCap`/`maxPerTrade`/`developerFeeRate` checks. Other bounded `queuePolicyUpdate` fields (`allowedDestinations` length, `protocolCaps` length-match with protocols, `maxSlippageBps`, `sessionExpirySlots` range) remain on-chain-only — the SDK JSDoc now enumerates which fields are pre-validated vs on-chain-only.

  **Tests added:** 7 queuePolicyUpdate validation tests (approvedApps length boundary both sides, maxConcurrentPositions u8 overflow / negative / non-integer / boundary), 1 toUsdNumber negative-guard test, 1 fromUsdNumber exact-boundary RangeError test.

## 0.2.2

### Patch Changes

- [#174](https://github.com/Kaleb-Rupe/sigil/pull/174) [`f9f874c`](https://github.com/Kaleb-Rupe/sigil/commit/f9f874c877979219dc7d5d7d3cd6ef27d0c443c1) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Remove external protocol bindings (Flash Trade, Kamino) from SDK source and npm package

  Moved 108,700 lines of Codama-generated external protocol code out of `src/generated/protocols/` into a gitignored `generated-protocols/` directory. These files were never imported at runtime and were inflating the published package. The SDK's public API is unchanged — `seal()`, `createVault()`, instruction builders, and all exports remain identical. Protocol bindings can be regenerated locally via `pnpm codama:all`.

## 0.2.1

### Patch Changes

- [#171](https://github.com/Kaleb-Rupe/sigil/pull/171) [`853f965`](https://github.com/Kaleb-Rupe/sigil/commit/853f965fbd682ff9539b98b87ed5064b49ded5be) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix: audit fixes — active session guard, agent_transfer TOCTOU, SDK error codes

  **On-chain program changes:**
  - H-1: Add `active_sessions: u8` counter to AgentVault (SIZE 634→635). Incremented in `validate_and_authorize`, decremented in `finalize_session`. `close_vault` now requires `active_sessions == 0` — prevents vault closure while SPL delegation is active. New error: `ActiveSessionsExist` (6075).
  - M-1: Add `expected_policy_version: u64` parameter to `agent_transfer` with on-chain TOCTOU check via `PolicyVersionMismatch` (6072). Matches existing pattern in `validate_and_authorize`.
  - M-3: Document per-protocol cap simple-window limitation on `get_protocol_spend` and `record_protocol_spend`.

  **SDK changes (@usesigil/kit):**
  - Fix pre-existing error code off-by-1: removed ghost `TimelockActive` entry at code 6027 (deleted from on-chain program but still in SDK), renumbered 44 entries to match IDL.
  - Add 5 missing error codes: `TimelockTooShort` (6071), `PolicyVersionMismatch` (6072), `PendingAgentPermsExists` (6073), `PendingCloseConstraintsExists` (6074), `ActiveSessionsExist` (6075).
  - Fix `extractErrorCode()` bounds: `<= 6069` → `<= 6075`.
  - Codama regeneration: `agentTransfer` instruction gains `expectedPolicyVersion`, `validateAndAuthorize` vault now writable, `AgentVault` gains `activeSessions`.

  **Plugins (@usesigil/plugins):**
  - Patch for compatibility with updated `@usesigil/kit` types.

## 0.2.0

### Minor Changes

- [#169](https://github.com/Kaleb-Rupe/sigil/pull/169) [`926bb76`](https://github.com/Kaleb-Rupe/sigil/commit/926bb7683df4533249dd5b61a0a8d048ba62cfd2) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Add OwnerClient DX convenience layer at `@usesigil/kit/dashboard`. Provides stateless, JSON-serializable owner-side vault management with 6 read functions, 23 mutations, and vault discovery. All amounts are raw bigint with toJSON() for MCP/REST serialization.

## 0.1.0

### Minor Changes

- Initial public release of the Sigil SDK — on-chain guardrails for AI agents on Solana.
