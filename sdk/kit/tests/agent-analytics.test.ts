/**
 * Tests for agent-analytics.ts — profiles, leaderboards, concentration.
 */

import { expect } from "chai";
import {
  getAgentProfile,
  getAgentLeaderboard,
  getAgentComparison,
} from "../src/agent-analytics.js";
import { FULL_PERMISSIONS } from "../src/types.js";
import type { Address } from "@solana/kit";

function mockStateWithAgents(
  agents: Array<{
    pubkey: string;
    spend: bigint;
    limit: bigint;
    perms: bigint;
    paused?: boolean;
  }>,
) {
  const allAgentBudgets = new Map<Address, any>();
  const vaultAgents = agents.map((a) => {
    allAgentBudgets.set(a.pubkey as Address, {
      spent24h: a.spend,
      cap: a.limit,
      remaining: a.limit > a.spend ? a.limit - a.spend : 0n,
    });
    return {
      pubkey: a.pubkey as Address,
      permissions: a.perms,
      spendingLimitUsd: a.limit,
      paused: a.paused ?? false,
    };
  });

  return {
    vault: { agents: vaultAgents },
    overlay: null,
    allAgentBudgets,
  } as any;
}

// ─── getAgentProfile ─────────────────────────────────────────────────────────

describe("getAgentProfile", () => {
  it("returns profile for registered agent", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 200_000_000n, limit: 500_000_000n, perms: 1n },
    ]);
    const profile = getAgentProfile(state, "agent1" as Address);
    expect(profile).to.not.be.null;
    expect(profile!.capUtilization).to.equal(40);
    expect(profile!.isApproachingCap).to.equal(false);
    expect(profile!.hasFullPermissions).to.equal(false);
  });

  it("returns null for unregistered agent", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 0n, limit: 0n, perms: 1n },
    ]);
    expect(getAgentProfile(state, "agent999" as Address)).to.be.null;
  });

  it("detects FULL_PERMISSIONS", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 0n, limit: 0n, perms: FULL_PERMISSIONS },
    ]);
    const profile = getAgentProfile(state, "agent1" as Address);
    expect(profile!.hasFullPermissions).to.equal(true);
    expect(profile!.permissionCount).to.equal(21);
  });

  it("detects approaching cap (>80%)", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 450_000_000n, limit: 500_000_000n, perms: 1n },
    ]);
    const profile = getAgentProfile(state, "agent1" as Address);
    expect(profile!.capUtilization).to.equal(90);
    expect(profile!.isApproachingCap).to.equal(true);
  });

  it("handles paused agent", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 0n, limit: 100n, perms: 1n, paused: true },
    ]);
    const profile = getAgentProfile(state, "agent1" as Address);
    expect(profile!.paused).to.equal(true);
  });
});

// ─── getAgentLeaderboard ─────────────────────────────────────────────────────

describe("getAgentLeaderboard", () => {
  it("ranks agents by spend descending", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 100_000_000n, limit: 500_000_000n, perms: 1n },
      { pubkey: "agent2", spend: 300_000_000n, limit: 500_000_000n, perms: 1n },
      { pubkey: "agent3", spend: 200_000_000n, limit: 500_000_000n, perms: 1n },
    ]);

    const leaderboard = getAgentLeaderboard(state);
    expect(leaderboard[0].address).to.equal("agent2");
    expect(leaderboard[0].rank).to.equal(1);
    expect(leaderboard[1].address).to.equal("agent3");
    expect(leaderboard[1].rank).to.equal(2);
    expect(leaderboard[2].address).to.equal("agent1");
    expect(leaderboard[2].rank).to.equal(3);
  });

  it("handles empty agents", () => {
    const state = mockStateWithAgents([]);
    expect(getAgentLeaderboard(state)).to.deep.equal([]);
  });

  it("handles single agent", () => {
    const state = mockStateWithAgents([
      { pubkey: "solo", spend: 50_000_000n, limit: 100_000_000n, perms: 1n },
    ]);
    const lb = getAgentLeaderboard(state);
    expect(lb).to.have.length(1);
    expect(lb[0].rank).to.equal(1);
  });
});

// ─── getAgentComparison ──────────────────────────────────────────────────────

describe("getAgentComparison", () => {
  it("computes concentration index for equal agents (H=0.5)", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 100_000_000n, limit: 500_000_000n, perms: 1n },
      { pubkey: "agent2", spend: 100_000_000n, limit: 500_000_000n, perms: 1n },
    ]);

    const comparison = getAgentComparison(state);
    expect(comparison.spendConcentration).to.be.closeTo(0.5, 0.01);
    expect(comparison.totalAgentSpend24h).to.equal(200_000_000n);
  });

  it("returns H=1.0 for single dominant agent", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 500_000_000n, limit: 500_000_000n, perms: 1n },
      { pubkey: "agent2", spend: 0n, limit: 500_000_000n, perms: 1n },
    ]);

    const comparison = getAgentComparison(state);
    expect(comparison.spendConcentration).to.be.closeTo(1.0, 0.01);
    expect(comparison.mostActiveAgent).to.equal("agent1");
  });

  it("handles zero total spend", () => {
    const state = mockStateWithAgents([
      { pubkey: "agent1", spend: 0n, limit: 500_000_000n, perms: 1n },
    ]);

    const comparison = getAgentComparison(state);
    expect(comparison.spendConcentration).to.equal(0);
    expect(comparison.mostActiveAgent).to.be.null;
    expect(comparison.leastActiveAgent).to.be.null;
  });

  it("identifies most and least active correctly", () => {
    const state = mockStateWithAgents([
      { pubkey: "big", spend: 300_000_000n, limit: 500_000_000n, perms: 1n },
      { pubkey: "med", spend: 100_000_000n, limit: 500_000_000n, perms: 1n },
      { pubkey: "small", spend: 10_000_000n, limit: 500_000_000n, perms: 1n },
    ]);

    const comparison = getAgentComparison(state);
    expect(comparison.mostActiveAgent).to.equal("big");
    expect(comparison.leastActiveAgent).to.equal("small");
  });
});
