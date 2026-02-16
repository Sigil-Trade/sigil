import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import type { UpdatePolicyParams } from "@agent-shield/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";

export const updatePolicySchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  dailySpendingCap: z
    .string()
    .optional()
    .describe("New daily spending cap in token base units"),
  maxTransactionSize: z
    .string()
    .optional()
    .describe("New max transaction size in token base units"),
  allowedTokens: z
    .array(z.string())
    .optional()
    .describe("New allowed token mints (base58). Max 10. Replaces existing list."),
  allowedProtocols: z
    .array(z.string())
    .optional()
    .describe("New allowed protocol IDs (base58). Max 10. Replaces existing list."),
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
  developerFeeRate: z
    .number()
    .optional()
    .describe("New developer fee rate (max 50 = 0.5 BPS)"),
});

export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

export async function updatePolicy(
  client: AgentShieldClient,
  input: UpdatePolicyInput
): Promise<string> {
  try {
    const params: UpdatePolicyParams = {};

    if (input.dailySpendingCap !== undefined) {
      params.dailySpendingCap = toBN(input.dailySpendingCap);
    }
    if (input.maxTransactionSize !== undefined) {
      params.maxTransactionSize = toBN(input.maxTransactionSize);
    }
    if (input.allowedTokens !== undefined) {
      params.allowedTokens = input.allowedTokens.map(toPublicKey);
    }
    if (input.allowedProtocols !== undefined) {
      params.allowedProtocols = input.allowedProtocols.map(toPublicKey);
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
    if (input.developerFeeRate !== undefined) {
      params.developerFeeRate = input.developerFeeRate;
    }

    const sig = await client.updatePolicy(
      toPublicKey(input.vault),
      params
    );

    const updated = Object.keys(params).join(", ") || "none";

    return [
      "## Policy Updated",
      `- **Vault:** ${input.vault}`,
      `- **Fields Updated:** ${updated}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const updatePolicyTool = {
  name: "shield_update_policy",
  description:
    "Update the policy configuration for an AgentShield vault. " +
    "Only the fields you provide will be changed. Owner-only operation.",
  schema: updatePolicySchema,
  handler: updatePolicy,
};
