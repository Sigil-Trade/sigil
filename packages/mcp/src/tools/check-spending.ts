import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import {
  toPublicKey,
  formatBN,
  formatTimestamp,
  formatActionType,
} from "../utils";
import { formatError } from "../errors";

export const checkSpendingSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type CheckSpendingInput = z.infer<typeof checkSpendingSchema>;

export async function checkSpending(
  client: AgentShieldClient,
  input: CheckSpendingInput
): Promise<string> {
  try {
    const vaultAddress = toPublicKey(input.vault);
    const tracker = await client.fetchTracker(vaultAddress);
    const policy = await client.fetchPolicy(vaultAddress);

    const cap = formatBN(policy.dailySpendingCap);
    const lines: string[] = [
      `## Spending Report: ${vaultAddress.toBase58()}`,
      `- **Daily Cap:** ${cap}`,
      "",
      "### Rolling 24h Spend by Token",
    ];

    if (tracker.rollingSpends.length === 0) {
      lines.push("No spending activity in the last 24 hours.");
    } else {
      for (const entry of tracker.rollingSpends) {
        lines.push(
          `- **${entry.tokenMint.toBase58()}**: ${formatBN(entry.amountSpent)} ` +
            `(at ${formatTimestamp(entry.timestamp)})`
        );
      }
    }

    lines.push("");
    lines.push(`### Recent Transactions (${tracker.recentTransactions.length})`);

    if (tracker.recentTransactions.length === 0) {
      lines.push("No recent transactions.");
    } else {
      for (const tx of tracker.recentTransactions.slice(-10)) {
        const status = tx.success ? "OK" : "FAIL";
        lines.push(
          `- [${status}] ${formatActionType(tx.actionType)} — ` +
            `${formatBN(tx.amount)} at ${formatTimestamp(tx.timestamp)} ` +
            `(slot ${formatBN(tx.slot)})`
        );
      }
      if (tracker.recentTransactions.length > 10) {
        lines.push(
          `... and ${tracker.recentTransactions.length - 10} more`
        );
      }
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const checkSpendingTool = {
  name: "shield_check_spending",
  description:
    "Check the rolling 24h spending and recent transaction history for an AgentShield vault.",
  schema: checkSpendingSchema,
  handler: checkSpending,
};
