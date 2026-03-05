import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const cancelTriggerOrderJupSchema = z.object({
  orderId: z.string().describe("Jupiter trigger order ID to cancel"),
});

export type CancelTriggerOrderJupInput = z.infer<
  typeof cancelTriggerOrderJupSchema
>;

export async function cancelTriggerOrderJup(
  client: PhalnxClient,
  config: McpConfig,
  input: CancelTriggerOrderJupInput,
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

    const result = await client.cancelJupiterTriggerOrder(
      input.orderId,
      agentPubkey,
      agentPubkey,
    );

    return [
      "## Jupiter Trigger Order Cancelled",
      `- **Order ID:** ${input.orderId}`,
      "",
      "Transaction ready for signing.",
      `Transaction: ${result.serializedTransaction.slice(0, 32)}...`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const cancelTriggerOrderJupTool = {
  name: "shield_cancel_trigger_order_jup",
  description:
    "Cancel a Jupiter trigger/limit order. Client-side policy enforcement.",
  schema: cancelTriggerOrderJupSchema,
  handler: cancelTriggerOrderJup,
};
