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
  // Escrow
  MAX_ESCROW_DURATION,
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
  parseActionType,
  isSpendingAction,
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
  findEscrowsByVault,
  findSessionsByVault,
  getPendingPolicyForVault,
  getPendingConstraintsForVault,
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
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getEscrowPDA,
  getAgentOverlayPDA,
  getConstraintsPDA,
  getPendingConstraintsPDA,
} from "./resolve-accounts.js";

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
export { analyzeInstructions, inspectConstraints } from "./inspector.js";
export type {
  InspectableInstruction,
  TokenTransferInfo,
  InstructionAnalysis,
  DangerousTokenOperation,
  ConstraintSummary,
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
} from "./seal.js";

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
  type SigilLogger,
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

// ─── Protocol Registry + Tier Resolver (v2.2 FE↔BE contract C6) ─────────────
// Hand-curated Verified-tier programId annotations plus the three-tier
// classifier primitives. See FRONTEND-BACKEND-CONTRACT.md §5c.
export {
  PROTOCOL_ANNOTATIONS,
  VERIFIED_PROGRAMS,
  lookupProtocolAnnotation,
} from "./protocol-registry/index.js";
export type { ProtocolAnnotation } from "./protocol-registry/index.js";
export { resolveProtocolTier } from "./protocol-tier.js";
export type {
  ProtocolTrustTier,
  NonConstrainableReason,
  IdlSource,
  ConstrainabilityResult,
  CheckConstrainabilityFn,
} from "./protocol-tier.js";

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
