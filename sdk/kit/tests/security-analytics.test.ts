/**
 * Tests for security-analytics.ts — posture checklist and alert conditions.
 */

import { expect } from "chai";
import {
  getSecurityPosture,
  evaluateAlertConditions,
} from "../src/security-analytics.js";
import { VaultStatus } from "../src/generated/types/vaultStatus.js";
import { FULL_PERMISSIONS, PROTOCOL_MODE_ALLOWLIST } from "../src/types.js";
import type { Address } from "@solana/kit";

function mockSecurityState(overrides: any = {}) {
  return {
    vault: {
      agents: [
        {
          pubkey: "agent1" as Address,
          permissions: 1n,
          spendingLimitUsd: 500_000_000n,
          paused: false,
        },
      ],
      status: VaultStatus.Active,
      feeDestination: "fee_dest_real" as Address,
      openPositions: 0,
      activeEscrowCount: 0,
      ...(overrides.vault ?? {}),
    },
    policy: {
      dailySpendingCapUsd: 1_000_000_000n,
      protocolMode: PROTOCOL_MODE_ALLOWLIST,
      timelockDuration: 3600n,
      maxSlippageBps: 300,
      ...(overrides.policy ?? {}),
    },
    constraints: overrides.constraints ?? null,
    tracker: overrides.tracker ?? null,
    globalBudget: {
      spent24h: 400_000_000n,
      cap: 1_000_000_000n,
      remaining: 600_000_000n,
      ...(overrides.globalBudget ?? {}),
    },
    allAgentBudgets: overrides.allAgentBudgets ?? new Map(),
    stablecoinBalances: { usdc: 100_000_000n, usdt: 0n },
    resolvedAtTimestamp: 1700000000n,
    ...overrides,
  } as any;
}

// ─── getSecurityPosture ──────────────────────────────────────────────────────

describe("getSecurityPosture", () => {
  it("passes all checks for well-configured vault", () => {
    const state = mockSecurityState({ constraints: {} });
    const posture = getSecurityPosture(state);
    // 13 checks total, all should pass for well-configured vault
    expect(posture.checks).to.have.length(13);
    expect(posture.failCount).to.equal(0);
    expect(posture.criticalFailures).to.have.length(0);
  });

  it("fails no-full-perms check", () => {
    const state = mockSecurityState({
      vault: {
        agents: [
          {
            pubkey: "a1" as Address,
            permissions: FULL_PERMISSIONS,
            spendingLimitUsd: 0n,
            paused: false,
          },
        ],
        status: VaultStatus.Active,
        feeDestination: "fee" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
    });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "no-full-perms")!;
    expect(check.passed).to.equal(false);
    expect(check.severity).to.equal("critical");
    expect(check.remediation).to.not.be.null;
  });

  it("fails cap-configured when cap is zero", () => {
    const state = mockSecurityState({
      policy: { dailySpendingCapUsd: 0n },
    });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "cap-configured")!;
    expect(check.passed).to.equal(false);
  });

  it("warns about system program fee destination", () => {
    const state = mockSecurityState({
      vault: {
        agents: [{ pubkey: "a1" as Address, permissions: 1n, spendingLimitUsd: 500_000_000n, paused: false }],
        status: VaultStatus.Active,
        feeDestination: "11111111111111111111111111111111" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
    });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "fee-destination-valid")!;
    expect(check.passed).to.equal(false);
    expect(check.severity).to.equal("critical");
  });

  it("provides remediation for failed checks", () => {
    const state = mockSecurityState({
      policy: { timelockDuration: 0n },
    });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "timelock-enabled")!;
    expect(check.passed).to.equal(false);
    expect(check.remediation).to.be.a("string");
    expect(check.remediation!.length).to.be.greaterThan(0);
  });
});

// ─── evaluateAlertConditions ─────────────────────────────────────────────────

describe("evaluateAlertConditions", () => {
  it("returns cap warning at 80%+", () => {
    const state = mockSecurityState({
      globalBudget: { spent24h: 850_000_000n, cap: 1_000_000_000n, remaining: 150_000_000n },
    });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("cap-warning"))).to.equal(true);
  });

  it("returns cap critical at 95%+", () => {
    const state = mockSecurityState({
      globalBudget: { spent24h: 960_000_000n, cap: 1_000_000_000n, remaining: 40_000_000n },
    });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.severity === "critical" && a.id.includes("cap-critical"))).to.equal(true);
  });

  it("returns frozen alert", () => {
    const state = mockSecurityState({
      vault: {
        agents: [],
        status: VaultStatus.Frozen,
        feeDestination: "f" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
    });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("frozen"))).to.equal(true);
  });

  it("returns no-agents warning for empty active vault", () => {
    const state = mockSecurityState({
      vault: {
        agents: [],
        status: VaultStatus.Active,
        feeDestination: "f" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
    });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("no-agents"))).to.equal(true);
  });

  it("sorts critical before warning before info", () => {
    const state = mockSecurityState({
      vault: {
        agents: [{ pubkey: "a1" as Address, permissions: 1n, spendingLimitUsd: 0n, paused: true }],
        status: VaultStatus.Frozen,
        feeDestination: "f" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
      globalBudget: { spent24h: 960_000_000n, cap: 1_000_000_000n, remaining: 40_000_000n },
    });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.length).to.be.greaterThan(1);
    expect(alerts[0].severity).to.equal("critical");
  });

  it("returns no alerts for healthy vault at low utilization", () => {
    const state = mockSecurityState();
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts).to.have.length(0);
  });

  it("returns per-agent cap warning at 80%+", () => {
    const agentBudgets = new Map<Address, any>();
    agentBudgets.set("agentHigh" as Address, {
      spent24h: 450_000_000n,
      cap: 500_000_000n,
      remaining: 50_000_000n,
    });
    const state = mockSecurityState({ allAgentBudgets: agentBudgets });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("agent-cap"))).to.equal(true);
  });

  it("returns all-agents-paused warning", () => {
    const state = mockSecurityState({
      vault: {
        agents: [
          { pubkey: "a1" as Address, permissions: 1n, spendingLimitUsd: 100n, paused: true },
          { pubkey: "a2" as Address, permissions: 1n, spendingLimitUsd: 100n, paused: true },
        ],
        status: VaultStatus.Active,
        feeDestination: "f" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
    });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("all-paused"))).to.equal(true);
  });

  it("detects high velocity (>2x average) via tracker data", () => {
    // Build a tracker where recent 3 epochs have 10x the average
    const buckets = Array.from({ length: 144 }, () => ({ epochId: 0n, usdAmount: 0n }));
    const now = 1700000000n;
    const epochDuration = 600n;
    const currentEpoch = now / epochDuration;

    // Baseline: 10 epochs at 10 USDC each
    for (let i = 10; i < 20; i++) {
      const eid = currentEpoch - BigInt(i);
      buckets[Number(eid % 144n)] = { epochId: eid, usdAmount: 10_000_000n };
    }
    // Recent: 3 epochs at 200 USDC each (20x average)
    for (let i = 0; i < 3; i++) {
      const eid = currentEpoch - BigInt(i);
      buckets[Number(eid % 144n)] = { epochId: eid, usdAmount: 200_000_000n };
    }

    const tracker = {
      buckets,
      lastWriteEpoch: currentEpoch,
    } as any;

    const state = mockSecurityState({
      tracker,
      globalBudget: { spent24h: 700_000_000n, cap: 2_000_000_000n, remaining: 1_300_000_000n },
    });

    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("high-velocity"))).to.equal(true);
  });

  it("detects potential drain (rate > 50% of cap per hour)", () => {
    const buckets = Array.from({ length: 144 }, () => ({ epochId: 0n, usdAmount: 0n }));
    const now = 1700000000n;
    const epochDuration = 600n;
    const currentEpoch = now / epochDuration;

    // 3 recent epochs at 500 USDC each → rate = 500*6/3 = 1000 USDC/hr
    // Cap = 1000 USDC → rate > cap/2 → drain alert
    for (let i = 0; i < 3; i++) {
      const eid = currentEpoch - BigInt(i);
      buckets[Number(eid % 144n)] = { epochId: eid, usdAmount: 500_000_000n };
    }

    const tracker = { buckets, lastWriteEpoch: currentEpoch } as any;

    const state = mockSecurityState({
      tracker,
      globalBudget: { spent24h: 1_500_000_000n, cap: 2_000_000_000n, remaining: 500_000_000n },
    });

    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("drain-detected"))).to.equal(true);
  });
});
