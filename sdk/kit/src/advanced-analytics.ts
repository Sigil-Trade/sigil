/**
 * Advanced analytics — institutional-grade metrics for compliance and risk.
 *
 * All functions operate on decoded event arrays (pure, no RPC).
 * The dashboard fetches events via Helius or parsed TX logs.
 *
 * Functions:
 * - getSlippageEfficiency() — authorized vs actual spend comparison
 * - getCapVelocity() — risk-classified cap approach rate
 * - getSessionDeviationRate() — compliance deviation tracking
 * - getIdleCapitalDuration() — dormancy detection
 * - getPermissionEscalationLatency() — suspicious grant-to-use timing
 * - getInstructionCoverageRatio() — session sandwich completeness
 */

import type { Address } from "@solana/kit";
import type { DecodedSigilEvent } from "./events.js";
import type { SpendTracker } from "./generated/index.js";
import type { EffectiveBudget } from "./state-resolver.js";
import { EPOCH_DURATION } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SlippageReport {
  byAgent: Array<{
    agent: Address;
    avgSlippageBps: number;
    worstSlippageBps: number;
    tradeCount: number;
    estimatedWasteUsd: bigint;
  }>;
  vaultAvgSlippageBps: number;
}

export interface CapVelocityReport {
  currentRate: bigint;
  avgRate: bigint;
  acceleration: number;
  projectedCapHitTime: number | null;
  riskLevel: "low" | "moderate" | "high" | "critical";
}

export interface DeviationReport {
  totalSessions: number;
  deviatedSessions: number;
  deviationRate: number;
  maxDeviationBps: number;
  deviations: Array<{
    agent: Address;
    authorizedAmount: bigint;
    actualSpend: bigint;
    deviationBps: number;
  }>;
}

export interface IdleCapitalReport {
  avgIdleHours: number;
  maxIdleHours: number;
  lastActivityTimestamp: number;
  idleSinceHours: number;
}

export interface EscalationReport {
  escalations: Array<{
    agent: Address;
    grantTimestamp: number;
    firstUseTimestamp: number | null;
    latencySeconds: number | null;
    suspicious: boolean;
  }>;
}

export interface CoverageReport {
  totalComposed: number;
  orphanedValidates: number;
  coverageRate: number;
}

// ─── getSlippageEfficiency ───────────────────────────────────────────────────

/**
 * Measure execution quality by comparing authorized amount to actual spend.
 * Pairs ActionAuthorized → SessionFinalized events by agent.
 */
export function getSlippageEfficiency(
  events: DecodedSigilEvent[],
): SlippageReport {
  const agentTrades = new Map<
    string,
    Array<{ authorized: bigint; actual: bigint }>
  >();

  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].name !== "ActionAuthorized" || !events[i].fields) continue;
    const auth = events[i].fields!;

    for (let j = i + 1; j < Math.min(i + 5, events.length); j++) {
      if (events[j].name !== "SessionFinalized" || !events[j].fields) continue;
      const fin = events[j].fields!;

      if (auth.agent === fin.agent) {
        const agent = auth.agent as string;
        const authorized = auth.usdAmount as bigint;
        const rawActual = fin.actualSpendUsd;
        const actual = typeof rawActual === "bigint" ? rawActual : 0n;

        if (!agentTrades.has(agent)) agentTrades.set(agent, []);
        agentTrades.get(agent)!.push({ authorized, actual });
        break;
      }
    }
  }

  const byAgent: SlippageReport["byAgent"] = [];
  let totalSlippageBps = 0;
  let totalTrades = 0;

  for (const [agent, trades] of agentTrades) {
    let worstBps = 0;
    let totalBps = 0;
    let totalWaste = 0n;

    for (const trade of trades) {
      if (trade.authorized === 0n) continue;
      const diff =
        trade.actual > trade.authorized ? trade.actual - trade.authorized : 0n;
      const bps = Number((diff * 10000n) / trade.authorized);
      totalBps += bps;
      totalWaste += diff;
      if (bps > worstBps) worstBps = bps;
    }

    byAgent.push({
      agent: agent as Address,
      avgSlippageBps: trades.length > 0 ? totalBps / trades.length : 0,
      worstSlippageBps: worstBps,
      tradeCount: trades.length,
      estimatedWasteUsd: totalWaste,
    });

    totalSlippageBps += totalBps;
    totalTrades += trades.length;
  }

  return {
    byAgent,
    vaultAvgSlippageBps: totalTrades > 0 ? totalSlippageBps / totalTrades : 0,
  };
}

// ─── getCapVelocity ──────────────────────────────────────────────────────────

/**
 * Cap velocity with risk classification (low/moderate/high/critical).
 */
export function getCapVelocity(
  tracker: SpendTracker | null,
  nowUnix: bigint,
  globalBudget: EffectiveBudget,
): CapVelocityReport {
  const epochDuration = BigInt(EPOCH_DURATION);
  const currentEpoch = nowUnix / epochDuration;

  let recentSum = 0n;
  let recentCount = 0;

  if (tracker) {
    for (const bucket of tracker.buckets) {
      if (
        bucket.epochId >= currentEpoch - 3n &&
        bucket.epochId <= currentEpoch &&
        bucket.usdAmount > 0n
      ) {
        recentSum += bucket.usdAmount;
        recentCount++;
      }
    }
  }

  const currentRate =
    recentCount > 0 ? (recentSum * 6n) / BigInt(recentCount) : 0n;
  const avgRate = globalBudget.spent24h / 24n;
  const acceleration = avgRate > 0n ? Number(currentRate) / Number(avgRate) : 0;

  let projectedCapHitTime: number | null = null;
  if (currentRate > 0n && globalBudget.remaining > 0n) {
    const hoursRemaining = Number(globalBudget.remaining) / Number(currentRate);
    projectedCapHitTime = Number(nowUnix) + hoursRemaining * 3600;
  }

  const util =
    globalBudget.cap > 0n
      ? Number((globalBudget.spent24h * 100n) / globalBudget.cap)
      : 0;

  let riskLevel: CapVelocityReport["riskLevel"];
  if (
    util >= 95 ||
    (projectedCapHitTime !== null &&
      projectedCapHitTime - Number(nowUnix) < 3600)
  ) {
    riskLevel = "critical";
  } else if (util >= 80 && acceleration > 1.5) {
    riskLevel = "high";
  } else if (util >= 50 || acceleration > 1.5) {
    riskLevel = "moderate";
  } else {
    riskLevel = "low";
  }

  return { currentRate, avgRate, acceleration, projectedCapHitTime, riskLevel };
}

// ─── getSessionDeviationRate ─────────────────────────────────────────────────

/**
 * Measure how often actual spend deviates >2% from authorized amount.
 * SOC 2 auditors require this metric.
 */
export function getSessionDeviationRate(
  events: DecodedSigilEvent[],
): DeviationReport {
  const pairs: Array<{ agent: string; authorized: bigint; actual: bigint }> =
    [];

  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].name !== "ActionAuthorized" || !events[i].fields) continue;
    const auth = events[i].fields!;

    for (let j = i + 1; j < Math.min(i + 5, events.length); j++) {
      if (events[j].name !== "SessionFinalized" || !events[j].fields) continue;
      const fin = events[j].fields!;

      const finActual =
        typeof fin.actualSpendUsd === "bigint" ? fin.actualSpendUsd : 0n;
      const authAmount =
        typeof auth.usdAmount === "bigint" ? auth.usdAmount : 0n;
      if (auth.agent === fin.agent && finActual > 0n) {
        pairs.push({
          agent: auth.agent as string,
          authorized: authAmount,
          actual: finActual,
        });
        break;
      }
    }
  }

  const deviations: DeviationReport["deviations"] = [];
  let maxBps = 0;

  for (const pair of pairs) {
    if (pair.authorized === 0n) continue;
    if (pair.actual > pair.authorized) {
      const bps = Number(
        ((pair.actual - pair.authorized) * 10000n) / pair.authorized,
      );
      if (bps > 200) {
        deviations.push({
          agent: pair.agent as Address,
          authorizedAmount: pair.authorized,
          actualSpend: pair.actual,
          deviationBps: bps,
        });
        if (bps > maxBps) maxBps = bps;
      }
    }
  }

  return {
    totalSessions: pairs.length,
    deviatedSessions: deviations.length,
    deviationRate:
      pairs.length > 0 ? (deviations.length / pairs.length) * 100 : 0,
    maxDeviationBps: maxBps,
    deviations,
  };
}

// ─── getIdleCapitalDuration ──────────────────────────────────────────────────

/**
 * Measure how long vault funds sit idle between agent actions.
 */
export function getIdleCapitalDuration(
  events: DecodedSigilEvent[],
  nowUnix: number,
): IdleCapitalReport {
  const tradeTimestamps: number[] = [];
  for (const e of events) {
    if (
      (e.name === "SessionFinalized" || e.name === "ActionAuthorized") &&
      e.fields?.timestamp != null
    ) {
      tradeTimestamps.push(Number(e.fields.timestamp as bigint));
    }
  }

  if (tradeTimestamps.length === 0) {
    return {
      avgIdleHours: 0,
      maxIdleHours: 0,
      lastActivityTimestamp: 0,
      idleSinceHours: 0,
    };
  }

  tradeTimestamps.sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < tradeTimestamps.length; i++) {
    gaps.push(tradeTimestamps[i] - tradeTimestamps[i - 1]);
  }

  const avgGapSeconds =
    gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const maxGapSeconds = gaps.length > 0 ? Math.max(...gaps) : 0;
  const lastTimestamp = tradeTimestamps[tradeTimestamps.length - 1];

  return {
    avgIdleHours: Math.round((avgGapSeconds / 3600) * 10) / 10,
    maxIdleHours: Math.round((maxGapSeconds / 3600) * 10) / 10,
    lastActivityTimestamp: lastTimestamp,
    idleSinceHours: Math.round(((nowUnix - lastTimestamp) / 3600) * 10) / 10,
  };
}

// ─── getPermissionEscalationLatency ──────────────────────────────────────────

/**
 * Time between permission grants and first use. <60s = suspicious.
 */
export function getPermissionEscalationLatency(
  events: DecodedSigilEvent[],
): EscalationReport {
  const escalations: EscalationReport["escalations"] = [];

  for (let i = 0; i < events.length; i++) {
    if (events[i].name !== "AgentPermissionsUpdated" || !events[i].fields)
      continue;
    const permEvent = events[i].fields!;
    const agent = permEvent.agent as string;
    const grantTimestamp = Number(permEvent.timestamp ?? 0);

    let firstUseTimestamp: number | null = null;
    for (let j = i + 1; j < events.length; j++) {
      if (
        events[j].name === "ActionAuthorized" &&
        events[j].fields?.agent === agent
      ) {
        firstUseTimestamp = Number(events[j].fields!.timestamp as bigint);
        break;
      }
    }

    const latencySeconds =
      firstUseTimestamp !== null ? firstUseTimestamp - grantTimestamp : null;

    escalations.push({
      agent: agent as Address,
      grantTimestamp,
      firstUseTimestamp,
      latencySeconds,
      suspicious: latencySeconds !== null && latencySeconds < 60,
    });
  }

  return { escalations };
}

// ─── getInstructionCoverageRatio ─────────────────────────────────────────────

/**
 * Measure instruction sandwich coverage — what % of authorized sessions
 * were properly finalized. Non-zero orphan rate = potential attack surface.
 */
export function getInstructionCoverageRatio(
  events: DecodedSigilEvent[],
): CoverageReport {
  const authorized = new Map<string, number>();
  const finalized = new Map<string, number>();

  for (const e of events) {
    if (e.name === "ActionAuthorized" && e.fields?.agent) {
      const agent = e.fields.agent as string;
      authorized.set(agent, (authorized.get(agent) ?? 0) + 1);
    }
    if (e.name === "SessionFinalized" && e.fields?.agent) {
      const agent = e.fields.agent as string;
      finalized.set(agent, (finalized.get(agent) ?? 0) + 1);
    }
  }

  let totalComposed = 0;
  let orphanedValidates = 0;

  for (const [agent, authCount] of authorized) {
    const finCount = finalized.get(agent) ?? 0;
    const paired = Math.min(authCount, finCount);
    totalComposed += paired;
    orphanedValidates += authCount - paired;
  }

  const total = totalComposed + orphanedValidates;
  const coverageRate = total > 0 ? (totalComposed / total) * 100 : 100;

  return { totalComposed, orphanedValidates, coverageRate };
}

// ─── getPermissionUtilizationRate ─────────────────────────────────────────────

export interface PermissionUtilization {
  byAgent: Array<{
    agent: Address;
    grantedPermissions: string[];
    exercisedPermissions: string[];
    utilizationRate: number;
    unusedPermissions: string[];
  }>;
  mostUsedActionType: string | null;
  leastUsedActionType: string | null;
}

const ACTION_NAMES = [
  "Swap",
  "OpenPosition",
  "ClosePosition",
  "IncreasePosition",
  "DecreasePosition",
  "Deposit",
  "Withdraw",
  "Transfer",
  "AddCollateral",
  "RemoveCollateral",
  "PlaceTriggerOrder",
  "EditTriggerOrder",
  "CancelTriggerOrder",
  "PlaceLimitOrder",
  "EditLimitOrder",
  "CancelLimitOrder",
  "SwapAndOpenPosition",
  "CloseAndSwapPosition",
  "CreateEscrow",
  "SettleEscrow",
  "RefundEscrow",
];

/**
 * Ratio of granted permission bits actually exercised by each agent.
 * Shows which ActionTypes agents use vs what they're granted — security surface analysis.
 *
 * Handles both legacy (actionType enum) and new v6 (isSpending + positionEffect) event formats.
 */
export function getPermissionUtilizationRate(
  state: { vault: { agents: Array<{ pubkey: Address; capability: number }> } },
  events: DecodedSigilEvent[],
): PermissionUtilization {
  // Count which action categories each agent has used
  const agentActionUsage = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.name === "ActionAuthorized" && e.fields?.agent) {
      const agent = e.fields.agent as string;
      if (!agentActionUsage.has(agent)) agentActionUsage.set(agent, new Set());

      // v6 event format: isSpending + positionEffect
      if (e.fields.isSpending != null) {
        const label = (e.fields.isSpending as boolean)
          ? "Spending"
          : "NonSpending";
        agentActionUsage.get(agent)!.add(label);
        const effect = e.fields.positionEffect as string | undefined;
        if (effect && effect !== "none") {
          agentActionUsage.get(agent)!.add(`Position:${effect}`);
        }
      } else if (e.fields.actionType) {
        // Legacy event format
        const actionObj = e.fields.actionType as { __kind: string } | number;
        const actionName =
          typeof actionObj === "object" && "__kind" in actionObj
            ? actionObj.__kind
            : (ACTION_NAMES[Number(actionObj)] ?? "Unknown");
        agentActionUsage.get(agent)!.add(actionName);
      }
    }
  }

  const globalActionCounts = new Map<string, number>();
  const byAgent: PermissionUtilization["byAgent"] = [];

  // Capability-based granted permissions:
  // 0=Disabled (no permissions), 1=Observer (NonSpending), 2=Operator (Spending + NonSpending)
  const CAPABILITY_GRANTS: Record<number, string[]> = {
    0: [],
    1: ["NonSpending"],
    2: ["Spending", "NonSpending"],
  };

  for (const agentEntry of state.vault.agents) {
    const agent = agentEntry.pubkey;
    const granted = CAPABILITY_GRANTS[agentEntry.capability] ?? [];

    const exercised =
      agentActionUsage.get(agent as string) ?? new Set<string>();
    const exercisedArr = [...exercised].filter((a) => granted.includes(a));
    const unused = granted.filter((a) => !exercised.has(a));

    for (const a of exercisedArr) {
      globalActionCounts.set(a, (globalActionCounts.get(a) ?? 0) + 1);
    }

    byAgent.push({
      agent,
      grantedPermissions: granted,
      exercisedPermissions: exercisedArr,
      utilizationRate:
        granted.length > 0 ? (exercisedArr.length / granted.length) * 100 : 0,
      unusedPermissions: unused,
    });
  }

  let mostUsed: string | null = null;
  let leastUsed: string | null = null;
  let maxCount = 0;
  let minCount = Infinity;
  for (const [action, count] of globalActionCounts) {
    if (count > maxCount) {
      maxCount = count;
      mostUsed = action;
    }
    if (count < minCount) {
      minCount = count;
      leastUsed = action;
    }
  }

  return {
    byAgent,
    mostUsedActionType: mostUsed,
    leastUsedActionType: leastUsed,
  };
}
