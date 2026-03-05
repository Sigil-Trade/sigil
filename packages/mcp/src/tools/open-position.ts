import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const openPositionSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
  collateralMint: z.string().describe("Collateral token mint address (base58)"),
  collateralAmount: z
    .string()
    .describe("Collateral amount in token base units"),
  sizeUsd: z.string().describe("Position size in USD base units"),
  side: z.enum(["long", "short"]).describe("Position side: 'long' or 'short'"),
  leverageBps: z
    .number()
    .describe("Leverage in basis points (e.g. 20000 = 2x)"),
});

export type OpenPositionInput = z.infer<typeof openPositionSchema>;

function parseSide(
  side: "long" | "short",
): { long: Record<string, never> } | { short: Record<string, never> } {
  return side === "long" ? { long: {} } : { short: {} };
}

export async function openPosition(
  client: PhalnxClient,
  config: McpConfig,
  input: OpenPositionInput,
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

    const result = await client.flashTradeOpen({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      targetSymbol: input.market,
      collateralSymbol: input.market,
      collateralAmount: toBN(input.collateralAmount),
      sizeAmount: toBN(input.sizeUsd),
      side: parseSide(input.side),
      priceWithSlippage: { price: toBN("0"), exponent: 0 },
      leverageBps: input.leverageBps,
    });

    const sig = await client.executeFlashTrade(result, agentPubkey, signers);

    return [
      "## Position Opened",
      `- **Vault:** ${input.vault}`,
      `- **Market:** ${input.market}`,
      `- **Side:** ${input.side.toUpperCase()}`,
      `- **Collateral:** ${input.collateralAmount} of ${input.collateralMint}`,
      `- **Size (USD):** ${input.sizeUsd}`,
      `- **Leverage:** ${input.leverageBps} BPS`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const openPositionTool = {
  name: "shield_open_position",
  description:
    "Open a leveraged perpetual position via Flash Trade through an Phalnx vault. " +
    "Requires PHALNX_AGENT_KEYPAIR_PATH. " +
    "Policy-checked: leverage limits, position count, spending caps apply.",
  schema: openPositionSchema,
  handler: openPosition,
};
