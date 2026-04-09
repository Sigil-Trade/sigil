/**
 * @usesigil/kit/dashboard — Error normalization for OwnerClient operations.
 *
 * Centralizes the toDxError helper used by both reads.ts and mutations.ts to
 * map any thrown error into the DxError type defined in types.ts. The optional
 * `context` argument prepends an "OwnerClient.<method>: " prefix to the message
 * so callers can tell which read/mutation produced the error.
 */

import { SDK_ERROR_CODES, toAgentError } from "../agent-errors.js";
import type { DxError } from "./types.js";

/**
 * Reverse lookup from SDK error name → numeric code. Built once at
 * module load. Fix for A5-adjacent Finding 4
 * (docs/SECURITY-FINDINGS-2026-04-07.md): the previous implementation
 * used `Number(agentErr.code)` which silently collapsed every
 * string-coded SDK error (RPC_ERROR, SIMULATION_FAILED, UNKNOWN, etc.)
 * to a hardcoded fallback of 7000 because `Number("RPC_ERROR") === NaN`.
 * That made DxError.code indistinguishable across the majority of
 * error paths — it was a lie for every non-on-chain error.
 */
const SDK_CODE_BY_NAME: Record<string, number> = Object.fromEntries(
  Object.entries(SDK_ERROR_CODES).map(([num, name]) => [name, Number(num)]),
);

/** Sentinel returned when an error code cannot be mapped to a numeric code. */
export const DX_ERROR_CODE_UNMAPPED = 7999;

/**
 * Resolve an agent error code to a numeric DxError.code.
 *
 * Priority order:
 *   1. Named SDK code string ("RPC_ERROR") → reverse-lookup (7001)
 *   2. Numeric string ("6010") or number (6010) → passthrough
 *   3. Unmappable / non-finite → DX_ERROR_CODE_UNMAPPED (7999)
 *
 * 7000 is reserved for the real NETWORK_ERROR code — never used as
 * a fallback, so DxError.code === 7000 now unambiguously means
 * NETWORK_ERROR (previously it also meant "I couldn't parse this").
 */
function resolveDxCode(rawCode: unknown): number {
  if (typeof rawCode === "string") {
    const named = SDK_CODE_BY_NAME[rawCode];
    if (named !== undefined) return named;
    const n = Number(rawCode);
    if (Number.isFinite(n)) return n;
    return DX_ERROR_CODE_UNMAPPED;
  }
  if (typeof rawCode === "number" && Number.isFinite(rawCode)) {
    return rawCode;
  }
  return DX_ERROR_CODE_UNMAPPED;
}

/** Normalize any error into a DxError with code, message, and recovery actions. */
export function toDxError(err: unknown, context?: string): DxError {
  try {
    const agentErr = toAgentError(err);
    const code = resolveDxCode(agentErr.code);
    return {
      code,
      message: context ? `${context}: ${agentErr.message}` : agentErr.message,
      recovery:
        agentErr.recovery_actions?.map(
          (a: { description?: string; action?: string }) =>
            a.description ?? a.action ?? "",
        ) ?? [],
    };
  } catch {
    // toAgentError itself failed — wrap the original error.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      code: DX_ERROR_CODE_UNMAPPED,
      message: context ? `${context}: ${msg}` : msg,
      recovery: ["Check transaction logs for details"],
    };
  }
}
