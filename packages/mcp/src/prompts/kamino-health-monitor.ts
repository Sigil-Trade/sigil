/**
 * kamino-health-monitor prompt — Position health assessment and repay planning.
 *
 * Checks obligation health factors, flags at-risk positions,
 * and calculates required repay amounts to restore safety.
 */

import { z } from "zod";

export const kaminoHealthMonitorArgsSchema = {
  wallet: z.string().optional().describe("Wallet address to monitor (uses default if omitted)"),
  healthThreshold: z
    .number()
    .optional()
    .describe("Health factor threshold for warnings (default: 1.2)"),
};

export interface KaminoHealthMonitorArgs {
  wallet?: string;
  healthThreshold?: number;
}

export function kaminoHealthMonitorPrompt(args: KaminoHealthMonitorArgs) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: JSON.stringify(
            {
              workflow: "kamino-health-monitor",
              params: {
                wallet: args.wallet ?? null,
                healthThreshold: args.healthThreshold ?? 1.2,
              },
              steps: [
                {
                  step: 1,
                  tool: "phalnx_query",
                  input: {
                    query: "kaminoPositionHealth",
                    params: { wallet: args.wallet ?? undefined },
                  },
                  purpose: "Fetch all obligations with health factors",
                },
                {
                  step: 2,
                  action: "assess",
                  purpose: "Identify obligations below health threshold",
                  check: `healthFactor < ${args.healthThreshold ?? 1.2}`,
                  onRisk: "Calculate repay amount needed to restore to safe level",
                },
                {
                  step: 3,
                  action: "plan",
                  purpose: "Present repay plan with exact amounts if at-risk",
                  ifSafe: "Report all positions healthy — no action needed",
                  ifAtRisk: "Show: which token to repay, how much, estimated new health factor",
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
