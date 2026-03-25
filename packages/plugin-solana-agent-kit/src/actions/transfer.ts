import { z } from "zod";
import type { PhalnxClient } from "@phalnx/kit";

const schema = z.object({
  destination: z
    .string()
    .describe("Destination wallet address for the transfer"),
  amount: z
    .number()
    .positive()
    .describe("Amount in human-readable units (e.g. 100 for $100 USDC)"),
  mint: z
    .string()
    .optional()
    .describe("Token mint address or symbol (defaults to USDC)"),
});

export function transferAction(_client: PhalnxClient) {
  return {
    description:
      "Execute a Phalnx-secured agent-to-agent stablecoin transfer. Enforces vault spending caps. " +
      "(Not yet implemented — requires PhalnxClient.transfer() method.)",
    schema,
    handler: async (_agent: unknown, _input: z.infer<typeof schema>) => {
      // agent_transfer is a standalone Phalnx instruction (not a DeFi CPI wrapped
      // with validate_and_authorize + finalize_session). It requires 11 accounts
      // with PDA derivation (policy, tracker, overlay, destination ATA, fee ATAs).
      // This must be exposed as PhalnxClient.transfer() — cannot be built inline
      // because wrap() rejects empty instructions ("No target protocol").
      return {
        success: false as const,
        error:
          "phalnx_transfer is not yet implemented. " +
          "On-chain agent_transfer uses a standalone instruction, not wrap(). " +
          "Use the vault dashboard or SDK directly to transfer.",
        recovery: [
          {
            action: "use_dashboard",
            description: "Use the Phalnx dashboard to execute transfers",
          },
        ],
      };
    },
  };
}
