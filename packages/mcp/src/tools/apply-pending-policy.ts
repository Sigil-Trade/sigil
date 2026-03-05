import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const applyPendingPolicySchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type ApplyPendingPolicyInput = z.infer<typeof applyPendingPolicySchema>;

export async function applyPendingPolicy(
  client: PhalnxClient,
  input: ApplyPendingPolicyInput,
): Promise<string> {
  try {
    const sig = await client.applyPendingPolicy(toPublicKey(input.vault));

    return [
      "## Pending Policy Applied",
      `- **Vault:** ${input.vault}`,
      `- **Transaction:** ${sig}`,
      "",
      "The queued policy changes have been applied. The pending policy PDA has been closed.",
      "Use `shield_check_vault` to verify the updated policy.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const applyPendingPolicyTool = {
  name: "shield_apply_pending_policy",
  description:
    "Apply a pending (timelocked) policy update to an Phalnx vault. " +
    "Only works after the timelock duration has elapsed. Owner-only operation.",
  schema: applyPendingPolicySchema,
  handler: applyPendingPolicy,
};
