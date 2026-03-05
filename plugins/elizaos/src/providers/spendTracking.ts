import { getOrCreateShieldedWallet } from "../client-factory";

/**
 * Spend Tracking Provider — injects per-token spending data and
 * remaining budget into agent context.
 */
export const spendTrackingProvider = {
  name: "PHALNX_SPEND_TRACKING",
  description:
    "Provides per-token spending data and remaining budget from the Phalnx policy wrapper",

  get: async (runtime: any, _message: any, _state: any) => {
    try {
      const { wallet } = await getOrCreateShieldedWallet(runtime);
      const summary = wallet.getSpendingSummary();

      const lines = [`Phalnx Spending:`];

      for (const t of summary.tokens) {
        const label = t.symbol ?? t.mint.slice(0, 8) + "...";
        const pct =
          t.limit > BigInt(0) ? Number((t.spent * BigInt(100)) / t.limit) : 0;
        const windowHrs = t.windowMs / 3_600_000;
        lines.push(
          `  ${label}: ${t.spent.toString()} / ${t.limit.toString()} (${pct}%, ${windowHrs}h window)`,
        );
        lines.push(`    Remaining: ${t.remaining.toString()}`);
      }

      if (summary.tokens.length === 0) {
        lines.push("  No spending limits configured.");
      }

      const text = lines.join("\n");

      // Compute aggregate values for context
      const maxUsagePct = summary.tokens.reduce((max, t) => {
        const pct =
          t.limit > BigInt(0) ? Number((t.spent * BigInt(100)) / t.limit) : 0;
        return Math.max(max, pct);
      }, 0);

      return {
        text,
        values: {
          tokenCount: summary.tokens.length.toString(),
          maxUsagePercent: maxUsagePct.toString(),
          isPaused: summary.isPaused.toString(),
        },
      };
    } catch (error: any) {
      return {
        text: `Phalnx: Unable to fetch spend data — ${error.message}`,
        values: {},
      };
    }
  },
};
