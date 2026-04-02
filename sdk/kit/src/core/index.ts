// Errors
export { ShieldDeniedError, ShieldConfigError } from "./errors.js";
export type { PolicyViolation } from "./errors.js";

// Policy configuration
export type {
  ShieldPolicies,
  SpendLimit,
  RateLimitConfig,
  PolicyCheckResult,
  TransactionAnalysis,
  TokenTransfer,
  ResolvedPolicies,
} from "./policies.js";
export { parseSpendLimit, resolvePolicies, DEFAULT_POLICIES } from "./policies.js";

// Protocol & token registry
export {
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  SYSTEM_PROGRAMS,
  getTokenInfo,
  getProtocolName,
  isSystemProgram,
  isKnownProtocol,
} from "./registry.js";

// Client-side state
export { ShieldState } from "./state.js";
export type { ShieldStorage, SpendEntry, TxEntry } from "./state.js";

// Policy engine
export { evaluatePolicy, enforcePolicy, recordTransaction } from "./engine.js";
