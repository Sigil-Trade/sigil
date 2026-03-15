/**
 * kamino://user/{wallet}/positions — Complete user position state.
 *
 * Deposits, borrows, health factor, PnL, and rewards for a wallet.
 * Gives agents full context to manage positions safely.
 */

import {
  fetchKaminoMarkets,
  fetchObligations,
  fetchLoanInfo,
  fetchObligationPnl,
  fetchUserRewards,
} from "@phalnx/kit";

export async function getKaminoPositionsResource(wallet: string): Promise<string> {
  try {
    const [markets, rewards] = await Promise.all([
      fetchKaminoMarkets(),
      fetchUserRewards(wallet).catch(() => ({ lending: { pending: 0, tokens: [] }, vault: { pending: 0, tokens: [] } })),
    ]);

    // Fetch obligations from all markets
    const allObligations = await Promise.all(
      markets.map(async (m) => {
        try {
          const obligations = await fetchObligations(m.lendingMarket, wallet);
          return Promise.all(
            obligations.map(async (o) => {
              const [loanInfo, pnl] = await Promise.all([
                fetchLoanInfo(m.lendingMarket, o.obligationAddress).catch(() => null),
                fetchObligationPnl(m.lendingMarket, o.obligationAddress).catch(() => null),
              ]);
              return {
                address: o.obligationAddress,
                market: m.name,
                marketAddress: m.lendingMarket,
                deposits: o.deposits,
                borrows: o.borrows,
                healthFactor: o.healthFactor,
                ltv: o.ltv,
                maxLtv: o.maxLtv,
                liquidationThreshold: loanInfo?.liquidationThreshold ?? null,
                netApy: loanInfo?.netApy ?? null,
                interestEarned: loanInfo?.interestEarned ?? null,
                interestPaid: loanInfo?.interestPaid ?? null,
                totalPnl: pnl?.totalPnl ?? null,
              };
            }),
          );
        } catch {
          return [];
        }
      }),
    );

    const obligations = allObligations.flat();

    return JSON.stringify(
      {
        wallet,
        obligations,
        rewards,
        lastUpdated: new Date().toISOString(),
      },
      null,
      2,
    );
  } catch (error) {
    return JSON.stringify(
      {
        error: "Failed to fetch Kamino positions",
        detail: error instanceof Error ? error.message : String(error),
        wallet,
        obligations: [],
      },
      null,
      2,
    );
  }
}
