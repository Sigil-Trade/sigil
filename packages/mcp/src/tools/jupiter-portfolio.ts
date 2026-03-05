import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { formatError } from "../errors";

export const jupiterPortfolioSchema = z.object({
  wallet: z.string().describe("Wallet address to check portfolio (base58)"),
});

export type JupiterPortfolioInput = z.infer<typeof jupiterPortfolioSchema>;

export async function jupiterPortfolio(
  client: PhalnxClient,
  input: JupiterPortfolioInput,
): Promise<string> {
  try {
    const portfolio = await client.getJupiterPortfolio(input.wallet);

    const lines = [
      `## Jupiter Portfolio: ${input.wallet}`,
      `- **Total Value:** $${portfolio.totalValue.toLocaleString()}`,
      "",
    ];

    if (portfolio.positions.length === 0) {
      lines.push("No positions found.");
    } else {
      for (const pos of portfolio.positions) {
        lines.push(
          `### ${pos.platformName} (${pos.elementType}) — $${pos.value.toLocaleString()}`,
        );
        for (const token of pos.tokens) {
          lines.push(
            `- ${token.symbol}: ${token.amount} ($${token.value.toLocaleString()})`,
          );
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const jupiterPortfolioTool = {
  name: "shield_jupiter_portfolio",
  description:
    "Get portfolio positions across Jupiter-supported platforms. " +
    "Beta API. Read-only — no vault required.",
  schema: jupiterPortfolioSchema,
  handler: jupiterPortfolio,
};
