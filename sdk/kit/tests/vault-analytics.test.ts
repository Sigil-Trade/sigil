/**
 * Tests for vault-analytics.ts — health assessment and vault summary.
 */

import { expect } from "chai";
import { getVaultHealth } from "../src/vault-analytics.js";
import { VaultStatus } from "../src/generated/types/vaultStatus.js";
import { FULL_PERMISSIONS, PROTOCOL_MODE_ALLOWLIST } from "../src/types.js";

function mockState(overrides: any = {}) {
  return {
    vault: {
      agents: [
        {
          pubkey: "agent1",
          permissions: 1n,
          spendingLimitUsd: 500_000_000n,
          paused: false,
        },
      ],
      status: VaultStatus.Active,
      openPositions: 0,
      activeEscrowCount: 0,
      ...(overrides.vault ?? {}),
    },
    policy: {
      dailySpendingCapUsd: 1_000_000_000n,
      protocolMode: PROTOCOL_MODE_ALLOWLIST,
      timelockDuration: 3600n,
      maxSlippageBps: 500,
      hasProtocolCaps: false,
      hasConstraints: false,
      ...(overrides.policy ?? {}),
    },
    tracker: overrides.tracker ?? null,
    constraints: overrides.constraints ?? null,
    globalBudget: {
      spent24h: 400_000_000n,
      cap: 1_000_000_000n,
      remaining: 600_000_000n,
      ...(overrides.globalBudget ?? {}),
    },
    overlay: null,
    allAgentBudgets: new Map(),
    protocolBudgets: [],
    maxTransactionUsd: 0n,
    stablecoinBalances: { usdc: 0n, usdt: 0n },
    resolvedAtTimestamp: 1700000000n,
    ...overrides,
  } as any;
}

describe("getVaultHealth", () => {
  it("reports healthy vault", () => {
    const health = getVaultHealth(mockState(), 1700000000n);
    expect(health.isHealthy).to.equal(true);
    expect(health.status).to.equal("Active");
    expect(health.capUtilization).to.equal(40);
    expect(health.agentCount).to.equal(1);
  });

  it("reports unhealthy when frozen", () => {
    const health = getVaultHealth(
      mockState({
        vault: {
          status: VaultStatus.Frozen,
          agents: [
            {
              pubkey: "a",
              permissions: 1n,
              spendingLimitUsd: 500_000_000n,
              paused: false,
            },
          ],
          openPositions: 0,
          activeEscrowCount: 0,
        },
      }),
      1700000000n,
    );
    expect(health.isHealthy).to.equal(false);
    expect(health.status).to.equal("Frozen");
  });

  it("reports unhealthy when agent has FULL_PERMISSIONS", () => {
    const health = getVaultHealth(
      mockState({
        vault: {
          agents: [
            {
              pubkey: "agent1",
              permissions: FULL_PERMISSIONS,
              spendingLimitUsd: 0n,
              paused: false,
            },
          ],
          status: VaultStatus.Active,
          openPositions: 0,
          activeEscrowCount: 0,
        },
      }),
      1700000000n,
    );
    expect(health.isHealthy).to.equal(false);
    const fullPermsCheck = health.securityChecks.find(
      (c: any) => c.id === "no-full-perms",
    );
    expect(fullPermsCheck!.passed).to.equal(false);
  });

  it("reports unhealthy when cap > 95%", () => {
    const health = getVaultHealth(
      mockState({
        globalBudget: {
          spent24h: 960_000_000n,
          cap: 1_000_000_000n,
          remaining: 40_000_000n,
        },
      }),
      1700000000n,
    );
    expect(health.isHealthy).to.equal(false);
    expect(health.capUtilization).to.equal(96);
  });

  it("reports no-agent vault as unhealthy", () => {
    const health = getVaultHealth(
      mockState({
        vault: {
          agents: [],
          status: VaultStatus.Active,
          openPositions: 0,
          activeEscrowCount: 0,
        },
      }),
      1700000000n,
    );
    expect(health.isHealthy).to.equal(false);
    expect(health.agentCount).to.equal(0);
  });

  it("counts paused agents correctly", () => {
    const health = getVaultHealth(
      mockState({
        vault: {
          agents: [
            {
              pubkey: "a1",
              permissions: 1n,
              spendingLimitUsd: 100n,
              paused: true,
            },
            {
              pubkey: "a2",
              permissions: 1n,
              spendingLimitUsd: 100n,
              paused: false,
            },
          ],
          status: VaultStatus.Active,
          openPositions: 0,
          activeEscrowCount: 0,
        },
      }),
      1700000000n,
    );
    expect(health.agentCount).to.equal(2);
    expect(health.pausedAgentCount).to.equal(1);
  });

  it("handles zero cap without division error", () => {
    const health = getVaultHealth(
      mockState({
        globalBudget: { spent24h: 0n, cap: 0n, remaining: 0n },
      }),
      1700000000n,
    );
    expect(health.capUtilization).to.equal(0);
    expect(health.capRemaining).to.equal(0n);
  });

  it("includes 7 security checks", () => {
    const health = getVaultHealth(mockState(), 1700000000n);
    expect(health.securityChecks).to.have.length(7);
  });
});
