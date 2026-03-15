/**
 * kamino://markets — All Kamino lending markets with reserves and metrics.
 *
 * Gives AI agents a complete view of available markets, reserves, APYs,
 * and utilization to make informed deposit/borrow recommendations.
 */

import {
  fetchKaminoMarkets,
  fetchReserveMetrics,
} from "@phalnx/kit";

export async function getKaminoMarketsResource(): Promise<string> {
  try {
    const markets = await fetchKaminoMarkets();
    const marketsWithReserves = await Promise.all(
      markets.map(async (m) => {
        try {
          const reserves = await fetchReserveMetrics(m.lendingMarket);
          return {
            address: m.lendingMarket,
            name: m.name,
            isPrimary: m.isPrimary,
            isCurated: m.isCurated,
            reserves: reserves.map((r) => ({
              address: r.reserve,
              token: r.liquidityToken,
              tokenMint: r.liquidityTokenMint,
              supplyApy: r.supplyApy,
              borrowApy: r.borrowApy,
              maxLtv: r.maxLtv,
              totalSupplyUsd: r.totalSupplyUsd,
              totalBorrowUsd: r.totalBorrowUsd,
              utilization: r.totalSupplyUsd > 0
                ? (r.totalBorrowUsd / r.totalSupplyUsd * 100).toFixed(1) + "%"
                : "0%",
            })),
          };
        } catch {
          return {
            address: m.lendingMarket,
            name: m.name,
            isPrimary: m.isPrimary,
            isCurated: m.isCurated,
            reserves: [],
            error: "Failed to fetch reserves",
          };
        }
      }),
    );

    return JSON.stringify(
      { markets: marketsWithReserves, lastUpdated: new Date().toISOString() },
      null,
      2,
    );
  } catch (error) {
    return JSON.stringify(
      {
        error: "Failed to fetch Kamino markets",
        detail: error instanceof Error ? error.message : String(error),
        markets: [],
      },
      null,
      2,
    );
  }
}
