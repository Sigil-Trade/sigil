import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const settleEscrowSchema = z.object({
  destinationVault: z
    .string()
    .describe("Destination vault PDA address (base58)"),
  sourceVault: z.string().describe("Source vault PDA address (base58)"),
  escrow: z.string().describe("Escrow PDA address (base58)"),
  escrowAta: z.string().describe("Escrow token account (base58)"),
  destinationVaultAta: z
    .string()
    .describe("Destination vault token account (base58)"),
  tokenMint: z.string().describe("Token mint address (base58)"),
  proof: z
    .string()
    .describe(
      "Base64-encoded proof data whose SHA-256 hash matches the condition_hash",
    ),
});

export type SettleEscrowInput = z.infer<typeof settleEscrowSchema>;

export async function settleEscrow(
  client: PhalnxClient,
  input: SettleEscrowInput,
): Promise<string> {
  try {
    const proofBuffer = Buffer.from(input.proof, "base64");
    const sig = await client.settleEscrow(
      toPublicKey(input.destinationVault),
      toPublicKey(input.sourceVault),
      toPublicKey(input.escrow),
      toPublicKey(input.escrowAta),
      toPublicKey(input.destinationVaultAta),
      toPublicKey(input.tokenMint),
      proofBuffer,
    );

    return [
      "## Escrow Settled",
      `- **Escrow:** ${input.escrow}`,
      `- **Destination Vault:** ${input.destinationVault}`,
      `- **Transaction:** ${sig}`,
      "",
      "Tokens have been released to the destination vault. " +
        "Use shield_close_settled_escrow to reclaim the escrow account rent.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const settleEscrowTool = {
  name: "shield_settle_escrow",
  description:
    "Settle a conditional escrow by providing proof that matches the condition hash. " +
    "Transfers escrowed tokens to the destination vault. Agent-signed (destination vault agent).",
  schema: settleEscrowSchema,
  handler: settleEscrow,
};
