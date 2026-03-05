import { z } from "zod";
import { BN } from "@coral-xyz/anchor";
import type { PhalnxClient, QueuePolicyUpdateParams } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";

export const queuePolicyUpdateSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  dailySpendingCapUsd: z
    .string()
    .optional()
    .describe("New daily spending cap in USD base units"),
  maxTransactionSizeUsd: z
    .string()
    .optional()
    .describe("New max transaction size in USD base units"),
  protocolMode: z
    .number()
    .optional()
    .describe(
      "New protocol access mode: 0 = all allowed, 1 = allowlist, 2 = denylist",
    ),
  protocols: z
    .array(z.string())
    .optional()
    .describe("New protocol program IDs (base58). Max 10."),
  allowedDestinations: z
    .array(z.string())
    .optional()
    .describe("New allowed destination addresses (base58). Max 10."),
  maxLeverageBps: z
    .number()
    .optional()
    .describe("New max leverage in basis points"),
  canOpenPositions: z
    .boolean()
    .optional()
    .describe("Whether the agent can open new positions"),
  maxConcurrentPositions: z
    .number()
    .optional()
    .describe("New max concurrent positions"),
  timelockDuration: z
    .number()
    .optional()
    .describe("New timelock duration in seconds"),
  developerFeeRate: z
    .number()
    .optional()
    .describe("New developer fee rate (max 500 = 5 BPS)"),
});

export type QueuePolicyUpdateInput = z.infer<typeof queuePolicyUpdateSchema>;

export async function queuePolicyUpdate(
  client: PhalnxClient,
  input: QueuePolicyUpdateInput,
): Promise<string> {
  try {
    const params: QueuePolicyUpdateParams = {};

    if (input.dailySpendingCapUsd !== undefined) {
      params.dailySpendingCapUsd = toBN(input.dailySpendingCapUsd);
    }
    if (input.maxTransactionSizeUsd !== undefined) {
      params.maxTransactionAmountUsd = toBN(input.maxTransactionSizeUsd);
    }
    if (input.protocolMode !== undefined) {
      params.protocolMode = input.protocolMode;
    }
    if (input.protocols !== undefined) {
      params.protocols = input.protocols.map(toPublicKey);
    }
    if (input.allowedDestinations !== undefined) {
      params.allowedDestinations = input.allowedDestinations.map(toPublicKey);
    }
    if (input.maxLeverageBps !== undefined) {
      params.maxLeverageBps = input.maxLeverageBps;
    }
    if (input.canOpenPositions !== undefined) {
      params.canOpenPositions = input.canOpenPositions;
    }
    if (input.maxConcurrentPositions !== undefined) {
      params.maxConcurrentPositions = input.maxConcurrentPositions;
    }
    if (input.timelockDuration !== undefined) {
      params.timelockDuration = new BN(input.timelockDuration);
    }
    if (input.developerFeeRate !== undefined) {
      params.developerFeeRate = input.developerFeeRate;
    }

    const sig = await client.queuePolicyUpdate(
      toPublicKey(input.vault),
      params,
    );

    const updated = Object.keys(params).join(", ") || "none";

    return [
      "## Policy Update Queued",
      `- **Vault:** ${input.vault}`,
      `- **Fields Queued:** ${updated}`,
      `- **Transaction:** ${sig}`,
      "",
      "The policy change is now pending. Use `shield_check_pending_policy` to view status.",
      "Use `shield_apply_pending_policy` after the timelock expires to apply the changes.",
      "Use `shield_cancel_pending_policy` to cancel before it takes effect.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const queuePolicyUpdateTool = {
  name: "shield_queue_policy_update",
  description:
    "Queue a timelocked policy change for an Phalnx vault. " +
    "Required when the vault has a timelock_duration > 0. " +
    "The change will not take effect until the timelock expires and shield_apply_pending_policy is called.",
  schema: queuePolicyUpdateSchema,
  handler: queuePolicyUpdate,
};
