// Core API
export { shield } from "./shield";
export type { ShieldedWallet, WalletLike, ShieldOptions } from "./shield";

// Policy configuration
export type {
  ShieldPolicies,
  SpendLimit,
  RateLimitConfig,
  PolicyCheckResult,
  TransactionAnalysis,
  TokenTransfer,
} from "./policies";
export { parseSpendLimit, resolvePolicies, DEFAULT_POLICIES } from "./policies";

// Errors
export { ShieldDeniedError, ShieldConfigError } from "./errors";
export type { PolicyViolation } from "./errors";

// Transaction inspection
export { analyzeTransaction, getNonSystemProgramIds } from "./inspector";

// Protocol & token registry
export {
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  SYSTEM_PROGRAMS,
  getTokenInfo,
  getProtocolName,
  isSystemProgram,
  isKnownProtocol,
} from "./registry";

// Client-side state
export { ShieldState } from "./state";
export type { ShieldStorage } from "./state";

// Policy engine
export { evaluatePolicy, enforcePolicy } from "./engine";

// On-chain upgrade (optional — requires @agent-shield/sdk)
export { harden } from "./harden";
export type { HardenOptions } from "./harden";
