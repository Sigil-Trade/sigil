import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PhalnxClient, AgentTransferParams } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";

export const agentTransferSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  destination: z
    .string()
    .describe(
      "Destination wallet address (base58). Must be in allowed_destinations if configured.",
    ),
  mint: z.string().describe("Token mint address (base58)"),
  amount: z.string().describe("Amount in token base units"),
});

export type AgentTransferInput = z.infer<typeof agentTransferSchema>;

export async function agentTransfer(
  client: PhalnxClient,
  input: AgentTransferInput,
): Promise<string> {
  try {
    const vault = toPublicKey(input.vault);
    const destination = toPublicKey(input.destination);
    const mint = toPublicKey(input.mint);
    const amount = toBN(input.amount);

    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vault,
      true, // allowOwnerOffCurve — vault is a PDA
    );
    const destinationTokenAccount = getAssociatedTokenAddressSync(
      mint,
      destination,
    );

    const params: AgentTransferParams = {
      amount,
      vaultTokenAccount,
      tokenMintAccount: mint,
      destinationTokenAccount,
    };

    const sig = await client.agentTransfer(vault, params);

    return [
      "## Agent Transfer Complete",
      `- **Vault:** ${input.vault}`,
      `- **Destination:** ${input.destination}`,
      `- **Token:** ${input.mint}`,
      `- **Amount:** ${input.amount}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const agentTransferTool = {
  name: "shield_agent_transfer",
  description:
    "Transfer tokens from an Phalnx vault to a destination address. " +
    "Agent-signed operation. If the vault has an allowed_destinations list, " +
    "the destination must be in it. Respects daily spending caps.",
  schema: agentTransferSchema,
  handler: agentTransfer,
};
