import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";

export const closeSettledEscrowSchema = z.object({
  sourceVault: z.string().describe("Source vault PDA address (base58)"),
  destinationVault: z
    .string()
    .describe("Destination vault PDA address (base58)"),
  escrow: z.string().describe("Escrow PDA address (base58)"),
  escrowId: z.string().describe("Escrow ID number"),
});

export type CloseSettledEscrowInput = z.infer<typeof closeSettledEscrowSchema>;

export async function closeSettledEscrow(
  client: PhalnxClient,
  input: CloseSettledEscrowInput,
): Promise<string> {
  try {
    const sig = await client.closeSettledEscrow(
      toPublicKey(input.sourceVault),
      toPublicKey(input.destinationVault),
      toPublicKey(input.escrow),
      toBN(input.escrowId),
    );

    return [
      "## Escrow Account Closed",
      `- **Escrow:** ${input.escrow}`,
      `- **Transaction:** ${sig}`,
      "",
      "The escrow account has been closed and rent reclaimed.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const closeSettledEscrowTool = {
  name: "shield_close_settled_escrow",
  description:
    "Close a settled or refunded escrow account and reclaim rent. " +
    "Can only be called after the escrow has been settled or refunded.",
  schema: closeSettledEscrowSchema,
  handler: closeSettledEscrow,
};
