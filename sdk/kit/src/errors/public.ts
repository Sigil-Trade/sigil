/**
 * @usesigil/kit/errors — public error-code subpath.
 *
 * Explicit named re-exports of every `SIGIL_ERROR__*` discriminant defined in
 * `./codes.ts`. Importing from this subpath (rather than from the package
 * root) keeps consumer bundles small — the root barrel should not re-export
 * these once Sprint 1 of the SDK redesign lands.
 *
 * Usage:
 *   import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "@usesigil/kit/errors";
 *
 * This file is the public contract. If a new error domain or discriminant
 * is added in `./codes.ts`, it must be re-exported here (or the test
 * `tests/errors/public-subpath.test.ts` will fail).
 */

// Shield domain — policy enforcement (4)
export {
  SIGIL_ERROR__SHIELD__POLICY_DENIED,
  SIGIL_ERROR__SHIELD__CONFIG_INVALID,
  SIGIL_ERROR__SHIELD__RATE_LIMIT_EXCEEDED,
  SIGIL_ERROR__SHIELD__SESSION_BINDING,
} from "./codes.js";

// TEE domain — attestation + custody (3)
export {
  SIGIL_ERROR__TEE__ATTESTATION_FAILED,
  SIGIL_ERROR__TEE__CERT_CHAIN_INVALID,
  SIGIL_ERROR__TEE__PCR_MISMATCH,
} from "./codes.js";

// Compose domain — DeFi instruction composition (3)
export {
  SIGIL_ERROR__COMPOSE__MISSING_PARAM,
  SIGIL_ERROR__COMPOSE__INVALID_BIGINT,
  SIGIL_ERROR__COMPOSE__UNSUPPORTED_ACTION,
} from "./codes.js";

// x402 domain — HTTP 402 payments (5)
export {
  SIGIL_ERROR__X402__HEADER_MALFORMED,
  SIGIL_ERROR__X402__PAYMENT_FAILED,
  SIGIL_ERROR__X402__UNSUPPORTED,
  SIGIL_ERROR__X402__DESTINATION_BLOCKED,
  SIGIL_ERROR__X402__REPLAY,
} from "./codes.js";

// SDK domain — config + runtime + state (26)
export {
  SIGIL_ERROR__SDK__INVALID_CONFIG,
  SIGIL_ERROR__SDK__INVALID_PARAMS,
  SIGIL_ERROR__SDK__INVALID_NETWORK,
  SIGIL_ERROR__SDK__INVALID_AMOUNT,
  SIGIL_ERROR__SDK__INVALID_CAPABILITY,
  SIGIL_ERROR__SDK__INVALID_ACTION_TYPE,
  SIGIL_ERROR__SDK__OWNER_AGENT_COLLISION,
  SIGIL_ERROR__SDK__VAULT_NOT_FOUND,
  SIGIL_ERROR__SDK__VAULT_INACTIVE,
  SIGIL_ERROR__SDK__VAULT_SLOTS_EXHAUSTED,
  SIGIL_ERROR__SDK__POLICY_NOT_FOUND,
  SIGIL_ERROR__SDK__AGENT_NOT_REGISTERED,
  SIGIL_ERROR__SDK__AGENT_PAUSED,
  SIGIL_ERROR__SDK__AGENT_ZERO_CAPABILITY,
  SIGIL_ERROR__SDK__SIGNER_INVALID,
  SIGIL_ERROR__SDK__SIGNATURE_INVALID,
  SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
  SIGIL_ERROR__SDK__PROTOCOL_NOT_ALLOWED,
  SIGIL_ERROR__SDK__PROTOCOL_NOT_TARGETED,
  SIGIL_ERROR__SDK__INSTRUCTION_COUNT,
  SIGIL_ERROR__SDK__CAP_EXCEEDED,
  SIGIL_ERROR__SDK__ATA_NON_CANONICAL,
  SIGIL_ERROR__SDK__ALT_INTEGRITY,
  SIGIL_ERROR__SDK__ALT_NOT_DEPLOYED,
  SIGIL_ERROR__SDK__SEAL_FAILED,
  SIGIL_ERROR__SDK__UNKNOWN,
} from "./codes.js";

// RPC domain — transport + simulation (7)
export {
  SIGIL_ERROR__RPC__TX_FAILED,
  SIGIL_ERROR__RPC__CONFIRMATION_TIMEOUT,
  SIGIL_ERROR__RPC__SIMULATION_FAILED,
  SIGIL_ERROR__RPC__DRAIN_DETECTED,
  SIGIL_ERROR__RPC__TX_TOO_LARGE,
  SIGIL_ERROR__RPC__RATE_LIMITED,
  SIGIL_ERROR__RPC__INSTRUCTION_REQUIRED,
} from "./codes.js";

// Program domain — on-chain Anchor errors surfaced to the SDK (1)
export { SIGIL_ERROR__PROGRAM__GENERIC } from "./codes.js";

// ---------------------------------------------------------------------------
// Type re-exports — error-code union types for exhaustive-switch narrowing.
// Types cost zero bytes in the output bundle but make /errors self-contained
// for TypeScript consumers who want to narrow on `.code` in catch blocks.
// ---------------------------------------------------------------------------

export type {
  SigilErrorCode,
  SigilShieldErrorCode,
  SigilTeeErrorCode,
  SigilComposeErrorCode,
  SigilX402ErrorCode,
  SigilSdkErrorCode,
  SigilRpcErrorCode,
  SigilProgramErrorCode,
} from "./codes.js";
