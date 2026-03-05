import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const revokeAgentSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  agent: z.string().describe("Agent public key to revoke (base58)"),
});

export type RevokeAgentInput = z.infer<typeof revokeAgentSchema>;

export async function revokeAgent(
  client: PhalnxClient,
  input: RevokeAgentInput,
): Promise<string> {
  try {
    const sig = await client.revokeAgent(
      toPublicKey(input.vault),
      toPublicKey(input.agent),
    );

    return [
      "## Agent Revoked",
      `- **Vault:** ${input.vault}`,
      `- **Agent:** ${input.agent}`,
      `- **Transaction:** ${sig}`,
      "",
      "The agent has been removed from the vault. " +
        "If this was the last agent, the vault is now FROZEN. " +
        "Use shield_reactivate_vault to restore access with a new agent.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const revokeAgentTool = {
  name: "shield_revoke_agent",
  description:
    "Remove an agent from a vault. If the vault has no remaining agents, it freezes. " +
    "Owner-only. Use shield_reactivate_vault to restore access afterward.",
  schema: revokeAgentSchema,
  handler: revokeAgent,
};
