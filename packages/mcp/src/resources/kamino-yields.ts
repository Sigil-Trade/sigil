/**
 * kamino://yields — Cross-product yield comparison.
 *
 * Combines lending rates, staking yields, and leverage metrics
 * into a single view for agent-driven yield optimization.
 */

import {
  fetchKaminoMarkets,
  fetchReserveMetrics,
  fetchStakingYields,
  fetchLeverageMetrics,
} from "@phalnx/kit";

export async function getKaminoYieldsResource(): Promise<string> {
  try {
    const [markets, stakingYields] = await Promise.all([
      fetchKaminoMarkets(),
      fetchStakingYields().catch(() => []),
    ]);

    // Get primary market reserves for lending yields
    const primaryMarket = markets.find((m) => m.isPrimary);
    const lendingYields = primaryMarket
      ? await fetchReserveMetrics(primaryMarket.lendingMarket).catch(() => [])
      : [];

    // Get leverage metrics from primary market
    const leverageYields = primaryMarket
      ? await fetchLeverageMetrics(primaryMarket.lendingMarket).catch(() => [])
      : [];

    return JSON.stringify(
      {
        lending: lendingYields.map((r) => ({
          token: r.liquidityToken,
          market: primaryMarket?.name ?? "unknown",
          supplyApy: r.supplyApy,
          borrowApy: r.borrowApy,
          tvl: r.totalSupplyUsd,
          type: "lending" as const,
        })),
        staking: stakingYields.map((s) => ({
          token: s.token,
          apy: s.apy,
          mint: s.mint,
          type: "staking" as const,
        })),
        leverage: leverageYields.map((l) => ({
          depositToken: l.depositReserve,
          borrowToken: l.borrowReserve,
          avgLeverage: l.avgLeverage,
          tvl: l.tvl,
          tag: l.tag,
          type: "leverage" as const,
        })),
        lastUpdated: new Date().toISOString(),
      },
      null,
      2,
    );
  } catch (error) {
    return JSON.stringify(
      {
        error: "Failed to fetch Kamino yields",
        detail: error instanceof Error ? error.message : String(error),
        lending: [],
        staking: [],
        leverage: [],
      },
      null,
      2,
    );
  }
}
