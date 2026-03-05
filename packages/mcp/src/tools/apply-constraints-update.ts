import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const applyConstraintsUpdateSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type ApplyConstraintsUpdateInput = z.infer<
  typeof applyConstraintsUpdateSchema
>;

export async function applyConstraintsUpdate(
  client: PhalnxClient,
  input: ApplyConstraintsUpdateInput,
): Promise<string> {
  try {
    const sig = await client.applyConstraintsUpdate(toPublicKey(input.vault));

    return [
      "## Constraints Update Applied",
      `- **Vault:** ${input.vault}`,
      `- **Transaction:** ${sig}`,
      "",
      "The pending constraints update has been applied. New constraints are now active.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const applyConstraintsUpdateTool = {
  name: "shield_apply_constraints_update",
  description:
    "Apply a pending timelocked constraints update after the timelock has expired. Owner-only.",
  schema: applyConstraintsUpdateSchema,
  handler: applyConstraintsUpdate,
};
