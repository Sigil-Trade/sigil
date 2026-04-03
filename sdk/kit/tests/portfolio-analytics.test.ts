/**
 * Tests for portfolio-analytics.ts — cross-vault aggregation.
 *
 * Tests the pure aggregation function (no RPC) since getPortfolioOverview
 * depends on live RPC which requires devnet tests.
 */

import { expect } from "chai";
import { getAgentLeaderboardAcrossVaults } from "../src/portfolio-analytics.js";
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
      mockVaultSummary({
        address: "frozen1",
        health: { status: "Frozen", agentCount: 0 },
      }),
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
        state: {
          globalBudget: {
            spent24h: 100_000_000n,
            cap: 1_000_000_000n,
            remaining: 900_000_000n,
          },
        },
      }),
      mockVaultSummary({
        address: "high",
        state: {
          globalBudget: {
            spent24h: 500_000_000n,
            cap: 1_000_000_000n,
            remaining: 500_000_000n,
          },
        },
      }),
    ];
    const result = aggregatePortfolio(vaults);
    expect(result.topVaultBySpending).to.equal("high");
  });
});

// ─── getAgentLeaderboardAcrossVaults ──────────────────────────────────────────

describe("getAgentLeaderboardAcrossVaults", () => {
  it("returns ranked agents from multiple vaults", () => {
    const vaultStates = [
      {
        address: "v1" as any,
        state: {
          vault: {
            vaultId: 1n,
            agents: [
              {
                pubkey: "a1" as any,
                permissions: 1n,
                spendingLimitUsd: 0n,
                paused: false,
              },
            ],
          },
          allAgentBudgets: new Map([
            ["a1", { spent24h: 200n, cap: 1000n, remaining: 800n }],
          ]),
          overlay: null,
        } as any,
      },
      {
        address: "v2" as any,
        state: {
          vault: {
            vaultId: 2n,
            agents: [
              {
                pubkey: "a2" as any,
                permissions: 1n,
                spendingLimitUsd: 0n,
                paused: false,
              },
            ],
          },
          allAgentBudgets: new Map([
            ["a2", { spent24h: 500n, cap: 1000n, remaining: 500n }],
          ]),
          overlay: null,
        } as any,
      },
    ];

    const result = getAgentLeaderboardAcrossVaults(vaultStates);
    expect(result).to.have.length(2);
    // Verify sort order property: each element spend24h >= next
    expect(result[0].spend24h).to.equal(500n);
    expect(result[1].spend24h).to.equal(200n);
    expect(result[0].agent).to.equal("a2");
    expect(result[1].agent).to.equal("a1");
    // Verify ranks are sequential
    expect(result[0].rank).to.equal(1);
    expect(result[1].rank).to.equal(2);
    // Verify sort order is descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i].spend24h <= result[i - 1].spend24h).to.equal(true);
    }
  });

  it("returns empty for vaults with no agents", () => {
    const result = getAgentLeaderboardAcrossVaults([
      {
        address: "v1" as any,
        state: {
          vault: { vaultId: 1n, agents: [] },
          allAgentBudgets: new Map(),
          overlay: null,
        } as any,
      },
    ]);
    expect(result).to.have.length(0);
  });

  it("lists same agent in multiple vaults as separate entries", () => {
    const vaultStates = [
      {
        address: "v1" as any,
        state: {
          vault: {
            vaultId: 1n,
            agents: [
              {
                pubkey: "shared" as any,
                permissions: 1n,
                spendingLimitUsd: 0n,
                paused: false,
              },
            ],
          },
          allAgentBudgets: new Map([
            ["shared", { spent24h: 100n, cap: 1000n, remaining: 900n }],
          ]),
          overlay: null,
        } as any,
      },
      {
        address: "v2" as any,
        state: {
          vault: {
            vaultId: 2n,
            agents: [
              {
                pubkey: "shared" as any,
                permissions: 1n,
                spendingLimitUsd: 0n,
                paused: false,
              },
            ],
          },
          allAgentBudgets: new Map([
            ["shared", { spent24h: 300n, cap: 1000n, remaining: 700n }],
          ]),
          overlay: null,
        } as any,
      },
    ];

    const result = getAgentLeaderboardAcrossVaults(vaultStates);
    // Same agent in 2 vaults = 2 SEPARATE entries (not aggregated)
    expect(result).to.have.length(2);
    expect(result[0].spend24h).to.equal(300n); // v2 entry first (higher spend)
    expect(result[0].vaultAddress).to.equal("v2");
    expect(result[1].spend24h).to.equal(100n);
    expect(result[1].vaultAddress).to.equal("v1");
  });
});
