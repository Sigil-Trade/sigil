import { z } from "zod";
import { searchJupiterTokens, isTokenSuspicious } from "@phalnx/sdk";
import { formatError } from "../errors";

export const searchTokensSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Search query (name, symbol, or mint address)"),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("Max results (default 10, max 50)"),
});

export type SearchTokensInput = z.input<typeof searchTokensSchema>;

export async function searchTokens(input: SearchTokensInput): Promise<string> {
  try {
    const tokens = await searchJupiterTokens({
      query: input.query,
      limit: input.limit,
    });

    if (tokens.length === 0) {
      return `No tokens found for "${input.query}".`;
    }

    const lines = [`## Token Search: "${input.query}"`, ""];
    for (const token of tokens) {
      const suspicious = isTokenSuspicious(token);
      const warning = suspicious ? " **[SUSPICIOUS]**" : "";
      lines.push(`### ${token.symbol} — ${token.name}${warning}`);
      lines.push(`- **Address:** ${token.address}`);
      lines.push(`- **Decimals:** ${token.decimals}`);
      if (token.dailyVolume !== undefined) {
        lines.push(
          `- **Daily Volume:** $${token.dailyVolume.toLocaleString()}`,
        );
      }
      if (token.organicScore !== undefined) {
        lines.push(`- **Organic Score:** ${token.organicScore}`);
      }
      if (token.freezeAuthority) {
        lines.push(`- **Freeze Authority:** ${token.freezeAuthority}`);
      }
      if (token.mintAuthority) {
        lines.push(`- **Mint Authority:** ${token.mintAuthority}`);
      }
      if (token.tags && token.tags.length > 0) {
        lines.push(`- **Tags:** ${token.tags.join(", ")}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const searchTokensTool = {
  name: "shield_search_tokens",
  description:
    "Search for Solana tokens by name, symbol, or address. " +
    "Returns verification status and safety indicators (isSus, freeze/mint authority). " +
    "Read-only — no vault required.",
  schema: searchTokensSchema,
  handler: searchTokens,
};
