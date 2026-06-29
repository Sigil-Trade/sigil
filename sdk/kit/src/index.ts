// @usesigil/kit — Kit-native SDK for Sigil
// ESM-only, zero web3.js dependency

// ─── Generated Client ─────────────────────────────────────────────────────────
//
// v0.9.0 barrel surgery (A12): was `export * from "./generated/index.js"`
// which pulled ~500 Codama exports (37 instruction builders + 60+ event/
// struct types + 82 hex error constants) into the root barrel. Consumers
// should go through `seal()` / `createSigilClient()` / `createVault()` for
// instruction building, and `SIGIL_PROGRAM_ADDRESS` (re-exported from
// `types.js` below) for the program ID. Account decoders stay public —
// they're the supported way to parse vault state fetched from an RPC.
export * from "./generated/accounts/index.js";

// ─── Type Constants + Capability ──────────────────────────────────────────────
//
// Legacy 21-bit permission bitmasks and their helpers (`SWAP_ONLY`,
// `PERPS_ONLY`, `TRANSFER_ONLY`, `ESCROW_ONLY`, `PERPS_FULL`,
// `ACTION_PERMISSION_MAP`, `hasPermission`, `permissionsToStrings`,
// `stringsToPermissions`, `PermissionBuilder`) were DELETED in the A11
// cleanup — they encoded a pre-v6 permission model the on-chain program no
// longer supports. Use {@link FULL_CAPABILITY} (2n) for operator agents and
// put granular per-action restrictions in `InstructionConstraints`.
export {
  // Program
  SIGIL_PROGRAM_ADDRESS,
  // USD
  USD_DECIMALS,
  // Branded types (PR 2.B — H7-BRAND)
  type UsdBaseUnits,
  type CapabilityTier,
  type Slot,
  usd,
  capability,
  slot,
  // Multi-agent
  MAX_AGENTS_PER_VAULT,
  MAX_ALLOWED_PROTOCOLS,
  FULL_CAPABILITY,
  FULL_PERMISSIONS,
  // Well-known program addresses (PR 3.B — F036 constant dedup)
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  ATA_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  // Protocol registry (PR 3.B — F042 unified registry)
  SUPPORTED_PROTOCOLS,
  type ProtocolMeta,
  // Slippage
  MAX_SLIPPAGE_BPS,
  // Protocol mode
  PROTOCOL_MODE_ALL,
  PROTOCOL_MODE_ALLOWLIST,
  PROTOCOL_MODE_DENYLIST,
  // Stablecoin mints
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  JUPITER_PROGRAM_ADDRESS,
  RECOGNIZED_DEFI_PROGRAMS,
  // Functions
  isStablecoinMint,
  validateNetwork,
  normalizeNetwork,
  // u64 boundary
  U64_MAX,
} from "./types.js";
export type { Network, NetworkInput } from "./types.js";

// ─── State Resolver ──────────────────────────────────────────────────────────
export {
  resolveVaultState,
  resolveVaultStateForOwner,
  resolveVaultBudget,
  getRolling24hUsd,
  getAgentRolling24hUsd,
  getProtocolSpend,
  getSpendingHistory,
  findVaultsByOwner,
  findSessionsByVault,
  getPendingPolicyForVault,
} from "./state-resolver.js";
export type {
  EffectiveBudget,
  ProtocolBudget,
  SpendingEpoch,
  ResolvedVaultState,
  ResolvedVaultStateForOwner,
  ResolvedBudget,
  VaultLocator,
  /** @deprecated Use VaultLocator. Removed at v1.0. */
  DiscoveredVault,
} from "./state-resolver.js";

// ─── PDA Resolution ───────────────────────────────────────────────────────────
export {
  getVaultPDA,
  // H-5 (audit 2026-05-21): post-ownership-transfer PDA helper.
  // Use this AFTER an ownership transfer — derives from the IMMUTABLE
  // `vault.vault_authority` instead of the mutable `vault.owner`.
  getVaultPdaFromState,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getAgentOverlayPDA,
  getAuditLogSuccessPDA,
  getAuditLogRejectedPDA,
} from "./resolve-accounts.js";
export type { VaultPdaSeedSource } from "./resolve-accounts.js";

// ─── Phase 7 — Audit Log ─────────────────────────────────────────────────────
export {
  fetchAuditLogSuccess,
  fetchAuditLogRejected,
  subjectBytes,
  // `targetProtocolBytes` alias removed in Phase 10 Bucket 1 (D-item cleanup;
  // §RP-1 HIGH-2 2026-05-19 deprecation promised removal). Use `subjectBytes`.
  AUDIT_DISC_RESERVED_ZERO,
  AUDIT_DISC_VALIDATE,
  AUDIT_DISC_FINALIZE_SUCCESS,
  AUDIT_DISC_FINALIZE_REJECT,
  AUDIT_DISC_DEPOSIT,
  AUDIT_DISC_WITHDRAW,
  AUDIT_DISC_FREEZE,
  AUDIT_DISC_REACTIVATE,
  AUDIT_DISC_OWNERSHIP_INITIATE,
  AUDIT_DISC_OWNERSHIP_ACCEPT,
  AUDIT_DISC_OWNERSHIP_CANCEL,
  AUDIT_DISC_PAUSE_AGENT,
  AUDIT_DISC_UNPAUSE_AGENT,
  AUDIT_DISC_REVOKE_AGENT,
  AUDIT_DISC_REGISTER_AGENT,
  AUDIT_DISC_POLICY_APPLY,
  AUDIT_DISC_CONSTRAINTS_APPLY,
  AUDIT_LOG_SUCCESS_CAPACITY,
  AUDIT_LOG_REJECTED_CAPACITY,
} from "./audit-log.js";
export type { AuditLogView } from "./audit-log.js";

// ─── Event Parser ─────────────────────────────────────────────────────────────
export {
  parseSigilEvents,
  filterEvents,
  getEventNames,
  decodeSigilEvent,
  parseAndDecodeSigilEvents,
} from "./events.js";
export type {
  SigilEvent,
  SigilEventName,
  DecodedSigilEvent,
} from "./events.js";

// ─── Priority Fees ────────────────────────────────────────────────────────────
export {
  estimateComposedCU,
  PriorityFeeEstimator,
  CU_AGENT_TRANSFER,
  CU_JUPITER_SWAP,
  CU_JUPITER_MULTI_HOP,
  CU_FLASH_TRADE,
  CU_JUPITER_LEND,
  CU_DRIFT,
  CU_KAMINO_LEND,
  CU_DEFAULT_COMPOSED,
  CU_VAULT_CREATION,
  CU_OWNER_ACTION,
} from "./priority-fees.js";
export type { PriorityLevel, PriorityFeeConfig } from "./priority-fees.js";

// ─── Simulation ───────────────────────────────────────────────────────────────
export {
  simulateBeforeSend,
  detectDrainAttempt,
  detectDrainFromSealContext,
  adjustCU,
  parseTokenBalance,
  RISK_FLAG_LARGE_OUTFLOW,
  RISK_FLAG_UNKNOWN_RECIPIENT,
  RISK_FLAG_FULL_DRAIN,
  RISK_FLAG_MULTI_OUTPUT,
  RISK_FLAG_SIZE_OVERFLOW,
  RISK_FLAG_ERROR_MAP,
  DEFAULT_WARNING_PERCENT,
  DEFAULT_BLOCK_PERCENT,
} from "./simulation.js";
export type {
  SimulationOptions,
  SimulationResult,
  SimulationError,
  BalanceDelta,
  RiskFlag,
  DrainDetectionInput,
  DrainThresholds,
} from "./simulation.js";

// ─── Token Resolution ─────────────────────────────────────────────────────────
export { resolveToken, toBaseUnits, fromBaseUnits } from "./tokens.js";
export type { ResolvedToken } from "./tokens.js";

// ─── Display Formatting ──────────────────────────────────────────────────────
export {
  formatUsd,
  formatUsdCompact,
  formatUsdSigned,
  formatPercent,
  formatPercentSigned,
  formatDuration,
  formatRelativeTime,
  formatTimeUntil,
  formatAddress,
  formatTokenAmount,
  formatTokenAmountCompact,
  // Precision helpers — convert between bigint base units and Number dollars
  toUsdNumber,
  fromUsdNumber,
} from "./formatting.js";

// ─── Spending Analytics ──────────────────────────────────────────────────────
export {
  getSpendingVelocity,
  getSpendingBreakdown,
  getAgentSpendingHistory,
} from "./spending-analytics.js";
export type {
  SpendingVelocity,
  SpendingBreakdown,
} from "./spending-analytics.js";

// ─── Event Analytics ─────────────────────────────────────────────────────────
export {
  categorizeEvent,
  describeEvent,
  buildActivityItem,
  getVaultActivity,
} from "./event-analytics.js";
export type { EventCategory, VaultActivityItem } from "./event-analytics.js";

// ─── Security Analytics ──────────────────────────────────────────────────────
export {
  getSecurityPosture,
  evaluateAlertConditions,
  getAuditTrail,
  getAuditTrailSummary,
} from "./security-analytics.js";
export type {
  SecurityPosture,
  SecurityCheck,
  Alert,
  AuditEntry,
  AuditTrailSummary,
} from "./security-analytics.js";

// ─── Agent Analytics ─────────────────────────────────────────────────────────
export {
  getAgentProfile,
  getAgentLeaderboard,
  getAgentComparison,
  getAgentErrorBreakdown,
} from "./agent-analytics.js";
export type {
  AgentProfile,
  AgentRanking,
  AgentComparisonData,
  AgentErrorBreakdown,
} from "./agent-analytics.js";

// ─── Portfolio Analytics ─────────────────────────────────────────────────────
export {
  getPortfolioOverview,
  aggregatePortfolio,
  getCrossVaultAgentRanking,
  getAgentLeaderboardAcrossVaults,
  getPortfolioTimeSeries,
} from "./portfolio-analytics.js";
export type {
  PortfolioOverview,
  CrossVaultAgentRanking,
  PortfolioTimeSeries,
} from "./portfolio-analytics.js";

// ─── Protocol Analytics ──────────────────────────────────────────────────────
export {
  getProtocolBreakdown,
  getProtocolUsageAcrossVaults,
} from "./protocol-analytics.js";
export type {
  ProtocolBreakdownItem,
  PlatformProtocolUsage,
} from "./protocol-analytics.js";

// ─── Advanced Analytics ──────────────────────────────────────────────────────
export {
  getSlippageEfficiency,
  getCapVelocity,
  getSessionDeviationRate,
  getIdleCapitalDuration,
  getPermissionEscalationLatency,
  getInstructionCoverageRatio,
  getPermissionUtilizationRate,
} from "./advanced-analytics.js";
export type {
  SlippageReport,
  CapVelocityReport,
  DeviationReport,
  IdleCapitalReport,
  EscalationReport,
  CoverageReport,
  PermissionUtilization,
} from "./advanced-analytics.js";

// ─── Protocol Names ──────────────────────────────────────────────────────────
export { resolveProtocolName, PROTOCOL_NAMES } from "./protocol-names.js";

// ─── Vault Analytics ─────────────────────────────────────────────────────────
export { getVaultHealth, getVaultSummary } from "./vault-analytics.js";
export type {
  VaultHealth,
  VaultSummary,
  VaultStats,
  VaultSecurityCheck,
} from "./vault-analytics.js";

// ─── Policy Engine ────────────────────────────────────────────────────────────
export {
  resolvePolicies,
  validateSpendLimitMints,
  DEFAULT_POLICIES,
  parseSpendLimit,
} from "./policies.js";
export type {
  ShieldPolicies,
  SpendLimit,
  TransactionAnalysis,
  TokenTransfer,
  ResolvedPolicies,
  RateLimitConfig,
  PolicyCheckResult,
} from "./policies.js";

// ─── TEE Attestation (public verification surface) ──────────────────────────
export {
  AttestationStatus,
  VALID_TEE_PROVIDERS,
  isTeeWallet,
  TeeAttestationError,
  AttestationCertChainError,
  AttestationPcrMismatchError,
  verifyTeeAttestation,
  verifyCrossmint,
  verifyPrivy,
  verifyTurnkey,
} from "./tee/index.js";
export type {
  TeeWallet,
  TeeProvider,
  AttestationResult,
  VerifiedTeeWallet,
} from "./tee/index.js";

// ─── Agent Errors ─────────────────────────────────────────────────────────────
export {
  toAgentError,
  toSigilAgentError,
  SigilSdkError,
  protocolEscalationError,
  parseOnChainErrorCode,
  isAgentError,
  getAllOnChainErrorCodes,
  getAllSdkErrorCodes,
  categorizeError,
} from "./agent-errors.js";
export type {
  ErrorCategory,
  RecoveryAction,
  AgentError,
  SigilErrorCategory,
} from "./agent-errors.js";

// ─── Phase 9 Batch I — AL3 SealInput intent digest ──────────────────────────
export {
  computeSealInputDigest,
  NETWORK_ID_DEVNET,
  NETWORK_ID_MAINNET,
} from "./seal/intent-digest.js";
export type { SealIntentInput } from "./seal/intent-digest.js";

// ─── Phase 9 Batch H — TA-19 policy preview digest helpers ──────────────────
// `computeAgentSetHash` is the canonical client-side mirror of the on-chain
// `compute_agent_set_hash`. It was previously reachable only via deep import
// (`@usesigil/kit/policy/compute-policy-preview-digest`); promoting it to
// the root barrel keeps the TA-19 binding contract symmetric with the
// `buildCosignBundle` surface and matches the D-9 root-export audit (Phase
// 10 Bucket 1). `computePolicyPreviewDigest` and friends remain reachable
// via the deep import for advanced consumers building custom preview UIs.
export { computeAgentSetHash } from "./policy/compute-policy-preview-digest.js";

// ─── Phase 9 Batch K — AL2 mainnet confirmation gate error codes ────────────
export {
  SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
  SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REJECTED,
} from "./errors/codes.js";

// ─── Phase 9 Batch J — AL4 isMainnet + CAIP-2 network identity ──────────────
export {
  CAIP2_NAMESPACE_SOLANA,
  CAIP2_SOLANA_MAINNET,
  CAIP2_SOLANA_DEVNET,
  CAIP2_SOLANA_TESTNET,
  toCaip2,
  isMainnetCaip2,
  deriveNetworkIdentity,
  // Phase 10 Bucket 1 (D-7): Wallet Standard chain identifier helper.
  // Identity transform over CAIP-2 today; the explicit helper localizes
  // any future wallet-standard surface changes.
  toWalletStandardChain,
  // M-3 (audit 2026-05-21): opt-in genesis-hash verification helper +
  // canonical hash constants. Additive; does not change default seal()
  // behaviour — assertGenesisHash still gates the createSigilClientAsync
  // factory path. Use verifyNetworkIdentity for preflight checks in
  // raw-tx-building flows that bypass the client factory.
  verifyNetworkIdentity,
  SOLANA_GENESIS_HASHES,
} from "./caip2-network.js";
export type {
  SigilCaip2Chain,
  SigilNetwork,
  SigilActualNetwork,
  NetworkIdentityResult,
  GenesisRpc,
} from "./caip2-network.js";

// ─── Phase 9 Batch E — multisig / session / attestation / ownership helpers ─
// `SQUADS_V4_PROGRAM_ID`, `detectSquadsV4Owner`, and `SquadsDetectionResult`
// are exported from the existing `./squads-detection.js` block lower in this
// file; multisig-detection.ts wraps them with the discriminator check
// (`isSquadsV4Owned`) without re-exporting the underlying primitives.
export {
  SQUADS_V4_MULTISIG_DISCRIMINATOR,
  isSquadsV4Owned,
} from "./multisig-detection.js";
export type { MultisigDetectionResult } from "./multisig-detection.js";

export { mintSessionForAgent } from "./session-mint.js";
export type { MintSessionForAgentInputs } from "./session-mint.js";

export { getLatestPolicyAttestation } from "./policy-attestation.js";
export type { PolicyAttestation } from "./policy-attestation.js";

export {
  buildInitiateOwnershipTransferIx,
  buildAcceptOwnershipTransferIx,
  buildAcceptOwnershipTransferMultisigIx,
  buildCancelOwnershipTransferIx,
} from "./ownership-transfer.js";
export type {
  BuildInitiateOwnershipTransferInputs,
  BuildAcceptOwnershipTransferInputs,
  BuildAcceptOwnershipTransferMultisigInputs,
  BuildCancelOwnershipTransferInputs,
  InitiateOwnershipTransferInstruction,
  AcceptOwnershipTransferInstruction,
  AcceptOwnershipTransferMultisigInstruction,
  CancelOwnershipTransferInstruction,
} from "./ownership-transfer.js";

// ─── Protocol Resolver ───────────────────────────────────────────────────────
export {
  ProtocolTier,
  isProtocolAllowed,
  resolveProtocol,
} from "./protocol-resolver.js";
export type {
  ProtocolResolution,
  EscalationInfo,
} from "./protocol-resolver.js";

// ─── Inspector ───────────────────────────────────────────────────────────────
export { analyzeInstructions } from "./inspector.js";
export type {
  InspectableInstruction,
  TokenTransferInfo,
  InstructionAnalysis,
  DangerousTokenOperation,
} from "./inspector.js";

// ─── Shield ─────────────────────────────────────────────────────────────────
export {
  ShieldState,
  ShieldDeniedError,
  evaluateInstructions,
  shield,
  createShieldedSigner,
} from "./shield.js";
export type {
  PolicyViolation,
  ShieldCheckResult,
  SpendingSummary,
  ShieldOptions,
  ShieldedContext,
  ShieldedSignerOptions,
} from "./shield.js";

// ─── Seal ──────────────────────────────────────────────────────────────────
export {
  seal,
  createSigilClient,
  /** @deprecated Use createSigilClient(). Removed at v1.0. */
  SigilClient,
  replaceAgentAtas,
} from "./seal.js";
export type { SigilClientApi } from "./seal.js";
export type {
  SealParams,
  SealResult,
  SigilClientConfig,
  ClientSealOpts,
  ExecuteResult,
  TransferOptions,
  TransferResult,
} from "./seal.js";

// ─── Agent Transfer (standalone direct payout — NOT a seal() sandwich) ───────
export { buildAgentTransfer } from "./agent-transfer.js";
export type { BuildAgentTransferOptions } from "./agent-transfer.js";

// ─── Create Vault ──────────────────────────────────────────────────────────
// ─── Sprint 2: Sigil Facade + SigilVault + Hooks + Plugins ──────────────────
export { Sigil } from "./sigil.js";
export type {
  SigilQuickstartOptions,
  SigilQuickstartResult,
  FundedOutcome,
  FromVaultOptions,
} from "./sigil.js";

export { SigilVault } from "./vault-handle.js";
export type {
  SigilVaultExecuteOptions,
  SigilVaultInternalState,
  TxOpts as SigilVaultTxOpts,
  TxResult as SigilVaultTxResult,
} from "./vault-handle.js";

export { composeHooks, invokeHook, newCorrelationId } from "./hooks.js";
export type {
  SealHooks,
  SealHookContext,
  SealHookAbort,
  OnBeforeBuildResult,
} from "./hooks.js";

export { runPlugins, validatePluginList } from "./plugin.js";
export type {
  SigilPolicyPlugin,
  PluginContext,
  PluginResult,
  PluginAllow,
  PluginReject,
} from "./plugin.js";

export { createVault, createAndSendVault } from "./create-vault.js";
export type {
  CreateVaultOptions,
  CreateVaultResult,
  CreateAndSendVaultOptions,
  CreateAndSendVaultResult,
} from "./create-vault.js";

// ─── Vault Presets ───────────────────────────────────────────────────────────
export {
  VAULT_PRESETS,
  getPreset,
  listPresets,
  presetToCreateVaultFields,
  // v0.9.0 A10: orthogonal SAFETY_PRESETS for timelock + cap defaults.
  SAFETY_PRESETS,
  applySafetyPreset,
  requireResolvedSafetyPreset,
} from "./presets.js";
export type {
  VaultPreset,
  PresetName,
  SafetyPresetFields,
  SafetyPresetName,
} from "./presets.js";

// ─── v0.9.0 helpers (A3, A4, A9) ────────────────────────────────────────────
// Strict USD parser, policy-gated ATA builder, aggregate cap validator.
export { parseUsd } from "./helpers/parse-usd.js";
export {
  initializeVaultAtas,
  type InitializeVaultAtasParams,
} from "./helpers/ata.js";
export {
  validateAgentCapAggregate,
  type ValidateAgentCapAggregateParams,
} from "./helpers/validate-cap-aggregate.js";

// ─── v0.9.0 logger (A5) ─────────────────────────────────────────────────────
// SigilLogger interface + NOOP_LOGGER default + createConsoleLogger opt-in.
// setSigilModuleLogger / getSigilModuleLogger are for SDK internals; the
// consumer-facing install point is SigilClient.create(config.logger).
export {
  NOOP_LOGGER,
  createConsoleLogger,
  resolveLogger,
  setSigilModuleLogger,
  getSigilModuleLogger,
  sanitizeNoop,
  structuredWarn,
  structuredError,
  type SigilLogger,
  type StructuredWarnSanitizer,
} from "./logger.js";

// ─── v0.9.0 genesis hash constants (A7) ─────────────────────────────────────
export {
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_GENESIS_HASH,
} from "./seal.js";

// ─── Owner Transaction ───────────────────────────────────────────────────────
export { buildOwnerTransaction } from "./owner-transaction.js";
export type {
  BuildOwnerTransactionParams,
  OwnerTransactionResult,
} from "./owner-transaction.js";

// ─── Build Unsigned (S21) ────────────────────────────────────────────────────
// Public composer for offline signing. Wraps `buildOwnerTransaction()` so
// callers without a `TransactionSigner` (Squads multisig flows, CLI cold-key
// signing, cost-preview UIs) can pass a plain `Address` and receive a
// serialized unsigned-tx buffer + decoded message in one call.
export { buildUnsigned } from "./build-unsigned.js";
export type {
  BuildUnsignedInput,
  BuildUnsignedResult,
} from "./build-unsigned.js";

// ─── Preview Create Vault (v2.2 FE↔BE contract C1) ──────────────────────────
// Wraps `createVault` + `buildOwnerTransaction` into a single preview call
// that returns rent + PDA list + cost + unsigned tx in one shot. Drives the
// dashboard's split-screen `/onboard` flow per FRONTEND-BACKEND-CONTRACT.md
// §3.3 + §5a C1.
export { previewCreateVault } from "./preview-create-vault.js";
export type {
  CreateVaultPreview,
  VaultPdaInfo,
  VaultPdaName,
  PreviewWarning,
  PreviewCreateVaultConfig,
} from "./preview-create-vault.js";

// ─── TA-09 Cosign Helper (G4 audit close) ───────────────────────────────────
// Client-side path to produce a valid cosign session + digest for elevated
// `queue_policy_update` mutations (raising caps, expanding allowlists,
// lowering floor, raising per-recipient cap). The on-chain handler at
// queue_policy_update.rs:286-328 rejects elevated mutations without cosign;
// this helper produces the matching digest mirroring the canonical Rust
// `compute_cosign_digest` byte-for-byte.
export { buildCosignBundle } from "./cosign-helper.js";
export type { CosignArgs, CosignBundle } from "./cosign-helper.js";
export {
  computeCosignDigest,
  cosignDigestsEqual,
} from "./policy/compute-cosign-digest.js";
export type { CosignDigestFields } from "./policy/compute-cosign-digest.js";
// Elevated agent-permissions cosign digest (audit 2026-06-12). Mirrors the
// on-chain compute_agent_perms_cosign_digest byte-for-byte.
export { computeAgentPermsCosignDigest } from "./policy/compute-agent-perms-cosign-digest.js";
export type { AgentPermsCosignDigestFields } from "./policy/compute-agent-perms-cosign-digest.js";

// ─── TA-18 / G6 — Squads V4 Detection Helper (audit 2026-05-18) ─────────────
// Read-only off-chain helper that inspects whether a vault owner pubkey is
// owned by the Squads V4 multisig program. Used by the dashboard to decide
// whether to suppress the "single-signer protection" warning banner when
// `policy.cosign_required = false`. NOT an on-chain enforcement primitive —
// Sigil makes no assumption about the multisig's threshold or configuration.
// See sdk/kit/src/squads-detection.ts for the full AC-2 mode framing.
export {
  SQUADS_V4_PROGRAM_ID,
  detectSquadsV4Owner,
} from "./squads-detection.js";
export type { SquadsDetectionResult } from "./squads-detection.js";

// ─── Error Classification (typed predicates + transport classifier) ─────────
//
// Shared helpers used across `seal`, `shielded-fetch`, `facilitator-verify`,
// and the dashboard reads. Consumers building their own retry/backoff or
// observability layers should reach for these before rolling their own.
export { isAccountNotFoundError } from "./dashboard/errors.js";
export {
  isTransportError,
  redactCause,
  PROVIDER_DENIAL_NAMES,
  TRANSPORT_CODES,
} from "./network-errors.js";

// ─── Core Policy Engine (public surface only — internals hidden in v0.13) ───
// Kit's shield.ts defines its own ShieldState, ShieldDeniedError, PolicyViolation.
// Kit's policies.ts defines its own ShieldPolicies etc. evaluatePolicy /
// enforcePolicy / recordTransaction / ShieldStorage / SpendEntry / TxEntry /
// VelocityTracker / VelocityConfig / SpendStatus were removed from the root
// barrel in v0.13 — they were internal orchestrators for `shield()` and
// `vault.budget()` which consumers should call directly.
export { ShieldConfigError } from "./core/index.js";
export {
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  SYSTEM_PROGRAMS,
  getTokenInfo,
  getProtocolName,
  isKnownProtocol,
  isSystemProgram,
} from "./core/index.js";

// ─── Unified Error Taxonomy (PR 2.A) ─────────────────────────────────────────
// SigilError base class + four domain classes + canonical SigilErrorCode
// constants + per-domain code unions + SigilErrorContext map + walk helper.
// All error classes (ShieldDeniedError, TeeAttestationError, X402ParseError,
// ComposeError, etc.) extend a domain class which extends SigilError.
// Exception: SigilSdkError — see its JSDoc for the deferral note (UD3 + R4).
//
// Aliased to `SigilKitError` publicly to avoid a name collision with the
// generated on-chain Anchor error enum (`SigilError` from generated/errors/sigil.ts).
// Internally the class is still called `SigilError`; the rename happens at
// the public export boundary. Internal code in sdk/kit/src/ continues to
// use `SigilError`. Targeted full rename for a follow-up cleanup PR.
// v0.9.0 A12: the 49 `SIGIL_ERROR__*` code constants are no longer
// re-exported from the root barrel — import them from the `./errors`
// subpath: `import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "@usesigil/kit/errors"`.
// Error classes + domain-union types stay at root for catch-block narrowing.
export {
  SigilError as SigilKitError,
  SigilShieldError,
  SigilTeeError,
  SigilX402Error,
  SigilComposeError,
  SigilSdkDomainError,
  SigilRpcError,
  SIGIL_KIT_VERSION,
  walk as walkSigilCause,
  type SigilErrorParameters,
  type SigilErrorCode,
  type SigilShieldErrorCode,
  type SigilTeeErrorCode,
  type SigilComposeErrorCode,
  type SigilX402ErrorCode,
  type SigilSdkErrorCode,
  type SigilRpcErrorCode,
  type SigilProgramErrorCode,
  type SigilErrorContext,
} from "./errors/index.js";

/** Per-module discriminated union of x402 errors (viem ErrorType pattern). */
export type X402ErrorType =
  | import("./x402/errors.js").X402ParseError
  | import("./x402/errors.js").X402PaymentError
  | import("./x402/errors.js").X402UnsupportedError
  | import("./x402/errors.js").X402DestinationBlockedError
  | import("./x402/errors.js").X402ReplayError;

/** Per-module discriminated union of TEE errors. */
export type TeeErrorType =
  | import("./tee/wallet-types.js").TeeAttestationError
  | import("./tee/wallet-types.js").AttestationCertChainError
  | import("./tee/wallet-types.js").AttestationPcrMismatchError;

/** Per-module discriminated union of compose errors. */
export type ComposeErrorType =
  import("./integrations/compose-errors.js").ComposeError;

/** Per-module discriminated union of shield errors. */
export type ShieldErrorType =
  | import("./core/errors.js").ShieldDeniedError
  | import("./core/errors.js").ShieldConfigError;

/**
 * Per-module discriminated union for `seal()` / `SigilClient.executeAndConfirm`.
 *
 * NOTE on `SigilSdkError`: per UD3 + R4 deferral, that class extends `Error`
 * directly (not `SigilError`). It IS in this union, so consumers narrowing
 * via `SealErrorType` catch it correctly. The `| Error` tail is honest:
 * raw `@solana/kit` `SolanaError` instances also propagate through `seal()`
 * unwrapped today (a follow-up PR will introduce `SigilRpcError` wrapping).
 */
export type SealErrorType =
  | import("./agent-errors.js").SigilSdkError
  | import("./core/errors.js").ShieldDeniedError
  | import("./tee/wallet-types.js").TeeAttestationError
  | Error;

/** Per-module discriminated union for OwnerClient (dashboard reads + mutations). */
export type DashboardErrorType =
  | import("./agent-errors.js").SigilSdkError
  | import("./core/errors.js").ShieldDeniedError
  | Error;

// ─── Dashboard / Owner Client ────────────────────────────────────────────────
// Re-exported from the dashboard subpath for convenience. Consumers preferring
// a single import path can use these; the dashboard subpath remains the
// canonical source with additional exports (fromJSON, overview builders).
export { createOwnerClient, OwnerClient } from "./dashboard/index.js";
export type { OwnerClientConfig } from "./dashboard/types.js";
// Elevated-cosign surface (audit 2026-06-12): the partial-sign handoff bundle.
// Elevated changes use the same PolicyChanges input (elevation is direction-
// dependent — see PolicyChanges docs); the elevated mutations are OwnerClient
// methods (queue*Elevated / buildQueue*Elevated).
export type {
  ElevatedCosignBundle,
  CosignedActionBundle,
} from "./dashboard/mutations.js";

// ─── Balance Tracker / P&L ──────────────────────────────────────────────────
export {
  getVaultPnL,
  getVaultPnLFromState,
  getVaultTokenBalances,
  getBalancePnL,
  BalanceSnapshotStore,
} from "./balance-tracker.js";
export type {
  TokenBalance,
  BalanceSnapshot,
  VaultPnL,
  BalancePnL,
} from "./balance-tracker.js";

// ─── Agent handoff bootstrap (v2.2 FE↔BE contract C5) ───────────────────────
// Canonical handoff-prompt composition for Claude Desktop / ChatGPT / CLI.
// See FRONTEND-BACKEND-CONTRACT.md §3.4 + §5a C5.
export {
  composeAgentBootstrap,
  getHandoffPromptTemplate,
  capabilityTierToNames,
} from "./agent-bootstrap.js";
export type {
  AgentBootstrap,
  AgentBootstrapConfig,
} from "./agent-bootstrap.js";

// ─── Verified-build program hash (Item 3 — TA-19 verified-build gate) ────────
// Computes sha256 of a deployed program's ELF from its BPFLoaderUpgradeable
// ProgramData account — the value an owner pins into PolicyConfig.protocol_hashes
// so validate_and_authorize can reject an upgraded (drain) build. Mirrors
// programs/sigil/src/utils/program_hash.rs byte-for-byte.
export {
  getProgramDataHash,
  getProgramDataAddress,
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  PROGRAM_DATA_HEADER_LEN,
} from "./program-hash.js";
// Item 1 — intent-named wrapper an owner calls to ARM the verified-build gate
// (`PolicyChanges.protocolHashes`). Hash only; the digest/array assembly lives
// in the policy mutation builders.
export { computeVerifiedBuildHash } from "./policy/verified-build.js";
