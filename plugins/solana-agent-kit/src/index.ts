import { AgentShieldPluginConfig, resolveWallet } from "./types";
import {
  status,
  statusSchema,
  updatePolicy,
  updatePolicySchema,
  pauseResume,
  pauseResumeSchema,
  transactionHistory,
  transactionHistorySchema,
  provision,
  provisionSchema,
  x402Fetch,
  x402FetchSchema,
} from "./tools";

export {
  AgentShieldPluginConfig,
  ResolvedConfig,
  resolveWallet,
} from "./types";
export { createShieldedWallet, type FactoryConfig } from "./factory";
export * from "./tools";

/**
 * Creates the AgentShield plugin for Solana Agent Kit.
 *
 * Usage with pre-created wallet:
 * ```ts
 * import { shieldWallet } from '@agent-shield/sdk';
 * import { createAgentShieldPlugin } from '@agent-shield/plugin-solana-agent-kit';
 *
 * const protectedWallet = shieldWallet(wallet, { maxSpend: '500 USDC/day' });
 * const plugin = createAgentShieldPlugin({ wallet: protectedWallet });
 * const agent = new SolanaAgentKit(protectedWallet, RPC_URL, { plugins: [plugin] });
 * ```
 *
 * Usage with factory (auto-creates ShieldedWallet):
 * ```ts
 * const plugin = createAgentShieldPlugin({
 *   rawWallet: keypairWallet,
 *   policies: { maxSpend: '500 USDC/day' },
 *   logger: console,
 * });
 * ```
 */
export function createAgentShieldPlugin(config: AgentShieldPluginConfig) {
  const resolved = resolveWallet(config);

  return {
    name: "agent-shield",
    description:
      "AgentShield — On-chain guardrails for AI agents on Solana. " +
      "Provides monitoring tools to check spending status, update policies, " +
      "pause/resume enforcement, and view transaction history. " +
      "Wraps signing transparently with policy enforcement.",

    methods: {
      shield_status: {
        description:
          "Check current shield status: spending vs limits, rate limit usage, " +
          "and whether enforcement is paused.",
        schema: statusSchema,
        handler: (agent: any, input: any) => status(agent, resolved, input),
      },
      shield_update_policy: {
        description:
          "Update shield policies at runtime. Can change spending limits " +
          "and unknown program blocking.",
        schema: updatePolicySchema,
        handler: (agent: any, input: any) =>
          updatePolicy(agent, resolved, input),
      },
      shield_pause_resume: {
        description:
          "Pause or resume shield enforcement. When paused, transactions " +
          "pass through without policy checks or spend recording.",
        schema: pauseResumeSchema,
        handler: (agent: any, input: any) =>
          pauseResume(agent, resolved, input),
      },
      shield_transaction_history: {
        description:
          "View recent transaction activity summary — per-token usage " +
          "percentages and rate limit status.",
        schema: transactionHistorySchema,
        handler: (agent: any, input: any) =>
          transactionHistory(agent, resolved, input),
      },
      shield_provision: {
        description:
          "Generate a Solana Action URL for one-click vault provisioning " +
          "with a TEE-backed agent wallet. User clicks to approve.",
        schema: provisionSchema,
        handler: (agent: any, input: any) => provision(agent, resolved, input),
      },
      shield_x402_fetch: {
        description:
          "Fetch a URL with automatic x402 (HTTP 402) payment support. " +
          "If the server requires payment, the shielded wallet signs and retries.",
        schema: x402FetchSchema,
        handler: (agent: any, input: any) => x402Fetch(agent, resolved, input),
      },
    },
  };
}
