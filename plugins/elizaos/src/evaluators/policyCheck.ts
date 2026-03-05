import { getOrCreateShieldedWallet } from "../client-factory";

/**
 * Policy Check Evaluator — runs after agent actions and warns
 * if spending is approaching any token's cap (>=80%).
 */
export const policyCheckEvaluator = {
  name: "PHALNX_POLICY_CHECK",
  description:
    "Post-action evaluator that checks spending against caps " +
    "and warns if any token usage exceeds 80%.",
  similes: ["check spending limits", "policy warning"],

  validate: async (_runtime: any, message: any): Promise<boolean> => {
    const text = (message.content?.text || "").toLowerCase();
    return (
      text.includes("phalnx") ||
      text.includes("shield") ||
      text.includes("transaction:")
    );
  },

  handler: async (runtime: any, _message: any) => {
    try {
      const { wallet } = await getOrCreateShieldedWallet(runtime);
      const summary = wallet.getSpendingSummary();

      if (summary.isPaused) return null;

      const warnings: string[] = [];

      for (const t of summary.tokens) {
        if (t.limit === BigInt(0)) continue;
        const pct = Number((t.spent * BigInt(100)) / t.limit);
        if (pct >= 80) {
          const label = t.symbol ?? t.mint.slice(0, 8) + "...";
          warnings.push(
            `${label}: ${pct}% used (${t.remaining.toString()} remaining)`,
          );
        }
      }

      if (warnings.length > 0) {
        return {
          text:
            `WARNING: Phalnx spending approaching limits:\n` +
            warnings.map((w) => `  ${w}`).join("\n") +
            `\nConsider reducing trade sizes or waiting for the rolling window to reset.`,
          action: "POLICY_WARNING",
        };
      }

      return null;
    } catch {
      // Silently fail — evaluators should not block the agent
      return null;
    }
  },

  examples: [
    {
      context:
        "Agent just executed a swap that pushed USDC spending to 85% of cap",
      messages: [
        {
          user: "{{agent}}",
          content: {
            text: "Swap executed successfully.\nTransaction: 5xYz...",
          },
        },
      ],
      outcome:
        "WARNING: Phalnx spending approaching limits:\n" +
        "  USDC: 85% used (75000000 remaining)",
    },
  ],
};
