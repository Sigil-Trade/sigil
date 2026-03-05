import { z } from "zod";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { loadShieldConfig, rpcUrlForNetwork } from "../config";

/** Phalnx program ID */
const PHALNX_PROGRAM_ID = new PublicKey(
  "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL",
);

function deriveVaultPDA(
  owner: PublicKey,
  vaultId: number,
): [PublicKey, number] {
  const vaultIdBn = new BN(vaultId);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultIdBn.toArrayLike(Buffer, "le", 8),
    ],
    PHALNX_PROGRAM_ID,
  );
}

export const discoverVaultSchema = z.object({
  owner: z
    .string()
    .describe("Owner public key (base58). Defaults to configured wallet."),
  vaultId: z
    .number()
    .optional()
    .describe("Specific vault ID to check. If omitted, scans a range of IDs."),
  scanRange: z
    .number()
    .optional()
    .default(10)
    .describe(
      "Number of vault IDs to scan (0 through scanRange-1). Max 256. Default: 10.",
    ),
});

export type DiscoverVaultInput = z.input<typeof discoverVaultSchema>;

/**
 * Discover vaults owned by a given public key.
 * Derives vault PDA(s) and checks on-chain existence.
 * Works without PhalnxClient — only needs RPC connection.
 */
export async function discoverVault(
  _client: any,
  input: DiscoverVaultInput,
): Promise<string> {
  try {
    // Resolve RPC URL from config or env
    const fileConfig = loadShieldConfig();
    const rpcUrl = fileConfig
      ? rpcUrlForNetwork(fileConfig.network)
      : process.env.PHALNX_RPC_URL || clusterApiUrl("devnet");
    const connection = new Connection(rpcUrl, "confirmed");

    let ownerPubkey: PublicKey;
    try {
      ownerPubkey = new PublicKey(input.owner);
    } catch {
      return `Error: Invalid owner public key: ${input.owner}`;
    }

    const scanRange = Math.min(input.scanRange ?? 10, 256);

    if (input.vaultId !== undefined) {
      // Check a single vault ID
      const [vaultPda] = deriveVaultPDA(ownerPubkey, input.vaultId);
      const accountInfo = await connection.getAccountInfo(vaultPda);

      if (!accountInfo) {
        return [
          "## Vault Discovery",
          "",
          `No vault found for owner \`${input.owner}\` with vault ID \`${input.vaultId}\`.`,
          `Derived PDA: \`${vaultPda.toBase58()}\``,
          "",
          "The vault may not have been created yet, or the owner/vaultId is incorrect.",
        ].join("\n");
      }

      return [
        "## Vault Found",
        "",
        `- **Vault Address:** ${vaultPda.toBase58()}`,
        `- **Owner:** ${input.owner}`,
        `- **Vault ID:** ${input.vaultId}`,
        `- **Data Size:** ${accountInfo.data.length} bytes`,
        `- **Lamports:** ${accountInfo.lamports}`,
      ].join("\n");
    }

    // Scan a range of vault IDs
    const found: Array<{
      vaultId: number;
      address: string;
      dataSize: number;
    }> = [];

    // Batch derive PDAs and fetch in parallel using getMultipleAccountsInfo
    const pdas: Array<{ vaultId: number; pda: PublicKey }> = [];
    for (let i = 0; i < scanRange; i++) {
      const [pda] = deriveVaultPDA(ownerPubkey, i);
      pdas.push({ vaultId: i, pda });
    }

    // Fetch in batches of 100 (Solana getMultipleAccountsInfo limit)
    for (let batch = 0; batch < pdas.length; batch += 100) {
      const batchPdas = pdas.slice(batch, batch + 100);
      const accounts = await connection.getMultipleAccountsInfo(
        batchPdas.map((p) => p.pda),
      );

      for (let j = 0; j < accounts.length; j++) {
        if (accounts[j]) {
          found.push({
            vaultId: batchPdas[j].vaultId,
            address: batchPdas[j].pda.toBase58(),
            dataSize: accounts[j]!.data.length,
          });
        }
      }
    }

    if (found.length === 0) {
      return [
        "## Vault Discovery",
        "",
        `No vaults found for owner \`${input.owner}\` (scanned IDs 0–${scanRange - 1}).`,
        "",
        "The vault may not have been created yet, or try a larger scan range.",
      ].join("\n");
    }

    const lines: string[] = [
      "## Vaults Found",
      "",
      `Found **${found.length}** vault(s) for owner \`${input.owner}\`:`,
      "",
    ];

    for (const v of found) {
      lines.push(
        `- **Vault ID ${v.vaultId}:** \`${v.address}\` (${v.dataSize} bytes)`,
      );
    }

    return lines.join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error discovering vaults: ${msg}`;
  }
}

export const discoverVaultTool = {
  name: "shield_discover_vault",
  description:
    "Discover vaults owned by a public key. Derives vault PDA(s) from owner + vaultId and checks on-chain. " +
    "Use to find vault addresses after creation, or to scan for all vaults owned by an address.",
  schema: discoverVaultSchema,
  handler: discoverVault,
};
