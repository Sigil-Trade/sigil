import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const cancelLimitOrderSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
  collateralMint: z.string().describe("Collateral token mint address (base58)"),
  reserveSymbol: z.string().describe("Reserve token symbol"),
  receiveSymbol: z.string().describe("Receive token symbol"),
  side: z.enum(["long", "short"]).describe("Position side"),
  orderId: z.string().describe("Limit order ID to cancel"),
});

export type CancelLimitOrderInput = z.infer<typeof cancelLimitOrderSchema>;

function parseSide(
  side: "long" | "short",
): { long: Record<string, never> } | { short: Record<string, never> } {
  return side === "long" ? { long: {} } : { short: {} };
}

export async function cancelLimitOrder(
  client: PhalnxClient,
  config: McpConfig,
  input: CancelLimitOrderInput,
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

    const orderId = parseInt(input.orderId, 10);
    if (isNaN(orderId)) {
      return "## Error\n\norderId must be a valid number";
    }

    const vaultAddress = toPublicKey(input.vault);
    const vault = await client.fetchVaultByAddress(vaultAddress);

    const result = await client.flashTradeCancelLimitOrder({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      targetSymbol: input.market,
      collateralSymbol: input.market,
      reserveSymbol: input.reserveSymbol,
      receiveSymbol: input.receiveSymbol,
      side: parseSide(input.side),
      orderId,
    });

    const sig = await client.executeFlashTrade(result, agentPubkey, signers);

    return [
      "## Limit Order Cancelled",
      `- **Vault:** ${input.vault}`,
      `- **Market:** ${input.market}`,
      `- **Order ID:** ${input.orderId}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const cancelLimitOrderTool = {
  name: "shield_cancel_limit_order",
  description:
    "Cancel a limit order on Flash Trade through an Phalnx vault. " +
    "Requires PHALNX_AGENT_KEYPAIR_PATH. " +
    "Non-spending: decrements position counter.",
  schema: cancelLimitOrderSchema,
  handler: cancelLimitOrder,
};
