import type { AgentShieldClient } from "@agent-shield/sdk";
import {
  toPublicKey,
  formatBN,
  formatTimestamp,
  formatActionType,
} from "../utils";

export async function getActivityResource(
  client: AgentShieldClient,
  vaultAddress: string
): Promise<string> {
  try {
    const vault = toPublicKey(vaultAddress);
    const tracker = await client.fetchTracker(vault);

    const transactions = tracker.recentTransactions.map((tx) => ({
      timestamp: formatTimestamp(tx.timestamp),
      actionType: formatActionType(tx.actionType),
      tokenMint: tx.tokenMint.toBase58(),
      amount: formatBN(tx.amount),
      protocol: tx.protocol.toBase58(),
      success: tx.success,
      slot: formatBN(tx.slot),
    }));

    return JSON.stringify(
      {
        vault: vaultAddress,
        totalTransactions: transactions.length,
        transactions,
      },
      null,
      2
    );
  } catch {
    return JSON.stringify(
      {
        vault: vaultAddress,
        error: "Activity data not found — vault may not exist",
        totalTransactions: 0,
        transactions: [],
      },
      null,
      2
    );
  }
}
