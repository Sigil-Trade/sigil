import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const cancelTriggerOrderSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
  collateralMint: z.string().describe("Collateral token mint address (base58)"),
  side: z.enum(["long", "short"]).describe("Position side"),
  orderId: z.string().describe("Trigger order ID to cancel"),
  isStopLoss: z.boolean().describe("True for stop-loss, false for take-profit"),
});

export type CancelTriggerOrderInput = z.infer<typeof cancelTriggerOrderSchema>;

function parseSide(
  side: "long" | "short",
): { long: Record<string, never> } | { short: Record<string, never> } {
  return side === "long" ? { long: {} } : { short: {} };
}

export async function cancelTriggerOrder(
  client: PhalnxClient,
  config: McpConfig,
  input: CancelTriggerOrderInput,
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

    const result = await client.flashTradeCancelTriggerOrder({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      targetSymbol: input.market,
      collateralSymbol: input.market,
      side: parseSide(input.side),
      orderId,
      isStopLoss: input.isStopLoss,
    });

    const sig = await client.executeFlashTrade(result, agentPubkey, signers);

    return [
      "## Trigger Order Cancelled",
      `- **Vault:** ${input.vault}`,
      `- **Market:** ${input.market}`,
      `- **Order ID:** ${input.orderId}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const cancelTriggerOrderTool = {
  name: "shield_cancel_trigger_order",
  description:
    "Cancel a take-profit or stop-loss trigger order on a Flash Trade position. " +
    "Requires PHALNX_AGENT_KEYPAIR_PATH. " +
    "Non-spending: does not count toward daily cap.",
  schema: cancelTriggerOrderSchema,
  handler: cancelTriggerOrder,
};
