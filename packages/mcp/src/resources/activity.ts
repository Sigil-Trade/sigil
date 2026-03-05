import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, formatBN } from "../utils";

export async function getActivityResource(
  client: PhalnxClient,
  vaultAddress: string,
): Promise<string> {
  try {
    const vault = toPublicKey(vaultAddress);
    const vaultAccount = await client.fetchVaultByAddress(vault);

    // V2: Transaction history is available via Anchor events, not on-chain state.
    // We expose aggregate stats from the vault account itself.
    return JSON.stringify(
      {
        vault: vaultAddress,
        totalTransactions: formatBN(vaultAccount.totalTransactions),
        totalVolume: formatBN(vaultAccount.totalVolume),
        note:
          "Detailed transaction history is available via Anchor events. " +
          "Use an explorer or event listener to view individual transactions.",
      },
      null,
      2,
    );
  } catch {
    return JSON.stringify(
      {
        vault: vaultAddress,
        error: "Activity data not found — vault may not exist",
        totalTransactions: "0",
        totalVolume: "0",
        note: "Detailed transaction history is available via Anchor events.",
      },
      null,
      2,
    );
  }
}
