import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, formatBN, formatTimestamp } from "../utils";
import { formatError } from "../errors";

export const checkPendingPolicySchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type CheckPendingPolicyInput = z.infer<typeof checkPendingPolicySchema>;

export async function checkPendingPolicy(
  client: PhalnxClient,
  input: CheckPendingPolicyInput,
): Promise<string> {
  try {
    const pending = await client.fetchPendingPolicy(toPublicKey(input.vault));

    if (!pending) {
      return [
        "## Pending Policy",
        `- **Vault:** ${input.vault}`,
        `- **Pending:** No`,
        "",
        "No pending policy update exists for this vault.",
      ].join("\n");
    }

    const now = Math.floor(Date.now() / 1000);
    const executesAt = pending.executesAt.toNumber();
    const remaining = executesAt - now;
    const timeRemaining =
      remaining > 0
        ? `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`
        : "Ready to apply";

    const changes: string[] = [];
    if (pending.dailySpendingCapUsd !== null) {
      changes.push(
        `  - Daily Spending Cap: → ${formatBN(pending.dailySpendingCapUsd)}`,
      );
    }
    if (pending.maxTransactionAmountUsd !== null) {
      changes.push(
        `  - Max Transaction Size: → ${formatBN(pending.maxTransactionAmountUsd)}`,
      );
    }
    if (pending.protocolMode !== null) {
      const modeLabels = ["All Allowed", "Allowlist", "Denylist"];
      changes.push(
        `  - Protocol Mode: → ${modeLabels[pending.protocolMode] ?? `Unknown (${pending.protocolMode})`}`,
      );
    }
    if (pending.protocols !== null) {
      const protocols = pending.protocols.map((p) => p.toBase58()).join(", ");
      changes.push(`  - Protocols: → [${protocols}]`);
    }
    if (pending.allowedDestinations !== null) {
      const dests = pending.allowedDestinations
        .map((d) => d.toBase58())
        .join(", ");
      changes.push(`  - Allowed Destinations: → [${dests}]`);
    }
    if (pending.maxLeverageBps !== null) {
      changes.push(`  - Max Leverage: → ${pending.maxLeverageBps} BPS`);
    }
    if (pending.canOpenPositions !== null) {
      changes.push(`  - Can Open Positions: → ${pending.canOpenPositions}`);
    }
    if (pending.maxConcurrentPositions !== null) {
      changes.push(
        `  - Max Concurrent Positions: → ${pending.maxConcurrentPositions}`,
      );
    }
    if (pending.timelockDuration !== null) {
      changes.push(
        `  - Timelock Duration: → ${formatBN(pending.timelockDuration)}s`,
      );
    }
    if (pending.developerFeeRate !== null) {
      changes.push(`  - Developer Fee Rate: → ${pending.developerFeeRate}`);
    }

    return [
      "## Pending Policy",
      `- **Vault:** ${input.vault}`,
      `- **Pending:** Yes`,
      `- **Queued At:** ${formatTimestamp(pending.queuedAt)}`,
      `- **Executes At:** ${formatTimestamp(pending.executesAt)}`,
      `- **Time Remaining:** ${timeRemaining}`,
      "",
      "### Queued Changes",
      changes.length > 0 ? changes.join("\n") : "  (no fields specified)",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const checkPendingPolicyTool = {
  name: "shield_check_pending_policy",
  description:
    "Check if a pending (timelocked) policy update exists for an Phalnx vault. " +
    "Shows queued changes, timestamps, and time remaining until the update can be applied.",
  schema: checkPendingPolicySchema,
  handler: checkPendingPolicy,
};
