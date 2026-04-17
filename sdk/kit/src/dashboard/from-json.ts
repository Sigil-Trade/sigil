/**
 * fromJSON — MCP round-trip deserialization for dashboard types.
 *
 * PR 3.A: Every toJSON() in dashboard/types.ts now has a corresponding
 * fromJSON() here. AI agents consuming Sigil via MCP receive JSON from tool
 * responses and pass data back to subsequent tool calls. Without fromJSON,
 * agents cannot reconstruct bigints from strings — breaking the round-trip.
 *
 * Pattern: standalone functions (not static methods) for tree-shaking.
 * Each function accepts a Serialized* object and returns the live type
 * (unchanged from A6 — logger import lives below).
 * with bigints, typed addresses, and full toJSON() methods restored.
 */

import type { Address } from "@solana/kit";
import { getSigilModuleLogger } from "../logger.js";
import type {
  VaultState,
  AgentData,
  SpendingData,
  ActivityRow,
  ActivityData,
  HealthData,
  PolicyData,
  OverviewData,
  TxResult,
  SerializedVaultState,
  SerializedAgentData,
  SerializedSpendingData,
  SerializedActivityRow,
  SerializedActivityData,
  SerializedHealthData,
  SerializedPolicyData,
  SerializedOverviewData,
  SerializedDiscoveredVault,
  HealthCheck,
} from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Safe bigint parse — returns 0n for empty/undefined/null values.
 *
 * C2 fix (silent-failure-hunter): logs a warning on parse failure instead
 * of silently returning 0n. AI agents receiving corrupted MCP data (e.g.,
 * "$500" instead of "500000000") will see the warning in logs rather than
 * silently operating on zeroed financial data.
 */
let biWarnCount = 0;
function bi(s: string | undefined | null): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    if (biWarnCount < 10) {
      biWarnCount++;
      getSigilModuleLogger().warn(
        `[@usesigil/kit/fromJSON] Failed to parse bigint from "${s.slice(0, 50)}" — returning 0n. ` +
          `This may indicate corrupted MCP data.`,
      );
    }
    return 0n;
  }
}

/** Cast string to Address (branded Kit type). */
function addr(s: string): Address {
  return s as Address;
}

// ─── fromJSON builders ──────────────────────────────────────────────────────

/** Rehydrate a TxResult from its JSON representation. */
export function txResultFromJSON(data: { signature: string }): TxResult {
  return {
    signature: data.signature,
    toJSON: () => ({ signature: data.signature }),
  };
}

/** Rehydrate a VaultState from its serialized JSON representation. */
export function vaultStateFromJSON(data: SerializedVaultState): VaultState {
  const result: VaultState = {
    vault: {
      address: addr(data.vault.address),
      status: data.vault.status,
      owner: addr(data.vault.owner),
      agentCount: data.vault.agentCount,
      openPositions: data.vault.openPositions,
      totalVolume: bi(data.vault.totalVolume),
      totalFees: bi(data.vault.totalFees),
    },
    balance: {
      total: bi(data.balance.total),
      tokens: data.balance.tokens.map((t) => ({
        mint: addr(t.mint),
        amount: bi(t.amount),
        decimals: t.decimals,
      })),
    },
    pnl: {
      percent: data.pnl.percent,
      absolute: bi(data.pnl.absolute),
    },
    health: {
      level: data.health.level as VaultState["health"]["level"],
      alertCount: data.health.alertCount,
      checks: data.health.checks,
    },
    toJSON: () => data,
  };
  return result;
}

/** Rehydrate an AgentData from its serialized JSON representation. */
export function agentDataFromJSON(data: SerializedAgentData): AgentData {
  return {
    address: addr(data.address),
    status: data.status as AgentData["status"],
    capabilityLabel: data.capabilityLabel,
    capability: data.capability,
    spending: {
      amount: bi(data.spending.amount),
      limit: bi(data.spending.limit),
      percent: data.spending.percent,
    },
    lastActionType: data.lastActionType,
    lastActionProtocol: data.lastActionProtocol,
    lastActionTimestamp: data.lastActionTimestamp,
    blockedCount24h: data.blockedCount24h,
    toJSON: () => data,
  };
}

/** Rehydrate a SpendingData from its serialized JSON representation. */
export function spendingDataFromJSON(
  data: SerializedSpendingData,
): SpendingData {
  return {
    global: {
      today: bi(data.global.today),
      cap: bi(data.global.cap),
      remaining: bi(data.global.remaining),
      percent: data.global.percent,
      rundownMs: data.global.rundownMs,
    },
    chart: data.chart,
    protocolBreakdown: data.protocolBreakdown.map((p) => ({
      name: p.name,
      programId: addr(p.programId),
      amount: bi(p.amount),
      percent: p.percent,
    })),
    toJSON: () => data,
  };
}

/** Rehydrate an ActivityRow from its serialized JSON representation. */
export function activityRowFromJSON(data: SerializedActivityRow): ActivityRow {
  return {
    id: data.id,
    timestamp: data.timestamp,
    type: data.type as ActivityRow["type"],
    protocol: data.protocol,
    protocolId: addr(data.protocolId),
    agent: addr(data.agent),
    amount: bi(data.amount),
    status: data.status as ActivityRow["status"],
    reason: data.reason,
    txSignature: data.txSignature,
    toJSON: () => data,
  };
}

/** Rehydrate an ActivityData from its serialized JSON representation. */
export function activityDataFromJSON(
  data: SerializedActivityData,
): ActivityData {
  return {
    rows: data.rows.map(activityRowFromJSON),
    summary: {
      total: data.summary.total,
      approved: data.summary.approved,
      blocked: data.summary.blocked,
      volume: bi(data.summary.volume),
    },
    toJSON: () => data,
  };
}

/** Rehydrate a HealthData from its serialized JSON representation. */
export function healthDataFromJSON(data: SerializedHealthData): HealthData {
  return {
    level: data.level as HealthData["level"],
    blockedCount24h: data.blockedCount24h,
    checks: data.checks as HealthCheck[],
    lastBlock: data.lastBlock
      ? {
          agent: addr(data.lastBlock.agent),
          reason: data.lastBlock.reason,
          amount: bi(data.lastBlock.amount),
          timestamp: data.lastBlock.timestamp,
        }
      : undefined,
    toJSON: () => data,
  };
}

/** Rehydrate a PolicyData from its serialized JSON representation. */
export function policyDataFromJSON(data: SerializedPolicyData): PolicyData {
  return {
    dailyCap: bi(data.dailyCap),
    maxPerTrade: bi(data.maxPerTrade),
    approvedApps: data.approvedApps.map((a) => ({
      name: a.name,
      programId: addr(a.programId),
    })),
    protocolMode: data.protocolMode as PolicyData["protocolMode"],
    hasProtocolCaps: data.hasProtocolCaps,
    protocolCaps: data.protocolCaps.map(bi),
    canOpenPositions: data.canOpenPositions,
    maxConcurrentPositions: data.maxConcurrentPositions,
    maxSlippageBps: data.maxSlippageBps,
    leverageLimitBps: data.leverageLimitBps,
    allowedDestinations: data.allowedDestinations.map(addr),
    developerFeeRate: data.developerFeeRate,
    sessionExpirySlots: bi(data.sessionExpirySlots),
    timelockSeconds: data.timelockSeconds,
    policyVersion: bi(data.policyVersion),
    pendingUpdate: data.pendingUpdate,
    toJSON: () => data,
  };
}

/** Rehydrate a DiscoveredVault from its serialized JSON representation. */
export function discoveredVaultFromJSON(data: SerializedDiscoveredVault) {
  return {
    address: addr(data.address),
    vaultId: bi(data.vaultId),
    status: data.status as "active" | "frozen",
    agentCount: data.agentCount,
    toJSON: () => data,
  };
}

/**
 * Rehydrate the full OverviewData from its serialized JSON representation.
 *
 * This is the primary MCP round-trip entry point — AI agents receive
 * overview JSON from the `sigil_get_overview` tool and pass it back to
 * subsequent tool calls.
 */
export function overviewDataFromJSON(
  data: SerializedOverviewData,
): OverviewData {
  return {
    vault: vaultStateFromJSON(data.vault),
    agents: data.agents.map(agentDataFromJSON),
    spending: spendingDataFromJSON(data.spending),
    health: healthDataFromJSON(data.health),
    policy: policyDataFromJSON(data.policy),
    activity: data.activity.map(activityRowFromJSON),
    toJSON: () => data,
  };
}
