import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const placeLimitOrderSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
  collateralSymbol: z
    .string()
    .describe("Collateral token symbol (e.g. 'USDC')"),
  reserveSymbol: z.string().describe("Reserve token symbol"),
  receiveSymbol: z.string().describe("Receive token symbol"),
  side: z.enum(["long", "short"]).describe("Position side"),
  limitPrice: z.string().describe("Limit price in base units"),
  priceExponent: z
    .number()
    .optional()
    .default(-6)
    .describe("Price exponent for OraclePrice (default: -6 for USD)"),
  reserveAmount: z.string().describe("Reserve amount in token base units"),
  sizeAmount: z.string().describe("Position size in base units"),
  leverageBps: z
    .number()
    .describe("Leverage in basis points (e.g. 20000 = 2x)"),
  stopLossPrice: z
    .string()
    .optional()
    .describe("Optional stop-loss trigger price"),
  takeProfitPrice: z
    .string()
    .optional()
    .describe("Optional take-profit trigger price"),
});

export type PlaceLimitOrderInput = z.input<typeof placeLimitOrderSchema>;

function parseSide(
  side: "long" | "short",
): { long: Record<string, never> } | { short: Record<string, never> } {
  return side === "long" ? { long: {} } : { short: {} };
}

export async function placeLimitOrder(
  client: PhalnxClient,
  config: McpConfig,
  input: PlaceLimitOrderInput,
  custodyWallet?: CustodyWalletLike | null,
): Promise<string> {
  try {
    let agentPubkey: import("@solana/web3.js").PublicKey;
    let signers: import("@solana/web3.js").Keypair[];

    if (custodyWallet) {
      agentPubkey = custodyWallet.publicKey;
      signers = [];
    } else {
      const agentKeypair = loadAgentKeypair(config);
      agentPubkey = agentKeypair.publicKey;
      signers = [agentKeypair];
    }

    const vaultAddress = toPublicKey(input.vault);
    const vault = await client.fetchVaultByAddress(vaultAddress);

    const exp = input.priceExponent ?? -6;
    const result = await client.flashTradePlaceLimitOrder({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      targetSymbol: input.market,
      collateralSymbol: input.collateralSymbol,
      reserveSymbol: input.reserveSymbol,
      receiveSymbol: input.receiveSymbol,
      side: parseSide(input.side),
      limitPrice: { price: toBN(input.limitPrice), exponent: exp },
      reserveAmount: toBN(input.reserveAmount),
      sizeAmount: toBN(input.sizeAmount),
      leverageBps: input.leverageBps,
      stopLossPrice: input.stopLossPrice
        ? { price: toBN(input.stopLossPrice), exponent: exp }
        : { price: toBN("0"), exponent: 0 },
      takeProfitPrice: input.takeProfitPrice
        ? { price: toBN(input.takeProfitPrice), exponent: exp }
        : { price: toBN("0"), exponent: 0 },
    });

    const sig = await client.executeFlashTrade(result, agentPubkey, signers);

    return [
      "## Limit Order Placed",
      `- **Vault:** ${input.vault}`,
      `- **Market:** ${input.market}`,
      `- **Side:** ${input.side.toUpperCase()}`,
      `- **Limit Price:** ${input.limitPrice}`,
      `- **Reserve Amount:** ${input.reserveAmount}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const placeLimitOrderTool = {
  name: "shield_place_limit_order",
  description:
    "Place a limit order via Flash Trade through an Phalnx vault. " +
    "Requires PHALNX_AGENT_KEYPAIR_PATH. " +
    "Spending-checked: counts toward daily cap. Increments position counter.",
  schema: placeLimitOrderSchema,
  handler: placeLimitOrder,
};
