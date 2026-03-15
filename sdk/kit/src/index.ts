// @phalnx/kit — Kit-native SDK for Phalnx
// ESM-only, zero web3.js dependency (except internal compat.ts)

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
  // Permission builder
  PermissionBuilder,
  // Types
  ACTION_PERMISSION_MAP,
  // Overlay constants
  OVERLAY_EPOCH_DURATION,
  OVERLAY_NUM_EPOCHS,
  ROLLING_WINDOW_SECONDS,
} from "./types.js";
export type { Network, PositionEffect } from "./types.js";

// ─── State Resolver ──────────────────────────────────────────────────────────
export {
  resolveVaultState,
  getRolling24hUsd,
  getAgentRolling24hUsd,
  getProtocolSpend,
  bytesToAddress,
} from "./state-resolver.js";
export type {
  EffectiveBudget,
  ProtocolBudget,
  ResolvedVaultState,
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
} from "./events.js";
export type { PhalnxEvent, PhalnxEventName } from "./events.js";

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
  RISK_FLAG_LARGE_OUTFLOW,
  RISK_FLAG_UNKNOWN_RECIPIENT,
  RISK_FLAG_FULL_DRAIN,
  RISK_FLAG_MULTI_OUTPUT,
  RISK_FLAG_SIZE_OVERFLOW,
  RISK_FLAG_ERROR_MAP,
} from "./simulation.js";
export type {
  SimulationOptions,
  SimulationResult,
  SimulationError,
  BalanceDelta,
  RiskFlag,
  DrainDetectionInput,
} from "./simulation.js";

// ─── Token Resolution ─────────────────────────────────────────────────────────
export { resolveToken, toBaseUnits, fromBaseUnits } from "./tokens.js";
export type { ResolvedToken } from "./tokens.js";

// ─── Policy Engine ────────────────────────────────────────────────────────────
export {
  resolvePolicies,
  toCoreAnalysis,
  DEFAULT_POLICIES,
  parseSpendLimit,
} from "./policies.js";
export type {
  ShieldPolicies,
  SpendLimit,
  TransactionAnalysis,
  TokenTransfer,
  SpendingSummary,
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
} from "./agent-errors.js";
export type {
  ErrorCategory,
  RecoveryAction,
  AgentError,
} from "./agent-errors.js";

// ─── Intents ──────────────────────────────────────────────────────────────────
export {
  DEFAULT_INTENT_TTL_MS,
  ACTION_TYPE_MAP,
  summarizeAction,
  resolveProtocolActionType,
} from "./intents.js";
export type {
  IntentAction,
  IntentActionType,
  IntentStatus,
  PrecheckResult,
  ExecuteResult,
  TransactionIntent,
  IntentStorage,
  ProtocolRegistryLike,
} from "./intents.js";

// ─── Intent Validator ─────────────────────────────────────────────────────────
export { validateIntentInput } from "./intent-validator.js";
export type { ValidationResult } from "./intent-validator.js";

// ─── Intent Storage ──────────────────────────────────────────────────────────
export {
  createIntent,
  MemoryIntentStorage,
} from "./intent-storage.js";

// ─── Protocol Handler Interface ──────────────────────────────────────────────
export type {
  ProtocolComposeResult,
  ProtocolContext,
  ProtocolActionDescriptor,
  ProtocolHandlerMetadata,
  ProtocolHandler,
} from "./integrations/protocol-handler.js";

// ─── Protocol Registry ───────────────────────────────────────────────────────
export {
  ProtocolRegistry,
  globalProtocolRegistry,
} from "./integrations/protocol-registry.js";

// ─── Adapter Verifier ────────────────────────────────────────────────────────
export { verifyAdapterOutput } from "./integrations/adapter-verifier.js";
export type { AdapterVerifyResult } from "./integrations/adapter-verifier.js";

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
} from "./inspector.js";

// ─── Jupiter Handler (T1) ───────────────────────────────────────────────────
export {
  deserializeJupiterInstruction,
  JupiterHandler,
} from "./integrations/jupiter-handler.js";
export type { JupiterSerializedInstruction } from "./integrations/jupiter-handler.js";

// ─── T2 Protocol Handlers ───────────────────────────────────────────────────
export {
  DriftHandler,
  FlashTradeHandler,
  KaminoHandler,
  SquadsHandler,
  driftHandler,
  flashTradeHandler,
  kaminoHandler,
  squadsHandler,
} from "./integrations/t2-handlers.js";

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
  SpendingSummary as ShieldSpendingSummary,
  ShieldOptions,
  ShieldedContext,
  ShieldedSignerOptions,
} from "./shield.js";

// ─── Intent Engine ──────────────────────────────────────────────────────────
export { IntentEngine } from "./intent-engine.js";
export type {
  ExplainResult,
  ProtocolInfo,
  ActionInfo,
  IntentEngineConfig,
} from "./intent-engine.js";

// ─── PhalnxKitClient ────────────────────────────────────────────────────────
export { PhalnxKitClient } from "./client.js";
export type { PhalnxKitClientConfig } from "./client.js";

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
export {
  BlockhashCache,
  sendAndConfirmTransaction,
} from "./rpc-helpers.js";
export type {
  Blockhash,
  SendAndConfirmOptions,
} from "./rpc-helpers.js";

// ─── Constraint Builder ──────────────────────────────────────────────────
export {
  // Builder
  ConstraintBuilder,
  ConstraintBudgetExceededError,
  // Flash Trade
  FlashTradeDescriptor,
  FLASH_TRADE_SCHEMA,
  FLASH_TRADE_PROGRAM,
  checkStrictModeWarnings,
  // Kamino
  KaminoDescriptor,
  KAMINO_SCHEMA,
  KAMINO_LENDING_PROGRAM,
  KAMINO_SPENDING_ACTIONS,
  KAMINO_RISK_REDUCING_ACTIONS,
  KAMINO_AMOUNT_CONSTRAINED_ACTIONS,
  // Encoding
  bigintToLeBytes,
  numberToLeBytes,
  mapOperator,
  fieldTypeToSize,
  // Schema constants
  SPENDING_ACTIONS,
  RISK_REDUCING_ACTIONS,
  SIZE_CONSTRAINED_ACTIONS,
  COLLATERAL_CONSTRAINED_ACTIONS,
  ORDER_SIZE_ACTIONS,
} from "./constraints/index.js";
export type {
  FieldType,
  InstructionFieldSchema,
  InstructionSchema,
  ProtocolSchema,
  ProtocolRuleConfig,
  ActionRule,
  CompiledConstraint,
  ProtocolDescriptor,
  ConstraintBuildResult,
  RuleTypeMetadata,
  RuleParamMeta,
} from "./constraints/index.js";

// ─── Flash Trade Analytics ──────────────────────────────────────────────────
export * from "./analytics/index.js";

// ─── Kamino API ──────────────────────────────────────────────────────────
export {
  // Config
  configureKaminoApi,
  getKaminoApiConfig,
  resetKaminoApiConfig,
  KaminoApiError,
  // Data queries
  fetchKaminoMarkets,
  fetchReserveMetrics,
  fetchLeverageMetrics,
  fetchObligations,
  fetchLoanInfo,
  fetchObligationPnl,
  fetchStakingYields,
  fetchUserRewards,
  // Deserialization
  deserializeKaminoInstruction,
} from "./integrations/kamino-api.js";
export type {
  KaminoApiConfig,
  KaminoSerializedInstruction,
  KaminoTxResponse,
  KaminoMarketInfo,
  KaminoReserveMetrics,
  KaminoLeverageMetrics,
  KaminoObligation,
  KaminoLoanInfo,
  KaminoPnl,
  StakingYield,
  KaminoRewards,
} from "./integrations/kamino-api.js";

// ─── Kamino Verification ──────────────────────────────────────────────────
export { verifyKaminoInstructions } from "./integrations/kamino-verify.js";

// ─── Compose Errors ──────────────────────────────────────────────────────
export {
  COMPOSE_ERROR_CODES,
  ComposeError,
  FlashTradeComposeError,
  KaminoComposeError,
  createSafeBigInt,
  createRequireField,
  addressAsSigner,
} from "./integrations/compose-errors.js";
export type { ComposeErrorCode } from "./integrations/compose-errors.js";

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

// ─── Intent-Drift Detection ──────────────────────────────────────────────
export { detectIntentDrift, enforceIntentDrift } from "./intent-drift.js";
export type {
  DriftViolationType,
  DriftViolation,
  DriftCheckResult,
  DriftConfig,
} from "./intent-drift.js";

// NOTE: compat.ts is intentionally NOT exported.
// It is for internal use only when bridging T2 protocol SDKs.
