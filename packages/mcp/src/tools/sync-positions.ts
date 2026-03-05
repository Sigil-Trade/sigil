import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey } from "../utils";
import { formatError } from "../errors";
import type { McpConfig } from "../config";

export const syncPositionsSchema = z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  poolCustodyPairs: z
    .array(
      z.object({
        pool: z.string().describe("Flash Trade pool address (base58)"),
        custody: z.string().describe("Custody account address (base58)"),
      }),
    )
    .describe("Array of pool/custody pairs to check positions against"),
  flashProgramId: z
    .string()
    .optional()
    .describe("Flash Trade program ID (defaults to mainnet)"),
});

export type SyncPositionsInput = z.infer<typeof syncPositionsSchema>;

export async function syncPositions(
  client: PhalnxClient,
  _config: McpConfig,
  input: SyncPositionsInput,
): Promise<string> {
  try {
    const vaultAddress = toPublicKey(input.vault);
    const vault = await client.fetchVaultByAddress(vaultAddress);

    const { FLASH_TRADE_PROGRAM_ID } = await import("@phalnx/sdk");

    const flashProgramId = input.flashProgramId
      ? toPublicKey(input.flashProgramId)
      : FLASH_TRADE_PROGRAM_ID;

    const pairs: [
      import("@solana/web3.js").PublicKey,
      import("@solana/web3.js").PublicKey,
    ][] = input.poolCustodyPairs.map((p) => [
      toPublicKey(p.pool),
      toPublicKey(p.custody),
    ]);

    const sig = await client.syncPositions(
      vault.owner,
      vaultAddress,
      pairs,
      flashProgramId,
    );

    if (!sig) {
      return [
        "## Positions Already In Sync",
        `- **Vault:** ${input.vault}`,
        "No correction needed — on-chain counter matches actual positions.",
      ].join("\n");
    }

    return [
      "## Positions Synced",
      `- **Vault:** ${input.vault}`,
      `- **Transaction:** ${sig}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const syncPositionsTool = {
  name: "shield_sync_positions",
  description:
    "Sync the vault's open position counter with actual Flash Trade state. " +
    "Owner-only — corrects counter drift from keeper-executed TP/SL fills.",
  schema: syncPositionsSchema,
  handler: syncPositions,
};
