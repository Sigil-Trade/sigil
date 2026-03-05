import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const cancelConstraintsUpdateSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type CancelConstraintsUpdateInput = z.infer<
  typeof cancelConstraintsUpdateSchema
>;

export async function cancelConstraintsUpdate(
  client: PhalnxClient,
  input: CancelConstraintsUpdateInput,
): Promise<string> {
  try {
    const sig = await client.cancelConstraintsUpdate(toPublicKey(input.vault));

    return [
      "## Constraints Update Cancelled",
      `- **Vault:** ${input.vault}`,
      `- **Transaction:** ${sig}`,
      "",
      "The pending constraints update has been cancelled. Existing constraints remain unchanged.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const cancelConstraintsUpdateTool = {
  name: "shield_cancel_constraints_update",
  description:
    "Cancel a pending timelocked constraints update before it takes effect. Owner-only.",
  schema: cancelConstraintsUpdateSchema,
  handler: cancelConstraintsUpdate,
};
