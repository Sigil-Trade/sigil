import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";

export const checkConstraintsSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
});

export type CheckConstraintsInput = z.infer<typeof checkConstraintsSchema>;

function formatOperator(op: any): string {
  if ("eq" in op) return "==";
  if ("ne" in op) return "!=";
  if ("gte" in op) return ">=";
  if ("lte" in op) return "<=";
  return "?";
}

export async function checkConstraints(
  client: PhalnxClient,
  input: CheckConstraintsInput,
): Promise<string> {
  try {
    const constraints = await client.fetchConstraints(toPublicKey(input.vault));

    if (!constraints) {
      return [
        "## Instruction Constraints",
        `- **Vault:** ${input.vault}`,
        "- **Status:** No constraints configured",
      ].join("\n");
    }

    const lines: string[] = [
      "## Instruction Constraints",
      `- **Vault:** ${constraints.vault.toBase58()}`,
      `- **Entries:** ${constraints.entries.length} program(s)`,
      "",
    ];

    for (const entry of constraints.entries) {
      lines.push(`### Program: ${entry.programId.toBase58()}`);
      for (const dc of entry.dataConstraints) {
        const valHex = dc.value
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join("");
        lines.push(
          `- Offset ${dc.offset}: data ${formatOperator(dc.operator)} 0x${valHex}`,
        );
      }
      lines.push("");
    }

    // Check for pending update
    const pending = await client.fetchPendingConstraints(
      toPublicKey(input.vault),
    );
    if (pending) {
      const executesAt = pending.executesAt.toNumber();
      const now = Math.floor(Date.now() / 1000);
      const remaining = executesAt - now;
      const timeStatus =
        remaining > 0
          ? `executes in ${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`
          : "ready to apply";
      lines.push(
        `### Pending Update`,
        `- **Entries:** ${pending.entries.length} program(s)`,
        `- **Status:** ${timeStatus}`,
      );
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const checkConstraintsTool = {
  name: "shield_check_constraints",
  description:
    "Check the instruction constraints and any pending constraint updates for a vault.",
  schema: checkConstraintsSchema,
  handler: checkConstraints,
};
