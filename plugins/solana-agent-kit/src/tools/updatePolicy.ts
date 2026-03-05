import { z } from "zod";
import type { ShieldPolicies } from "@phalnx/sdk";
import type { ResolvedConfig } from "../types";

export const updatePolicySchema = z.object({
  maxSpend: z
    .string()
    .optional()
    .describe(
      'Spending limit string, e.g. "500 USDC/day". Replaces current spend limits.',
    ),
  blockUnknownPrograms: z
    .boolean()
    .optional()
    .describe("Whether to block unknown (unregistered) program IDs."),
});

export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

export async function updatePolicy(
  _agent: any,
  config: ResolvedConfig,
  input: UpdatePolicyInput,
): Promise<string> {
  const newPolicies: ShieldPolicies = {};

  if (input.maxSpend !== undefined) {
    newPolicies.maxSpend = input.maxSpend;
  }
  if (input.blockUnknownPrograms !== undefined) {
    newPolicies.blockUnknownPrograms = input.blockUnknownPrograms;
  }

  config.wallet.updatePolicies(newPolicies);

  const parts = [];
  if (input.maxSpend !== undefined) {
    parts.push(`maxSpend: ${input.maxSpend}`);
  }
  if (input.blockUnknownPrograms !== undefined) {
    parts.push(`blockUnknownPrograms: ${input.blockUnknownPrograms}`);
  }

  return `Shield policies updated: ${parts.join(", ")}`;
}
