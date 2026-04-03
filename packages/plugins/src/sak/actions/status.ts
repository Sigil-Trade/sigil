import { z } from "zod";
import type { SigilClient } from "@usesigil/kit";
import { formatUsd, toAgentError } from "@usesigil/kit";

const schema = z
  .object({})
  .describe("No input required — queries the configured vault.");

export function statusAction(client: SigilClient) {
  return {
    description:
      "Query Sigil vault budget and status. Returns global and agent spending limits, remaining budget, and vault health.",
    schema,
    handler: async () => {
      try {
        const budget = await client.getAgentBudget();

        const globalRemaining = formatUsd(budget.globalBudget.remaining);
        const globalLimit = formatUsd(budget.globalBudget.cap);
        const globalSpent = formatUsd(budget.globalBudget.spent24h);

        const agentRemaining = budget.agentBudget
          ? formatUsd(budget.agentBudget.remaining)
          : "unlimited";
        const agentLimit = budget.agentBudget
          ? formatUsd(budget.agentBudget.cap)
          : "unlimited";
        const agentSpent = budget.agentBudget
          ? formatUsd(budget.agentBudget.spent24h)
          : "$0.00";

        return {
          success: true,
          vault: client.vault,
          global: {
            remaining: globalRemaining,
            limit: globalLimit,
            spent: globalSpent,
          },
          agent: {
            remaining: agentRemaining,
            limit: agentLimit,
            spent: agentSpent,
          },
        };
      } catch (err) {
        const agentErr = toAgentError(err);
        return {
          success: false,
          error: agentErr.message,
          recovery: agentErr.recovery_actions,
        };
      }
    },
  };
}
