/**
 * x402 Facilitator Verification — Kit-native
 *
 * Validates settlement responses from x402 facilitators.
 * Non-fatal — logs warnings on suspicious responses.
 */

import type { SettleResponse } from "./types.js";

/** Base58 character set for validation */
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export interface FacilitatorVerifyResult {
  valid: boolean;
  warnings: string[];
}

/**
 * Validate a settlement response from the x402 facilitator.
 *
 * Checks:
 * 1. success: true must include a transaction signature
 * 2. Transaction signature must be valid base58 (64-88 chars)
 * 3. Network field matches expected (if provided)
 */
export function validateSettlement(
  settlement: SettleResponse,
  expectedNetwork?: string,
): FacilitatorVerifyResult {
  const warnings: string[] = [];

  // 1. Successful settlement must include tx signature
  if (settlement.success && !settlement.transaction) {
    warnings.push("Settlement reports success but has no transaction signature");
    return { valid: false, warnings };
  }

  // 2. Validate tx signature format (base58, 64-88 chars)
  if (settlement.transaction && !BASE58_REGEX.test(settlement.transaction)) {
    warnings.push(
      `Settlement transaction signature has invalid format: "${settlement.transaction.slice(0, 20)}..."`,
    );
    return { valid: false, warnings };
  }

  // 3. Network mismatch check
  if (expectedNetwork && settlement.network && settlement.network !== expectedNetwork) {
    warnings.push(
      `Settlement network "${settlement.network}" does not match expected "${expectedNetwork}"`,
    );
  }

  // 4. Failed settlement
  if (!settlement.success) {
    warnings.push(
      `Settlement failed: ${settlement.errorReason ?? "unknown reason"}`,
    );
    return { valid: false, warnings };
  }

  return { valid: true, warnings };
}
