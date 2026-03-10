// @phalnx/sdk — TypeScript SDK for Phalnx
// On-chain guardrails for AI agents on Solana

export { PhalnxClient, type PhalnxClientOptions } from "./client";
export { IDL } from "./idl-json";

// Simulation
export {
  simulateTransaction,
  isHeliusConnection,
  ANCHOR_ERROR_MAP,
  type SimulationResult,
  type SimulationError,
  type SimulateOptions,
} from "./simulation";

// Intents
export {
  createIntent,
  summarizeAction,
  resolveProtocolActionType,
  MemoryIntentStorage,
  DEFAULT_INTENT_TTL_MS,
  ACTION_TYPE_MAP,
  type IntentAction,
  type IntentActionType,
  type IntentStatus,
  type TransactionIntent,
  type IntentStorage,
  type PrecheckResult,
  type ExecuteResult,
} from "./intents";

// Adapter Verifier
export {
  verifyAdapterOutput,
  type AdapterVerifyResult,
} from "./integrations/adapter-verifier";

// Token Resolution
export {
  resolveToken,
  toBaseUnits,
  fromBaseUnits,
  type ResolvedToken,
} from "./tokens";

// Structured Errors
export { PhalnxSDKError, parseOnChainError, precheckError } from "./errors";

// Agent-First Error System
export {
  toAgentError,
  agentErrorFromCode,
  isAgentError,
  getAllOnChainErrorCodes,
  getAllSdkErrorCodes,
  type ErrorCategory,
  type RecoveryAction,
  type AgentError,
} from "./agent-errors";

// Intent Input Validation
export { validateIntentInput, type ValidationResult } from "./intent-validator";

// IntentEngine (Agent-first facade)
export {
  IntentEngine,
  type ExplainResult,
  type ProtocolInfo,
  type ActionInfo,
} from "./intent-engine";

// Agent Tool Creation
export {
  createPhalnxTools,
  type PhalnxTool,
  type PhalnxToolOptions,
  type PluginName,
} from "./create-tools";

export {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getEscrowPDA,
  getConstraintsPDA,
  getPendingConstraintsPDA,
  getAgentOverlayPDA,
  fetchVault,
  fetchPolicy,
  fetchTracker,
  fetchSession,
  fetchVaultByAddress,
  fetchPolicyByAddress,
  fetchTrackerByAddress,
  fetchPendingPolicy,
  fetchEscrow,
  fetchEscrowByAddress,
  fetchConstraints,
  fetchPendingConstraints,
} from "./accounts";

export {
  buildInitializeVault,
  buildDepositFunds,
  buildRegisterAgent,
  buildUpdatePolicy,
  buildValidateAndAuthorize,
  buildFinalizeSession,
  buildRevokeAgent,
  buildReactivateVault,
  buildFreezeVault,
  buildPauseAgent,
  buildUnpauseAgent,
  buildWithdrawFunds,
  buildCloseVault,
  buildQueuePolicyUpdate,
  buildApplyPendingPolicy,
  buildCancelPendingPolicy,
  buildAgentTransfer,
  buildSyncPositions,
  // Multi-agent
  buildUpdateAgentPermissions,
  // Escrow
  buildCreateEscrow,
  buildSettleEscrow,
  buildRefundEscrow,
  buildCloseSettledEscrow,
  // Constraints
  buildCreateInstructionConstraints,
  buildCloseInstructionConstraints,
  buildUpdateInstructionConstraints,
  buildQueueConstraintsUpdate,
  buildApplyConstraintsUpdate,
  buildCancelConstraintsUpdate,
} from "./instructions";

export {
  composePermittedAction,
  composePermittedTransaction,
  composePermittedSwap,
} from "./composer";

export { rewriteVaultAuthority, validateRewrite } from "./rewriter";

export {
  PriorityFeeEstimator,
  getEstimator,
  estimateComposedCU,
  CU_AGENT_TRANSFER,
  CU_JUPITER_SWAP,
  CU_JUPITER_MULTI_HOP,
  CU_JUPITER_LEND,
  CU_FLASH_TRADE,
  CU_DRIFT,
  CU_KAMINO_LEND,
  CU_DEFAULT_COMPOSED,
  CU_VAULT_CREATION,
  CU_OWNER_ACTION,
  type PriorityFeeConfig,
  type PriorityLevel,
} from "./priority-fees";

export {
  wrapTransaction,
  wrapInstructions,
  type WrapTransactionParams,
} from "./wrap";

export {
  PHALNX_PROGRAM_ID,
  USD_DECIMALS,
  EPOCH_DURATION,
  NUM_EPOCHS,
  PROTOCOL_MODE_ALL,
  PROTOCOL_MODE_ALLOWLIST,
  PROTOCOL_MODE_DENYLIST,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  isStablecoinMint,
  // Multi-agent constants
  MAX_AGENTS_PER_VAULT,
  FULL_PERMISSIONS,
  SWAP_ONLY,
  PERPS_ONLY,
  TRANSFER_ONLY,
  ESCROW_ONLY,
  MAX_ESCROW_DURATION,
  hasPermission,
  isAgentPaused,
  // Type exports
  type Phalnx,
  type AgentEntry,
  type AgentVaultAccount,
  type PolicyConfigAccount,
  type SpendTrackerAccount,
  type SessionAuthorityAccount,
  type EpochBucket,
  type VaultStatus,
  type ActionType,
  type PendingPolicyUpdateAccount,
  // Escrow types
  type EscrowStatus,
  type EscrowDepositAccount,
  // Constraint types
  type ConstraintOperator,
  type DataConstraint,
  type ConstraintEntry,
  type InstructionConstraintsAccount,
  type PendingConstraintsUpdateAccount,
  // Param types
  type InitializeVaultParams,
  type UpdatePolicyParams,
  type QueuePolicyUpdateParams,
  type AgentTransferParams,
  type AuthorizeParams,
  type ComposeActionParams,
  type CreateEscrowParams,
  type SettleEscrowParams,
  type RefundEscrowParams,
  type CreateConstraintsParams,
  type UpdateConstraintsParams,
  type QueueConstraintsUpdateParams,
  type PositionEffect,
  isSpendingAction,
  getPositionEffect,
} from "./types";

export {
  configureJupiterApi,
  getJupiterApiConfig,
  resetJupiterApiConfig,
  jupiterFetch,
  type JupiterApiConfig,
  type JupiterFetchOptions,
} from "./integrations/jupiter-api";

export {
  JUPITER_V6_API,
  JUPITER_PROGRAM_ID,
  JupiterApiError,
  deserializeInstruction,
  fetchJupiterQuote,
  fetchJupiterSwapInstructions,
  fetchAddressLookupTables,
  composeJupiterSwap,
  composeJupiterSwapTransaction,
  type JupiterQuoteParams,
  type JupiterQuoteResponse,
  type JupiterSwapInstructionsResponse,
  type JupiterSwapParams,
  type JupiterSerializedInstruction,
  type JupiterRoutePlanStep,
} from "./integrations/jupiter";

export {
  getJupiterPrices,
  getTokenPriceUsd,
  type JupiterPriceData,
  type JupiterPriceResponse,
} from "./integrations/jupiter-price";

export {
  searchJupiterTokens,
  getTrendingTokens,
  isTokenSuspicious,
  type JupiterTokenInfo,
  type TrendingInterval,
} from "./integrations/jupiter-tokens";

export {
  JUPITER_LEND_PROGRAM_ID,
  JUPITER_BORROW_PROGRAM_ID,
  getJupiterLendTokens,
  getJupiterEarnPositions,
  composeJupiterLendDeposit,
  composeJupiterLendWithdraw,
  type JupiterLendTokenInfo,
  type JupiterEarnPosition,
  type JupiterLendDepositParams,
  type JupiterLendWithdrawParams,
} from "./integrations/jupiter-lend";

export {
  createJupiterTriggerOrder,
  cancelJupiterTriggerOrder,
  getJupiterTriggerOrders,
  type JupiterTriggerOrderParams,
  type JupiterTriggerOrder,
  type TriggerOrderPolicyCheck,
} from "./integrations/jupiter-trigger";

export {
  createJupiterRecurringOrder,
  getJupiterRecurringOrders,
  cancelJupiterRecurringOrder,
  type JupiterRecurringOrderParams,
  type JupiterRecurringOrder,
  type RecurringOrderPolicyCheck,
} from "./integrations/jupiter-recurring";

export {
  getJupiterPortfolio,
  type JupiterPortfolioSummary,
  type JupiterPortfolioPosition,
} from "./integrations/jupiter-portfolio";

export {
  FLASH_TRADE_PROGRAM_ID,
  FLASH_COMPOSABILITY_PROGRAM_ID,
  FLASH_FB_NFT_REWARD_PROGRAM_ID,
  FLASH_REWARD_DISTRIBUTION_PROGRAM_ID,
  Side,
  Privilege,
  createFlashTradeClient,
  getPoolConfig,
  composeFlashTradeOpen,
  composeFlashTradeClose,
  composeFlashTradeIncrease,
  composeFlashTradeDecrease,
  composeFlashTradeAddCollateral,
  composeFlashTradeRemoveCollateral,
  composeFlashTradePlaceTriggerOrder,
  composeFlashTradeEditTriggerOrder,
  composeFlashTradeCancelTriggerOrder,
  composeFlashTradePlaceLimitOrder,
  composeFlashTradeEditLimitOrder,
  composeFlashTradeCancelLimitOrder,
  composeFlashTradeSwapAndOpen,
  composeFlashTradeCloseAndSwap,
  composeFlashTradeTransaction,
  validateDegenMode,
  type FlashTradeConfig,
  type ContractOraclePrice,
  type FlashOpenPositionParams,
  type FlashClosePositionParams,
  type FlashIncreasePositionParams,
  type FlashDecreasePositionParams,
  type FlashAddCollateralParams,
  type FlashRemoveCollateralParams,
  type FlashTriggerOrderParams,
  type FlashEditTriggerOrderParams,
  type FlashCancelTriggerOrderParams,
  type FlashLimitOrderParams,
  type FlashEditLimitOrderParams,
  type FlashCancelLimitOrderParams,
  type FlashSwapAndOpenParams,
  type FlashCloseAndSwapParams,
  type FlashTradeResult,
} from "./integrations/flash-trade";

export {
  reconcilePositions,
  countFlashTradePositions,
} from "./integrations/flash-trade-reconcile";

// --- Protocol Handler Interface + Registry ---

export type {
  ProtocolHandler,
  ProtocolHandlerMetadata,
  ProtocolActionDescriptor,
  ProtocolComposeResult,
  ProtocolContext,
} from "./integrations/protocol-handler";

export {
  ProtocolRegistry,
  globalProtocolRegistry,
} from "./integrations/protocol-registry";

// --- Drift Protocol Adapter ---

export {
  DRIFT_PROGRAM_ID_STR,
  DRIFT_QUOTE_PRECISION,
  DRIFT_BASE_PRECISION,
  DRIFT_PRICE_PRECISION,
  DRIFT_PERP_MARKETS,
  DRIFT_SPOT_MARKETS,
  composeDriftDeposit,
  composeDriftWithdraw,
  composeDriftPlacePerpOrder,
  composeDriftPlaceSpotOrder,
  composeDriftCancelOrder,
  composeDriftModifyOrder,
  composeDriftSettlePnl,
  type DriftDepositParams,
  type DriftWithdrawParams,
  type DriftPlacePerpOrderParams,
  type DriftPlaceSpotOrderParams,
  type DriftCancelOrderParams,
  type DriftModifyOrderParams,
  type DriftSettlePnlParams,
  type DriftComposeResult,
} from "./integrations/drift";

export { DriftHandler } from "./integrations/drift-handler";

// --- Kamino Lending Adapter ---

export {
  KAMINO_LEND_PROGRAM_ID_STR,
  KAMINO_MAIN_MARKET_STR,
  composeKaminoDeposit,
  composeKaminoBorrow,
  composeKaminoRepay,
  composeKaminoWithdraw,
  type KaminoDepositParams,
  type KaminoBorrowParams,
  type KaminoRepayParams,
  type KaminoWithdrawParams,
  type KaminoComposeResult,
} from "./integrations/kamino";

export { KaminoHandler } from "./integrations/kamino-handler";

export {
  SQUADS_V4_PROGRAM_ID,
  getSquadsMultisigPda,
  getSquadsVaultPda,
  getSquadsTransactionPda,
  getSquadsProposalPda,
  createSquadsMultisig,
  proposeVaultAction,
  approveProposal,
  rejectProposal,
  executeVaultTransaction,
  fetchMultisigInfo,
  fetchProposalInfo,
  proposeInitializeVault,
  proposeUpdatePolicy,
  proposeQueuePolicyUpdate,
  proposeApplyPendingPolicy,
  proposeSyncPositions,
  type SquadsMember,
  type CreateSquadsMultisigParams,
  type ProposeVaultActionParams,
  type ApproveProposalParams,
  type RejectProposalParams,
  type ExecuteVaultTransactionParams,
  type MultisigInfo,
  type ProposalInfo,
  type ProposeInitializeVaultParams,
  type ProposeUpdatePolicyParams,
  type ProposeQueuePolicyUpdateParams,
  type ProposeApplyPendingPolicyParams,
  type ProposeSyncPositionsParams,
} from "./integrations/squads";

// --- Wrapper (client-side policy enforcement + on-chain hardening) ---

export {
  harden,
  withVault,
  mapPoliciesToVaultParams,
  findNextVaultId,
  shieldWallet,
  queuePolicyUpdate,
  applyPendingPolicy,
  cancelPendingPolicy,
  fetchPendingPolicyStatus,
  createVaultManager,
  timelockContextFromResult,
} from "./wrapper";
export type {
  HardenOptions,
  HardenResult,
  TimelockPolicyParams,
  TimelockContext,
  VaultManager,
} from "./wrapper";

export type {
  ShieldedWallet,
  WalletLike,
  ShieldOptions,
  TeeWallet,
  ShieldPolicies,
  SpendLimit,
  SpendingSummary,
  RateLimitConfig,
  PolicyCheckResult,
  TransactionAnalysis,
  TokenTransfer,
  ResolvedPolicies,
  PolicyViolation,
  ShieldStorage,
  ClientSpendEntry,
  TxEntry,
} from "./wrapper";

export {
  isTeeWallet,
  parseSpendLimit,
  resolvePolicies,
  DEFAULT_POLICIES,
  ShieldDeniedError,
  ShieldConfigError,
  TeeRequiredError,
  TransactionSimulationError,
  // TEE Remote Attestation
  TeeAttestationError,
  AttestationCertChainError,
  AttestationPcrMismatchError,
  AttestationStatus,
  AttestationCache,
  DEFAULT_CACHE_TTL_MS,
  verifyTeeAttestation,
  clearAttestationCache,
  deleteFromAttestationCache,
  verifyCrossmint,
  verifyPrivy,
  verifyTurnkey,
  analyzeTransaction,
  getNonSystemProgramIds,
  resolveTransactionAddressLookupTables,
  extractInstructions,
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  SYSTEM_PROGRAMS,
  getTokenInfo,
  getProtocolName,
  isSystemProgram,
  isKnownProtocol,
  ShieldState,
  evaluatePolicy,
  enforcePolicy,
  recordTransaction,
  // Dry-run policy evaluation
  dryRunPolicy,
  // x402 — HTTP 402 payment support
  shieldedFetch,
  createShieldedFetchForWallet,
  selectPaymentOption,
  evaluateX402Payment,
  buildX402TransferInstruction,
  encodeX402Payload,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
  X402ParseError,
  X402PaymentError,
  X402UnsupportedError,
} from "./wrapper";

export type {
  ShieldedFetchOptions,
  ShieldedFetchResponse,
  X402PaymentResult,
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  ResourceInfo,
  SettleResponse,
  // Dry-run types
  DryRunInput,
  DryRunIntent,
  DryRunResult,
  DryRunSpendingSummary,
  FeeEstimate,
  // TEE Remote Attestation types
  TeeProvider,
  AttestationResult,
  AttestationConfig,
  AttestationMetadata,
  AttestationLevel,
  VerifiedTeeWallet,
  NitroPcrValues,
  TurnkeyAttestationBundle,
} from "./wrapper";
