import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const revokeAgentSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type RevokeAgentInput = z.infer<typeof revokeAgentSchema>;

export async function revokeAgent(
  client: AgentShieldClient,
  input: RevokeAgentInput
): Promise<string> {
  try {
    const sig = await client.revokeAgent(toPublicKey(input.vault));

    return [
      "## Agent Revoked (Kill Switch)",
      `- **Vault:** ${input.vault}`,
      `- **Transaction:** ${sig}`,
      "",
      "The vault is now FROZEN. No trades can be executed. " +
        "Use shield_reactivate_vault to restore access with a new or existing agent.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const revokeAgentTool = {
  name: "shield_revoke_agent",
  description:
    "Emergency kill switch — revokes the agent and freezes the vault immediately. " +
    "Owner-only. Use shield_reactivate_vault to restore access afterward.",
  schema: revokeAgentSchema,
  handler: revokeAgent,
};
