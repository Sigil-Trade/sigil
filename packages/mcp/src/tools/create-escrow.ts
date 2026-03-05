import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";

export const createEscrowSchema = z.object({
  sourceVault: z.string().describe("Source vault PDA address (base58)"),
  destinationVault: z
    .string()
    .describe("Destination vault PDA address (base58)"),
  escrowId: z.string().describe("Unique escrow ID number"),
  amount: z.string().describe("Amount in token base units"),
  expiresAt: z
    .string()
    .describe("Expiration timestamp (Unix seconds). Max 30 days from now."),
  conditionHash: z
    .array(z.number().int().min(0).max(255))
    .length(32)
    .describe(
      "SHA-256 condition hash (32 bytes) that must be proven to settle",
    ),
  tokenMint: z.string().describe("Token mint address (base58)"),
  sourceVaultAta: z
    .string()
    .describe("Source vault's associated token account (base58)"),
  protocolTreasuryAta: z
    .string()
    .optional()
    .describe("Protocol treasury token account (base58)"),
  feeDestinationAta: z
    .string()
    .optional()
    .describe("Developer fee destination token account (base58)"),
});

export type CreateEscrowInput = z.infer<typeof createEscrowSchema>;

export async function createEscrow(
  client: PhalnxClient,
  input: CreateEscrowInput,
): Promise<string> {
  try {
    const sig = await client.createEscrow(
      toPublicKey(input.sourceVault),
      toPublicKey(input.destinationVault),
      toBN(input.escrowId),
      toBN(input.amount),
      toBN(input.expiresAt),
      input.conditionHash,
      toPublicKey(input.tokenMint),
      toPublicKey(input.sourceVaultAta),
      input.protocolTreasuryAta ? toPublicKey(input.protocolTreasuryAta) : null,
      input.feeDestinationAta ? toPublicKey(input.feeDestinationAta) : null,
    );

    return [
      "## Escrow Created",
      `- **Source Vault:** ${input.sourceVault}`,
      `- **Destination Vault:** ${input.destinationVault}`,
      `- **Escrow ID:** ${input.escrowId}`,
      `- **Amount:** ${input.amount}`,
      `- **Expires At:** ${new Date(Number(input.expiresAt) * 1000).toISOString()}`,
      `- **Token Mint:** ${input.tokenMint}`,
      `- **Transaction:** ${sig}`,
      "",
      "The escrow is now active. The destination vault's agent can settle it " +
        "by providing proof matching the condition hash. If not settled by the " +
        "expiration time, anyone can refund the tokens to the source vault.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const createEscrowTool = {
  name: "shield_create_escrow",
  description:
    "Create a conditional escrow between two Phalnx vaults. " +
    "Locks tokens from the source vault until conditions are met or the escrow expires. " +
    "Agent-signed (source vault agent).",
  schema: createEscrowSchema,
  handler: createEscrow,
};
