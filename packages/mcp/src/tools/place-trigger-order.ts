import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const placeTriggerOrderSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
  collateralMint: z.string().describe("Collateral token mint address (base58)"),
  receiveSymbol: z.string().describe("Token symbol to receive on trigger"),
  side: z.enum(["long", "short"]).describe("Position side"),
  triggerPrice: z.string().describe("Trigger price in base units"),
  deltaSizeAmount: z.string().describe("Size delta in base units"),
  isStopLoss: z.boolean().describe("True for stop-loss, false for take-profit"),
});

export type PlaceTriggerOrderInput = z.infer<typeof placeTriggerOrderSchema>;

function parseSide(
  side: "long" | "short",
): { long: Record<string, never> } | { short: Record<string, never> } {
  return side === "long" ? { long: {} } : { short: {} };
}

export async function placeTriggerOrder(
  client: PhalnxClient,
  config: McpConfig,
  input: PlaceTriggerOrderInput,
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

    const result = await client.flashTradePlaceTriggerOrder({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      targetSymbol: input.market,
      collateralSymbol: input.market,
      receiveSymbol: input.receiveSymbol,
      side: parseSide(input.side),
      triggerPrice: { price: toBN(input.triggerPrice), exponent: 0 },
      deltaSizeAmount: toBN(input.deltaSizeAmount),
      isStopLoss: input.isStopLoss,
    });

    const sig = await client.executeFlashTrade(result, agentPubkey, signers);

    const orderType = input.isStopLoss ? "Stop-Loss" : "Take-Profit";
    return [
      `## ${orderType} Order Placed`,
      `- **Vault:** ${input.vault}`,
      `- **Market:** ${input.market}`,
      `- **Side:** ${input.side.toUpperCase()}`,
      `- **Trigger Price:** ${input.triggerPrice}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const placeTriggerOrderTool = {
  name: "shield_place_trigger_order",
  description:
    "Place a take-profit or stop-loss trigger order on a Flash Trade position. " +
    "Requires PHALNX_AGENT_KEYPAIR_PATH. " +
    "Non-spending: does not count toward daily cap.",
  schema: placeTriggerOrderSchema,
  handler: placeTriggerOrder,
};
