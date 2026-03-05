import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { formatError } from "../errors";

export const getRecurringOrdersSchema = z.object({
  user: z.string().describe("Wallet address to query orders for (base58)"),
});

export type GetRecurringOrdersInput = z.infer<typeof getRecurringOrdersSchema>;

export async function getRecurringOrders(
  client: PhalnxClient,
  input: GetRecurringOrdersInput,
): Promise<string> {
  try {
    const orders = await client.getJupiterRecurringOrders(input.user);

    if (orders.length === 0) {
      return `No recurring orders found for ${input.user}.`;
    }

    const lines = [`## Jupiter Recurring Orders (${orders.length})`, ""];

    for (const order of orders) {
      const intervalHrs = (order.intervalSeconds / 3600).toFixed(1);
      lines.push(`### Order ${order.orderId}`);
      lines.push(`- **State:** ${order.state}`);
      lines.push(`- **Input:** ${order.inAmount} of ${order.inputMint}`);
      lines.push(`- **Output Token:** ${order.outputMint}`);
      lines.push(
        `- **Progress:** ${order.numberOfOrdersFilled}/${order.numberOfOrders} orders`,
      );
      lines.push(`- **Interval:** every ${intervalHrs}h`);
      lines.push(`- **Deposited:** ${order.inDeposited}`);
      lines.push(`- **Received:** ${order.outWithdrawn}`);
      lines.push(`- **Created:** ${order.createdAt}`);
      if (order.nextExecutionAt) {
        lines.push(`- **Next Execution:** ${order.nextExecutionAt}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const getRecurringOrdersTool = {
  name: "shield_get_recurring_orders",
  description:
    "List Jupiter recurring/DCA orders for a wallet. " +
    "Read-only — no vault required.",
  schema: getRecurringOrdersSchema,
  handler: getRecurringOrders,
};
