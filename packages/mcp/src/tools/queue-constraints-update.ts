import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

const dataConstraintSchema = z.object({
  offset: z.number().int().min(0).describe("Byte offset in instruction data"),
  operator: z.enum(["eq", "ne", "gte", "lte"]).describe("Comparison operator"),
  value: z
    .array(z.number().int().min(0).max(255))
    .min(1)
    .max(32)
    .describe("Expected value bytes (1-32 bytes)"),
});

const constraintEntrySchema = z.object({
  programId: z.string().describe("Target program ID (base58)"),
  dataConstraints: z
    .array(dataConstraintSchema)
    .describe("Data constraints for instructions to this program"),
});

export const queueConstraintsUpdateSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  entries: z
    .array(constraintEntrySchema)
    .min(1)
    .describe("New constraint entries to apply after timelock"),
});

export type QueueConstraintsUpdateInput = z.infer<
  typeof queueConstraintsUpdateSchema
>;

function operatorToAnchor(op: string): any {
  switch (op) {
    case "eq":
      return { eq: {} };
    case "ne":
      return { ne: {} };
    case "gte":
      return { gte: {} };
    case "lte":
      return { lte: {} };
    default:
      throw new Error(`Unknown operator: ${op}`);
  }
}

function toConstraintEntries(entries: any[]): any[] {
  return entries.map((e) => ({
    programId: toPublicKey(e.programId),
    dataConstraints: e.dataConstraints.map((dc: any) => ({
      offset: dc.offset,
      operator: operatorToAnchor(dc.operator),
      value: dc.value,
    })),
  }));
}

export async function queueConstraintsUpdate(
  client: PhalnxClient,
  input: QueueConstraintsUpdateInput,
): Promise<string> {
  try {
    const entries = toConstraintEntries(input.entries);
    const sig = await client.queueConstraintsUpdate(
      toPublicKey(input.vault),
      entries,
    );

    return [
      "## Constraints Update Queued",
      `- **Vault:** ${input.vault}`,
      `- **Entries:** ${input.entries.length} program(s)`,
      `- **Transaction:** ${sig}`,
      "",
      "The constraints update is now pending. It can be applied after the " +
        "vault's timelock duration expires. Use shield_apply_constraints_update " +
        "to apply it, or shield_cancel_constraints_update to cancel.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const queueConstraintsUpdateTool = {
  name: "shield_queue_constraints_update",
  description:
    "Queue a timelocked constraints update. Required when the vault has a timelock. " +
    "Apply after timelock expires with shield_apply_constraints_update. Owner-only.",
  schema: queueConstraintsUpdateSchema,
  handler: queueConstraintsUpdate,
};
