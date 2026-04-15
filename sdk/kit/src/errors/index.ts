/**
 * @usesigil/kit error taxonomy — public barrel.
 *
 * Re-exports the SigilError base, all four domain classes, the SigilErrorCode
 * union + per-domain subsets, the SigilErrorContext map, and the walk helper.
 *
 * Leaf classes (ShieldDeniedError, X402ParseError, TeeAttestationError, etc.)
 * are exported from their existing modules — re-exported through src/index.ts
 * for backwards compatibility.
 */

export { SigilError, SIGIL_KIT_VERSION, type SigilErrorParameters } from "./base.js";
export { SigilShieldError } from "./shield.js";
export { SigilTeeError } from "./tee.js";
export { SigilX402Error } from "./x402.js";
export { SigilComposeError } from "./compose.js";
export { walk } from "./walk.js";

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

export {
  // Shield
  SIGIL_ERROR__SHIELD__POLICY_DENIED,
  SIGIL_ERROR__SHIELD__CONFIG_INVALID,
  SIGIL_ERROR__SHIELD__RATE_LIMIT_EXCEEDED,
  SIGIL_ERROR__SHIELD__SESSION_BINDING,
  // TEE
  SIGIL_ERROR__TEE__ATTESTATION_FAILED,
  SIGIL_ERROR__TEE__CERT_CHAIN_INVALID,
  SIGIL_ERROR__TEE__PCR_MISMATCH,
  // Compose
  SIGIL_ERROR__COMPOSE__MISSING_PARAM,
  SIGIL_ERROR__COMPOSE__INVALID_BIGINT,
  SIGIL_ERROR__COMPOSE__UNSUPPORTED_ACTION,
  // x402
  SIGIL_ERROR__X402__HEADER_MALFORMED,
  SIGIL_ERROR__X402__PAYMENT_FAILED,
  SIGIL_ERROR__X402__UNSUPPORTED,
  SIGIL_ERROR__X402__DESTINATION_BLOCKED,
  SIGIL_ERROR__X402__REPLAY,
  // SDK
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
  // RPC
  SIGIL_ERROR__RPC__TX_FAILED,
  SIGIL_ERROR__RPC__CONFIRMATION_TIMEOUT,
  SIGIL_ERROR__RPC__SIMULATION_FAILED,
  SIGIL_ERROR__RPC__DRAIN_DETECTED,
  SIGIL_ERROR__RPC__TX_TOO_LARGE,
  SIGIL_ERROR__RPC__RATE_LIMITED,
  SIGIL_ERROR__RPC__INSTRUCTION_REQUIRED,
  // Program
  SIGIL_ERROR__PROGRAM__GENERIC,
} from "./codes.js";

export type { SigilErrorContext } from "./context.js";
