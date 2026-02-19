import { z } from "zod";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { AgentShieldClient, QueuePolicyUpdateParams } from "@agent-shield/sdk";
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
  allowedTokens: z
    .array(z.string())
    .optional()
    .describe("New allowed token mints (base58). Max 10."),
  allowedProtocols: z
    .array(z.string())
    .optional()
    .describe("New allowed protocol IDs (base58). Max 10."),
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
    .describe("New developer fee rate (max 50 = 0.5 BPS)"),
});

export type QueuePolicyUpdateInput = z.infer<typeof queuePolicyUpdateSchema>;

export async function queuePolicyUpdate(
  client: AgentShieldClient,
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
    if (input.allowedTokens !== undefined) {
      params.allowedTokens = input.allowedTokens.map((addr) => ({
        mint: toPublicKey(addr),
        oracleFeed: PublicKey.default,
        decimals: 6,
        dailyCapBase: new BN(0),
        maxTxBase: new BN(0),
      }));
    }
    if (input.allowedProtocols !== undefined) {
      params.allowedProtocols = input.allowedProtocols.map(toPublicKey);
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
    "Queue a timelocked policy change for an AgentShield vault. " +
    "Required when the vault has a timelock_duration > 0. " +
    "The change will not take effect until the timelock expires and shield_apply_pending_policy is called.",
  schema: queuePolicyUpdateSchema,
  handler: queuePolicyUpdate,
};
