// Wrapper — client-side policy enforcement + on-chain hardening

// Main API — harden() and withVault() are the primary entry points
export {
  harden,
  withVault,
  mapPoliciesToVaultParams,
  findNextVaultId,
} from "./harden";
export type { HardenOptions, HardenResult } from "./harden";

// Types (kept for advanced users and framework integrators)
export type { ShieldedWallet, WalletLike, ShieldOptions } from "./shield";
export { isTeeWallet } from "./shield";
export type { TeeWallet } from "./shield";

// Public client-side-only API (re-export shield() under its public name)
export { shield as shieldWallet } from "./shield";

// Policy configuration (wrapper types — accepts PublicKey | string)
export type {
  ShieldPolicies,
  SpendLimit,
  SpendingSummary,
  RateLimitConfig,
  PolicyCheckResult,
  TransactionAnalysis,
  TokenTransfer,
  ResolvedPolicies,
} from "./policies";
export { parseSpendLimit, resolvePolicies, DEFAULT_POLICIES } from "./policies";

// Errors (re-exported from @agent-shield/core + TeeRequiredError)
export {
  ShieldDeniedError,
  ShieldConfigError,
  TeeRequiredError,
} from "./errors";
export type { PolicyViolation } from "./errors";

// Transaction inspection (Solana-specific)
export {
  analyzeTransaction,
  getNonSystemProgramIds,
  resolveTransactionAddressLookupTables,
  extractInstructions,
} from "./inspector";

// Protocol & token registry (wrapper versions — accept PublicKey | string)
export {
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  SYSTEM_PROGRAMS,
  getTokenInfo,
  getProtocolName,
  isSystemProgram,
  isKnownProtocol,
} from "./registry";

// Client-side state (re-exported from @agent-shield/core)
export { ShieldState } from "./state";
export type {
  ShieldStorage,
  SpendEntry as ClientSpendEntry,
  TxEntry,
} from "./state";

// Policy engine (wrapper versions — accept PublicKey-based TransactionAnalysis)
export { evaluatePolicy, enforcePolicy, recordTransaction } from "./engine";

// x402 — HTTP 402 payment support
export {
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
} from "./x402";
export type {
  ShieldedFetchOptions,
  ShieldedFetchResponse,
  X402PaymentResult,
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  ResourceInfo,
  SettleResponse,
} from "./x402";
