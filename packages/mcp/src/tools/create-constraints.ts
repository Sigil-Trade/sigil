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

export const createConstraintsSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  entries: z
    .array(constraintEntrySchema)
    .min(1)
    .describe("Constraint entries (one per target program)"),
});

export type CreateConstraintsInput = z.infer<typeof createConstraintsSchema>;

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

export async function createConstraints(
  client: PhalnxClient,
  input: CreateConstraintsInput,
): Promise<string> {
  try {
    const entries = toConstraintEntries(input.entries);
    const sig = await client.createInstructionConstraints(
      toPublicKey(input.vault),
      entries,
    );

    return [
      "## Instruction Constraints Created",
      `- **Vault:** ${input.vault}`,
      `- **Entries:** ${input.entries.length} program(s)`,
      `- **Transaction:** ${sig}`,
      "",
      "Instruction constraints are now active. All DeFi instructions " +
        "must satisfy these constraints to be authorized.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const createConstraintsTool = {
  name: "shield_create_constraints",
  description:
    "Create instruction constraints for a vault. Constraints validate DeFi instruction " +
    "data bytes at specific offsets (e.g., enforce minimum amounts, specific discriminators). " +
    "Owner-only.",
  schema: createConstraintsSchema,
  handler: createConstraints,
};
