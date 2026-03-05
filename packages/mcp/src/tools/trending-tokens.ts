import { z } from "zod";
import { getTrendingTokens, isTokenSuspicious } from "@phalnx/sdk";
import { formatError } from "../errors";

export const trendingTokensSchema = z.object({
  interval: z
    .enum(["5m", "1h", "6h", "24h"])
    .optional()
    .default("24h")
    .describe("Trending interval (default: 24h)"),
});

export type TrendingTokensInput = z.input<typeof trendingTokensSchema>;

export async function trendingTokens(
  input: TrendingTokensInput,
): Promise<string> {
  try {
    const tokens = await getTrendingTokens(input.interval);

    if (tokens.length === 0) {
      return `No trending tokens found for interval "${input.interval}".`;
    }

    const lines = [`## Trending Tokens (${input.interval})`, ""];
    for (const token of tokens) {
      const suspicious = isTokenSuspicious(token);
      const warning = suspicious ? " **[SUSPICIOUS]**" : "";
      lines.push(`- **${token.symbol}** (${token.name})${warning}`);
      lines.push(`  - Address: ${token.address}`);
      if (token.dailyVolume !== undefined) {
        lines.push(`  - Daily Volume: $${token.dailyVolume.toLocaleString()}`);
      }
      if (token.organicScore !== undefined) {
        lines.push(`  - Organic Score: ${token.organicScore}`);
      }
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const trendingTokensTool = {
  name: "shield_trending_tokens",
  description:
    "Get trending Solana tokens from Jupiter with safety indicators. " +
    "Read-only — no vault required.",
  schema: trendingTokensSchema,
  handler: trendingTokens,
};
