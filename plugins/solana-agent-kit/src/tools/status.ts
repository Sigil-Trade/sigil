import { z } from "zod";
import type { ResolvedConfig } from "../types";

export const statusSchema = z.object({});

export type StatusInput = z.infer<typeof statusSchema>;

export async function status(
  _agent: any,
  config: ResolvedConfig,
  _input: StatusInput,
): Promise<string> {
  const summary = config.wallet.getSpendingSummary();

  const lines = [
    `=== Phalnx Status ===`,
    `Paused: ${summary.isPaused}`,
    ``,
    `--- Spending Limits ---`,
  ];

  if (summary.tokens.length === 0) {
    lines.push("No spending limits configured.");
  } else {
    for (const t of summary.tokens) {
      const label = t.symbol ?? t.mint.slice(0, 8) + "...";
      const windowHrs = t.windowMs / 3_600_000;
      const pct =
        t.limit > BigInt(0) ? Number((t.spent * BigInt(100)) / t.limit) : 0;
      lines.push(
        `  ${label}: ${t.spent.toString()} / ${t.limit.toString()} (${pct}% used, ${windowHrs}h window)`,
      );
      lines.push(`    Remaining: ${t.remaining.toString()}`);
    }
  }

  lines.push("", `--- Rate Limit ---`);
  lines.push(
    `  Transactions: ${summary.rateLimit.count} / ${summary.rateLimit.limit} (${summary.rateLimit.remaining} remaining)`,
  );
  const rlWindowHrs = summary.rateLimit.windowMs / 3_600_000;
  lines.push(`  Window: ${rlWindowHrs}h`);

  return lines.join("\n");
}
