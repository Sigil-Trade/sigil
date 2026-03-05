import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";
import type { McpConfig } from "../config";
import { loadOwnerKeypair } from "../config";

export const squadsExecuteSchema = z.object({
  multisig: z.string().describe("Squads multisig address (base58)"),
  transactionIndex: z
    .string()
    .describe("Transaction index to execute (numeric string)"),
});

export type SquadsExecuteInput = z.infer<typeof squadsExecuteSchema>;

export async function squadsExecute(
  client: PhalnxClient,
  config: McpConfig,
  input: SquadsExecuteInput,
): Promise<string> {
  try {
    const memberKeypair = loadOwnerKeypair(config);
    const multisigPda = toPublicKey(input.multisig);
    const transactionIndex = BigInt(input.transactionIndex);

    const sig = await client.squadsExecuteTransaction(memberKeypair, {
      multisigPda,
      transactionIndex,
    });

    return [
      "## Vault Transaction Executed",
      `- **Multisig:** ${input.multisig}`,
      `- **Transaction Index:** ${input.transactionIndex}`,
      `- **Executor:** ${memberKeypair.publicKey.toBase58()}`,
      `- **Transaction:** ${sig}`,
      "",
      "The Phalnx admin action has been executed through Squads governance.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const squadsExecuteTool = {
  name: "shield_squads_execute",
  description:
    "Execute an approved Squads vault transaction. " +
    "The connected wallet must be a member with Execute permission, " +
    "and the proposal must have reached threshold.",
  schema: squadsExecuteSchema,
  handler: squadsExecute,
};
