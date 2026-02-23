// @agentshield/sdk — TypeScript SDK for AgentShield
// On-chain guardrails for AI agents on Solana

export { AgentShieldClient, type AgentShieldClientOptions } from "./client";
export { IDL } from "./idl-json";

export {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getOracleRegistryPDA,
  fetchVault,
  fetchPolicy,
  fetchTracker,
  fetchSession,
  fetchVaultByAddress,
  fetchPolicyByAddress,
  fetchTrackerByAddress,
  fetchPendingPolicy,
  fetchOracleRegistry,
} from "./accounts";

export {
  buildInitializeOracleRegistry,
  buildUpdateOracleRegistry,
  buildInitializeVault,
  buildDepositFunds,
  buildRegisterAgent,
  buildUpdatePolicy,
  buildValidateAndAuthorize,
  buildFinalizeSession,
  buildRevokeAgent,
  buildReactivateVault,
  buildWithdrawFunds,
  buildCloseVault,
  buildQueuePolicyUpdate,
  buildApplyPendingPolicy,
  buildCancelPendingPolicy,
  buildAgentTransfer,
} from "./instructions";

export {
  composePermittedAction,
  composePermittedTransaction,
  composePermittedSwap,
} from "./composer";

export { rewriteVaultAuthority, validateRewrite } from "./rewriter";

export {
  wrapTransaction,
  wrapInstructions,
  type WrapTransactionParams,
} from "./wrap";

export {
  PYTH_RECEIVER_PROGRAM,
  SWITCHBOARD_ON_DEMAND_PROGRAM,
  PYTH_FEEDS,
  SWITCHBOARD_FEEDS,
  resolveOracleFeed,
  detectOracleSource,
} from "./oracle";

export {
  AGENT_SHIELD_PROGRAM_ID,
  USD_DECIMALS,
  EPOCH_DURATION,
  NUM_EPOCHS,
  PROTOCOL_MODE_ALL,
  PROTOCOL_MODE_ALLOWLIST,
  PROTOCOL_MODE_DENYLIST,
  type AgentShield,
  type AgentVaultAccount,
  type PolicyConfigAccount,
  type SpendTrackerAccount,
  type OracleRegistryAccount,
  type SessionAuthorityAccount,
  type OracleEntry,
  type EpochBucket,
  type VaultStatus,
  type ActionType,
  type PendingPolicyUpdateAccount,
  type InitializeVaultParams,
  type UpdatePolicyParams,
  type QueuePolicyUpdateParams,
  type AgentTransferParams,
  type AuthorizeParams,
  type OracleSource,
  type ComposeActionParams,
  type InitializeOracleRegistryParams,
  type UpdateOracleRegistryParams,
} from "./types";

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
  composeFlashTradeTransaction,
  type FlashTradeConfig,
  type ContractOraclePrice,
  type FlashOpenPositionParams,
  type FlashClosePositionParams,
  type FlashIncreasePositionParams,
  type FlashDecreasePositionParams,
  type FlashTradeResult,
} from "./integrations/flash-trade";

// --- Wrapper (client-side policy enforcement + on-chain hardening) ---

export {
  harden,
  withVault,
  mapPoliciesToVaultParams,
  findNextVaultId,
  shieldWallet,
} from "./wrapper";
export type { HardenOptions, HardenResult } from "./wrapper";

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
} from "./wrapper";
