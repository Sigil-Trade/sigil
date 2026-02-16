// Errors
export { ShieldDeniedError, ShieldConfigError } from "./errors";
export type { PolicyViolation } from "./errors";

// Policy configuration
export type {
  ShieldPolicies,
  SpendLimit,
  RateLimitConfig,
  PolicyCheckResult,
  TransactionAnalysis,
  TokenTransfer,
  ResolvedPolicies,
} from "./policies";
export { parseSpendLimit, resolvePolicies, DEFAULT_POLICIES } from "./policies";

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
export type { ShieldStorage, SpendEntry, TxEntry } from "./state";

// Policy engine
export { evaluatePolicy, enforcePolicy, recordTransaction } from "./engine";
