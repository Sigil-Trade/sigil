import { getOrCreateShieldedWallet } from "../client-factory";

export const transactionHistoryAction = {
  name: "SHIELD_TRANSACTION_HISTORY",
  description:
    "Show recent Phalnx transaction activity — per-token usage " +
    "percentages and rate limit status.",
  similes: [
    "transaction history",
    "recent activity",
    "shield history",
    "spending history",
    "activity log",
  ],

  validate: async (runtime: any, message: any): Promise<boolean> => {
    try {
      await getOrCreateShieldedWallet(runtime);
    } catch {
      return false;
    }

    const text = (message.content?.text || "").toLowerCase();
    const keywords = [
      "transaction history",
      "recent activity",
      "shield history",
      "spending history",
      "activity log",
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
        `=== Phalnx Transaction History ===`,
        `Enforcement: ${summary.isPaused ? "PAUSED" : "ACTIVE"}`,
        ``,
        `--- Per-Token Usage ---`,
      ];

      if (summary.tokens.length === 0) {
        lines.push("No spending limits configured.");
      } else {
        for (const t of summary.tokens) {
          const label = t.symbol ?? t.mint.slice(0, 8) + "...";
          const pct =
            t.limit > BigInt(0) ? Number((t.spent * BigInt(100)) / t.limit) : 0;
          const windowHrs = t.windowMs / 3_600_000;
          lines.push(`  ${label}:`);
          lines.push(
            `    Spent: ${t.spent.toString()} / ${t.limit.toString()}`,
          );
          lines.push(`    Usage: ${pct}%`);
          lines.push(`    Remaining: ${t.remaining.toString()}`);
          lines.push(`    Window: ${windowHrs}h rolling`);
        }
      }

      lines.push("", `--- Rate Limit ---`);
      lines.push(
        `  Transactions: ${summary.rateLimit.count} / ${summary.rateLimit.limit}`,
      );
      lines.push(`  Remaining: ${summary.rateLimit.remaining}`);
      const rlWindowHrs = summary.rateLimit.windowMs / 3_600_000;
      lines.push(`  Window: ${rlWindowHrs}h`);

      callback({ text: lines.join("\n") });
    } catch (error: any) {
      callback({
        text: `Failed to get transaction history: ${error.message}`,
        error: true,
      });
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Show me the transaction history" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "=== Phalnx Transaction History ===\nEnforcement: ACTIVE\n\n--- Per-Token Usage ---\n  USDC:\n    Spent: 200000000 / 500000000\n    Usage: 40%\n    Remaining: 300000000\n    Window: 24h rolling",
        },
      },
    ],
  ],
};
