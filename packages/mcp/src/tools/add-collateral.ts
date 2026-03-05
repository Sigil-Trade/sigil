import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";

export const addCollateralSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
  collateralMint: z.string().describe("Collateral token mint address (base58)"),
  collateralAmount: z
    .string()
    .describe("Collateral amount to add in token base units"),
  side: z.enum(["long", "short"]).describe("Position side"),
  positionPubKey: z.string().describe("Position account address (base58)"),
});

export type AddCollateralInput = z.infer<typeof addCollateralSchema>;

function parseSide(
  side: "long" | "short",
): { long: Record<string, never> } | { short: Record<string, never> } {
  return side === "long" ? { long: {} } : { short: {} };
}

export async function addCollateral(
  client: PhalnxClient,
  config: McpConfig,
  input: AddCollateralInput,
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

    const result = await client.flashTradeAddCollateral({
      owner: vault.owner,
      vaultId: vault.vaultId,
      agent: agentPubkey,
      targetSymbol: input.market,
      collateralSymbol: input.market,
      side: parseSide(input.side),
      collateralWithFee: toBN(input.collateralAmount),
      positionPubKey: toPublicKey(input.positionPubKey),
    });

    const sig = await client.executeFlashTrade(result, agentPubkey, signers);

    return [
      "## Collateral Added",
      `- **Vault:** ${input.vault}`,
      `- **Market:** ${input.market}`,
      `- **Side:** ${input.side.toUpperCase()}`,
      `- **Amount:** ${input.collateralAmount}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const addCollateralTool = {
  name: "shield_add_collateral",
  description:
    "Add collateral to an existing Flash Trade position through an Phalnx vault. " +
    "Requires PHALNX_AGENT_KEYPAIR_PATH. " +
    "Spending-checked: amount counts toward daily spending cap.",
  schema: addCollateralSchema,
  handler: addCollateral,
};
