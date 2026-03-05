// Wrapper — client-side policy enforcement + on-chain hardening

// Main API — harden() and withVault() are the primary entry points
export {
  harden,
  withVault,
  mapPoliciesToVaultParams,
  findNextVaultId,
} from "./harden";
export type { HardenOptions, HardenResult } from "./harden";

// Timelock — owner-signed queue/apply/cancel for timelocked policy updates
export {
  queuePolicyUpdate,
  applyPendingPolicy,
  cancelPendingPolicy,
  fetchPendingPolicyStatus,
  createVaultManager,
  timelockContextFromResult,
} from "./timelock";
export type {
  TimelockPolicyParams,
  TimelockContext,
  VaultManager,
} from "./timelock";

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

// Errors (re-exported from @phalnx/core + TeeRequiredError + attestation errors)
export {
  ShieldDeniedError,
  ShieldConfigError,
  TeeRequiredError,
  TeeAttestationError,
  AttestationCertChainError,
  AttestationPcrMismatchError,
} from "./errors";
export type { PolicyViolation } from "./errors";

// TEE Remote Attestation
export {
  AttestationStatus,
  AttestationCache,
  DEFAULT_CACHE_TTL_MS,
  verifyTeeAttestation,
  clearAttestationCache,
  deleteFromAttestationCache,
  verifyCrossmint,
  verifyPrivy,
  verifyTurnkey,
} from "./tee";
export type {
  TeeProvider,
  AttestationResult,
  AttestationConfig,
  AttestationMetadata,
  AttestationLevel,
  VerifiedTeeWallet,
  NitroPcrValues,
  TurnkeyAttestationBundle,
} from "./tee";

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

// Client-side state (re-exported from @phalnx/core)
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
