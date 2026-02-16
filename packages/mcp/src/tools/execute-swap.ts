import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import { loadAgentKeypair, type McpConfig } from "../config";

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
  client: AgentShieldClient,
  config: McpConfig,
  input: ExecuteSwapInput
): Promise<string> {
  try {
    const agentKeypair = loadAgentKeypair(config);
    const vaultAddress = toPublicKey(input.vault);

    // Fetch vault to get owner and vaultId for the swap params
    const vault = await client.fetchVaultByAddress(vaultAddress);

    // Execute swap through AgentShield
    // executeJupiterSwap fetches the quote internally if not provided
    const sig = await client.executeJupiterSwap(
      {
        owner: vault.owner,
        vaultId: vault.vaultId,
        agent: agentKeypair.publicKey,
        inputMint: toPublicKey(input.inputMint),
        outputMint: toPublicKey(input.outputMint),
        amount: toBN(input.amount),
        slippageBps: input.slippageBps,
      },
      [agentKeypair]
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
    "Execute a Jupiter token swap through an AgentShield vault. " +
    "Requires AGENTSHIELD_AGENT_KEYPAIR_PATH to be set. " +
    "The swap is policy-checked: spending caps, token allowlist, and transaction size limits apply.",
  schema: executeSwapSchema,
  handler: executeSwap,
};
