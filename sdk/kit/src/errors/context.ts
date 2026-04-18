/**
 * SigilErrorContext — discriminated context map.
 *
 * For each `SigilErrorCode`, the corresponding context shape is bound at
 * compile time. When `SigilError<TCode>` is narrowed (via `instanceof` or
 * code check), `instance.context` is typed precisely.
 *
 * Pattern matches `@solana/kit`'s `SolanaErrorContext` map.
 */

import type { Address } from "../kit-adapter.js";
import type {
  SIGIL_ERROR__SHIELD__POLICY_DENIED,
  SIGIL_ERROR__SHIELD__CONFIG_INVALID,
  SIGIL_ERROR__SHIELD__RATE_LIMIT_EXCEEDED,
  SIGIL_ERROR__SHIELD__SESSION_BINDING,
  SIGIL_ERROR__TEE__ATTESTATION_FAILED,
  SIGIL_ERROR__TEE__CERT_CHAIN_INVALID,
  SIGIL_ERROR__TEE__PCR_MISMATCH,
  SIGIL_ERROR__COMPOSE__MISSING_PARAM,
  SIGIL_ERROR__COMPOSE__INVALID_BIGINT,
  SIGIL_ERROR__COMPOSE__UNSUPPORTED_ACTION,
  SIGIL_ERROR__X402__HEADER_MALFORMED,
  SIGIL_ERROR__X402__PAYMENT_FAILED,
  SIGIL_ERROR__X402__UNSUPPORTED,
  SIGIL_ERROR__X402__DESTINATION_BLOCKED,
  SIGIL_ERROR__X402__REPLAY,
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
  SIGIL_ERROR__SDK__HOOK_ABORTED,
  SIGIL_ERROR__SDK__PLUGIN_REJECTED,
  SIGIL_ERROR__SDK__OWNER_REQUIRED,
  SIGIL_ERROR__SDK__UNKNOWN,
  SIGIL_ERROR__RPC__TX_FAILED,
  SIGIL_ERROR__RPC__CONFIRMATION_TIMEOUT,
  SIGIL_ERROR__RPC__SIMULATION_FAILED,
  SIGIL_ERROR__RPC__DRAIN_DETECTED,
  SIGIL_ERROR__RPC__TX_TOO_LARGE,
  SIGIL_ERROR__RPC__RATE_LIMITED,
  SIGIL_ERROR__RPC__INSTRUCTION_REQUIRED,
  SIGIL_ERROR__PROGRAM__GENERIC,
} from "./codes.js";
// Local minimal types to avoid circular imports from src/core/, src/tee/.
// The full PolicyViolation / AttestationResult types are imported by the leaf
// classes in src/shield.ts / src/tee/wallet-types.ts, which extend these
// contexts and refine .violations / .result via their own field types.

interface PolicyViolationLike {
  rule: string;
  message: string;
  suggestion: string;
  details?: Record<string, unknown>;
}

interface AttestationResultLike {
  status: string;
  [key: string]: unknown;
}

/**
 * Map every SigilErrorCode to its required context shape.
 * `undefined` means the error has no required context fields.
 *
 * Leaf classes (e.g., ShieldDeniedError, X402ParseError) extend the base
 * context with their own additional getter-accessed fields.
 */
export interface SigilErrorContext {
  [SIGIL_ERROR__SHIELD__POLICY_DENIED]: { violations: PolicyViolationLike[] };
  [SIGIL_ERROR__SHIELD__CONFIG_INVALID]: undefined;
  [SIGIL_ERROR__SHIELD__RATE_LIMIT_EXCEEDED]: {
    violations: PolicyViolationLike[];
    windowMs?: number;
    limitTx?: number;
    countedTx?: number;
  };
  [SIGIL_ERROR__SHIELD__SESSION_BINDING]: { violations: PolicyViolationLike[] };

  [SIGIL_ERROR__TEE__ATTESTATION_FAILED]: {
    result?: AttestationResultLike;
    provider?: string;
  };
  [SIGIL_ERROR__TEE__CERT_CHAIN_INVALID]: {
    result?: AttestationResultLike;
    provider?: string;
  };
  [SIGIL_ERROR__TEE__PCR_MISMATCH]: {
    pcrIndex: number;
    expected: string;
    actual: string;
    result?: AttestationResultLike;
    provider?: string;
  };

  [SIGIL_ERROR__COMPOSE__MISSING_PARAM]: {
    protocol: string;
    fieldName: string;
  };
  [SIGIL_ERROR__COMPOSE__INVALID_BIGINT]: {
    protocol: string;
    fieldName: string;
    receivedValue: unknown;
  };
  [SIGIL_ERROR__COMPOSE__UNSUPPORTED_ACTION]: {
    protocol: string;
    action: string;
  };

  [SIGIL_ERROR__X402__HEADER_MALFORMED]: { legacyNumericCode: 7024 };
  [SIGIL_ERROR__X402__PAYMENT_FAILED]: { legacyNumericCode: 7025 };
  [SIGIL_ERROR__X402__UNSUPPORTED]: { legacyNumericCode: 7026 };
  [SIGIL_ERROR__X402__DESTINATION_BLOCKED]: {
    payTo: string;
    legacyNumericCode: 7027;
  };
  [SIGIL_ERROR__X402__REPLAY]: { nonceKey: string; legacyNumericCode: 7028 };

  [SIGIL_ERROR__SDK__INVALID_CONFIG]: { field: string; expected?: string };
  [SIGIL_ERROR__SDK__INVALID_PARAMS]: { field?: string; received?: unknown };
  [SIGIL_ERROR__SDK__INVALID_NETWORK]: {
    received: string;
    valid: readonly string[];
  };
  [SIGIL_ERROR__SDK__INVALID_AMOUNT]: { received: unknown };
  [SIGIL_ERROR__SDK__INVALID_CAPABILITY]: {
    capability: number;
    valid: readonly number[];
  };
  [SIGIL_ERROR__SDK__INVALID_ACTION_TYPE]: {
    received: string;
    valid: readonly string[];
  };
  [SIGIL_ERROR__SDK__OWNER_AGENT_COLLISION]: { owner: Address; agent: Address };
  [SIGIL_ERROR__SDK__VAULT_NOT_FOUND]: { vault: Address };
  [SIGIL_ERROR__SDK__VAULT_INACTIVE]: { vault: Address; status: string };
  [SIGIL_ERROR__SDK__VAULT_SLOTS_EXHAUSTED]: { owner: Address };
  [SIGIL_ERROR__SDK__POLICY_NOT_FOUND]: { vault: Address };
  [SIGIL_ERROR__SDK__AGENT_NOT_REGISTERED]: { vault: Address; agent: Address };
  [SIGIL_ERROR__SDK__AGENT_PAUSED]: { vault: Address; agent: Address };
  [SIGIL_ERROR__SDK__AGENT_ZERO_CAPABILITY]: { vault: Address; agent: Address };
  [SIGIL_ERROR__SDK__SIGNER_INVALID]: { reason: string };
  [SIGIL_ERROR__SDK__SIGNATURE_INVALID]: { reason: string };
  [SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED]: {
    operation: string;
    vault?: Address;
  };
  [SIGIL_ERROR__SDK__PROTOCOL_NOT_ALLOWED]: {
    protocol: Address;
    vault: Address;
  };
  [SIGIL_ERROR__SDK__PROTOCOL_NOT_TARGETED]: undefined;
  [SIGIL_ERROR__SDK__INSTRUCTION_COUNT]: { expected: number; got: number };
  [SIGIL_ERROR__SDK__CAP_EXCEEDED]: {
    vault: Address;
    agent: Address;
    cap: bigint;
    attempted: bigint;
  };
  [SIGIL_ERROR__SDK__ATA_NON_CANONICAL]: { expected: Address; got: Address };
  [SIGIL_ERROR__SDK__ALT_INTEGRITY]: { altAddress: Address; missing: number };
  [SIGIL_ERROR__SDK__ALT_NOT_DEPLOYED]: { network: string };
  [SIGIL_ERROR__SDK__SEAL_FAILED]: { vault: Address; agent: Address };
  [SIGIL_ERROR__SDK__HOOK_ABORTED]: {
    hook: string;
    reason: string;
    correlationId?: string;
  };
  [SIGIL_ERROR__SDK__PLUGIN_REJECTED]: {
    plugin: string;
    reason?: string;
    code?: string;
    correlationId?: string;
    metadata?: Readonly<Record<string, unknown>>;
  };
  [SIGIL_ERROR__SDK__OWNER_REQUIRED]: { method: string; vault: Address };
  [SIGIL_ERROR__SDK__UNKNOWN]: { rawCode?: string; rawMessage?: string };

  [SIGIL_ERROR__RPC__TX_FAILED]: { signature?: string; logs?: string[] };
  [SIGIL_ERROR__RPC__CONFIRMATION_TIMEOUT]: {
    signature: string;
    timeoutMs: number;
  };
  [SIGIL_ERROR__RPC__SIMULATION_FAILED]: {
    signature?: string;
    logs?: string[];
  };
  [SIGIL_ERROR__RPC__DRAIN_DETECTED]: { reason: string };
  [SIGIL_ERROR__RPC__TX_TOO_LARGE]: { byteLength: number; limit: number };
  [SIGIL_ERROR__RPC__RATE_LIMITED]: { statusCode?: number };
  [SIGIL_ERROR__RPC__INSTRUCTION_REQUIRED]: undefined;

  [SIGIL_ERROR__PROGRAM__GENERIC]: { anchorCode?: number; anchorName?: string };
}
