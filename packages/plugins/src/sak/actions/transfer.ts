import { z } from "zod";
import type { SigilClientApi } from "@usesigil/kit";
import { resolveToken, toAgentError, toBaseUnits } from "@usesigil/kit";
import type { Address } from "@solana/kit";
import { toResolvedNetwork } from "../types.js";

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

export function transferAction(client: SigilClientApi) {
  return {
    description:
      "Execute a Sigil-secured agent-to-agent stablecoin transfer. Enforces vault " +
      "spending caps, per-recipient caps, and the destination allowlist.",
    schema,
    handler: async (_agent: unknown, input: z.infer<typeof schema>) => {
      try {
        const net = toResolvedNetwork(client.network);
        // Resolve the mint (symbol or address). Defaults to USDC. agent_transfer
        // is stablecoin-only on-chain, so non-stablecoin mints reject in the SDK.
        const token = resolveToken(input.mint ?? "USDC", net);
        const tokenMint = (token?.mint ?? input.mint) as Address;
        const decimals = token?.decimals ?? 6;
        const baseAmount = toBaseUnits(input.amount, decimals);

        const result = await client.transfer({
          destination: input.destination as Address,
          amount: baseAmount,
          tokenMint,
        });

        return {
          success: true as const,
          signature: result.signature,
          destination: input.destination,
          amount: input.amount,
          mint: tokenMint,
        };
      } catch (err) {
        const agentErr = toAgentError(err);
        return {
          success: false as const,
          error: agentErr.message,
          recovery: agentErr.recovery_actions,
        };
      }
    },
  };
}
