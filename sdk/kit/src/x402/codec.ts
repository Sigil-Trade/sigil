/**
 * x402 Codec — Kit-native
 *
 * Base64 encode/decode and header parse/encode with schema validation.
 * Zero external dependencies.
 */

import type {
  PaymentRequired,
  PaymentPayload,
  SettleResponse,
} from "./types.js";
import { X402ParseError } from "./errors.js";
import { U64_MAX } from "../types.js";

// ─── Base64 Helpers ─────────────────────────────────────────────────────────

/** Base64 encode a JSON/ASCII string. Platform-agnostic (no Buffer dependency). */
export function base64Encode(data: string): string {
  return btoa(data);
}

/** Base64 decode to a JSON/ASCII string. Platform-agnostic (no Buffer dependency). */
export function base64Decode(encoded: string): string {
  return atob(encoded);
}

// ─── Header Decode/Encode ───────────────────────────────────────────────────

/**
 * Decode a base64-encoded PAYMENT-REQUIRED header value.
 * Validates schema: x402Version is number, accepts is non-empty array,
 * each entry has required fields.
 */
export function decodePaymentRequiredHeader(header: string): PaymentRequired {
  let parsed: unknown;
  try {
    const json = base64Decode(header);
    parsed = JSON.parse(json);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new X402ParseError(
      `Failed to decode PAYMENT-REQUIRED header: ${msg}`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // Schema validation
  if (typeof obj.x402Version !== "number") {
    throw new X402ParseError("x402Version must be a number");
  }
  if (!Array.isArray(obj.accepts) || obj.accepts.length === 0) {
    throw new X402ParseError("accepts must be a non-empty array");
  }

  for (let i = 0; i < obj.accepts.length; i++) {
    const entry = obj.accepts[i] as Record<string, unknown>;
    if (typeof entry.scheme !== "string") {
      throw new X402ParseError(`accepts[${i}].scheme must be a string`);
    }
    if (typeof entry.network !== "string") {
      throw new X402ParseError(`accepts[${i}].network must be a string`);
    }
    if (typeof entry.asset !== "string") {
      throw new X402ParseError(`accepts[${i}].asset must be a string`);
    }
    if (typeof entry.amount !== "string" || entry.amount.length === 0) {
      throw new X402ParseError(
        `accepts[${i}].amount must be a non-empty string`,
      );
    }
    // Validate amount is a valid non-negative integer string (BUG-7/BUG-15: use BigInt to avoid precision loss)
    try {
      const parsed = BigInt(entry.amount);
      if (parsed < 0n) {
        throw new X402ParseError(
          `accepts[${i}].amount must be non-negative (got: "${entry.amount}")`,
        );
      }
      if (parsed > U64_MAX) {
        throw new X402ParseError(
          `accepts[${i}].amount exceeds u64 max (got: "${entry.amount}")`,
        );
      }
    } catch (e) {
      if (e instanceof X402ParseError) throw e;
      throw new X402ParseError(
        `accepts[${i}].amount must be a valid integer string (got: "${entry.amount}")`,
      );
    }
    if (typeof entry.payTo !== "string") {
      throw new X402ParseError(`accepts[${i}].payTo must be a string`);
    }
  }

  return parsed as PaymentRequired;
}

/**
 * Encode a PaymentPayload as a base64 string for PAYMENT-SIGNATURE header.
 */
export function encodePaymentSignatureHeader(payload: PaymentPayload): string {
  return base64Encode(JSON.stringify(payload));
}

/**
 * Decode a base64-encoded PAYMENT-RESPONSE header value.
 */
export function decodePaymentResponseHeader(header: string): SettleResponse {
  try {
    return JSON.parse(base64Decode(header)) as SettleResponse;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new X402ParseError(
      `Failed to decode PAYMENT-RESPONSE header: ${msg}`,
    );
  }
}
