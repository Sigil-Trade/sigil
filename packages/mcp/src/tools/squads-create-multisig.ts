import { z } from "zod";
import { Keypair } from "@solana/web3.js";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";
import type { McpConfig } from "../config";
import { loadOwnerKeypair } from "../config";

export const squadsCreateMultisigSchema = z.object({
  members: z
    .array(
      z.object({
        key: z.string().describe("Member wallet address (base58)"),
        permissions: z
          .object({
            initiate: z.boolean().optional().default(true),
            vote: z.boolean().optional().default(true),
            execute: z.boolean().optional().default(true),
          })
          .describe("Member permissions"),
      }),
    )
    .min(1)
    .describe("Multisig members with permissions"),
  threshold: z
    .number()
    .int()
    .min(1)
    .describe("Number of approvals required (N-of-M)"),
  timeLock: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Delay in seconds between approval and execution (default 0)"),
  memo: z.string().optional().describe("Optional memo"),
});

export type SquadsCreateMultisigInput = z.infer<
  typeof squadsCreateMultisigSchema
>;

export async function squadsCreateMultisig(
  client: PhalnxClient,
  config: McpConfig,
  input: SquadsCreateMultisigInput,
): Promise<string> {
  try {
    const ownerKeypair = loadOwnerKeypair(config);
    const createKey = Keypair.generate();

    const members = input.members.map((m) => ({
      key: toPublicKey(m.key),
      permissions: {
        initiate: m.permissions.initiate ?? true,
        vote: m.permissions.vote ?? true,
        execute: m.permissions.execute ?? true,
      },
    }));

    if (input.threshold > members.length) {
      return `Error: Threshold (${input.threshold}) cannot exceed member count (${members.length}).`;
    }

    const result = await client.squadsCreateMultisig(ownerKeypair, {
      createKey,
      members,
      threshold: input.threshold,
      timeLock: input.timeLock,
    });

    return [
      "## Squads Multisig Created",
      `- **Multisig Address:** ${result.multisigPda.toBase58()}`,
      `- **Vault PDA (index 0):** ${result.vaultPda.toBase58()}`,
      `- **Threshold:** ${input.threshold}-of-${members.length}`,
      `- **Time Lock:** ${input.timeLock ?? 0}s`,
      `- **Transaction:** ${result.signature}`,
      "",
      "Use the **Vault PDA** as the `owner` when creating an Phalnx vault " +
        "to enable multisig governance.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const squadsCreateMultisigTool = {
  name: "shield_squads_create_multisig",
  description:
    "Create a new Squads V4 multisig for N-of-M governance over Phalnx vaults. " +
    "The vault PDA becomes the Phalnx vault owner.",
  schema: squadsCreateMultisigSchema,
  handler: squadsCreateMultisig,
};
