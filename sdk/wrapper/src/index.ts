// Core API
export { shield } from "./shield";
export type { ShieldedWallet, WalletLike, ShieldOptions } from "./shield";

// Policy configuration (wrapper types — accepts PublicKey | string)
export type {
  ShieldPolicies,
  SpendLimit,
  SpendingSummary,
  RateLimitConfig,
  PolicyCheckResult,
  TransactionAnalysis,
  TokenTransfer,
} from "./policies";
export { parseSpendLimit, resolvePolicies, DEFAULT_POLICIES } from "./policies";

// Errors (re-exported from @agent-shield/core)
export { ShieldDeniedError, ShieldConfigError } from "./errors";
export type { PolicyViolation } from "./errors";

// Transaction inspection (Solana-specific)
export {
  analyzeTransaction,
  getNonSystemProgramIds,
  resolveTransactionAddressLookupTables,
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
export type { ShieldStorage } from "./state";

// Policy engine (wrapper versions — accept PublicKey-based TransactionAnalysis)
export { evaluatePolicy, enforcePolicy } from "./engine";

// On-chain upgrade (optional — requires @agent-shield/sdk)
export { harden } from "./harden";
export type { HardenOptions } from "./harden";
