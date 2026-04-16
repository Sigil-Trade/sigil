/**
 * Compose Error Utilities
 *
 * Error class and helper factories for protocol compose functions.
 * Generated {proto}-compose.ts files import from "./compose-errors.js".
 *
 * PR 2.A: Re-homed under SigilComposeError per UD1 (single canonical .code).
 * The historical ComposeErrorCode string-literal union is preserved as
 * .legacyComposeCode for one-minor migration ramp; deletion targeted at
 * v1.0. New .code is the canonical SigilErrorCode string-literal.
 */

import { AccountRole, type Address } from "../kit-adapter.js";
import { SigilComposeError } from "../errors/compose.js";
import {
  SIGIL_ERROR__COMPOSE__MISSING_PARAM,
  SIGIL_ERROR__COMPOSE__INVALID_BIGINT,
  SIGIL_ERROR__COMPOSE__UNSUPPORTED_ACTION,
  type SigilComposeErrorCode,
} from "../errors/codes.js";

// ─── Error Codes ────────────────────────────────────────────────────────────

export const COMPOSE_ERROR_CODES = {
  MISSING_PARAM: "missing_param",
  INVALID_BIGINT: "invalid_bigint",
  UNSUPPORTED_ACTION: "unsupported_action",
} as const;

/** Union literal type of all valid compose error codes (legacy). */
export type ComposeErrorCode =
  (typeof COMPOSE_ERROR_CODES)[keyof typeof COMPOSE_ERROR_CODES];

const COMPOSE_LEGACY_TO_SIGIL: Record<ComposeErrorCode, SigilComposeErrorCode> =
  {
    missing_param: SIGIL_ERROR__COMPOSE__MISSING_PARAM,
    invalid_bigint: SIGIL_ERROR__COMPOSE__INVALID_BIGINT,
    unsupported_action: SIGIL_ERROR__COMPOSE__UNSUPPORTED_ACTION,
  };

// ─── Base Error Class ───────────────────────────────────────────────────────

export class ComposeError extends SigilComposeError<SigilComposeErrorCode> {
  readonly protocol: string;
  /** @deprecated Use `err.code` (SigilErrorCode). Removed at v1.0. */
  readonly legacyComposeCode: ComposeErrorCode;

  constructor(protocol: string, code: ComposeErrorCode, message: string) {
    const sigilCode = COMPOSE_LEGACY_TO_SIGIL[code];
    // H1 fix: build code-specific context instead of a single `as never`
    // shape. Each SigilErrorContext entry declares different required fields
    // (fieldName for missing_param, fieldName+receivedValue for invalid_bigint,
    // protocol+action for unsupported_action). The message already contains
    // the field/action name so we extract it best-effort.
    const contextForCode =
      code === "unsupported_action"
        ? ({ protocol, action: message } as never)
        : code === "invalid_bigint"
          ? ({
              protocol,
              fieldName: message,
              receivedValue: undefined,
            } as never)
          : ({ protocol, fieldName: message } as never);
    super(sigilCode, `[${protocol}] ${code}: ${message}`, {
      context: contextForCode,
    });
    this.name = "ComposeError";
    this.protocol = protocol;
    this.legacyComposeCode = code;
  }
}

// ─── Helper Factories ───────────────────────────────────────────────────────

/**
 * Create a field-required assertion function.
 *
 * The returned function asserts the value is non-null/undefined and narrows
 * the TypeScript type via `NonNullable<T>`. Falsy primitives (`0`, `false`,
 * `""`, `0n`) are intentionally allowed — only `null` and `undefined` throw.
 *
 * Usage in generated code (note the explicit type annotation — required by TS):
 * ```ts
 * const requireField: <T>(name: string, value: T) => asserts value is NonNullable<T> =
 *   createRequireField(
 *     (field) => new ProtoComposeError(COMPOSE_ERROR_CODES.MISSING_PARAM, `Missing: ${field}`),
 *   );
 * requireField("amount", params.amount);
 * ```
 */
export function createRequireField(
  errorFactory: (name: string) => ComposeError,
): <T>(name: string, value: T) => asserts value is NonNullable<T> {
  return <T>(name: string, value: T): asserts value is NonNullable<T> => {
    if (value === undefined || value === null) {
      throw errorFactory(name);
    }
  };
}

/**
 * Create a safe BigInt conversion function.
 *
 * Validates and converts inputs to bigint. Rejects:
 * - Numbers that are not integers (`1.5`, `NaN`, `Infinity`)
 * - Numbers above `Number.MAX_SAFE_INTEGER` (silent precision loss above 2^53)
 * - Empty / whitespace strings (`BigInt("")` silently returns `0n`)
 * - Non-decimal string formats (hex `0x10`, binary `0b101`, octal `0o17`)
 * - Booleans, objects, null, undefined
 *
 * Usage in generated code:
 * ```ts
 * const safeBigInt = createSafeBigInt(
 *   (field, value) => new ProtoComposeError(COMPOSE_ERROR_CODES.INVALID_BIGINT, `Invalid: ${field}`)
 * );
 * const amount = safeBigInt("amount", params.amount);
 * ```
 */
export function createSafeBigInt(
  errorFactory: (name: string, value: unknown) => ComposeError,
): (name: string, value: unknown) => bigint {
  return (name: string, value: unknown): bigint => {
    try {
      if (typeof value === "bigint") return value;
      if (typeof value === "number") {
        if (!Number.isInteger(value)) throw new TypeError("not integer");
        // Numbers above 2^53 silently lose precision in JavaScript.
        // Force callers to pass bigint or string for large values.
        if (!Number.isSafeInteger(value)) {
          throw new TypeError(
            "unsafe integer — pass bigint or string for values above 2^53",
          );
        }
        return BigInt(value);
      }
      if (typeof value === "string") {
        // Reject non-decimal formats — BigInt() accepts hex/binary/octal
        // and signed prefix, which are surprising for financial inputs.
        // Only allow optional leading "-" followed by decimal digits.
        if (!/^-?[0-9]+$/.test(value)) {
          throw new TypeError("not a decimal integer string");
        }
        return BigInt(value);
      }
      throw new TypeError("not coercible");
    } catch {
      throw errorFactory(name, value);
    }
  };
}

/**
 * Wrap an address as a writable signer account meta.
 * Used in compose functions when building instruction account lists.
 */
export function addressAsSigner(address: Address): {
  address: Address;
  role: AccountRole;
} {
  return { address, role: AccountRole.WRITABLE_SIGNER };
}
