/**
 * x402 Policy Bridge — Kit-native
 *
 * Bridges x402 payments to Kit ShieldState for spending integration.
 * x402 payments share the SAME spending state as DeFi operations.
 */

import type { Address } from "../kit-adapter.js";
import type { ShieldedContext } from "../shield.js";
import type { InspectableInstruction } from "../inspector.js";
import type { PaymentRequirements, X402Config } from "./types.js";
import { X402PaymentError } from "./errors.js";
import { TOKEN_PROGRAM_ID } from "./transfer-builder.js";

/**
 * Evaluate an x402 payment against Kit Shield policies.
 * Pre-check only — does NOT record spend.
 *
 * @throws X402PaymentError if shield is paused
 * @returns violations array (empty = approved)
 */
export function evaluateX402Payment(
  selected: PaymentRequirements,
  shieldCtx: ShieldedContext,
  config?: X402Config,
  signerAddress?: Address,
): string[] {
  const violations: string[] = [];

  // 1. Shield paused = block all x402 payments
  if (shieldCtx.isPaused) {
    throw new X402PaymentError(
      "Shield is paused — all x402 payments are blocked until resume()",
    );
  }

  // 2. Cumulative spend check via ShieldState
  if (config?.maxCumulativeSpend !== undefined) {
    const windowMs = config.cumulativeWindowMs ?? 86_400_000;
    const currentSpend = shieldCtx.state.getTotalSpendInWindow(windowMs);
    const paymentAmount = BigInt(selected.amount);

    if (currentSpend + paymentAmount > config.maxCumulativeSpend) {
      violations.push(
        `Cumulative x402 spend ${currentSpend + paymentAmount} exceeds limit ${config.maxCumulativeSpend} ` +
          `in ${windowMs}ms window`,
      );
    }
  }

  // 3. Per-request ceiling
  if (config?.maxPaymentPerRequest !== undefined) {
    const paymentAmount = BigInt(selected.amount);
    if (paymentAmount > config.maxPaymentPerRequest) {
      violations.push(
        `Payment ${selected.amount} exceeds per-request ceiling ${config.maxPaymentPerRequest}`,
      );
    }
  }

  // 4. Delegate to Shield's instruction check with synthetic transfer instruction
  if (signerAddress) {
    const syntheticIx: InspectableInstruction = {
      programAddress: TOKEN_PROGRAM_ID,
      accounts: [
        { address: signerAddress },
        { address: selected.asset as Address },
        { address: selected.payTo as Address },
        { address: signerAddress },
      ],
    };

    const checkResult = shieldCtx.check([syntheticIx], signerAddress);
    if (!checkResult.allowed) {
      for (const v of checkResult.violations) {
        violations.push(v.message);
      }
    }
  }

  return violations;
}

/**
 * Record an x402 payment in ShieldState after successful payment.
 * x402 payments share the SAME spending state as DeFi operations.
 */
export function recordX402Spend(
  shieldCtx: ShieldedContext,
  asset: string,
  amount: bigint,
): void {
  shieldCtx.state.recordSpend(asset, amount);
  shieldCtx.state.recordTransaction();
}
