import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const cancelRecurringOrderSchema = z.object({
  orderId: z.string().describe("Jupiter recurring order ID to cancel"),
});

export type CancelRecurringOrderInput = z.infer<
  typeof cancelRecurringOrderSchema
>;

export async function cancelRecurringOrder(
  client: PhalnxClient,
  config: McpConfig,
  input: CancelRecurringOrderInput,
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

    const result = await client.cancelJupiterRecurringOrder(
      input.orderId,
      agentPubkey,
      agentPubkey,
    );

    return [
      "## Jupiter Recurring Order Cancelled",
      `- **Order ID:** ${input.orderId}`,
      "",
      "Transaction ready for signing.",
      `Transaction: ${result.transaction.slice(0, 32)}...`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const cancelRecurringOrderTool = {
  name: "shield_cancel_recurring_order",
  description:
    "Cancel a Jupiter recurring/DCA order. Client-side policy enforcement.",
  schema: cancelRecurringOrderSchema,
  handler: cancelRecurringOrder,
};
