/**
 * Tests for security-analytics.ts — posture checklist and alert conditions.
 */

import { expect } from "chai";
import {
  getSecurityPosture,
  evaluateAlertConditions,
  getAuditTrail,
  getAuditTrailSummary,
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
  it("has exactly 20 checks and each one passes for well-configured vault", () => {
    const state = mockSecurityState({ constraints: {} });
    const posture = getSecurityPosture(state);
    expect(posture.checks).to.have.length(20);
    // Verify each critical/warning check individually (not just summary)
    const ids = posture.checks.map((c) => c.id);
    expect(ids).to.include("no-full-perms");
    expect(ids).to.include("cap-configured");
    expect(ids).to.include("fee-destination-valid");
    expect(ids).to.include("timelock-meaningful");
    expect(ids).to.include("fee-rate-reasonable");
    expect(ids).to.include("no-permission-concentration");
    expect(ids).to.include("mode-all-unguarded");
    // Every single check should pass — assert individually to prevent cancellation trap
    for (const check of posture.checks) {
      expect(
        check.passed,
        `check "${check.id}" should pass but failed: ${check.detail}`,
      ).to.equal(true);
    }
  });

  it("fails no-full-perms check", () => {
    const state = mockSecurityState({
      vault: {
        agents: [
          {
            pubkey: "a1" as Address,
            capability: Number(FULL_PERMISSIONS),
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
        agents: [
          {
            pubkey: "a1" as Address,
            permissions: 1n,
            spendingLimitUsd: 500_000_000n,
            paused: false,
          },
        ],
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
      globalBudget: {
        spent24h: 850_000_000n,
        cap: 1_000_000_000n,
        remaining: 150_000_000n,
      },
    });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("cap-warning"))).to.equal(true);
  });

  it("returns cap critical at 95%+", () => {
    const state = mockSecurityState({
      globalBudget: {
        spent24h: 960_000_000n,
        cap: 1_000_000_000n,
        remaining: 40_000_000n,
      },
    });
    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(
      alerts.some(
        (a) => a.severity === "critical" && a.id.includes("cap-critical"),
      ),
    ).to.equal(true);
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
        agents: [
          {
            pubkey: "a1" as Address,
            permissions: 1n,
            spendingLimitUsd: 0n,
            paused: true,
          },
        ],
        status: VaultStatus.Frozen,
        feeDestination: "f" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
      globalBudget: {
        spent24h: 960_000_000n,
        cap: 1_000_000_000n,
        remaining: 40_000_000n,
      },
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
          {
            pubkey: "a1" as Address,
            permissions: 1n,
            spendingLimitUsd: 100n,
            paused: true,
          },
          {
            pubkey: "a2" as Address,
            permissions: 1n,
            spendingLimitUsd: 100n,
            paused: true,
          },
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
    const buckets = Array.from({ length: 144 }, () => ({
      epochId: 0n,
      usdAmount: 0n,
    }));
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
      globalBudget: {
        spent24h: 700_000_000n,
        cap: 2_000_000_000n,
        remaining: 1_300_000_000n,
      },
    });

    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("high-velocity"))).to.equal(true);
  });

  it("detects potential drain (rate > 50% of cap per hour)", () => {
    const buckets = Array.from({ length: 144 }, () => ({
      epochId: 0n,
      usdAmount: 0n,
    }));
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
      globalBudget: {
        spent24h: 1_500_000_000n,
        cap: 2_000_000_000n,
        remaining: 500_000_000n,
      },
    });

    const alerts = evaluateAlertConditions(state, "vault1" as Address);
    expect(alerts.some((a) => a.id.includes("drain-detected"))).to.equal(true);
  });
});

// ─── Step 8 checks ──────────────────────────────────────────────────────────

describe("Step 8 security checks", () => {
  it("fails timelock-meaningful for short timelock", () => {
    const state = mockSecurityState({ policy: { timelockDuration: 60n } });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "timelock-meaningful");
    expect(check).to.exist;
    expect(check!.passed).to.equal(false);
  });

  it("fails timelock-meaningful at exactly 3599n (1 second below threshold)", () => {
    const state = mockSecurityState({ policy: { timelockDuration: 3599n } });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "timelock-meaningful");
    expect(check!.passed).to.equal(false);
  });

  it("passes timelock-meaningful at exactly 3600n (boundary)", () => {
    const state = mockSecurityState({ policy: { timelockDuration: 3600n } });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "timelock-meaningful");
    expect(check!.passed).to.equal(true);
  });

  it("passes timelock-meaningful for disabled (0) timelock", () => {
    const state = mockSecurityState({ policy: { timelockDuration: 0n } });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "timelock-meaningful");
    expect(check!.passed).to.equal(true);
  });

  it("passes fee-rate-reasonable for valid fee rate", () => {
    const state = mockSecurityState({ policy: { developerFeeRate: 100 } });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "fee-rate-reasonable");
    expect(check!.passed).to.equal(true);
  });

  it("passes no-permission-concentration with Observer capability", () => {
    // Observer (1) is not full capability — should PASS
    const state = mockSecurityState({
      vault: {
        agents: [
          {
            pubkey: "a1" as Address,
            capability: 1n,
            spendingLimitUsd: 500_000_000n,
            paused: false,
          },
        ],
        status: 0,
        feeDestination: "fee" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
    });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find(
      (c) => c.id === "no-permission-concentration",
    );
    expect(check!.passed).to.equal(true);
  });

  it("fails no-permission-concentration with Operator capability", () => {
    // Operator (2) = FULL_CAPABILITY — should FAIL (full access)
    const state = mockSecurityState({
      vault: {
        agents: [
          {
            pubkey: "a1" as Address,
            capability: 2n,
            spendingLimitUsd: 500_000_000n,
            paused: false,
          },
        ],
        status: 0,
        feeDestination: "fee" as Address,
        openPositions: 0,
        activeEscrowCount: 0,
      },
    });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find(
      (c) => c.id === "no-permission-concentration",
    );
    expect(check!.passed).to.equal(false);
  });

  it("fails mode-all-unguarded for protocol mode ALL without strict constraints", () => {
    const state = mockSecurityState({
      policy: { protocolMode: 0 },
      constraints: null,
    });
    const posture = getSecurityPosture(state);
    const check = posture.checks.find((c) => c.id === "mode-all-unguarded");
    expect(check!.passed).to.equal(false);
    expect(check!.severity).to.equal("critical");
  });
});

// ─── getAuditTrail ───────────────────────────────────────────────────────────

describe("getAuditTrail", () => {
  const mockEvents = [
    {
      name: "PolicyUpdated",
      data: new Uint8Array(),
      fields: { owner: "owner1", timestamp: 1000n },
    },
    {
      name: "AgentRegistered",
      data: new Uint8Array(),
      fields: { owner: "owner1", agent: "agent1", timestamp: 2000n },
    },
    {
      name: "VaultFrozen",
      data: new Uint8Array(),
      fields: { owner: "owner1", timestamp: 3000n },
    },
    { name: "SessionFinalized", data: new Uint8Array(), fields: {} }, // Not in AUDIT_EVENTS — should be filtered out
  ] as any[];

  it("filters to audit-relevant events only", () => {
    const trail = getAuditTrail(mockEvents);
    expect(trail).to.have.length(3);
    expect(trail.every((e) => e.action !== "SessionFinalized")).to.equal(true);
  });

  it("filters by category", () => {
    const trail = getAuditTrail(mockEvents, { categories: ["emergency"] });
    expect(trail).to.have.length(1);
    expect(trail[0].action).to.equal("VaultFrozen");
  });

  it("filters by since timestamp", () => {
    const trail = getAuditTrail(mockEvents, { since: 2500 });
    expect(trail).to.have.length(1);
    expect(trail[0].action).to.equal("VaultFrozen");
  });

  it("filters by actor", () => {
    // Actor fallback: owner ?? agent ?? ... — "owner1" takes precedence over "agent1"
    const trail = getAuditTrail(mockEvents, { actor: "owner1" as Address });
    expect(trail).to.have.length(3); // All 3 events have owner: "owner1"
  });
});

// ─── getAuditTrailSummary ────────────────────────────────────────────────────

describe("getAuditTrailSummary", () => {
  it("returns per-category counts", () => {
    const trail = getAuditTrail([
      {
        name: "PolicyUpdated",
        data: new Uint8Array(),
        fields: { owner: "o1", timestamp: 1n },
      },
      {
        name: "VaultFrozen",
        data: new Uint8Array(),
        fields: { owner: "o1", timestamp: 2n },
      },
      {
        name: "VaultClosed",
        data: new Uint8Array(),
        fields: { owner: "o1", timestamp: 3n },
      },
    ] as any[]);
    const summary = getAuditTrailSummary(trail);
    expect(summary.totalEntries).to.equal(3);
    expect(summary.byCategory.policy_change).to.equal(1);
    expect(summary.byCategory.emergency).to.equal(2);
    expect(summary.latestTimestamp).to.equal(3);
  });
});
