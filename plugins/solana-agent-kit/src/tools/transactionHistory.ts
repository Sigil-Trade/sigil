import { z } from "zod";
import type { ResolvedConfig } from "../types";

export const transactionHistorySchema = z.object({});

export type TransactionHistoryInput = z.infer<typeof transactionHistorySchema>;

export async function transactionHistory(
  _agent: any,
  config: ResolvedConfig,
  _input: TransactionHistoryInput,
): Promise<string> {
  const wallet = config.wallet;
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
      lines.push(`    Spent: ${t.spent.toString()} / ${t.limit.toString()}`);
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

  return lines.join("\n");
}
