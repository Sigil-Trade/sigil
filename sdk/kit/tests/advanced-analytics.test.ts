/**
 * Tests for advanced-analytics.ts — institutional metrics.
 */

import { expect } from "chai";
import {
  getSlippageEfficiency,
  getCapVelocity,
  getSessionDeviationRate,
  getIdleCapitalDuration,
  getPermissionEscalationLatency,
  getInstructionCoverageRatio,
} from "../src/advanced-analytics.js";
import type { DecodedSigilEvent } from "../src/events.js";

// ─── getSlippageEfficiency ───────────────────────────────────────────────────

describe("getSlippageEfficiency", () => {
  it("computes slippage from auth/finalize pairs", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1", usdAmount: 100_000_000n },
      },
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1", actualSpendUsd: 102_000_000n, success: true },
      },
    ];
    const report = getSlippageEfficiency(events);
    expect(report.byAgent).to.have.length(1);
    expect(report.byAgent[0].avgSlippageBps).to.equal(200);
    expect(report.byAgent[0].estimatedWasteUsd).to.equal(2_000_000n);
  });

  it("returns empty for no trade events", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "FundsDeposited",
        data: new Uint8Array(0),
        fields: { amount: 100n },
      },
    ];
    expect(getSlippageEfficiency(events).byAgent).to.have.length(0);
  });

  it("handles zero authorized amount", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1", usdAmount: 0n },
      },
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1", actualSpendUsd: 50_000_000n, success: true },
      },
    ];
    const report = getSlippageEfficiency(events);
    expect(report.byAgent[0].avgSlippageBps).to.equal(0);
  });
});

// ─── getCapVelocity ──────────────────────────────────────────────────────────

describe("getCapVelocity", () => {
  it("classifies low risk for fresh vault", () => {
    const budget = {
      spent24h: 100_000_000n,
      cap: 1_000_000_000n,
      remaining: 900_000_000n,
    };
    const result = getCapVelocity(null, 1700000000n, budget);
    expect(result.riskLevel).to.equal("low");
  });

  it("classifies critical when >95% used", () => {
    const budget = {
      spent24h: 960_000_000n,
      cap: 1_000_000_000n,
      remaining: 40_000_000n,
    };
    const result = getCapVelocity(null, 1700000000n, budget);
    expect(result.riskLevel).to.equal("critical");
  });

  it("classifies moderate when >50% used", () => {
    const budget = {
      spent24h: 600_000_000n,
      cap: 1_000_000_000n,
      remaining: 400_000_000n,
    };
    const result = getCapVelocity(null, 1700000000n, budget);
    expect(result.riskLevel).to.equal("moderate");
  });
});

// ─── getSessionDeviationRate ─────────────────────────────────────────────────

describe("getSessionDeviationRate", () => {
  it("detects deviations above 2% threshold", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1", usdAmount: 100_000_000n },
      },
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1", actualSpendUsd: 105_000_000n, success: true },
      },
    ];
    const report = getSessionDeviationRate(events);
    expect(report.deviatedSessions).to.equal(1);
    expect(report.deviationRate).to.equal(100);
    expect(report.maxDeviationBps).to.equal(500);
  });

  it("ignores normal slippage (<2%)", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1", usdAmount: 100_000_000n },
      },
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1", actualSpendUsd: 101_000_000n, success: true },
      },
    ];
    const report = getSessionDeviationRate(events);
    expect(report.deviatedSessions).to.equal(0);
  });

  it("returns zero for no events", () => {
    const report = getSessionDeviationRate([]);
    expect(report.totalSessions).to.equal(0);
    expect(report.deviationRate).to.equal(0);
  });
});

// ─── getIdleCapitalDuration ──────────────────────────────────────────────────

describe("getIdleCapitalDuration", () => {
  it("computes idle time between trades", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1", timestamp: 1700000000n },
      },
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1", timestamp: 1700003600n },
      }, // 1h later
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1", timestamp: 1700010800n },
      }, // 2h later
    ];
    const report = getIdleCapitalDuration(events, 1700014400); // 1h after last
    expect(report.avgIdleHours).to.be.greaterThan(0);
    expect(report.maxIdleHours).to.equal(2);
    expect(report.idleSinceHours).to.equal(1);
  });

  it("returns zero for no events", () => {
    const report = getIdleCapitalDuration([], 1700000000);
    expect(report.avgIdleHours).to.equal(0);
    expect(report.lastActivityTimestamp).to.equal(0);
  });
});

// ─── getPermissionEscalationLatency ──────────────────────────────────────────

describe("getPermissionEscalationLatency", () => {
  it("detects suspicious rapid permission use", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "AgentPermissionsUpdated",
        data: new Uint8Array(0),
        fields: {
          agent: "a1",
          timestamp: 1700000000n,
          newPermissions: 1n,
          oldPermissions: 0n,
        },
      },
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1", timestamp: 1700000030n },
      }, // 30s later
    ];
    const report = getPermissionEscalationLatency(events);
    expect(report.escalations).to.have.length(1);
    expect(report.escalations[0].latencySeconds).to.equal(30);
    expect(report.escalations[0].suspicious).to.equal(true);
  });

  it("normal latency is not suspicious", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "AgentPermissionsUpdated",
        data: new Uint8Array(0),
        fields: {
          agent: "a1",
          timestamp: 1700000000n,
          newPermissions: 1n,
          oldPermissions: 0n,
        },
      },
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1", timestamp: 1700003600n },
      }, // 1h later
    ];
    const report = getPermissionEscalationLatency(events);
    expect(report.escalations[0].suspicious).to.equal(false);
  });

  it("handles no subsequent use", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "AgentPermissionsUpdated",
        data: new Uint8Array(0),
        fields: {
          agent: "a1",
          timestamp: 1700000000n,
          newPermissions: 1n,
          oldPermissions: 0n,
        },
      },
    ];
    const report = getPermissionEscalationLatency(events);
    expect(report.escalations[0].firstUseTimestamp).to.be.null;
    expect(report.escalations[0].suspicious).to.equal(false);
  });
});

// ─── getInstructionCoverageRatio ─────────────────────────────────────────────

describe("getInstructionCoverageRatio", () => {
  it("reports 100% coverage for matched pairs", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1" },
      },
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1" },
      },
    ];
    const report = getInstructionCoverageRatio(events);
    expect(report.totalComposed).to.equal(1);
    expect(report.orphanedValidates).to.equal(0);
    expect(report.coverageRate).to.equal(100);
  });

  it("detects orphaned validates", () => {
    const events: DecodedSigilEvent[] = [
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1" },
      },
      {
        name: "ActionAuthorized",
        data: new Uint8Array(0),
        fields: { agent: "a1" },
      },
      {
        name: "SessionFinalized",
        data: new Uint8Array(0),
        fields: { agent: "a1" },
      },
    ];
    const report = getInstructionCoverageRatio(events);
    expect(report.totalComposed).to.equal(1);
    expect(report.orphanedValidates).to.equal(1);
    expect(report.coverageRate).to.equal(50);
  });

  it("returns 100% for empty events", () => {
    const report = getInstructionCoverageRatio([]);
    expect(report.coverageRate).to.equal(100);
  });
});
