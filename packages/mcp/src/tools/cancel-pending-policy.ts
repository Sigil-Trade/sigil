import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const cancelPendingPolicySchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type CancelPendingPolicyInput = z.infer<
  typeof cancelPendingPolicySchema
>;

export async function cancelPendingPolicy(
  client: AgentShieldClient,
  input: CancelPendingPolicyInput,
): Promise<string> {
  try {
    const sig = await client.cancelPendingPolicy(toPublicKey(input.vault));

    return [
      "## Pending Policy Cancelled",
      `- **Vault:** ${input.vault}`,
      `- **Transaction:** ${sig}`,
      "",
      "The queued policy change has been cancelled. No changes were applied.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const cancelPendingPolicyTool = {
  name: "shield_cancel_pending_policy",
  description:
    "Cancel a pending (timelocked) policy update for an AgentShield vault. " +
    "Removes the queued changes without applying them. Owner-only operation.",
  schema: cancelPendingPolicySchema,
  handler: cancelPendingPolicy,
};
