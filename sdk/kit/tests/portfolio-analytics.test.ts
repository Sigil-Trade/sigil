/**
 * Tests for portfolio-analytics.ts — cross-vault aggregation.
 *
 * Tests the pure aggregation function (no RPC) since getPortfolioOverview
 * depends on live RPC which requires devnet tests.
 */

import { expect } from "chai";
import { aggregatePortfolio } from "../src/portfolio-analytics.js";
import type { VaultSummary } from "../src/vault-analytics.js";
import type { Address } from "@solana/kit";

function mockVaultSummary(overrides: any = {}): VaultSummary {
  return {
    address: (overrides.address ?? "vault1") as Address,
    owner: "owner1" as Address,
    vaultId: 1n,
    health: {
      status: "Active",
      isHealthy: true,
      agentCount: 1,
      pausedAgentCount: 0,
      openPositions: 0,
      activeEscrowCount: 0,
      capUtilization: 40,
      capRemaining: 600_000_000n,
      capResetsIn: 3600,
      timeToCapAtCurrentRate: null,
      hasConstraints: false,
      hasTimelock: true,
      timelockDuration: 3600,
      hasPendingPolicyChange: false,
      lastActivityTimestamp: 1700000000,
      securityChecks: [],
      ...(overrides.health ?? {}),
    },
    pnl: {
      totalDeposited: 1_000_000_000n,
      totalWithdrawn: 0n,
      currentBalance: 1_100_000_000n,
      netInvestment: 1_000_000_000n,
      pnl: 100_000_000n,
      pnlPercent: 10,
      ...(overrides.pnl ?? {}),
    },
    tokenBalances: [],
    totalValueUsd: overrides.totalValueUsd ?? 500_000_000n,
    state: {
      globalBudget: {
        spent24h: 200_000_000n,
        cap: 1_000_000_000n,
        remaining: 800_000_000n,
      },
      vault: { agents: [], status: { __kind: "Active" } },
      allAgentBudgets: new Map(),
      protocolBudgets: [],
      ...(overrides.state ?? {}),
    } as any,
    stats: {
      totalTransactions: 10n,
      totalVolume: 5_000_000_000n,
      totalFeesCollected: 50_000_000n,
      totalDeposited: 1_000_000_000n,
      totalWithdrawn: 0n,
      createdAt: 1699000000n,
      ageInDays: 12,
      avgDailyVolume: 416_666_666n,
      avgTransactionSize: 500_000_000n,
      feeRate: 100,
      ...(overrides.stats ?? {}),
    },
  } as VaultSummary;
}

describe("aggregatePortfolio", () => {
  it("returns zero totals for empty portfolio", () => {
    const result = aggregatePortfolio([]);
    expect(result.vaults).to.have.length(0);
    expect(result.totals.vaultCount).to.equal(0);
    expect(result.totals.totalValueUsd).to.equal(0n);
    expect(result.topVaultByValue).to.be.null;
  });

  it("aggregates single vault correctly", () => {
    const result = aggregatePortfolio([mockVaultSummary()]);
    expect(result.totals.vaultCount).to.equal(1);
    expect(result.totals.activeVaultCount).to.equal(1);
    expect(result.totals.totalValueUsd).to.equal(500_000_000n);
    expect(result.totals.totalAgents).to.equal(1);
    expect(result.totals.totalPnl).to.equal(100_000_000n);
    expect(result.topVaultByValue).to.equal("vault1");
  });

  it("aggregates multiple vaults", () => {
    const vaults = [
      mockVaultSummary({ address: "v1", totalValueUsd: 500_000_000n }),
      mockVaultSummary({ address: "v2", totalValueUsd: 800_000_000n }),
    ];
    const result = aggregatePortfolio(vaults);
    expect(result.totals.vaultCount).to.equal(2);
    expect(result.totals.totalValueUsd).to.equal(1_300_000_000n);
    expect(result.topVaultByValue).to.equal("v2");
  });

  it("counts active vaults correctly", () => {
    const vaults = [
      mockVaultSummary({ address: "active1" }),
      mockVaultSummary({ address: "frozen1", health: { status: "Frozen", agentCount: 0 } }),
    ];
    const result = aggregatePortfolio(vaults);
    expect(result.totals.activeVaultCount).to.equal(1);
  });

  it("computes overall P&L percent", () => {
    const result = aggregatePortfolio([mockVaultSummary()]);
    // pnl=100M, deposited=1000M, withdrawn=0 → net=1000M → 10%
    expect(result.totals.overallPnlPercent).to.equal(10);
  });

  it("identifies top vault by spending", () => {
    const vaults = [
      mockVaultSummary({
        address: "low",
        state: { globalBudget: { spent24h: 100_000_000n, cap: 1_000_000_000n, remaining: 900_000_000n } },
      }),
      mockVaultSummary({
        address: "high",
        state: { globalBudget: { spent24h: 500_000_000n, cap: 1_000_000_000n, remaining: 500_000_000n } },
      }),
    ];
    const result = aggregatePortfolio(vaults);
    expect(result.topVaultBySpending).to.equal("high");
  });
});
