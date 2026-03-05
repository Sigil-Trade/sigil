import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN, formatBN, formatTimestamp } from "../utils";
import { formatError } from "../errors";

export const checkEscrowSchema = z.object({
  sourceVault: z.string().describe("Source vault PDA address (base58)"),
  destinationVault: z
    .string()
    .describe("Destination vault PDA address (base58)"),
  escrowId: z.string().describe("Escrow ID number"),
});

export type CheckEscrowInput = z.infer<typeof checkEscrowSchema>;

function formatEscrowStatus(status: any): string {
  if ("active" in status) return "Active";
  if ("settled" in status) return "Settled";
  if ("refunded" in status) return "Refunded";
  return "Unknown";
}

export async function checkEscrow(
  client: PhalnxClient,
  input: CheckEscrowInput,
): Promise<string> {
  try {
    const escrow = await client.fetchEscrow(
      toPublicKey(input.sourceVault),
      toPublicKey(input.destinationVault),
      toBN(input.escrowId),
    );

    const now = Math.floor(Date.now() / 1000);
    const expiresAtNum = escrow.expiresAt.toNumber();
    const remaining = expiresAtNum - now;
    const timeStatus =
      remaining > 0
        ? `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m remaining`
        : "Expired";

    return [
      "## Escrow Status",
      `- **Source Vault:** ${escrow.sourceVault.toBase58()}`,
      `- **Destination Vault:** ${escrow.destinationVault.toBase58()}`,
      `- **Escrow ID:** ${formatBN(escrow.escrowId)}`,
      `- **Status:** ${formatEscrowStatus(escrow.status)}`,
      `- **Amount:** ${formatBN(escrow.amount)}`,
      `- **Token Mint:** ${escrow.tokenMint.toBase58()}`,
      `- **Created:** ${formatTimestamp(escrow.createdAt)}`,
      `- **Expires:** ${formatTimestamp(escrow.expiresAt)} (${timeStatus})`,
      `- **Condition Hash:** [${escrow.conditionHash.join(", ")}]`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const checkEscrowTool = {
  name: "shield_check_escrow",
  description:
    "Check the status of a conditional escrow between two vaults. " +
    "Shows amount, expiration, status, and condition hash.",
  schema: checkEscrowSchema,
  handler: checkEscrow,
};
