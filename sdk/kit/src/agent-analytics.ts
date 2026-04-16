/**
 * Agent analytics — profiles, leaderboards, and concentration metrics.
 *
 * All functions are pure (no RPC) — they derive metrics from already-resolved
 * vault state. The dashboard Agents tab and Agent Detail page use these.
 */

import type { Address } from "./kit-adapter.js";
import type { DecodedSigilEvent } from "./events.js";
import type { ResolvedVaultState, EffectiveBudget } from "./state-resolver.js";
import { bytesToAddress, findAgentOverlaySlot } from "./state-resolver.js";
import { FULL_CAPABILITY } from "./types.js";
import { computeHerfindahl } from "./math-utils.js";
import { computeUtilizationPercent } from "./math-utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentProfile {
  address: Address;
  /** Agent capability: 0=Disabled, 1=Observer, 2=Operator */
  capability: number;
  capabilityLabel: string;
  spendingLimitUsd: bigint;
  paused: boolean;
  budget: EffectiveBudget;
  lifetimeSpend: bigint;
  /** Lifetime transaction count from overlay (0 if no overlay or slot not found) */
  lifetimeTxCount: bigint;
  /** Average transaction size: lifetimeSpend / lifetimeTxCount (0n if no transactions) */
  avgTransactionSize: bigint;
  /** 0-100 percentage of per-agent cap used */
  capUtilization: number;
  /** Whether agent is over 80% of its cap */
  isApproachingCap: boolean;
  /** Whether agent has full capability (Operator = 2) */
  hasFullCapability: boolean;
}

export interface AgentRanking {
  address: Address;
  /** 1-based rank (1 = highest spender) */
  rank: number;
  spend24h: bigint;
  lifetimeSpend: bigint;
  capUtilization: number;
  paused: boolean;
  capability: number;
}

export interface AgentComparisonData {
  agents: AgentRanking[];
  totalAgentSpend24h: bigint;
  /** Herfindahl-Hirschman Index (0-1). 1.0 = single agent dominates. */
  spendConcentration: number;
  mostActiveAgent: Address | null;
  leastActiveAgent: Address | null;
}

// ─── getAgentProfile ─────────────────────────────────────────────────────────

/**
 * Build a complete profile for a single agent within a vault.
 * Returns null if the agent is not registered.
 */
export function getAgentProfile(
  state: ResolvedVaultState,
  agentAddress: Address,
): AgentProfile | null {
  const { vault, overlay, allAgentBudgets } = state;

  const agentEntry = vault.agents.find((a) => a.pubkey === agentAddress);
  if (!agentEntry) return null;

  const budget = allAgentBudgets.get(agentAddress) ?? {
    spent24h: 0n,
    cap: 0n,
    remaining: 0n,
  };

  // PR 3.B F038: use extracted helper instead of inline overlay lookup
  const overlaySlot = findAgentOverlaySlot(overlay, agentAddress);
  const lifetimeSpend = overlaySlot?.lifetimeSpend ?? 0n;
  const lifetimeTxCount = overlaySlot?.lifetimeTxCount ?? 0n;

  const capUtilization = computeUtilizationPercent(budget.spent24h, budget.cap);

  return {
    address: agentAddress,
    capability: agentEntry.capability,
    capabilityLabel: capabilityToLabel(agentEntry.capability),
    spendingLimitUsd: agentEntry.spendingLimitUsd,
    paused: agentEntry.paused,
    budget,
    lifetimeSpend,
    lifetimeTxCount,
    avgTransactionSize:
      lifetimeTxCount > 0n ? lifetimeSpend / lifetimeTxCount : 0n,
    capUtilization,
    isApproachingCap: capUtilization > 80,
    hasFullCapability: agentEntry.capability === Number(FULL_CAPABILITY),
  };
}

// ─── getAgentLeaderboard ─────────────────────────────────────────────────────

/**
 * Rank all agents in a vault by 24h spending (descending).
 * Returns agents with 1-based rank numbers.
 */
export function getAgentLeaderboard(state: ResolvedVaultState): AgentRanking[] {
  const { vault, overlay, allAgentBudgets } = state;

  const rankings: AgentRanking[] = vault.agents.map((agentEntry) => {
    const budget = allAgentBudgets.get(agentEntry.pubkey) ?? {
      spent24h: 0n,
      cap: 0n,
      remaining: 0n,
    };

    let lifetimeSpend = 0n;
    if (overlay) {
      const slotIdx = overlay.entries.findIndex((e) => {
        try {
          return bytesToAddress(e.agent) === agentEntry.pubkey;
        } catch {
          return false;
        }
      });
      if (slotIdx >= 0 && slotIdx < overlay.lifetimeSpend.length) {
        lifetimeSpend = overlay.lifetimeSpend[slotIdx];
      }
    }

    const capUtilization = computeUtilizationPercent(
      budget.spent24h,
      budget.cap,
    );

    return {
      address: agentEntry.pubkey,
      rank: 0,
      spend24h: budget.spent24h,
      lifetimeSpend,
      capUtilization,
      paused: agentEntry.paused,
      capability: agentEntry.capability,
    };
  });

  rankings.sort((a, b) => {
    if (b.spend24h > a.spend24h) return 1;
    if (b.spend24h < a.spend24h) return -1;
    return 0;
  });

  rankings.forEach((r, i) => {
    r.rank = i + 1;
  });

  return rankings;
}

// ─── getAgentComparison ──────────────────────────────────────────────────────

/**
 * Cross-agent comparison with Herfindahl concentration analysis.
 */
export function getAgentComparison(
  state: ResolvedVaultState,
): AgentComparisonData {
  const rankings = getAgentLeaderboard(state);

  const totalSpend = rankings.reduce((sum, r) => sum + r.spend24h, 0n);

  const hhi = computeHerfindahl(rankings.map((r) => r.spend24h));

  const activeAgents = rankings.filter((r) => r.spend24h > 0n);
  const mostActive = activeAgents.length > 0 ? activeAgents[0].address : null;
  const leastActive =
    activeAgents.length > 0
      ? activeAgents[activeAgents.length - 1].address
      : null;

  return {
    agents: rankings,
    totalAgentSpend24h: totalSpend,
    spendConcentration: hhi,
    mostActiveAgent: mostActive,
    leastActiveAgent: leastActive,
  };
}

// ─── Internal ────────────────────────────────────────────────────────────────

/** Convert 2-bit capability to a human-readable label. */
function capabilityToLabel(capability: number): string {
  switch (capability) {
    case 0:
      return "Disabled";
    case 1:
      return "Observer";
    case 2:
      return "Operator";
    default:
      return `Unknown(${capability})`;
  }
}

// ─── getAgentErrorBreakdown ──────────────────────────────────────────────────

export interface AgentErrorBreakdown {
  agent: Address;
  totalSessions: number;
  failedSessions: number;
  expiredSessions: number;
  successfulSessions: number;
  /** 0-100 percentage */
  successRate: number;
}

/**
 * Categorize an agent's sessions by outcome (success/fail/expired).
 * Used for the Agent Detail page success rate metric.
 */
export function getAgentErrorBreakdown(
  events: DecodedSigilEvent[],
  agentAddress: Address,
): AgentErrorBreakdown {
  let total = 0;
  let failed = 0;
  let expired = 0;
  let successful = 0;

  for (const e of events) {
    if (e.name !== "SessionFinalized" || !e.fields) continue;
    if ((e.fields.agent as string) !== agentAddress) continue;

    total++;
    const success = e.fields.success as boolean;
    const isExpired = e.fields.isExpired as boolean;

    if (isExpired) expired++;
    else if (!success) failed++;
    else successful++;
  }

  return {
    agent: agentAddress,
    totalSessions: total,
    failedSessions: failed,
    expiredSessions: expired,
    successfulSessions: successful,
    successRate: total > 0 ? Math.round((successful / total) * 100) : 100,
  };
}
