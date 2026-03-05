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

export const updateConstraintsSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  entries: z
    .array(constraintEntrySchema)
    .min(1)
    .describe("New constraint entries (replaces existing)"),
});

export type UpdateConstraintsInput = z.infer<typeof updateConstraintsSchema>;

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

export async function updateConstraints(
  client: PhalnxClient,
  input: UpdateConstraintsInput,
): Promise<string> {
  try {
    const entries = toConstraintEntries(input.entries);
    const sig = await client.updateInstructionConstraints(
      toPublicKey(input.vault),
      entries,
    );

    return [
      "## Instruction Constraints Updated",
      `- **Vault:** ${input.vault}`,
      `- **Entries:** ${input.entries.length} program(s)`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const updateConstraintsTool = {
  name: "shield_update_constraints",
  description:
    "Update instruction constraints for a vault (replaces all existing entries). " +
    "Only works on vaults without a timelock. Owner-only.",
  schema: updateConstraintsSchema,
  handler: updateConstraints,
};
