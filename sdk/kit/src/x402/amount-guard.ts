/**
 * x402 Amount Guard — Kit-native
 *
 * Validates payment amounts beyond simple maxPayment ceiling.
 * Detects zero, negative, NaN, per-request ceiling, and spike anomalies.
 */

import type { X402Config } from "./types.js";
import { X402PaymentError } from "./errors.js";

/**
 * Recent payment amounts for spike detection.
 * Intentionally module-level (global): all shieldedFetch instances share spike
 * history so cross-instance spike detection catches manipulation attempts.
 * Use resetPaymentHistory() in tests to clear between suites.
 */
const recentPayments: bigint[] = [];
const MAX_RECENT = 20;

/** Spike detection threshold: payment > 10x median = suspicious */
const SPIKE_MULTIPLIER = 10n;

/**
 * Validate a payment amount against sanity checks.
 *
 * @throws X402PaymentError on invalid or suspicious amounts
 */
export function validatePaymentAmount(
  amount: string,
  config?: X402Config,
): bigint {
  // 1. Parse and validate — enforce string type at runtime (JS callers may bypass TS types)
  if (typeof amount !== "string") {
    throw new X402PaymentError(
      `Invalid payment amount: expected string, got ${typeof amount}`,
    );
  }
  let parsed: bigint;
  try {
    parsed = BigInt(amount);
  } catch {
    throw new X402PaymentError(
      `Invalid payment amount: "${amount}" is not a valid integer`,
    );
  }

  // 2. Reject zero and negative
  if (parsed <= 0n) {
    throw new X402PaymentError(
      `Invalid payment amount: ${amount} must be positive`,
    );
  }

  // 3. Per-request ceiling
  if (
    config?.maxPaymentPerRequest !== undefined &&
    parsed > config.maxPaymentPerRequest
  ) {
    throw new X402PaymentError(
      `Payment amount ${amount} exceeds per-request ceiling ${config.maxPaymentPerRequest}`,
    );
  }

  // 4. Spike detection: if payment > 10x median of recent payments
  if (recentPayments.length >= 3) {
    const median = getMedian(recentPayments);
    if (median > 0n && parsed > median * SPIKE_MULTIPLIER) {
      throw new X402PaymentError(
        `Suspicious payment spike: ${amount} is > 10x the median of recent payments (${median})`,
      );
    }
  }

  return parsed;
}

/**
 * Record a successful payment amount for spike detection.
 */
export function recordPaymentAmount(amount: bigint): void {
  recentPayments.push(amount);
  if (recentPayments.length > MAX_RECENT) {
    recentPayments.shift();
  }
}

/**
 * Reset the recent payments history (for testing).
 */
export function resetPaymentHistory(): void {
  recentPayments.length = 0;
}

/**
 * Get the current payment history length (for testing).
 */
export function getPaymentHistoryLength(): number {
  return recentPayments.length;
}

/** Compute median of a bigint array. */
function getMedian(arr: bigint[]): bigint {
  const sorted = [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2n;
  }
  return sorted[mid];
}
