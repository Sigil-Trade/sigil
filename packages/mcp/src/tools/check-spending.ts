import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey, formatBN } from "../utils";
import { formatError } from "../errors";

export const checkSpendingSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type CheckSpendingInput = z.infer<typeof checkSpendingSchema>;

export async function checkSpending(
  client: AgentShieldClient,
  input: CheckSpendingInput,
): Promise<string> {
  try {
    const vaultAddress = toPublicKey(input.vault);
    const tracker = await client.fetchTracker(vaultAddress);
    const policy = await client.fetchPolicy(vaultAddress);

    const cap = formatBN(policy.dailySpendingCapUsd);
    const lines: string[] = [
      `## Spending Report: ${vaultAddress.toBase58()}`,
      `- **Daily Cap:** ${cap}`,
      "",
      "### Rolling 24h Spend (Epoch Buckets)",
    ];

    // Filter to non-zero buckets only
    const activeBuckets = tracker.buckets.filter((b) => !b.usdAmount.isZero());

    if (activeBuckets.length === 0) {
      lines.push("No spending activity in the last 24 hours.");
    } else {
      let totalUsd = activeBuckets[0].usdAmount.clone();
      for (let i = 1; i < activeBuckets.length; i++) {
        totalUsd = totalUsd.add(activeBuckets[i].usdAmount);
      }
      lines.push(`- **Total 24h Spend (USD):** ${formatBN(totalUsd)}`);
      lines.push(`- **Active Epoch Buckets:** ${activeBuckets.length}`);
      for (const bucket of activeBuckets) {
        lines.push(
          `  - Epoch ${formatBN(bucket.epochId)}: $${formatBN(bucket.usdAmount)}`,
        );
      }
    }

    lines.push("");
    lines.push(
      "Transaction history is available via Anchor events (use an explorer or event listener).",
    );

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const checkSpendingTool = {
  name: "shield_check_spending",
  description:
    "Check the rolling 24h spending for an AgentShield vault. " +
    "Uses epoch-based circular buffer. Transaction history is available via Anchor events.",
  schema: checkSpendingSchema,
  handler: checkSpending,
};
