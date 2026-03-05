import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";
import type { McpConfig } from "../config";
import { loadOwnerKeypair } from "../config";

export const squadsApproveSchema = z.object({
  multisig: z.string().describe("Squads multisig address (base58)"),
  transactionIndex: z
    .string()
    .describe("Transaction index to approve (numeric string)"),
  memo: z.string().optional().describe("Optional approval memo"),
});

export type SquadsApproveInput = z.infer<typeof squadsApproveSchema>;

export async function squadsApprove(
  client: PhalnxClient,
  config: McpConfig,
  input: SquadsApproveInput,
): Promise<string> {
  try {
    const memberKeypair = loadOwnerKeypair(config);
    const multisigPda = toPublicKey(input.multisig);
    const transactionIndex = BigInt(input.transactionIndex);

    const sig = await client.squadsApproveProposal(memberKeypair, {
      multisigPda,
      transactionIndex,
      memo: input.memo,
    });

    // Fetch updated proposal status
    let statusLine = "";
    try {
      const info = await client.squadsFetchProposalInfo(
        multisigPda,
        transactionIndex,
      );
      statusLine = `- **Status:** ${info.status} (${info.approvals.length} approvals, ${info.rejections.length} rejections)`;
    } catch {
      statusLine = "- **Status:** Vote cast (could not fetch updated status)";
    }

    return [
      "## Proposal Approved",
      `- **Multisig:** ${input.multisig}`,
      `- **Transaction Index:** ${input.transactionIndex}`,
      `- **Voter:** ${memberKeypair.publicKey.toBase58()}`,
      statusLine,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const squadsApproveTool = {
  name: "shield_squads_approve",
  description:
    "Cast an approval vote on a Squads proposal. " +
    "The connected wallet must be a member with Vote permission.",
  schema: squadsApproveSchema,
  handler: squadsApprove,
};
