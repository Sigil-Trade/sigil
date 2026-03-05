import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const refundEscrowSchema = z.object({
  sourceVault: z.string().describe("Source vault PDA address (base58)"),
  escrow: z.string().describe("Escrow PDA address (base58)"),
  escrowAta: z.string().describe("Escrow token account (base58)"),
  sourceVaultAta: z.string().describe("Source vault token account (base58)"),
  tokenMint: z.string().describe("Token mint address (base58)"),
});

export type RefundEscrowInput = z.infer<typeof refundEscrowSchema>;

export async function refundEscrow(
  client: PhalnxClient,
  input: RefundEscrowInput,
): Promise<string> {
  try {
    const sig = await client.refundEscrow(
      toPublicKey(input.sourceVault),
      toPublicKey(input.escrow),
      toPublicKey(input.escrowAta),
      toPublicKey(input.sourceVaultAta),
      toPublicKey(input.tokenMint),
    );

    return [
      "## Escrow Refunded",
      `- **Escrow:** ${input.escrow}`,
      `- **Source Vault:** ${input.sourceVault}`,
      `- **Transaction:** ${sig}`,
      "",
      "Tokens have been returned to the source vault. The escrow has expired.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const refundEscrowTool = {
  name: "shield_refund_escrow",
  description:
    "Refund an expired escrow, returning tokens to the source vault. " +
    "Can only be called after the escrow expiration time has passed.",
  schema: refundEscrowSchema,
  handler: refundEscrow,
};
