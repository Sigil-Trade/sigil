import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const lendWithdrawSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  mint: z.string().describe("Token mint to withdraw (base58)"),
  amount: z.string().describe("Amount in token base units"),
});

export type LendWithdrawInput = z.infer<typeof lendWithdrawSchema>;

export async function lendWithdraw(
  client: PhalnxClient,
  config: McpConfig,
  input: LendWithdrawInput,
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

    const sig = await client.jupiterLendWithdraw({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      tokenMint: toPublicKey(input.mint),
      amount: toBN(input.amount),
    });

    return [
      "## Lend Withdrawal Complete",
      `- **Vault:** ${input.vault}`,
      `- **Mint:** ${input.mint}`,
      `- **Amount:** ${input.amount}`,
      `- **Transaction:** ${sig}`,
      "",
      "Withdrawal is non-spending — does not count against daily cap.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const lendWithdrawTool = {
  name: "shield_lend_withdraw",
  description:
    "Withdraw tokens from Jupiter Lend/Earn through an Phalnx vault. " +
    "Full on-chain sandwich enforcement. Non-spending action.",
  schema: lendWithdrawSchema,
  handler: lendWithdraw,
};
