import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";

export const depositSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  mint: z.string().describe("Token mint address (base58)"),
  amount: z.string().describe("Amount in token base units (e.g. lamports)"),
});

export type DepositInput = z.infer<typeof depositSchema>;

export async function deposit(
  client: PhalnxClient,
  input: DepositInput,
): Promise<string> {
  try {
    const sig = await client.deposit(
      toPublicKey(input.vault),
      toPublicKey(input.mint),
      toBN(input.amount),
    );

    return [
      "## Deposit Successful",
      `- **Vault:** ${input.vault}`,
      `- **Token:** ${input.mint}`,
      `- **Amount:** ${input.amount}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const depositTool = {
  name: "shield_deposit",
  description:
    "Deposit tokens into an Phalnx vault. " +
    "The owner must have sufficient token balance.",
  schema: depositSchema,
  handler: deposit,
};
