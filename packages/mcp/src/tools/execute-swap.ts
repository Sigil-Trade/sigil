import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const executeSwapSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  inputMint: z.string().describe("Input token mint address (base58)"),
  outputMint: z.string().describe("Output token mint address (base58)"),
  amount: z.string().describe("Input amount in token base units"),
  slippageBps: z
    .number()
    .optional()
    .default(50)
    .describe("Slippage tolerance in basis points (default: 50 = 0.5%)"),
});

export type ExecuteSwapInput = z.infer<typeof executeSwapSchema>;

export async function executeSwap(
  client: PhalnxClient,
  config: McpConfig,
  input: ExecuteSwapInput,
  custodyWallet?: CustodyWalletLike | null,
): Promise<string> {
  try {
    let agentPubkey: import("@solana/web3.js").PublicKey;
    let signers: import("@solana/web3.js").Keypair[];

    if (custodyWallet) {
      // Custody: provider.wallet IS the agent signer
      agentPubkey = custodyWallet.publicKey;
      signers = []; // provider.wallet handles signing via custody API
    } else {
      // Keypair: load from config
      const agentKeypair = loadAgentKeypair(config);
      agentPubkey = agentKeypair.publicKey;
      signers = [agentKeypair];
    }

    const vaultAddress = toPublicKey(input.vault);

    // Fetch vault to get owner and vaultId for the swap params
    const vault = await client.fetchVaultByAddress(vaultAddress);

    // Execute swap through Phalnx
    // executeJupiterSwap fetches the quote internally if not provided
    const sig = await client.executeJupiterSwap(
      {
        owner: vault.owner,
        vaultId: vault.vaultId,
        agent: agentPubkey,
        inputMint: toPublicKey(input.inputMint),
        outputMint: toPublicKey(input.outputMint),
        amount: toBN(input.amount),
        slippageBps: input.slippageBps,
      },
      signers,
    );

    return [
      "## Swap Executed",
      `- **Vault:** ${input.vault}`,
      `- **Input:** ${input.amount} of ${input.inputMint}`,
      `- **Output Token:** ${input.outputMint}`,
      `- **Slippage:** ${input.slippageBps} BPS`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const executeSwapTool = {
  name: "shield_execute_swap",
  description:
    "Execute a Jupiter token swap through an Phalnx vault. " +
    "Requires PHALNX_AGENT_KEYPAIR_PATH to be set. " +
    "The swap is policy-checked: spending caps, token allowlist, and transaction size limits apply.",
  schema: executeSwapSchema,
  handler: executeSwap,
};
