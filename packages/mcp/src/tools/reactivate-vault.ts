import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const reactivateVaultSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  newAgent: z
    .string()
    .optional()
    .describe(
      "Optional new agent public key (base58). If omitted, the previous agent is re-registered.",
    ),
  newAgentPermissions: z
    .string()
    .optional()
    .describe(
      "Permission bitmask for the new agent as a decimal string. " +
        "Omit for full permissions (2097151). Only used when newAgent is provided.",
    ),
});

export type ReactivateVaultInput = z.infer<typeof reactivateVaultSchema>;

export async function reactivateVault(
  client: PhalnxClient,
  input: ReactivateVaultInput,
): Promise<string> {
  try {
    const { BN } = await import("@coral-xyz/anchor");
    const newAgent = input.newAgent ? toPublicKey(input.newAgent) : undefined;
    const newAgentPermissions = input.newAgentPermissions
      ? new BN(input.newAgentPermissions)
      : undefined;

    const sig = await client.reactivateVault(
      toPublicKey(input.vault),
      newAgent,
      newAgentPermissions,
    );

    return [
      "## Vault Reactivated",
      `- **Vault:** ${input.vault}`,
      `- **New Agent:** ${input.newAgent ?? "(previous agent re-registered)"}`,
      ...(newAgentPermissions
        ? [`- **Permissions:** ${newAgentPermissions.toString()}`]
        : []),
      `- **Transaction:** ${sig}`,
      "",
      "The vault is now ACTIVE. The agent can execute trades again.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const reactivateVaultTool = {
  name: "shield_reactivate_vault",
  description:
    "Reactivate a frozen vault. Optionally register a new agent key. " +
    "Owner-only. The vault must be in Frozen status.",
  schema: reactivateVaultSchema,
  handler: reactivateVault,
};
