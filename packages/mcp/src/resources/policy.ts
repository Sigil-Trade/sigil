import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, formatBN } from "../utils";

export async function getPolicyResource(
  client: PhalnxClient,
  vaultAddress: string,
): Promise<string> {
  try {
    const vault = toPublicKey(vaultAddress);
    const policy = await client.fetchPolicy(vault);

    const protocolModeLabels = ["all", "allowlist", "denylist"];
    return JSON.stringify(
      {
        vault: vaultAddress,
        dailySpendingCapUsd: formatBN(policy.dailySpendingCapUsd),
        maxTransactionSizeUsd: formatBN(policy.maxTransactionSizeUsd),
        protocolMode:
          protocolModeLabels[policy.protocolMode] ??
          `unknown(${policy.protocolMode})`,
        protocols: policy.protocols.map((p) => p.toBase58()),
        maxLeverageBps: policy.maxLeverageBps,
        canOpenPositions: policy.canOpenPositions,
        maxConcurrentPositions: policy.maxConcurrentPositions,
        developerFeeRate: policy.developerFeeRate,
      },
      null,
      2,
    );
  } catch {
    return JSON.stringify(
      {
        vault: vaultAddress,
        error: "Policy not found — vault may not exist",
        dailySpendingCapUsd: "0",
        maxTransactionSizeUsd: "0",
        protocolMode: "all",
        protocols: [],
        maxLeverageBps: 0,
        canOpenPositions: false,
        maxConcurrentPositions: 0,
        developerFeeRate: 0,
      },
      null,
      2,
    );
  }
}
