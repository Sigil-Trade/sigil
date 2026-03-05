import { z } from "zod";
import { getJupiterLendTokens } from "@phalnx/sdk";
import { formatError } from "../errors";

export const lendTokensSchema = z.object({});

export type LendTokensInput = z.infer<typeof lendTokensSchema>;

export async function lendTokens(_input: LendTokensInput): Promise<string> {
  try {
    const tokens = await getJupiterLendTokens();

    if (tokens.length === 0) {
      return "No tokens available for Jupiter Lend/Earn.";
    }

    const lines = ["## Jupiter Lend/Earn — Available Tokens", ""];
    for (const token of tokens) {
      const apyPct = (token.apy * 100).toFixed(2);
      const utilPct = (token.utilizationRate * 100).toFixed(1);
      lines.push(`### ${token.symbol} (${token.name})`);
      lines.push(`- **Mint:** ${token.mint}`);
      lines.push(`- **APY:** ${apyPct}%`);
      lines.push(`- **Total Deposited:** ${token.totalDeposited}`);
      lines.push(`- **Utilization:** ${utilPct}%`);
      lines.push("");
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const lendTokensTool = {
  name: "shield_lend_tokens",
  description:
    "List available tokens for Jupiter Lend/Earn with APY rates. " +
    "Read-only — no vault required.",
  schema: lendTokensSchema,
  handler: lendTokens,
};
