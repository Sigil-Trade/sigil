import { z } from "zod";
import { getJupiterPrices } from "@phalnx/sdk";
import { formatError } from "../errors";

export const getPricesSchema = z.object({
  mints: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe("Token mint addresses (base58). Max 50."),
  showExtraInfo: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include confidence level, depth, and quoted prices"),
});

export type GetPricesInput = z.input<typeof getPricesSchema>;

export async function getPrices(input: GetPricesInput): Promise<string> {
  try {
    const response = await getJupiterPrices({
      ids: input.mints,
      showExtraInfo: input.showExtraInfo,
    });

    const entries = Object.entries(response.data);
    if (entries.length === 0) {
      return "No price data found for the provided mints.";
    }

    const lines = ["## Token Prices", ""];
    for (const [mint, data] of entries) {
      lines.push(`- **${mint}**: $${data.price}`);
      if (data.extraInfo?.confidenceLevel) {
        lines.push(`  - Confidence: ${data.extraInfo.confidenceLevel}`);
      }
    }

    lines.push("", `_Fetched in ${response.timeTaken}ms_`);
    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const getPricesTool = {
  name: "shield_get_prices",
  description:
    "Get real-time USD prices for Solana tokens via Jupiter Price API. " +
    "Read-only — no vault required. Supports up to 50 mints per request.",
  schema: getPricesSchema,
  handler: getPrices,
};
