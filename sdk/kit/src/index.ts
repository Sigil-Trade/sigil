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
} from "./types.js";
export type { PositionEffect } from "./types.js";

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

// ─── Transaction Composer ─────────────────────────────────────────────────────
export {
  composePhalnxTransaction,
  validateTransactionSize,
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
} from "./shield.js";
export type {
  PolicyViolation,
  ShieldCheckResult,
  SpendingSummary as ShieldSpendingSummary,
  ShieldOptions,
  ShieldedContext,
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

// NOTE: compat.ts is intentionally NOT exported.
// It is for internal use only when bridging T2 protocol SDKs.
