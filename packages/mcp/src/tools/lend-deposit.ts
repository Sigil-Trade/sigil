import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const lendDepositSchema = z.object({
  vault: z.string().min(32).max(44).describe("Vault PDA address (base58)"),
  mint: z.string().min(32).max(44).describe("Token mint to deposit (base58)"),
  amount: z
    .string()
    .regex(/^\d+$/, "Amount must be a numeric string")
    .describe("Amount in token base units"),
});

export type LendDepositInput = z.infer<typeof lendDepositSchema>;

export async function lendDeposit(
  client: PhalnxClient,
  config: McpConfig,
  input: LendDepositInput,
  custodyWallet?: CustodyWalletLike | null,
): Promise<string> {
  try {
    let agentPubkey: import("@solana/web3.js").PublicKey;

    if (custodyWallet) {
      agentPubkey = custodyWallet.publicKey;
    } else {
      const agentKeypair = loadAgentKeypair(config);
      agentPubkey = agentKeypair.publicKey;
    }

    const vaultAddress = toPublicKey(input.vault);
    const vault = await client.fetchVaultByAddress(vaultAddress);

    const sig = await client.jupiterLendDeposit({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      tokenMint: toPublicKey(input.mint),
      amount: toBN(input.amount),
    });

    return [
      "## Lend Deposit Complete",
      `- **Vault:** ${input.vault}`,
      `- **Mint:** ${input.mint}`,
      `- **Amount:** ${input.amount}`,
      `- **Transaction:** ${sig}`,
      "",
      "Deposit is spending-checked against your vault's daily spending cap.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const lendDepositTool = {
  name: "shield_lend_deposit",
  description:
    "Deposit tokens into Jupiter Lend/Earn through an Phalnx vault. " +
    "Full on-chain sandwich enforcement. Counts against daily spending cap.",
  schema: lendDepositSchema,
  handler: lendDeposit,
};
