import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const removeCollateralSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
  collateralDeltaUsd: z
    .string()
    .describe("Collateral USD delta to remove (Flash Trade uses USD)"),
  side: z.enum(["long", "short"]).describe("Position side"),
  positionPubKey: z.string().describe("Position account address (base58)"),
});

export type RemoveCollateralInput = z.infer<typeof removeCollateralSchema>;

function parseSide(
  side: "long" | "short",
): { long: Record<string, never> } | { short: Record<string, never> } {
  return side === "long" ? { long: {} } : { short: {} };
}

export async function removeCollateral(
  client: PhalnxClient,
  config: McpConfig,
  input: RemoveCollateralInput,
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

    const result = await client.flashTradeRemoveCollateral({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      targetSymbol: input.market,
      collateralSymbol: input.market,
      side: parseSide(input.side),
      collateralDeltaUsd: toBN(input.collateralDeltaUsd),
      positionPubKey: toPublicKey(input.positionPubKey),
    });

    const sig = await client.executeFlashTrade(result, agentPubkey, signers);

    return [
      "## Collateral Removed",
      `- **Vault:** ${input.vault}`,
      `- **Market:** ${input.market}`,
      `- **Side:** ${input.side.toUpperCase()}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const removeCollateralTool = {
  name: "shield_remove_collateral",
  description:
    "Remove collateral from an existing Flash Trade position through an Phalnx vault. " +
    "Requires PHALNX_AGENT_KEYPAIR_PATH. " +
    "Non-spending: does not count toward daily cap.",
  schema: removeCollateralSchema,
  handler: removeCollateral,
};
