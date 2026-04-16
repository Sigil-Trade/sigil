/**
 * Spending analytics — velocity, breakdown, and per-agent time series.
 *
 * Builds on top of existing functions:
 * - getSpendingHistory() in state-resolver.ts (144-epoch time series)
 * - getRolling24hUsd() in state-resolver.ts (global 24h spend)
 * - getAgentRolling24hUsd() in state-resolver.ts (per-agent 24h spend)
 *
 * This module adds:
 * - getSpendingVelocity() — rate, acceleration, cap projection
 * - getSpendingBreakdown() — by-agent + by-protocol + concentration indices
 * - getAgentSpendingHistory() — per-agent hourly time series from overlay
 */

import type { Address } from "./kit-adapter.js";
import type { SpendTracker, AgentSpendOverlay } from "./generated/index.js";
import { computeUtilizationPercent } from "./math-utils.js";
import type {
  ResolvedVaultState,
  EffectiveBudget,
  SpendingEpoch,
} from "./state-resolver.js";
import { bytesToAddress } from "./state-resolver.js";
import { formatUsd } from "./formatting.js";
import { resolveProtocolName } from "./protocol-names.js";
import { computeHerfindahl } from "./math-utils.js";
import {
  EPOCH_DURATION,
  NUM_EPOCHS,
  OVERLAY_EPOCH_DURATION,
  OVERLAY_NUM_EPOCHS,
  MAX_AGENTS_PER_VAULT,
} from "./types.js";

// Re-export for convenience — consumers can import from either location
export type { SpendingEpoch } from "./state-resolver.js";
export { getSpendingHistory } from "./state-resolver.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Velocity metrics derived from spending rate analysis. */
export interface SpendingVelocity {
  /** Current spend rate in USD base units per hour (average of last 3 10-min epochs = 30 min) */
  currentRate: bigint;
  /** 24h average spend rate in USD base units per hour */
  averageRate: bigint;
  /** Highest single-epoch (10-min) spend in the 24h window */
  peakRate: bigint;
  /** Timestamp of the peak spend epoch */
  peakTimestamp: number;
  /** Whether spending is accelerating (currentRate > 1.5x averageRate) */
  isAccelerating: boolean;
  /** Seconds until the cap is projected to be hit at current rate. null if rate is 0. */
  timeToCapSeconds: number | null;
  /** Unix timestamp when cap would be hit. null if not approaching. */
  projectedCapHitTime: number | null;
}

/** Complete spending breakdown by agent and protocol. */
export interface SpendingBreakdown {
  global: { spent24h: bigint; cap: bigint; utilization: number };
  byAgent: Array<{
    agent: Address;
    spent24h: bigint;
    cap: bigint;
    utilization: number;
    lifetimeSpend: bigint;
  }>;
  byProtocol: Array<{
    protocol: Address;
    protocolName: string;
    spent24h: bigint;
    cap: bigint;
    utilization: number;
  }>;
  /** Herfindahl index (0-1). 1.0 = one agent does all spending. */
  agentConcentration: number;
  /** Herfindahl index (0-1). 1.0 = one protocol gets all spend. */
  protocolConcentration: number;
  topAgent: Address | null;
  topProtocol: Address | null;
}

// ─── Spending Velocity ───────────────────────────────────────────────────────

/**
 * Compute spending velocity metrics from the SpendTracker.
 *
 * Velocity = rate of spending relative to cap. A vault at 60% cap with
 * accelerating velocity is MORE dangerous than one at 80% that's decelerating.
 *
 * Algorithm:
 * 1. currentRate = sum of last 3 non-zero epochs / 0.5 hours (extrapolated to hourly)
 * 2. averageRate = total24h spend / 24 hours
 * 3. acceleration = currentRate / averageRate > 1.5x
 * 4. timeToCapSeconds = remaining cap / currentRate
 */
export function getSpendingVelocity(
  tracker: SpendTracker | null,
  nowUnix: bigint,
  globalBudget: EffectiveBudget,
): SpendingVelocity {
  const zero: SpendingVelocity = {
    currentRate: 0n,
    averageRate: 0n,
    peakRate: 0n,
    peakTimestamp: 0,
    isAccelerating: false,
    timeToCapSeconds: null,
    projectedCapHitTime: null,
  };

  if (!tracker || nowUnix <= 0n) return zero;

  const epochDuration = BigInt(EPOCH_DURATION);
  const currentEpoch = nowUnix / epochDuration;
  const windowStartEpoch = currentEpoch - BigInt(NUM_EPOCHS);

  // Collect all valid (in-window, non-zero) epochs sorted by epochId descending
  const validBuckets: Array<{ epochId: bigint; usdAmount: bigint }> = [];
  let peakAmount = 0n;
  let peakEpochId = 0n;

  for (const bucket of tracker.buckets) {
    if (bucket.epochId < windowStartEpoch || bucket.epochId > currentEpoch)
      continue;
    if (bucket.usdAmount === 0n) continue;

    validBuckets.push({ epochId: bucket.epochId, usdAmount: bucket.usdAmount });

    if (bucket.usdAmount > peakAmount) {
      peakAmount = bucket.usdAmount;
      peakEpochId = bucket.epochId;
    }
  }

  // Sort descending by epoch (most recent first)
  validBuckets.sort((a, b) => Number(b.epochId - a.epochId));

  // currentRate: sum of last 3 non-zero epochs, extrapolated to per-hour rate.
  // Each epoch = 10 minutes. N epochs = N*10 minutes.
  // Hourly rate = recentSum * 60 / (N * 10) = recentSum * 6 / N
  const recentEpochs = validBuckets.slice(0, 3);
  const recentSum = recentEpochs.reduce((sum, b) => sum + b.usdAmount, 0n);
  const currentRate =
    recentEpochs.length > 0
      ? (recentSum * 6n) / BigInt(recentEpochs.length)
      : 0n;

  // averageRate: total 24h spend / 24 hours
  const averageRate = globalBudget.spent24h / 24n;

  // Acceleration: currentRate > 1.5x averageRate (integer: currentRate > averageRate * 3 / 2)
  const isAccelerating =
    averageRate > 0n ? currentRate > (averageRate * 3n) / 2n : currentRate > 0n;

  // Time to cap projection
  let timeToCapSeconds: number | null = null;
  let projectedCapHitTime: number | null = null;

  if (currentRate > 0n && globalBudget.remaining > 0n) {
    // remaining / rate = hours, convert to seconds
    const hoursToCapx1000 = (globalBudget.remaining * 1000n) / currentRate;
    timeToCapSeconds = (Number(hoursToCapx1000) * 3600) / 1000;
    projectedCapHitTime = Number(nowUnix) + timeToCapSeconds;
  }

  return {
    currentRate,
    averageRate,
    peakRate: peakAmount,
    peakTimestamp: Number(peakEpochId * epochDuration),
    isAccelerating,
    timeToCapSeconds,
    projectedCapHitTime,
  };
}

// ─── Spending Breakdown ──────────────────────────────────────────────────────

/**
 * Complete spending breakdown by agent and protocol with concentration indices.
 *
 * The dashboard Spending tab needs global, per-agent, per-protocol spend, and
 * concentration metrics all at once. This does it in one pass.
 */
export function getSpendingBreakdown(
  state: ResolvedVaultState,
): SpendingBreakdown {
  const { globalBudget, allAgentBudgets, protocolBudgets, overlay, vault } =
    state;

  // Global utilization
  const globalUtil = computeUtilizationPercent(
    globalBudget.spent24h,
    globalBudget.cap,
  );

  // By agent
  const byAgent: SpendingBreakdown["byAgent"] = [];
  let topAgentAddr: Address | null = null;
  let topAgentSpend = 0n;

  for (const [agent, budget] of allAgentBudgets) {
    const util = computeUtilizationPercent(budget.spent24h, budget.cap);

    // Find lifetime spend from overlay
    let lifetimeSpend = 0n;
    if (overlay) {
      const slotIdx = overlay.entries.findIndex((e) => {
        try {
          return bytesToAddress(e.agent) === agent;
        } catch {
          return false;
        }
      });
      if (slotIdx >= 0 && slotIdx < overlay.lifetimeSpend.length) {
        lifetimeSpend = overlay.lifetimeSpend[slotIdx];
      }
    }

    byAgent.push({
      agent,
      spent24h: budget.spent24h,
      cap: budget.cap,
      utilization: util,
      lifetimeSpend,
    });

    if (budget.spent24h > topAgentSpend) {
      topAgentSpend = budget.spent24h;
      topAgentAddr = agent;
    }
  }

  // By protocol
  const byProtocol: SpendingBreakdown["byProtocol"] = [];
  let topProtocolAddr: Address | null = null;
  let topProtocolSpend = 0n;

  for (const pb of protocolBudgets) {
    const util = computeUtilizationPercent(pb.spent24h, pb.cap);

    byProtocol.push({
      protocol: pb.protocol,
      protocolName: resolveProtocolName(pb.protocol),
      spent24h: pb.spent24h,
      cap: pb.cap,
      utilization: util,
    });

    if (pb.spent24h > topProtocolSpend) {
      topProtocolSpend = pb.spent24h;
      topProtocolAddr = pb.protocol;
    }
  }

  return {
    global: {
      spent24h: globalBudget.spent24h,
      cap: globalBudget.cap,
      utilization: globalUtil,
    },
    byAgent,
    byProtocol,
    agentConcentration: computeHerfindahl(byAgent.map((a) => a.spent24h)),
    protocolConcentration: computeHerfindahl(byProtocol.map((p) => p.spent24h)),
    topAgent: topAgentAddr,
    topProtocol: topProtocolAddr,
  };
}

// ─── Per-Agent Spending History ──────────────────────────────────────────────

/**
 * Per-agent spending time series from AgentSpendOverlay (24 hourly epochs).
 *
 * Same algorithm as getSpendingHistory but for the overlay's 24-bucket hourly
 * scheme instead of the tracker's 144-bucket 10-minute scheme.
 */
export function getAgentSpendingHistory(
  overlay: AgentSpendOverlay | null,
  agentSlot: number,
  nowUnix: bigint,
): SpendingEpoch[] {
  if (
    !overlay ||
    agentSlot < 0 ||
    agentSlot >= MAX_AGENTS_PER_VAULT ||
    nowUnix <= 0n
  ) {
    return [];
  }

  const entry = overlay.entries[agentSlot];
  if (!entry || entry.lastWriteEpoch === 0n) return [];

  const epochDuration = BigInt(OVERLAY_EPOCH_DURATION);
  const currentEpoch = nowUnix / epochDuration;
  const windowStartEpoch = currentEpoch - BigInt(OVERLAY_NUM_EPOCHS);

  const results: SpendingEpoch[] = [];

  for (let k = 0; k < OVERLAY_NUM_EPOCHS; k++) {
    const epochForK = entry.lastWriteEpoch - BigInt(k);
    if (epochForK < 0n || epochForK <= windowStartEpoch) break;
    if (epochForK > currentEpoch) continue;

    const bucketIdx = Number(epochForK % BigInt(OVERLAY_NUM_EPOCHS));
    const contribution = entry.contributions[bucketIdx];
    if (contribution === 0n) continue;

    results.push({
      epochId: Number(epochForK),
      timestamp: Number(epochForK * epochDuration),
      usdAmount: contribution,
      usdAmountFormatted: formatUsd(contribution),
    });
  }

  results.sort((a, b) => a.timestamp - b.timestamp);
  return results;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

// computeHerfindahl imported from math-utils.ts (shared with agent-analytics)
// resolveProtocolName imported from protocol-names.ts (shared with event-analytics)
