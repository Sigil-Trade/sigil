/**
 * kamino-rebalance prompt — Position rebalancing workflow.
 *
 * Compares current positions against available rates,
 * factors in gas costs, and recommends rebalancing actions.
 */

import { z } from "zod";

export const kaminoRebalanceArgsSchema = {
  wallet: z.string().optional().describe("Wallet address (uses default if omitted)"),
  minApyDelta: z
    .number()
    .optional()
    .describe("Minimum APY improvement to justify rebalance (default: 0.5%)"),
};

export interface KaminoRebalanceArgs {
  wallet?: string;
  minApyDelta?: number;
}

export function kaminoRebalancePrompt(args: KaminoRebalanceArgs) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: JSON.stringify(
            {
              workflow: "kamino-rebalance",
              params: {
                wallet: args.wallet ?? null,
                minApyDelta: args.minApyDelta ?? 0.5,
              },
              steps: [
                {
                  step: 1,
                  tool: "phalnx_query",
                  input: {
                    query: "kaminoPositionHealth",
                    params: { wallet: args.wallet ?? undefined },
                  },
                  purpose: "Load current positions with APYs",
                },
                {
                  step: 2,
                  tool: "phalnx_query",
                  input: { query: "kaminoMarkets" },
                  purpose: "Load all available markets with current rates",
                },
                {
                  step: 3,
                  action: "compare",
                  purpose: "Compare current deposit/borrow rates vs available alternatives",
                  criteria: `APY delta must exceed ${args.minApyDelta ?? 0.5}% to justify gas costs`,
                },
                {
                  step: 4,
                  action: "recommend",
                  purpose: "Present rebalance plan or confirm no action needed",
                  ifBetter: "Show: withdraw from X, deposit to Y, expected APY improvement, estimated gas",
                  ifOptimal: "Report: current allocation is optimal within threshold",
                },
              ],
            },
            null,
            2,
          ),
        },
      },
    ],
  };
}
