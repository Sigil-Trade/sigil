import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey, formatBN } from "../utils";

export async function getPolicyResource(
  client: AgentShieldClient,
  vaultAddress: string
): Promise<string> {
  try {
    const vault = toPublicKey(vaultAddress);
    const policy = await client.fetchPolicy(vault);

    return JSON.stringify(
      {
        vault: vaultAddress,
        dailySpendingCap: formatBN(policy.dailySpendingCap),
        maxTransactionSize: formatBN(policy.maxTransactionSize),
        allowedTokens: policy.allowedTokens.map((t) => t.toBase58()),
        allowedProtocols: policy.allowedProtocols.map((p) => p.toBase58()),
        maxLeverageBps: policy.maxLeverageBps,
        canOpenPositions: policy.canOpenPositions,
        maxConcurrentPositions: policy.maxConcurrentPositions,
        developerFeeRate: policy.developerFeeRate,
      },
      null,
      2
    );
  } catch {
    return JSON.stringify(
      {
        vault: vaultAddress,
        error: "Policy not found — vault may not exist",
        dailySpendingCap: "0",
        maxTransactionSize: "0",
        allowedTokens: [],
        allowedProtocols: [],
        maxLeverageBps: 0,
        canOpenPositions: false,
        maxConcurrentPositions: 0,
        developerFeeRate: 0,
      },
      null,
      2
    );
  }
}
