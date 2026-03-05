import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const createRecurringOrderSchema = z.object({
  inputMint: z.string().describe("Input token mint address (base58)"),
  outputMint: z.string().describe("Output token mint address (base58)"),
  inAmount: z
    .string()
    .describe("Total input amount across all orders (token base units)"),
  numberOfOrders: z
    .number()
    .min(2)
    .describe("Number of orders to split into (min 2)"),
  intervalSeconds: z.number().describe("Interval between orders in seconds"),
});

export type CreateRecurringOrderInput = z.infer<
  typeof createRecurringOrderSchema
>;

export async function createRecurringOrder(
  client: PhalnxClient,
  config: McpConfig,
  input: CreateRecurringOrderInput,
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

    const result = await client.createJupiterRecurringOrder({
      maker: agentPubkey,
      payer: agentPubkey,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inAmount: input.inAmount,
      numberOfOrders: input.numberOfOrders,
      intervalSeconds: input.intervalSeconds,
    });

    const intervalHrs = (input.intervalSeconds / 3600).toFixed(1);

    return [
      "## Jupiter Recurring Order Created",
      `- **Input:** ${input.inAmount} of ${input.inputMint}`,
      `- **Output Token:** ${input.outputMint}`,
      `- **Orders:** ${input.numberOfOrders} every ${intervalHrs}h`,
      "",
      "Transaction ready for signing. Client-side policy enforcement applied.",
      `Transaction: ${result.transaction.slice(0, 32)}...`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const createRecurringOrderTool = {
  name: "shield_create_recurring_order",
  description:
    "Create a Jupiter recurring/DCA order. Automates periodic token buys. " +
    "Client-side policy enforcement. Min 2 orders, min 100 USD total.",
  schema: createRecurringOrderSchema,
  handler: createRecurringOrder,
};
