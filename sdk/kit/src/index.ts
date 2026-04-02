// @usesigil/kit — Kit-native SDK for Sigil
// ESM-only, zero web3.js dependency

// ─── Generated Client ─────────────────────────────────────────────────────────
export * from "./generated/index.js";

// ─── Type Constants + Permissions ─────────────────────────────────────────────
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
  FULL_PERMISSIONS,
  SWAP_ONLY,
  PERPS_ONLY,
  TRANSFER_ONLY,
  ESCROW_ONLY,
  PERPS_FULL,
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
  hasPermission,
  permissionsToStrings,
  stringsToPermissions,
  parseActionType,
  isSpendingAction,
  getPositionEffect,
  validateNetwork,
  normalizeNetwork,
  toInstruction,
  // Permission builder
  PermissionBuilder,
  // Types
  ACTION_PERMISSION_MAP,
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
  signAndEncode,
  sendAndConfirmTransaction,
} from "./rpc-helpers.js";
export type { Blockhash, SendAndConfirmOptions } from "./rpc-helpers.js";

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

// ─── Balance Tracker / P&L ──────────────────────────────────────────────────
export {
  getVaultPnL,
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
