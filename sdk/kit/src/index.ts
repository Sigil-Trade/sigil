// @usesigil/kit — Kit-native SDK for Sigil
// ESM-only, zero web3.js dependency

// ─── Generated Client ─────────────────────────────────────────────────────────
export * from "./generated/index.js";

// ─── Type Constants + Permissions ─────────────────────────────────────────────
//
// The legacy 21-bit permission bitmasks (`SWAP_ONLY`, `PERPS_ONLY`,
// `TRANSFER_ONLY`, `ESCROW_ONLY`, `PERPS_FULL`), the `ACTION_PERMISSION_MAP`
// table, and the permission helpers built on top of them (`hasPermission`,
// `permissionsToStrings`, `stringsToPermissions`, `PermissionBuilder`) are no
// longer re-exported here. They encode a pre-v6 permission model that the
// on-chain program replaced with a 2-bit capability enum (`0 = Disabled`,
// `1 = Observer`, `2 = Operator`), and the presets that previously used those
// bitmasks now register agents with invalid capability values (either
// silently Observer or rejected with `InvalidArgument`). Use
// {@link FULL_CAPABILITY} / {@link FULL_PERMISSIONS} (both equal `2n`) for
// any preset or vault-creation flow that needs spending authority.
export {
  // Program
  SIGIL_PROGRAM_ADDRESS,
  // Fee constants
  FEE_RATE_DENOMINATOR,
  PROTOCOL_FEE_RATE,
  MAX_DEVELOPER_FEE_RATE,
  PROTOCOL_TREASURY,
  // USD
  USD_DECIMALS,
  // Multi-agent
  MAX_AGENTS_PER_VAULT,
  MAX_ALLOWED_PROTOCOLS,
  FULL_CAPABILITY,
  FULL_PERMISSIONS,
  // Escrow
  MAX_ESCROW_DURATION,
  // Slippage
  MAX_SLIPPAGE_BPS,
  // SpendTracker
  EPOCH_DURATION,
  NUM_EPOCHS,
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
  getPositionEffect,
  validateNetwork,
  normalizeNetwork,
  toInstruction,
  // Overlay constants
  OVERLAY_EPOCH_DURATION,
  OVERLAY_NUM_EPOCHS,
  ROLLING_WINDOW_SECONDS,
  // u64 boundary
  U64_MAX,
} from "./types.js";
export type { Network, NetworkInput, PositionEffect } from "./types.js";

// ─── State Resolver ──────────────────────────────────────────────────────────
export {
  resolveVaultState,
  resolveVaultStateForOwner,
  resolveVaultBudget,
  getRolling24hUsd,
  getAgentRolling24hUsd,
  getProtocolSpend,
  getSpendingHistory,
  bytesToAddress,
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
  resolveAccounts,
} from "./resolve-accounts.js";
export type {
  ResolveAccountsInput,
  ResolvedAccounts,
} from "./resolve-accounts.js";

// ─── ALT (Address Lookup Table) ──────────────────────────────────────────────
export {
  SIGIL_ALT_DEVNET,
  SIGIL_ALT_MAINNET,
  getSigilAltAddress,
} from "./alt-config.js";
export { AltCache, mergeAltAddresses } from "./alt-loader.js";

// ─── Transaction Composer ─────────────────────────────────────────────────────
export {
  composeSigilTransaction,
  validateTransactionSize,
  measureTransactionSize,
} from "./composer.js";
export type { ComposeTransactionParams } from "./composer.js";

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
  toCoreAnalysis,
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

// ─── TEE Attestation ──────────────────────────────────────────────────────────
export {
  AttestationStatus,
  AttestationCache,
  DEFAULT_CACHE_TTL_MS,
  VALID_TEE_PROVIDERS,
  isTeeWallet,
  TeeAttestationError,
  AttestationCertChainError,
  AttestationPcrMismatchError,
  verifyTeeAttestation,
  clearAttestationCache,
  deleteFromAttestationCache,
  verifyCrossmint,
  verifyPrivy,
  verifyTurnkey,
} from "./tee/index.js";
export type {
  WalletLike,
  TeeWallet,
  TeeProvider,
  AttestationResult,
  AttestationConfig,
  AttestationMetadata,
  AttestationLevel,
  VerifiedTeeWallet,
  NitroPcrValues,
  TurnkeyAttestationBundle,
} from "./tee/index.js";

// ─── Custody Adapter ────────────────────────────────────────────────────────
export { custodyAdapterToTransactionSigner } from "./custody-adapter.js";
export type { CustodyAdapter } from "./custody-adapter.js";

// ─── Agent Errors ─────────────────────────────────────────────────────────────
export {
  ON_CHAIN_ERROR_MAP,
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
export { seal, SigilClient, replaceAgentAtas } from "./seal.js";
export type {
  SealParams,
  SealResult,
  SigilClientConfig,
  ClientSealOpts,
  ExecuteResult,
} from "./seal.js";

// ─── Create Vault ──────────────────────────────────────────────────────────
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
} from "./presets.js";
export type { VaultPreset, PresetName } from "./presets.js";

// ─── Owner Transaction ───────────────────────────────────────────────────────
export { buildOwnerTransaction } from "./owner-transaction.js";
export type {
  BuildOwnerTransactionParams,
  OwnerTransactionResult,
} from "./owner-transaction.js";

// ─── Inscribe / withVault ─────────────────────────────────────────────────────
export {
  mapPoliciesToVaultParams,
  findNextVaultId,
  inscribe,
  withVault,
} from "./inscribe.js";
export type {
  InscribeOptions,
  InscribeResult,
  WithVaultOptions,
  WithVaultResult,
} from "./inscribe.js";

// ─── Transaction Executor ──────────────────────────────────────────────────
export { TransactionExecutor } from "./transaction-executor.js";
export type {
  ExecuteTransactionParams,
  ExecuteTransactionResult,
  TransactionExecutorOptions,
} from "./transaction-executor.js";

// ─── RPC Helpers ───────────────────────────────────────────────────────────
export {
  BlockhashCache,
  getBlockhashCache,
  signAndEncode,
  sendAndConfirmTransaction,
} from "./rpc-helpers.js";
export type { Blockhash, SendAndConfirmOptions } from "./rpc-helpers.js";

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

// ─── VelocityTracker ──────────────────────────────────────────────────────
export { VelocityTracker } from "./velocity-tracker.js";
export type { VelocityConfig, SpendStatus } from "./velocity-tracker.js";

// ─── Core Policy Engine ──────────────────────────────────────────────────────
// Non-conflicting core exports only. Kit's shield.ts defines its own
// ShieldState, ShieldDeniedError, PolicyViolation. Kit's policies.ts defines
// its own ShieldPolicies, SpendLimit, TransactionAnalysis, TokenTransfer,
// ResolvedPolicies, resolvePolicies. DEFAULT_POLICIES, parseSpendLimit,
// RateLimitConfig, PolicyCheckResult already flow through policies.ts.
export { ShieldConfigError } from "./core/index.js";
export {
  evaluatePolicy,
  enforcePolicy,
  recordTransaction,
} from "./core/index.js";
export {
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  SYSTEM_PROGRAMS,
  getTokenInfo,
  getProtocolName,
  isKnownProtocol,
  isSystemProgram,
} from "./core/index.js";
export type { ShieldStorage, SpendEntry, TxEntry } from "./core/index.js";

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
  // Code constants — all 47.
  SIGIL_ERROR__SHIELD__POLICY_DENIED,
  SIGIL_ERROR__SHIELD__CONFIG_INVALID,
  SIGIL_ERROR__SHIELD__RATE_LIMIT_EXCEEDED,
  SIGIL_ERROR__SHIELD__SESSION_BINDING,
  SIGIL_ERROR__TEE__ATTESTATION_FAILED,
  SIGIL_ERROR__TEE__CERT_CHAIN_INVALID,
  SIGIL_ERROR__TEE__PCR_MISMATCH,
  SIGIL_ERROR__COMPOSE__MISSING_PARAM,
  SIGIL_ERROR__COMPOSE__INVALID_BIGINT,
  SIGIL_ERROR__COMPOSE__UNSUPPORTED_ACTION,
  SIGIL_ERROR__X402__HEADER_MALFORMED,
  SIGIL_ERROR__X402__PAYMENT_FAILED,
  SIGIL_ERROR__X402__UNSUPPORTED,
  SIGIL_ERROR__X402__DESTINATION_BLOCKED,
  SIGIL_ERROR__X402__REPLAY,
  SIGIL_ERROR__SDK__INVALID_CONFIG,
  SIGIL_ERROR__SDK__INVALID_PARAMS,
  SIGIL_ERROR__SDK__INVALID_NETWORK,
  SIGIL_ERROR__SDK__INVALID_AMOUNT,
  SIGIL_ERROR__SDK__INVALID_CAPABILITY,
  SIGIL_ERROR__SDK__INVALID_ACTION_TYPE,
  SIGIL_ERROR__SDK__OWNER_AGENT_COLLISION,
  SIGIL_ERROR__SDK__VAULT_NOT_FOUND,
  SIGIL_ERROR__SDK__VAULT_INACTIVE,
  SIGIL_ERROR__SDK__VAULT_SLOTS_EXHAUSTED,
  SIGIL_ERROR__SDK__POLICY_NOT_FOUND,
  SIGIL_ERROR__SDK__AGENT_NOT_REGISTERED,
  SIGIL_ERROR__SDK__AGENT_PAUSED,
  SIGIL_ERROR__SDK__AGENT_ZERO_CAPABILITY,
  SIGIL_ERROR__SDK__SIGNER_INVALID,
  SIGIL_ERROR__SDK__SIGNATURE_INVALID,
  SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
  SIGIL_ERROR__SDK__PROTOCOL_NOT_ALLOWED,
  SIGIL_ERROR__SDK__PROTOCOL_NOT_TARGETED,
  SIGIL_ERROR__SDK__INSTRUCTION_COUNT,
  SIGIL_ERROR__SDK__CAP_EXCEEDED,
  SIGIL_ERROR__SDK__ATA_NON_CANONICAL,
  SIGIL_ERROR__SDK__ALT_INTEGRITY,
  SIGIL_ERROR__SDK__ALT_NOT_DEPLOYED,
  SIGIL_ERROR__SDK__SEAL_FAILED,
  SIGIL_ERROR__SDK__UNKNOWN,
  SIGIL_ERROR__RPC__TX_FAILED,
  SIGIL_ERROR__RPC__CONFIRMATION_TIMEOUT,
  SIGIL_ERROR__RPC__SIMULATION_FAILED,
  SIGIL_ERROR__RPC__DRAIN_DETECTED,
  SIGIL_ERROR__RPC__TX_TOO_LARGE,
  SIGIL_ERROR__RPC__RATE_LIMITED,
  SIGIL_ERROR__RPC__INSTRUCTION_REQUIRED,
  SIGIL_ERROR__PROGRAM__GENERIC,
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
