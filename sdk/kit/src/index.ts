// @phalnx/kit — Kit-native SDK for Phalnx
// ESM-only, zero web3.js dependency

// ─── Generated Client ─────────────────────────────────────────────────────────
export * from "./generated/index.js";

// ─── Type Constants + Permissions ─────────────────────────────────────────────
export {
  // Program
  PHALNX_PROGRAM_ADDRESS,
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
  // Functions
  isStablecoinMint,
  hasPermission,
  permissionsToStrings,
  parseActionType,
  isSpendingAction,
  getPositionEffect,
  validateNetwork,
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
export type { Network, PositionEffect } from "./types.js";

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
  PHALNX_ALT_DEVNET,
  PHALNX_ALT_MAINNET,
  getPhalnxAltAddress,
} from "./alt-config.js";
export { AltCache, mergeAltAddresses } from "./alt-loader.js";

// ─── Transaction Composer ─────────────────────────────────────────────────────
export {
  composePhalnxTransaction,
  validateTransactionSize,
  measureTransactionSize,
} from "./composer.js";
export type { ComposeTransactionParams } from "./composer.js";

// ─── Event Parser ─────────────────────────────────────────────────────────────
export {
  parsePhalnxEvents,
  filterEvents,
  getEventNames,
  decodePhalnxEvent,
  parseAndDecodePhalnxEvents,
} from "./events.js";
export type {
  PhalnxEvent,
  PhalnxEventName,
  DecodedPhalnxEvent,
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
export type {
  EventCategory,
  VaultActivityItem,
} from "./event-analytics.js";

// ─── Security Analytics ──────────────────────────────────────────────────────
export {
  getSecurityPosture,
  evaluateAlertConditions,
  getAuditTrail,
} from "./security-analytics.js";
export type {
  SecurityPosture,
  SecurityCheck,
  Alert,
  AuditEntry,
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
export {
  getVaultHealth,
  getVaultSummary,
} from "./vault-analytics.js";
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
  PhalnxErrorCategory,
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

// ─── Wrap ──────────────────────────────────────────────────────────────────
export { wrap, PhalnxClient, replaceAgentAtas } from "./wrap.js";
export type { WrapParams, WrapResult, PhalnxClientConfig, ClientWrapOpts, ExecuteResult } from "./wrap.js";

// ─── Create Vault ──────────────────────────────────────────────────────────
export { createVault } from "./create-vault.js";
export type { CreateVaultOptions, CreateVaultResult } from "./create-vault.js";

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

// ─── Harden / withVault ─────────────────────────────────────────────────────
export {
  mapPoliciesToVaultParams,
  findNextVaultId,
  harden,
  withVault,
} from "./harden.js";
export type {
  HardenOptions,
  HardenResult,
  WithVaultOptions,
  WithVaultResult,
} from "./harden.js";

// ─── Transaction Executor ──────────────────────────────────────────────────
export { TransactionExecutor } from "./transaction-executor.js";
export type {
  ExecuteTransactionParams,
  ExecuteTransactionResult,
  TransactionExecutorOptions,
} from "./transaction-executor.js";

// ─── RPC Helpers ───────────────────────────────────────────────────────────
export { BlockhashCache, signAndEncode, sendAndConfirmTransaction } from "./rpc-helpers.js";
export type { Blockhash, SendAndConfirmOptions } from "./rpc-helpers.js";

// ─── x402 HTTP 402 Payment Required ───────────────────────────────────────
export {
  // Core
  shieldedFetch,
  createShieldedFetch,
  // Codec
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
  // Selector
  selectPaymentOption,
  // Transfer Builder
  buildX402TransferInstruction,
  deriveAta,
  transferToInspectable,
  X402_TOKEN_PROGRAM_ID,
  X402_ATA_PROGRAM_ID,
  // Nonce Tracker
  NonceTracker,
  // Amount Guard
  validatePaymentAmount,
  recordPaymentAmount,
  resetPaymentHistory,
  // Policy Bridge
  evaluateX402Payment,
  recordX402Spend,
  // Facilitator
  validateSettlement,
  // Audit
  emitPaymentEvent,
  createPaymentEvent,
  // Errors
  X402ParseError,
  X402PaymentError,
  X402UnsupportedError,
  X402DestinationBlockedError,
  X402ReplayError,
} from "./x402/index.js";
export type {
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  PaymentPayload,
  SettleResponse,
  X402Config,
  ShieldedFetchOptions,
  ShieldedFetchResponse,
  X402PaymentResult,
  X402PaymentEvent,
  FacilitatorVerifyResult,
} from "./x402/index.js";

// ─── VelocityTracker ──────────────────────────────────────────────────────
export { VelocityTracker } from "./velocity-tracker.js";
export type { VelocityConfig, SpendStatus } from "./velocity-tracker.js";

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
