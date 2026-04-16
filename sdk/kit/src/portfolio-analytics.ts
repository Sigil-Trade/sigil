/**
 * Portfolio analytics — cross-vault aggregation for the portfolio page.
 *
 * getPortfolioOverview() is the most expensive SDK call — it resolves ALL
 * vaults for an owner. The dashboard caches this with 30s stale time.
 */

import type { Address, Rpc, SolanaRpcApi } from "./kit-adapter.js";
import { computeUtilizationPercent } from "./math-utils.js";
import {
  findVaultsByOwner,
  bytesToAddress,
  getSpendingHistory,
  type SpendingEpoch,
} from "./state-resolver.js";
import type { ResolvedVaultState } from "./state-resolver.js";
import { getVaultSummary, type VaultSummary } from "./vault-analytics.js";
import { evaluateAlertConditions, type Alert } from "./security-analytics.js";
import type { Network } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PortfolioOverview {
  vaults: VaultSummary[];
  totals: {
    vaultCount: number;
    activeVaultCount: number;
    totalValueUsd: bigint;
    totalAgents: number;
    totalSpend24h: bigint;
    totalVolume: bigint;
    totalFeesCollected: bigint;
    totalPnl: bigint;
    totalDeposited: bigint;
    totalWithdrawn: bigint;
    overallPnlPercent: number;
  };
  topVaultByValue: Address | null;
  topVaultBySpending: Address | null;
  alerts: Alert[];
}

// ─── Helpers (exported for testing) ──────────────────────────────────────────

/** Aggregate VaultSummary[] into portfolio totals. Pure function. */
export function aggregatePortfolio(
  vaults: VaultSummary[],
): Omit<PortfolioOverview, "alerts"> {
  if (vaults.length === 0) {
    return {
      vaults: [],
      totals: {
        vaultCount: 0,
        activeVaultCount: 0,
        totalValueUsd: 0n,
        totalAgents: 0,
        totalSpend24h: 0n,
        totalVolume: 0n,
        totalFeesCollected: 0n,
        totalPnl: 0n,
        totalDeposited: 0n,
        totalWithdrawn: 0n,
        overallPnlPercent: 0,
      },
      topVaultByValue: null,
      topVaultBySpending: null,
    };
  }

  let totalValueUsd = 0n;
  let totalAgents = 0;
  let totalSpend24h = 0n;
  let totalVolume = 0n;
  let totalFeesCollected = 0n;
  let totalPnl = 0n;
  let totalDeposited = 0n;
  let totalWithdrawn = 0n;
  let activeVaultCount = 0;
  let topValueAddr: Address | null = null;
  let topValue = 0n;
  let topSpendAddr: Address | null = null;
  let topSpend = 0n;

  for (const v of vaults) {
    totalValueUsd += v.totalValueUsd;
    totalAgents += v.health.agentCount;
    totalSpend24h += v.state.globalBudget.spent24h;
    totalVolume += v.stats.totalVolume;
    totalFeesCollected += v.stats.totalFeesCollected;
    totalPnl += v.pnl.pnl;
    totalDeposited += v.pnl.totalDeposited;
    totalWithdrawn += v.pnl.totalWithdrawn;

    if (v.health.status === "Active") activeVaultCount++;

    if (v.totalValueUsd > topValue) {
      topValue = v.totalValueUsd;
      topValueAddr = v.address;
    }
    if (v.state.globalBudget.spent24h > topSpend) {
      topSpend = v.state.globalBudget.spent24h;
      topSpendAddr = v.address;
    }
  }

  const netInvestment = totalDeposited - totalWithdrawn;
  const overallPnlPercent = computeUtilizationPercent(totalPnl, netInvestment);

  return {
    vaults,
    totals: {
      vaultCount: vaults.length,
      activeVaultCount,
      totalValueUsd,
      totalAgents,
      totalSpend24h,
      totalVolume,
      totalFeesCollected,
      totalPnl,
      totalDeposited,
      totalWithdrawn,
      overallPnlPercent,
    },
    topVaultByValue: topValueAddr,
    topVaultBySpending: topSpendAddr,
  };
}

// ─── getPortfolioOverview ────────────────────────────────────────────────────

/**
 * Cross-vault aggregated analytics for the portfolio page.
 * N+1 RPC calls: 1 discovery + N vault summaries (parallel).
 */
export async function getPortfolioOverview(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  network: Network = "mainnet-beta",
): Promise<PortfolioOverview> {
  const discovered = await findVaultsByOwner(rpc, owner);

  if (discovered.length === 0) {
    return { ...aggregatePortfolio([]), alerts: [] };
  }

  // Use allSettled so one failed vault doesn't kill the entire portfolio
  const results = await Promise.allSettled(
    discovered.map((v) => getVaultSummary(rpc, v.vaultAddress, network)),
  );
  const vaults = results
    .filter(
      (r): r is PromiseFulfilledResult<VaultSummary> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value);

  const portfolio = aggregatePortfolio(vaults);

  const allAlerts: Alert[] = [];
  for (const v of vaults) {
    allAlerts.push(...evaluateAlertConditions(v.state, v.address));
  }

  return { ...portfolio, alerts: allAlerts };
}

// ─── getCrossVaultAgentRanking ───────────────────────────────────────────────

export interface CrossVaultAgentRanking {
  agent: Address;
  vaultAddress: Address;
  vaultId: bigint;
  spend24h: bigint;
  lifetimeSpend: bigint;
  capUtilization: number;
  paused: boolean;
  rank: number;
}

/**
 * Rank all agents across all vaults by 24h spend.
 * Aggregates what getAgentLeaderboard does per-vault into a portfolio-wide ranking.
 */
export function getCrossVaultAgentRanking(
  overview: PortfolioOverview,
): CrossVaultAgentRanking[] {
  const allAgents: CrossVaultAgentRanking[] = [];

  for (const vault of overview.vaults) {
    for (const [agentAddr, budget] of vault.state.allAgentBudgets) {
      const agentEntry = vault.state.vault.agents.find(
        (a) => a.pubkey === agentAddr,
      );
      if (!agentEntry) continue;

      let lifetimeSpend = 0n;
      if (vault.state.overlay) {
        const slotIdx = vault.state.overlay.entries.findIndex((e) => {
          try {
            return bytesToAddress(e.agent) === agentAddr;
          } catch {
            return false;
          }
        });
        if (
          slotIdx >= 0 &&
          slotIdx < vault.state.overlay.lifetimeSpend.length
        ) {
          lifetimeSpend = vault.state.overlay.lifetimeSpend[slotIdx];
        }
      }

      allAgents.push({
        agent: agentAddr,
        vaultAddress: vault.address,
        vaultId: vault.vaultId,
        spend24h: budget.spent24h,
        lifetimeSpend,
        capUtilization: computeUtilizationPercent(budget.spent24h, budget.cap),
        paused: agentEntry.paused,
        rank: 0,
      });
    }
  }

  allAgents.sort((a, b) =>
    b.spend24h > a.spend24h ? 1 : b.spend24h < a.spend24h ? -1 : 0,
  );
  allAgents.forEach((a, i) => {
    a.rank = i + 1;
  });

  return allAgents;
}

// ─── getAgentLeaderboardAcrossVaults ─────────────────────────────────────────

/**
 * Rank agents across multiple pre-resolved vault states.
 * Convenience wrapper when you have ResolvedVaultState[] but not a full PortfolioOverview.
 *
 * For the full portfolio pipeline, use getPortfolioOverview() + getCrossVaultAgentRanking().
 */
export function getAgentLeaderboardAcrossVaults(
  vaultStates: Array<{ address: Address; state: ResolvedVaultState }>,
): CrossVaultAgentRanking[] {
  const allAgents: CrossVaultAgentRanking[] = [];

  for (const { address: vaultAddress, state } of vaultStates) {
    for (const [agentAddr, budget] of state.allAgentBudgets) {
      const agentEntry = state.vault.agents.find((a) => a.pubkey === agentAddr);
      if (!agentEntry) continue;

      let lifetimeSpend = 0n;
      if (state.overlay) {
        const slotIdx = state.overlay.entries.findIndex((e) => {
          try {
            return bytesToAddress(e.agent) === agentAddr;
          } catch {
            return false;
          }
        });
        if (slotIdx >= 0 && slotIdx < state.overlay.lifetimeSpend.length) {
          lifetimeSpend = state.overlay.lifetimeSpend[slotIdx];
        }
      }

      allAgents.push({
        agent: agentAddr,
        vaultAddress,
        vaultId: state.vault.vaultId,
        spend24h: budget.spent24h,
        lifetimeSpend,
        capUtilization: computeUtilizationPercent(budget.spent24h, budget.cap),
        paused: agentEntry.paused,
        rank: 0,
      });
    }
  }

  allAgents.sort((a, b) =>
    b.spend24h > a.spend24h ? 1 : b.spend24h < a.spend24h ? -1 : 0,
  );
  allAgents.forEach((a, i) => {
    a.rank = i + 1;
  });

  return allAgents;
}

// ─── getPortfolioTimeSeries ──────────────────────────────────────────────────

export interface PortfolioTimeSeries {
  /** Aggregated spending per epoch across all vaults */
  spendingByEpoch: Array<{
    timestamp: number;
    totalUsd: bigint;
    vaultBreakdown: Map<Address, bigint>;
  }>;
  totalSpend24h: bigint;
  totalCap24h: bigint;
  utilization: number;
}

/**
 * Aggregated spending time-series across all vaults for portfolio-level charts.
 * Merges per-vault SpendTracker histories into one combined timeline.
 */
export function getPortfolioTimeSeries(
  vaultStates: Array<{ address: Address; state: ResolvedVaultState }>,
  nowUnix: bigint,
): PortfolioTimeSeries {
  const epochMap = new Map<
    number,
    { totalUsd: bigint; vaultBreakdown: Map<Address, bigint> }
  >();

  let totalSpend24h = 0n;
  let totalCap24h = 0n;

  for (const { address, state } of vaultStates) {
    totalSpend24h += state.globalBudget.spent24h;
    totalCap24h += state.globalBudget.cap;

    if (!state.tracker) continue;
    const history = getSpendingHistory(state.tracker, nowUnix);

    for (const epoch of history) {
      const existing = epochMap.get(epoch.timestamp) ?? {
        totalUsd: 0n,
        vaultBreakdown: new Map<Address, bigint>(),
      };
      existing.totalUsd += epoch.usdAmount;
      existing.vaultBreakdown.set(
        address,
        (existing.vaultBreakdown.get(address) ?? 0n) + epoch.usdAmount,
      );
      epochMap.set(epoch.timestamp, existing);
    }
  }

  const spendingByEpoch = Array.from(epochMap.entries())
    .map(([timestamp, data]) => ({
      timestamp,
      totalUsd: data.totalUsd,
      vaultBreakdown: data.vaultBreakdown,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const utilization = computeUtilizationPercent(totalSpend24h, totalCap24h);

  return { spendingByEpoch, totalSpend24h, totalCap24h, utilization };
}
