// x402 — Kit-native HTTP 402 Payment Required support
// Barrel exports

// Types
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
} from "./types.js";

// Errors
export {
  X402ParseError,
  X402PaymentError,
  X402UnsupportedError,
  X402DestinationBlockedError,
  X402ReplayError,
} from "./errors.js";

// Codec
export {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
  base64Encode,
  base64Decode,
} from "./codec.js";

// Payment Selector
export { selectPaymentOption } from "./payment-selector.js";

// Transfer Builder
export {
  buildX402TransferInstruction,
  deriveAta,
  transferToInspectable,
  TOKEN_PROGRAM_ID as X402_TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID as X402_ATA_PROGRAM_ID,
} from "./transfer-builder.js";

// Nonce Tracker
export { NonceTracker } from "./nonce-tracker.js";

// Amount Guard
export {
  validatePaymentAmount,
  recordPaymentAmount,
  resetPaymentHistory,
} from "./amount-guard.js";

// Policy Bridge
export { evaluateX402Payment, recordX402Spend } from "./policy-bridge.js";

// Facilitator Verification
export { validateSettlement } from "./facilitator-verify.js";
export type { FacilitatorVerifyResult } from "./facilitator-verify.js";

// Audit Trail
export { emitPaymentEvent, createPaymentEvent } from "./audit-trail.js";

// Core: shieldedFetch
export { shieldedFetch, createShieldedFetch } from "./shielded-fetch.js";
