import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey, formatBN } from "../utils";

export async function getSpendingResource(
  client: AgentShieldClient,
  vaultAddress: string,
): Promise<string> {
  try {
    const vault = toPublicKey(vaultAddress);
    const tracker = await client.fetchTracker(vault);
    const policy = await client.fetchPolicy(vault);

    const cap = policy.dailySpendingCapUsd;

    // Filter to non-zero buckets
    const activeBuckets = tracker.buckets.filter((b) => !b.usdAmount.isZero());

    // Compute rolling 24h total
    let totalUsd = activeBuckets.reduce(
      (sum, b) => sum.add(b.usdAmount),
      cap.sub(cap), // BN zero
    );

    const buckets = activeBuckets.map((bucket) => ({
      epochId: formatBN(bucket.epochId),
      usdAmount: formatBN(bucket.usdAmount),
    }));

    return JSON.stringify(
      {
        vault: vaultAddress,
        dailySpendingCapUsd: formatBN(cap),
        totalRolling24hUsd: formatBN(totalUsd),
        percentOfCap: cap.isZero()
          ? "N/A"
          : `${totalUsd.muln(100).div(cap).toNumber()}%`,
        remaining: cap.isZero() ? "N/A" : formatBN(cap.sub(totalUsd)),
        buckets,
      },
      null,
      2,
    );
  } catch {
    return JSON.stringify(
      {
        vault: vaultAddress,
        error: "Spending data not found — vault may not exist",
        dailySpendingCapUsd: "0",
        totalRolling24hUsd: "0",
        percentOfCap: "N/A",
        remaining: "N/A",
        buckets: [],
      },
      null,
      2,
    );
  }
}
