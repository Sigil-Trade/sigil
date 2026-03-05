import {
  statusAction,
  updatePolicyAction,
  pauseResumeAction,
  transactionHistoryAction,
  provisionAction,
  x402FetchAction,
} from "./actions";
import { shieldStatusProvider, spendTrackingProvider } from "./providers";
import { policyCheckEvaluator } from "./evaluators";

/**
 * Phalnx Plugin for ElizaOS.
 *
 * Provides:
 * - Actions: SHIELD_STATUS, SHIELD_UPDATE_POLICY, SHIELD_PAUSE_RESUME, SHIELD_TRANSACTION_HISTORY
 * - Providers: shield status, spend tracking (injected into agent context)
 * - Evaluators: policy cap warning (runs after actions)
 *
 * Required environment variables:
 * - SOLANA_WALLET_PRIVATE_KEY — agent wallet key
 *
 * Optional:
 * - PHALNX_MAX_SPEND — e.g. "500 USDC/day"
 * - PHALNX_BLOCK_UNKNOWN — "true" or "false" (default: true)
 */
export const phalnxPlugin = {
  name: "phalnx",
  description:
    "Phalnx — On-chain guardrails for AI agents. " +
    "Wraps wallet signing with policy enforcement, spending caps, " +
    "and rate limiting.",

  actions: [
    statusAction,
    updatePolicyAction,
    pauseResumeAction,
    transactionHistoryAction,
    provisionAction,
    x402FetchAction,
  ],

  providers: [shieldStatusProvider, spendTrackingProvider],

  evaluators: [policyCheckEvaluator],
};
