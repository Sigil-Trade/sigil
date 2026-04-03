/**
 * Tests for spending-analytics.ts — velocity, breakdown, agent history.
 */

import { expect } from "chai";
import {
  getSpendingVelocity,
  getSpendingBreakdown,
  getAgentSpendingHistory,
  getSpendingHistory,
} from "../src/spending-analytics.js";
import type { SpendTracker, EpochBucket } from "../src/generated/index.js";
import type {
  AgentSpendOverlay,
  AgentContributionEntry,
} from "../src/generated/index.js";
import type { Address } from "@solana/kit";

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function mockTracker(
  entries: Array<{ epochId: bigint; usdAmount: bigint }>,
): SpendTracker {
  const buckets: EpochBucket[] = Array.from({ length: 144 }, () => ({
    epochId: 0n,
    usdAmount: 0n,
  }));

  for (const entry of entries) {
    const idx = Number(entry.epochId % 144n);
    buckets[idx] = { epochId: entry.epochId, usdAmount: entry.usdAmount };
  }

  return {
    discriminator: new Uint8Array(8),
    vault: new Uint8Array(32),
    buckets,
    protocolCounters: [],
    lastWriteEpoch:
      entries.length > 0 ? entries[entries.length - 1].epochId : 0n,
    bump: 0,
    padding: new Uint8Array(7),
  } as unknown as SpendTracker;
}

// ─── getSpendingHistory (re-exported from state-resolver) ────────────────────

describe("getSpendingHistory (via spending-analytics)", () => {
  it("returns empty for null tracker", () => {
    expect(getSpendingHistory(null, 1000000n)).to.deep.equal([]);
  });

  it("returns empty for zero timestamp", () => {
    const tracker = mockTracker([{ epochId: 100n, usdAmount: 500_000_000n }]);
    expect(getSpendingHistory(tracker, 0n)).to.deep.equal([]);
  });

  it("returns chronologically sorted epochs within window", () => {
    const now = 1700000000n;
    const currentEpoch = now / 600n;

    const tracker = mockTracker([
      { epochId: currentEpoch - 2n, usdAmount: 100_000_000n },
      { epochId: currentEpoch - 1n, usdAmount: 200_000_000n },
      { epochId: currentEpoch, usdAmount: 300_000_000n },
    ]);

    const result = getSpendingHistory(tracker, now);
    expect(result).to.have.length(3);
    expect(result[0].timestamp).to.be.lessThan(result[1].timestamp);
    expect(result[1].timestamp).to.be.lessThan(result[2].timestamp);
    expect(result[0].usdAmount).to.equal(100_000_000n);
    expect(result[2].usdAmount).to.equal(300_000_000n);
  });

  it("excludes stale epochs outside 24h window", () => {
    const now = 1700000000n;
    const currentEpoch = now / 600n;
    const staleEpoch = currentEpoch - 200n; // > 144 epochs ago

    const tracker = mockTracker([
      { epochId: staleEpoch, usdAmount: 999_000_000n },
      { epochId: currentEpoch, usdAmount: 100_000_000n },
    ]);

    const result = getSpendingHistory(tracker, now);
    expect(result).to.have.length(1);
    expect(result[0].usdAmount).to.equal(100_000_000n);
  });
});

// ─── getSpendingVelocity ─────────────────────────────────────────────────────

describe("getSpendingVelocity", () => {
  it("returns zero velocity for null tracker", () => {
    const budget = { spent24h: 0n, cap: 500_000_000n, remaining: 500_000_000n };
    const result = getSpendingVelocity(null, 1700000000n, budget);
    expect(result.currentRate).to.equal(0n);
    expect(result.isAccelerating).to.equal(false);
    expect(result.timeToCapSeconds).to.be.null;
  });

  it("detects acceleration when recent rate exceeds 1.5x average", () => {
    const now = 1700000000n;
    const currentEpoch = now / 600n;

    // Most epochs: 10 USDC each. Last 3: 100 USDC each.
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        epochId: currentEpoch - BigInt(i + 3),
        usdAmount: 10_000_000n,
      });
    }
    for (let i = 0; i < 3; i++) {
      entries.push({
        epochId: currentEpoch - BigInt(i),
        usdAmount: 100_000_000n,
      });
    }

    const tracker = mockTracker(entries);
    const budget = {
      spent24h: 400_000_000n,
      cap: 1_000_000_000n,
      remaining: 600_000_000n,
    };

    const result = getSpendingVelocity(tracker, now, budget);
    expect(result.isAccelerating).to.equal(true);
    expect(result.timeToCapSeconds).to.not.be.null;
  });

  it("projects cap hit time correctly", () => {
    const now = 1700000000n;
    const currentEpoch = now / 600n;

    // 3 recent epochs spending 100 USDC each (300 USDC in 30 min = 600/hr)
    const tracker = mockTracker([
      { epochId: currentEpoch - 2n, usdAmount: 100_000_000n },
      { epochId: currentEpoch - 1n, usdAmount: 100_000_000n },
      { epochId: currentEpoch, usdAmount: 100_000_000n },
    ]);
    const budget = {
      spent24h: 300_000_000n,
      cap: 1_000_000_000n,
      remaining: 700_000_000n,
    };

    const result = getSpendingVelocity(tracker, now, budget);
    expect(result.timeToCapSeconds).to.not.be.null;
    // 700 remaining / 600/hr ≈ 1.17 hours ≈ 4200 seconds
    expect(result.timeToCapSeconds!).to.be.greaterThan(3000);
    expect(result.timeToCapSeconds!).to.be.lessThan(6000);
  });

  it("finds peak rate correctly", () => {
    const now = 1700000000n;
    const currentEpoch = now / 600n;

    const tracker = mockTracker([
      { epochId: currentEpoch - 2n, usdAmount: 50_000_000n },
      { epochId: currentEpoch - 1n, usdAmount: 500_000_000n }, // peak
      { epochId: currentEpoch, usdAmount: 100_000_000n },
    ]);
    const budget = {
      spent24h: 650_000_000n,
      cap: 1_000_000_000n,
      remaining: 350_000_000n,
    };

    const result = getSpendingVelocity(tracker, now, budget);
    expect(result.peakRate).to.equal(500_000_000n);
  });
});

// ─── getSpendingBreakdown ────────────────────────────────────────────────────

describe("getSpendingBreakdown", () => {
  it("computes correct global utilization", () => {
    const state = {
      globalBudget: {
        spent24h: 400_000_000n,
        cap: 1_000_000_000n,
        remaining: 600_000_000n,
      },
      allAgentBudgets: new Map(),
      protocolBudgets: [],
      overlay: null,
      vault: { agents: [] },
    } as unknown as any;

    const result = getSpendingBreakdown(state);
    expect(result.global.utilization).to.equal(40);
  });

  it("computes Herfindahl for equal agents (H=0.5)", () => {
    const state = {
      globalBudget: {
        spent24h: 200_000_000n,
        cap: 1_000_000_000n,
        remaining: 800_000_000n,
      },
      allAgentBudgets: new Map([
        [
          "agent1" as Address,
          {
            spent24h: 100_000_000n,
            cap: 500_000_000n,
            remaining: 400_000_000n,
          },
        ],
        [
          "agent2" as Address,
          {
            spent24h: 100_000_000n,
            cap: 500_000_000n,
            remaining: 400_000_000n,
          },
        ],
      ]),
      protocolBudgets: [],
      overlay: null,
      vault: { agents: [] },
    } as unknown as any;

    const result = getSpendingBreakdown(state);
    // Two agents with equal spend: H = 0.25 + 0.25 = 0.5
    expect(result.agentConcentration).to.be.closeTo(0.5, 0.01);
  });

  it("returns H=1.0 when single agent dominates", () => {
    const state = {
      globalBudget: {
        spent24h: 100_000_000n,
        cap: 1_000_000_000n,
        remaining: 900_000_000n,
      },
      allAgentBudgets: new Map([
        [
          "agent1" as Address,
          {
            spent24h: 100_000_000n,
            cap: 500_000_000n,
            remaining: 400_000_000n,
          },
        ],
        [
          "agent2" as Address,
          { spent24h: 0n, cap: 500_000_000n, remaining: 500_000_000n },
        ],
      ]),
      protocolBudgets: [],
      overlay: null,
      vault: { agents: [] },
    } as unknown as any;

    const result = getSpendingBreakdown(state);
    expect(result.agentConcentration).to.be.closeTo(1.0, 0.01);
    expect(result.topAgent).to.equal("agent1");
  });

  it("handles zero cap without division error", () => {
    const state = {
      globalBudget: { spent24h: 0n, cap: 0n, remaining: 0n },
      allAgentBudgets: new Map(),
      protocolBudgets: [],
      overlay: null,
      vault: { agents: [] },
    } as unknown as any;

    const result = getSpendingBreakdown(state);
    expect(result.global.utilization).to.equal(0);
  });
});

// ─── getAgentSpendingHistory ─────────────────────────────────────────────────

describe("getAgentSpendingHistory", () => {
  it("returns empty for null overlay", () => {
    expect(getAgentSpendingHistory(null, 0, 1700000000n)).to.deep.equal([]);
  });

  it("returns empty for out-of-range slot", () => {
    const overlay = {
      entries: [],
      lifetimeSpend: [],
    } as unknown as AgentSpendOverlay;
    expect(getAgentSpendingHistory(overlay, 15, 1700000000n)).to.deep.equal([]);
  });

  it("returns empty for zero timestamp", () => {
    const overlay = {
      entries: [],
      lifetimeSpend: [],
    } as unknown as AgentSpendOverlay;
    expect(getAgentSpendingHistory(overlay, 0, 0n)).to.deep.equal([]);
  });

  it("returns chronologically sorted agent epochs", () => {
    const now = 1700000000n;
    const epochDuration = 3600n; // OVERLAY_EPOCH_DURATION = 3600
    const currentEpoch = now / epochDuration;

    const contributions = Array.from({ length: 24 }, () => 0n);
    // Write 3 contributions at recent epochs
    contributions[Number((currentEpoch - 2n) % 24n)] = 50_000_000n;
    contributions[Number((currentEpoch - 1n) % 24n)] = 75_000_000n;
    contributions[Number(currentEpoch % 24n)] = 100_000_000n;

    const entry: AgentContributionEntry = {
      agent: new Uint8Array(32),
      lastWriteEpoch: currentEpoch,
      contributions,
    } as unknown as AgentContributionEntry;

    const overlay = {
      entries: [entry],
      lifetimeSpend: [225_000_000n],
    } as unknown as AgentSpendOverlay;

    const result = getAgentSpendingHistory(overlay, 0, now);
    expect(result.length).to.be.greaterThan(0);
    // Should be chronologically sorted
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp).to.be.greaterThan(result[i - 1].timestamp);
    }
  });
});
