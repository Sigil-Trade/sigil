import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const closePositionSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
  side: z.enum(["long", "short"]).describe("Position side: 'long' or 'short'"),
  priceWithSlippage: z
    .string()
    .describe("Exit price in base units (for slippage protection)"),
  priceExponent: z
    .number()
    .optional()
    .default(0)
    .describe("Price exponent (default: 0)"),
});

export type ClosePositionInput = z.infer<typeof closePositionSchema>;

function parseSide(
  side: "long" | "short",
): { long: Record<string, never> } | { short: Record<string, never> } {
  return side === "long" ? { long: {} } : { short: {} };
}

export async function closePosition(
  client: AgentShieldClient,
  config: McpConfig,
  input: ClosePositionInput,
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

    const result = await client.flashTradeClose({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      targetSymbol: input.market,
      collateralSymbol: input.market,
      collateralAmount: toBN("0"),
      side: parseSide(input.side),
      priceWithSlippage: {
        price: toBN(input.priceWithSlippage),
        exponent: input.priceExponent ?? 0,
      },
    });

    const sig = await client.executeFlashTrade(result, agentPubkey, signers);

    return [
      "## Position Closed",
      `- **Vault:** ${input.vault}`,
      `- **Market:** ${input.market}`,
      `- **Side:** ${input.side.toUpperCase()}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const closePositionTool = {
  name: "shield_close_position",
  description:
    "Close a leveraged perpetual position via Flash Trade through an AgentShield vault. " +
    "Requires AGENTSHIELD_AGENT_KEYPAIR_PATH.",
  schema: closePositionSchema,
  handler: closePosition,
};
