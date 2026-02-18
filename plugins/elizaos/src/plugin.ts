import {
  statusAction,
  updatePolicyAction,
  pauseResumeAction,
  transactionHistoryAction,
  provisionAction,
} from "./actions";
import { shieldStatusProvider, spendTrackingProvider } from "./providers";
import { policyCheckEvaluator } from "./evaluators";

/**
 * AgentShield Plugin for ElizaOS.
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
 * - AGENT_SHIELD_MAX_SPEND — e.g. "500 USDC/day"
 * - AGENT_SHIELD_BLOCK_UNKNOWN — "true" or "false" (default: true)
 */
export const agentShieldPlugin = {
  name: "agent-shield",
  description:
    "AgentShield — Client-side spending controls for AI agents. " +
    "Wraps wallet signing with policy enforcement, spending caps, " +
    "and rate limiting. Zero on-chain setup required.",

  actions: [
    statusAction,
    updatePolicyAction,
    pauseResumeAction,
    transactionHistoryAction,
    provisionAction,
  ],

  providers: [shieldStatusProvider, spendTrackingProvider],

  evaluators: [policyCheckEvaluator],
};
