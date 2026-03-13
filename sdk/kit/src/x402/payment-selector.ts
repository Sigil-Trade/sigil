/**
 * x402 Payment Option Selector — Kit-native
 *
 * Selects a Solana-compatible payment option from the accepts array.
 * Includes SECURITY-CRITICAL payTo destination allowlisting.
 */

import type { Address } from "@solana/kit";
import type { PaymentRequired, PaymentRequirements, X402Config } from "./types.js";
import { X402UnsupportedError, X402DestinationBlockedError } from "./errors.js";

/**
 * Select a Solana-compatible payment option from the accepts array.
 *
 * Filtering order:
 * 1. Network: must start with "solana:" (CAIP-2 format)
 * 2. Token allowlist: asset must be in config.allowedTokens (if set)
 * 3. payTo allowlist: destination must be in config.allowedDestinations (if set) — SECURITY-CRITICAL
 *
 * @throws X402DestinationBlockedError if Solana options exist but all destinations are blocked
 * @throws X402UnsupportedError if no compatible Solana option found
 */
export function selectPaymentOption(
  paymentRequired: PaymentRequired,
  config?: X402Config,
): PaymentRequirements {
  const solanaOptions: PaymentRequirements[] = [];
  let hasBlockedDestination = false;

  for (const option of paymentRequired.accepts) {
    // 1. Network filter: must be Solana
    if (!option.network.startsWith("solana:")) {
      continue;
    }

    // 2. Token allowlist filter
    if (config?.allowedTokens && !config.allowedTokens.has(option.asset as Address)) {
      continue;
    }

    solanaOptions.push(option);

    // 3. payTo destination allowlist — SECURITY-CRITICAL
    // Defense against prompt injection: malicious API returns attacker's payTo
    if (config?.allowedDestinations && !config.allowedDestinations.has(option.payTo as Address)) {
      hasBlockedDestination = true;
      continue;
    }

    return option;
  }

  // Specific error when Solana options exist but all destinations are blocked
  if (solanaOptions.length > 0 && hasBlockedDestination) {
    throw new X402DestinationBlockedError(
      solanaOptions[0].payTo,
      `All ${solanaOptions.length} Solana payment option(s) have blocked payTo destinations. ` +
        "Add trusted destinations to X402Config.allowedDestinations.",
    );
  }

  throw new X402UnsupportedError(
    "No compatible Solana payment option found in accepts array",
  );
}
