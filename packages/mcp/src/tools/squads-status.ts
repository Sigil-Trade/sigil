import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const squadsStatusSchema = z.object({
  multisig: z.string().describe("Squads multisig address (base58)"),
  transactionIndex: z
    .string()
    .optional()
    .describe(
      "Optional transaction index to check proposal status (numeric string)",
    ),
});

export type SquadsStatusInput = z.infer<typeof squadsStatusSchema>;

export async function squadsStatus(
  client: PhalnxClient,
  input: SquadsStatusInput,
): Promise<string> {
  try {
    const multisigPda = toPublicKey(input.multisig);
    const info = await client.squadsFetchMultisigInfo(multisigPda);

    const lines = [
      "## Squads Multisig Status",
      `- **Address:** ${info.address.toBase58()}`,
      `- **Threshold:** ${info.threshold}-of-${info.memberCount}`,
      `- **Time Lock:** ${info.timeLock}s`,
      `- **Transaction Count:** ${info.transactionIndex}`,
      `- **Vault PDA (index 0):** ${info.vaultPda.toBase58()}`,
      "",
      "### Members",
      ...info.members.map((m, i) => {
        const perms = [];
        if (m.permissions.initiate) perms.push("Initiate");
        if (m.permissions.vote) perms.push("Vote");
        if (m.permissions.execute) perms.push("Execute");
        return `${i + 1}. \`${m.key.toBase58()}\` — ${perms.join(", ")}`;
      }),
    ];

    if (input.transactionIndex) {
      const txIndex = BigInt(input.transactionIndex);
      try {
        const proposal = await client.squadsFetchProposalInfo(
          multisigPda,
          txIndex,
        );
        lines.push(
          "",
          `### Proposal #${input.transactionIndex}`,
          `- **Status:** ${proposal.status}`,
          `- **Approvals:** ${proposal.approvals.length} — ${proposal.approvals.map((k) => k.toBase58().slice(0, 8) + "…").join(", ") || "none"}`,
          `- **Rejections:** ${proposal.rejections.length} — ${proposal.rejections.map((k) => k.toBase58().slice(0, 8) + "…").join(", ") || "none"}`,
        );
      } catch {
        lines.push(
          "",
          `### Proposal #${input.transactionIndex}`,
          "- Could not fetch proposal (may not exist yet).",
        );
      }
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const squadsStatusTool = {
  name: "shield_squads_status",
  description:
    "Check Squads multisig status: members, threshold, transaction count. " +
    "Optionally check a specific proposal's voting status.",
  schema: squadsStatusSchema,
  handler: squadsStatus,
};
