import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";

export const withdrawSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  mint: z.string().describe("Token mint address (base58)"),
  amount: z.string().describe("Amount in token base units (e.g. lamports)"),
});

export type WithdrawInput = z.infer<typeof withdrawSchema>;

export async function withdraw(
  client: PhalnxClient,
  input: WithdrawInput,
): Promise<string> {
  try {
    const sig = await client.withdraw(
      toPublicKey(input.vault),
      toPublicKey(input.mint),
      toBN(input.amount),
    );

    return [
      "## Withdrawal Successful",
      `- **Vault:** ${input.vault}`,
      `- **Token:** ${input.mint}`,
      `- **Amount:** ${input.amount}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const withdrawTool = {
  name: "shield_withdraw",
  description: "Withdraw tokens from an Phalnx vault. Owner-only operation.",
  schema: withdrawSchema,
  handler: withdraw,
};
