import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const createTriggerOrderJupSchema = z.object({
  inputMint: z.string().describe("Input token mint address (base58)"),
  outputMint: z.string().describe("Output token mint address (base58)"),
  makingAmount: z.string().describe("Input amount in token base units"),
  takingAmount: z
    .string()
    .describe("Minimum output amount in token base units"),
  expiredAt: z
    .number()
    .optional()
    .default(0)
    .describe("Expiry timestamp (Unix seconds). 0 = no expiry."),
});

export type CreateTriggerOrderJupInput = z.input<
  typeof createTriggerOrderJupSchema
>;

export async function createTriggerOrderJup(
  client: PhalnxClient,
  config: McpConfig,
  input: CreateTriggerOrderJupInput,
  custodyWallet?: CustodyWalletLike | null,
): Promise<string> {
  try {
    let agentPubkey: string;

    if (custodyWallet) {
      agentPubkey = custodyWallet.publicKey.toBase58();
    } else {
      const agentKeypair = loadAgentKeypair(config);
      agentPubkey = agentKeypair.publicKey.toBase58();
    }

    const result = await client.createJupiterTriggerOrder({
      maker: agentPubkey,
      payer: agentPubkey,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      makingAmount: input.makingAmount,
      takingAmount: input.takingAmount,
      expiredAt: input.expiredAt,
    });

    return [
      "## Jupiter Trigger Order Created",
      `- **Input:** ${input.makingAmount} of ${input.inputMint}`,
      `- **Output:** min ${input.takingAmount} of ${input.outputMint}`,
      `- **Expiry:** ${input.expiredAt === 0 ? "None" : new Date(input.expiredAt! * 1000).toISOString()}`,
      "",
      "Transaction ready for signing. Client-side policy enforcement applied.",
      `Transaction: ${result.serializedTransaction.slice(0, 32)}...`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const createTriggerOrderJupTool = {
  name: "shield_create_trigger_order_jup",
  description:
    "Create a Jupiter limit/trigger order. Client-side policy enforcement. " +
    "Uses _jup suffix to distinguish from Flash Trade trigger orders.",
  schema: createTriggerOrderJupSchema,
  handler: createTriggerOrderJup,
};
