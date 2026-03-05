import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const closeConstraintsSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type CloseConstraintsInput = z.infer<typeof closeConstraintsSchema>;

export async function closeConstraints(
  client: PhalnxClient,
  input: CloseConstraintsInput,
): Promise<string> {
  try {
    const sig = await client.closeInstructionConstraints(
      toPublicKey(input.vault),
    );

    return [
      "## Instruction Constraints Removed",
      `- **Vault:** ${input.vault}`,
      `- **Transaction:** ${sig}`,
      "",
      "Instruction constraints have been removed. DeFi instructions " +
        "will no longer be validated against data constraints.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const closeConstraintsTool = {
  name: "shield_close_constraints",
  description:
    "Remove all instruction constraints from a vault and reclaim rent. Owner-only.",
  schema: closeConstraintsSchema,
  handler: closeConstraints,
};
