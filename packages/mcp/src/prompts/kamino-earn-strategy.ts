/**
 * kamino-earn-strategy prompt — Guided yield discovery and optimization.
 *
 * Walks the agent through loading all markets, comparing rates,
 * and recommending the best earning opportunity for the user.
 */

import { z } from "zod";

export const kaminoEarnStrategyArgsSchema = {
  token: z.string().optional().describe("Token to earn with (e.g. 'USDC'). If omitted, shows all."),
  riskTolerance: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe("Risk tolerance (default: low)"),
};

export interface KaminoEarnStrategyArgs {
  token?: string;
  riskTolerance?: "low" | "medium" | "high";
}

export function kaminoEarnStrategyPrompt(args: KaminoEarnStrategyArgs) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: JSON.stringify(
            {
              workflow: "kamino-earn-strategy",
              params: {
                token: args.token ?? null,
                riskTolerance: args.riskTolerance ?? "low",
              },
              steps: [
                {
                  step: 1,
                  tool: "phalnx_query",
                  input: { query: "kaminoMarkets" },
                  purpose: "Load all available markets and reserves with APYs",
                },
                {
                  step: 2,
                  tool: "phalnx_query",
                  input: { query: "kaminoYields" },
                  purpose: "Compare lending, staking, and leverage yields",
                },
                {
                  step: 3,
                  tool: "phalnx_query",
                  input: { query: "spending" },
                  purpose: "Check remaining spending capacity",
                },
                {
                  step: 4,
                  action: "recommend",
                  purpose: "Compare yields, factor in risk tolerance, recommend best option",
                  criteria: {
                    low: "Supply-only lending, high TVL reserves, stablecoin pairs",
                    medium: "Lending + moderate leverage (2-3x), LST staking",
                    high: "High leverage (3-5x), volatile pairs, higher APY",
                  },
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
