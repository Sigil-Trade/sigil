import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const registerAgentSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  agent: z.string().describe("Agent public key to register (base58)"),
});

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;

export async function registerAgent(
  client: AgentShieldClient,
  input: RegisterAgentInput
): Promise<string> {
  try {
    const sig = await client.registerAgent(
      toPublicKey(input.vault),
      toPublicKey(input.agent)
    );

    return [
      "## Agent Registered",
      `- **Vault:** ${input.vault}`,
      `- **Agent:** ${input.agent}`,
      `- **Transaction:** ${sig}`,
      "",
      "The agent can now execute trades through this vault (swaps, positions) " +
        "within the vault's policy limits.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const registerAgentTool = {
  name: "shield_register_agent",
  description:
    "Register an agent signing key to an AgentShield vault. " +
    "One agent per vault. The agent can execute trades within policy limits.",
  schema: registerAgentSchema,
  handler: registerAgent,
};
