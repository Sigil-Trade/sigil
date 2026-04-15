/**
 * @usesigil/kit/dashboard — Error normalization for OwnerClient operations.
 *
 * Centralizes the toDxError helper used by both reads.ts and mutations.ts to
 * map any thrown error into the DxError type defined in types.ts. The optional
 * `context` argument prepends an "OwnerClient.<method>: " prefix to the message
 * so callers can tell which read/mutation produced the error.
 *
 * Also exports {@link isAccountNotFoundError}, the shared predicate for
 * "this error means the account was missing, treat as null rather than
 * re-throw." Used by `getPolicy`, `getOverview`, and `getVaultSummary`.
 */

import {
  isSolanaError,
  SOLANA_ERROR__NONCE_ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_ACCOUNT_NOT_FOUND,
  type SolanaError,
} from "@solana/errors";

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

// ─── isAccountNotFoundError ────────────────────────────────────────────────

/**
 * Typed account-not-found codes from `@solana/errors`. Covers the four
 * distinct "account missing" shapes Kit may surface:
 *
 *   - {@link SOLANA_ERROR__NONCE_ACCOUNT_NOT_FOUND} (3) — nonce account.
 *   - {@link SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND} (3230000) — the
 *     canonical Accounts-subsystem code thrown by `assertAccountExists`.
 *   - {@link SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND} (7050003).
 *   - {@link SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_ACCOUNT_NOT_FOUND}
 *     (7050004).
 */
const ACCOUNT_NOT_FOUND_CODES = [
  SOLANA_ERROR__NONCE_ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_ACCOUNT_NOT_FOUND,
] as const;

type AccountNotFoundCode = (typeof ACCOUNT_NOT_FOUND_CODES)[number];

/**
 * Is this error a Solana "account not found" error?
 *
 * Primary path: typed `SolanaError` matching any of the four
 * {@link ACCOUNT_NOT_FOUND_CODES} — narrows to `SolanaError<C>` so callers
 * can destructure `err.context` inside the matched branch without casts.
 *
 * Fallback path: legacy substring match on `"could not find"` or
 * `"Account does not exist"`. Retained because `@solana/web3.js` 1.x
 * `Connection.getAccountInfo` throws plain `Error` with these messages
 * and may still be reachable through transitive Connection usage. If
 * this project fully retires web3.js 1.x, the substring branch becomes
 * dead code and should be removed in a follow-up.
 */
// Note: unlike `isTransportError` in `network-errors.ts`, this predicate
// does NOT walk `AggregateError.errors`. "Any of these errors is a
// transport problem" is a useful retry signal; "any of these errors is
// an account-not-found" is not actionable without knowing WHICH account.
// A caller who needs fine-grained aggregate semantics should iterate
// `.errors` explicitly.
export function isAccountNotFoundError(
  err: unknown,
): err is SolanaError<AccountNotFoundCode> {
  for (const code of ACCOUNT_NOT_FOUND_CODES) {
    // `isSolanaError` probes `err.context.__code`; a hostile Proxy with
    // a throwing `get` trap would propagate out of this predicate and
    // re-introduce the silent-failure class. The try/catch lets the
    // classifier fall through to substring matching and ultimately false.
    try {
      if (isSolanaError(err, code)) return true;
    } catch {
      // Proxy trap / throwing getter — treat this code as a non-match
      // and continue to the next.
    }
  }
  let message = "";
  try {
    if (err instanceof Error) message = err.message;
  } catch {
    // instanceof itself can throw through Proxy traps; fall through to
    // empty-message substring check, which cannot match.
  }
  return (
    message.includes("could not find") ||
    message.includes("Account does not exist")
  );
}

// ─── toDxError ─────────────────────────────────────────────────────────────

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
