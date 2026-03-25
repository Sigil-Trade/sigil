/**
 * x402 Facilitator Verification — Kit-native
 *
 * Validates settlement responses from x402 facilitators.
 * Non-fatal — logs warnings on suspicious responses.
 */

import type { Rpc, SolanaRpcApi } from "@solana/kit";
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
 * 4. Failed settlement
 * 5. On-chain confirmation (when rpc provided)
 */
export async function validateSettlement(
  settlement: SettleResponse,
  expectedNetwork?: string,
  rpc?: Rpc<SolanaRpcApi>,
  timeoutMs?: number,
): Promise<FacilitatorVerifyResult> {
  const warnings: string[] = [];

  // 1. Successful settlement must include tx signature
  if (settlement.success && !settlement.transaction) {
    warnings.push(
      "Settlement reports success but has no transaction signature",
    );
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
  if (
    expectedNetwork &&
    settlement.network &&
    settlement.network !== expectedNetwork
  ) {
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

  // 5. On-chain confirmation (when rpc provided and transaction exists)
  if (rpc && settlement.transaction) {
    try {
      const confirmed = await pollSignatureStatus(
        rpc,
        settlement.transaction,
        timeoutMs ?? 10_000,
      );
      if (!confirmed) {
        warnings.push(
          `Settlement TX ${settlement.transaction.slice(0, 12)}... not confirmed on-chain within ${timeoutMs ?? 10_000}ms`,
        );
      }
    } catch {
      warnings.push(
        `Failed to verify settlement TX on-chain: ${settlement.transaction.slice(0, 12)}...`,
      );
    }
  }

  return { valid: true, warnings };
}

async function pollSignatureStatus(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  while (Date.now() < deadline) {
    const result = await rpc.getSignatureStatuses([signature as unknown as Parameters<typeof rpc.getSignatureStatuses>[0][0]]).send();
    const statuses = (result as unknown as { value: readonly ({ err: unknown; confirmationStatus: string } | null)[] }).value;
    if (statuses?.[0]) {
      if (statuses[0].err) return false;
      const level = statuses[0].confirmationStatus;
      if (level === "confirmed" || level === "finalized") return true;
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2_000);
  }
  return false;
}
