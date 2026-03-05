import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { formatError } from "../errors";

export const getTriggerOrdersJupSchema = z.object({
  authority: z.string().describe("Wallet address to query orders for (base58)"),
  state: z
    .enum(["active", "completed", "cancelled"])
    .optional()
    .describe("Filter by order state"),
});

export type GetTriggerOrdersJupInput = z.infer<
  typeof getTriggerOrdersJupSchema
>;

export async function getTriggerOrdersJup(
  client: PhalnxClient,
  input: GetTriggerOrdersJupInput,
): Promise<string> {
  try {
    const orders = await client.getJupiterTriggerOrders(
      input.authority,
      input.state,
    );

    if (orders.length === 0) {
      return `No ${input.state ?? ""} trigger orders found for ${input.authority}.`;
    }

    const lines = [`## Jupiter Trigger Orders (${orders.length})`, ""];

    for (const order of orders) {
      lines.push(`### Order ${order.orderId}`);
      lines.push(`- **State:** ${order.state}`);
      lines.push(`- **Input:** ${order.makingAmount} of ${order.inputMint}`);
      lines.push(`- **Output:** ${order.takingAmount} of ${order.outputMint}`);
      lines.push(
        `- **Remaining:** ${order.remainingMakingAmount} / ${order.remainingTakingAmount}`,
      );
      lines.push(`- **Created:** ${order.createdAt}`);
      if (order.expiredAt) {
        lines.push(`- **Expires:** ${order.expiredAt}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const getTriggerOrdersJupTool = {
  name: "shield_get_trigger_orders_jup",
  description:
    "List Jupiter trigger/limit orders for a wallet. " +
    "Read-only — no vault required.",
  schema: getTriggerOrdersJupSchema,
  handler: getTriggerOrdersJup,
};
