import { getOrCreateShieldedWallet } from "../client-factory";

export const statusAction = {
  name: "SHIELD_STATUS",
  description:
    "Show current Phalnx spending summary, rate limit usage, and enforcement state.",
  similes: [
    "shield status",
    "spending status",
    "budget remaining",
    "check spending",
    "how much budget",
  ],

  validate: async (runtime: any, message: any): Promise<boolean> => {
    try {
      await getOrCreateShieldedWallet(runtime);
    } catch {
      return false;
    }

    const text = (message.content?.text || "").toLowerCase();
    const keywords = [
      "shield status",
      "spending",
      "budget",
      "how much left",
      "remaining",
    ];
    return keywords.some((kw) => text.includes(kw));
  },

  handler: async (
    runtime: any,
    _message: any,
    _state: any,
    _options: any,
    callback: (response: any) => void,
  ) => {
    try {
      const { wallet } = await getOrCreateShieldedWallet(runtime);
      const summary = wallet.getSpendingSummary();

      const lines = [
        `=== Phalnx Status ===`,
        `Enforcement: ${summary.isPaused ? "PAUSED" : "ACTIVE"}`,
        ``,
      ];

      for (const t of summary.tokens) {
        const label = t.symbol ?? t.mint.slice(0, 8) + "...";
        const pct =
          t.limit > BigInt(0) ? Number((t.spent * BigInt(100)) / t.limit) : 0;
        lines.push(
          `${label}: ${t.spent.toString()} / ${t.limit.toString()} (${pct}% used)`,
        );
        lines.push(`  Remaining: ${t.remaining.toString()}`);
      }

      lines.push(
        ``,
        `Rate limit: ${summary.rateLimit.count}/${summary.rateLimit.limit} transactions (${summary.rateLimit.remaining} remaining)`,
      );

      callback({ text: lines.join("\n") });
    } catch (error: any) {
      callback({
        text: `Failed to get shield status: ${error.message}`,
        error: true,
      });
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "What's my shield spending status?" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "=== Phalnx Status ===\nEnforcement: ACTIVE\n\nUSDC: 200000000 / 500000000 (40% used)\n  Remaining: 300000000",
        },
      },
    ],
  ],
};
