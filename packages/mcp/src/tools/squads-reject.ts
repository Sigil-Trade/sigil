import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";
import type { McpConfig } from "../config";
import { loadOwnerKeypair } from "../config";

export const squadsRejectSchema = z.object({
  multisig: z.string().describe("Squads multisig address (base58)"),
  transactionIndex: z
    .string()
    .describe("Transaction index to reject (numeric string)"),
});

export type SquadsRejectInput = z.infer<typeof squadsRejectSchema>;

export async function squadsReject(
  client: PhalnxClient,
  config: McpConfig,
  input: SquadsRejectInput,
): Promise<string> {
  try {
    const memberKeypair = loadOwnerKeypair(config);
    const multisigPda = toPublicKey(input.multisig);
    const transactionIndex = BigInt(input.transactionIndex);

    const sig = await client.squadsRejectProposal(memberKeypair, {
      multisigPda,
      transactionIndex,
    });

    return [
      "## Proposal Rejected",
      `- **Multisig:** ${input.multisig}`,
      `- **Transaction Index:** ${input.transactionIndex}`,
      `- **Voter:** ${memberKeypair.publicKey.toBase58()}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const squadsRejectTool = {
  name: "shield_squads_reject",
  description:
    "Cast a rejection vote on a Squads proposal. " +
    "The connected wallet must be a member with Vote permission.",
  schema: squadsRejectSchema,
  handler: squadsReject,
};
