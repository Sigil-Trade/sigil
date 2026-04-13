/**
 * @usesigil/kit/dashboard — Read functions for OwnerClient.
 *
 * Each function is stateless (fetches fresh from RPC), composes existing
 * SDK functions, and returns raw values with toJSON() for MCP serialization.
 */

import { isSome } from "@solana/kit";
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { toDxError } from "./errors.js";
import {
  resolveVaultStateForOwner,
  getSpendingHistory,
  getPendingPolicyForVault,
  resolveVaultBudget,
} from "../state-resolver.js";
import { getVaultPnL } from "../balance-tracker.js";
import { getSecurityPosture } from "../security-analytics.js";
import { evaluateAlertConditions } from "../security-analytics.js";
import { getAgentProfile } from "../agent-analytics.js";
import { getSpendingBreakdown } from "../spending-analytics.js";
import { getVaultActivity } from "../event-analytics.js";
import { resolveProtocolName } from "../protocol-names.js";
import type { Network } from "../types.js";
import type { ResolvedVaultState } from "../state-resolver.js";
import type { AgentVault } from "../generated/accounts/agentVault.js";
import type { PolicyConfig } from "../generated/accounts/policyConfig.js";
import type { PendingPolicyUpdate } from "../generated/accounts/pendingPolicyUpdate.js";

/**
 * Cast ResolvedVaultStateForOwner to ResolvedVaultState.
 * Safe because ForOwner only omits `agentBudget` which analytics functions don't use.
 */
function asVaultState(state: unknown): ResolvedVaultState {
  return state as ResolvedVaultState;
}

import type {
  VaultState,
  AgentData,
  SpendingData,
  ActivityData,
  ActivityFilters,
  ActivityRow,
  ActivityType,
  HealthData,
  PolicyData,
  ChartPoint,
  PolicyChanges,
} from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNet(network: "devnet" | "mainnet"): Network {
  return network === "mainnet" ? "mainnet-beta" : "devnet";
}

function bs(v: bigint): string {
  return v.toString();
}

function serializeBigints(obj: unknown): unknown {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeBigints);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = serializeBigints(v);
    }
    return result;
  }
  return obj;
}

// ─── getVaultState ───────────────────────────────────────────────────────────

export async function getVaultState(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: "devnet" | "mainnet",
): Promise<VaultState> {
  try {
    const [state, pnl] = await Promise.all([
      resolveVaultStateForOwner(rpc, vault, undefined, toNet(network)),
      getVaultPnL(rpc, vault, toNet(network)),
    ]);

    const posture = getSecurityPosture(asVaultState(state));
    const v = state.vault as AgentVault;
    const bal = state.stablecoinBalances;
    const total = bal.usdc + bal.usdt;

    const tokens = [
      ...(bal.usdc > 0n
        ? [{ mint: "USDC", amount: bal.usdc, decimals: 6 }]
        : []),
      ...(bal.usdt > 0n
        ? [{ mint: "USDT", amount: bal.usdt, decimals: 6 }]
        : []),
    ];

    const checks = posture.checks.map((c: any) => ({
      name: c.id,
      passed: c.passed,
    }));
    const level =
      posture.criticalFailures.length > 0
        ? ("critical" as const)
        : posture.failCount > 0
          ? ("elevated" as const)
          : ("healthy" as const);

    return {
      vault: {
        address: vault,
        status:
          v.status === 0 ? "active" : v.status === 1 ? "frozen" : "closed",
        owner: v.owner as string,
        agentCount: v.agents?.length ?? 0,
        openPositions: v.openPositions,
        totalVolume: v.totalVolume,
        totalFees: v.totalFeesCollected,
      },
      balance: { total, tokens },
      pnl: {
        percent: Number.isFinite(pnl.pnlPercent) ? pnl.pnlPercent : 0,
        absolute: pnl.pnl,
      },
      health: { level, alertCount: posture.failCount, checks },
      toJSON: () => ({
        vault: {
          address: vault,
          status: (v.status === 0
            ? "active"
            : v.status === 1
              ? "frozen"
              : "closed") as VaultState["vault"]["status"],
          owner: v.owner as string,
          agentCount: v.agents?.length ?? 0,
          openPositions: v.openPositions,
          totalVolume: bs(v.totalVolume),
          totalFees: bs(v.totalFeesCollected),
        },
        balance: {
          total: bs(total),
          tokens: tokens.map((t) => ({ ...t, amount: bs(t.amount) })),
        },
        pnl: {
          percent: Number.isFinite(pnl.pnlPercent) ? pnl.pnlPercent : 0,
          absolute: bs(pnl.pnl),
        },
        health: { level, alertCount: posture.failCount, checks },
      }),
    };
  } catch (err) {
    throw toDxError(err, "OwnerClient.getVaultState");
  }
}

// ─── getAgents ───────────────────────────────────────────────────────────────

export async function getAgents(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: "devnet" | "mainnet",
): Promise<AgentData[]> {
  try {
    // Fetch vault state and activity feed in parallel. Single getVaultActivity
    // call is shared across all agents (N+1 prevention). Activity is enrichment,
    // so a fetch failure degrades gracefully to empty last-action fields.
    // Window: 100 most recent signatures — large enough to surface last action
    // for low-volume agents without inflating RPC cost.
    const [state, activity] = await Promise.all([
      resolveVaultStateForOwner(rpc, vault, undefined, toNet(network)),
      // Fix for docs/SECURITY-FINDINGS-2026-04-07.md Finding 5: the
      // previous `.catch(() => [])` swallowed activity-fetch failures
      // silently. If Helius started rate-limiting getSignaturesForAddress,
      // every dashboard call would show "last action: never" for every
      // agent forever and nobody would notice. Graceful degradation is
      // still the right behavior (activity is enrichment, not core), but
      // it must be observable — console.warn is the minimum bar.
      getVaultActivity(rpc, vault, 100, toNet(network)).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          "[OwnerClient.getAgents] activity enrichment failed — falling back to empty last-action fields:",
          err instanceof Error ? err.message : String(err),
        );
        return [];
      }),
    ]);
    const vaultAgents = (state.vault as AgentVault).agents;
    if (!vaultAgents || vaultAgents.length === 0) return [];

    const blockedCutoffMs = Date.now() - 24 * 3600 * 1000;

    return vaultAgents.map((entry) => {
      const addr = entry.pubkey;
      const profile = getAgentProfile(asVaultState(state), addr);
      const budget = state.allAgentBudgets.get(addr);

      const spentAmt = budget?.spent24h ?? 0n;
      const capAmt = budget?.cap ?? 0n;
      const pct = capAmt > 0n ? Number((spentAmt * 10000n) / capAmt) / 100 : 0;

      // Derive last-action and blocked-count fields from the shared activity
      // feed. Items are newest-first (getSignaturesForAddress ordering).
      const agentActivity = activity.filter(
        (item) => item.agent !== null && item.agent === addr,
      );
      const last = agentActivity[0];
      const lastActionType: string = last
        ? mapCategory(
            (last.category as string) ?? "unknown",
            (last.eventType as string) ?? "",
            last.actionType ?? undefined,
          )
        : "";
      const lastActionProtocol = last?.protocolName ?? "";
      const lastActionTimestamp = last ? last.timestamp * 1000 : 0;
      const blockedCount24h = agentActivity.filter(
        (item) => !item.success && item.timestamp * 1000 >= blockedCutoffMs,
      ).length;

      return {
        address: addr,
        status: (profile?.paused ? "paused" : "active") as "active" | "paused",
        capabilityLabel: profile?.capabilityLabel ?? "Disabled",
        capability: profile?.capability ?? 0,
        spending: { amount: spentAmt, limit: capAmt, percent: pct },
        lastActionType,
        lastActionProtocol,
        lastActionTimestamp,
        blockedCount24h,
        toJSON: () => ({
          address: addr,
          status: profile?.paused ? "paused" : "active",
          capabilityLabel: profile?.capabilityLabel ?? "Disabled",
          capability: profile?.capability ?? 0,
          spending: { amount: bs(spentAmt), limit: bs(capAmt), percent: pct },
          lastActionType,
          lastActionProtocol,
          lastActionTimestamp,
          blockedCount24h,
        }),
      };
    });
  } catch (err) {
    throw toDxError(err, "OwnerClient.getAgents");
  }
}

// ─── getSpending ─────────────────────────────────────────────────────────────

export async function getSpending(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: "devnet" | "mainnet",
): Promise<SpendingData> {
  try {
    const state = await resolveVaultStateForOwner(
      rpc,
      vault,
      undefined,
      toNet(network),
    );
    const breakdown = getSpendingBreakdown(asVaultState(state));
    const nowUnix = BigInt(Math.floor(Date.now() / 1000));
    const epochs = getSpendingHistory(state.tracker, nowUnix);

    const chart: ChartPoint[] = epochs.map((e) => ({
      time: new Date(e.timestamp * 1000).toISOString(),
      amount: Number(e.usdAmount) / 1_000_000,
    }));

    const { spent24h: spent, cap, remaining } = state.globalBudget;
    const percent = cap > 0n ? Number((spent * 10000n) / cap) / 100 : 0;
    const velocityPerMs = spent > 0n ? Number(spent) / (24 * 3600 * 1000) : 0;
    const rundown =
      velocityPerMs > 0 && remaining > 0n
        ? Math.floor(Number(remaining) / velocityPerMs)
        : 0;

    const protoBreak = breakdown.byProtocol.map((p: any) => ({
      name: resolveProtocolName(p.protocol),
      programId: p.protocol as string,
      amount: p.spent24h as bigint,
      percent: p.utilization as number,
    }));

    return {
      global: { today: spent, cap, remaining, percent, rundownMs: rundown },
      chart,
      protocolBreakdown: protoBreak,
      toJSON: () => ({
        global: {
          today: bs(spent),
          cap: bs(cap),
          remaining: bs(remaining),
          percent,
          rundownMs: rundown,
        },
        chart,
        protocolBreakdown: protoBreak.map((p) => ({
          ...p,
          amount: bs(p.amount),
        })),
      }),
    };
  } catch (err) {
    throw toDxError(err, "OwnerClient.getSpending");
  }
}

// ─── getActivity ─────────────────────────────────────────────────────────────

export async function getActivity(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: "devnet" | "mainnet",
  filters?: ActivityFilters,
): Promise<ActivityData> {
  try {
    const limit = filters?.limit ?? 50;
    const items = await getVaultActivity(rpc, vault, limit, toNet(network));

    let rows: ActivityRow[] = items.map((item, i) => {
      const cat = (item.category as string) ?? "unknown";
      const evt = (item.eventType as string) ?? "";
      const act = (item.actionType as string) ?? undefined;
      const type = mapCategory(cat, evt, act);
      const amt = item.amount ?? 0n;
      const sig = item.txSignature || `evt-${item.timestamp}-${item.eventType}`;

      return {
        id: sig,
        timestamp: item.timestamp * 1000,
        type,
        protocol: item.protocolName || "",
        protocolId: (item.protocol as string) || "",
        agent: (item.agent as string) || "",
        amount: amt,
        status: item.success ? ("approved" as const) : ("blocked" as const),
        reason: item.success ? undefined : item.description,
        txSignature: item.txSignature,
        toJSON: () => ({
          id: sig,
          timestamp: item.timestamp * 1000,
          type,
          protocol: item.protocolName || "",
          protocolId: (item.protocol as string) || "",
          agent: (item.agent as string) || "",
          amount: bs(amt),
          status: item.success ? "approved" : "blocked",
          reason: item.success ? undefined : item.description,
          txSignature: item.txSignature,
        }),
      };
    });

    if (filters?.agent) rows = rows.filter((r) => r.agent === filters.agent);
    if (filters?.protocol)
      rows = rows.filter(
        (r) =>
          r.protocolId === filters.protocol || r.protocol === filters.protocol,
      );
    if (filters?.status) rows = rows.filter((r) => r.status === filters.status);
    if (filters?.timeRange) {
      const cutoff = Date.now() - rangeToMs(filters.timeRange);
      rows = rows.filter((r) => r.timestamp >= cutoff);
    }

    const approved = rows.filter((r) => r.status === "approved").length;
    const blocked = rows.length - approved;
    const volume = rows.reduce((s, r) => s + r.amount, 0n);

    return {
      rows,
      summary: { total: rows.length, approved, blocked, volume },
      toJSON: () => ({
        rows: rows.map((r) => r.toJSON()),
        summary: { total: rows.length, approved, blocked, volume: bs(volume) },
      }),
    };
  } catch (err) {
    throw toDxError(err, "OwnerClient.getActivity");
  }
}

function mapCategory(
  cat: string,
  evt: string,
  actionType?: string,
): ActivityType {
  if (cat === "trade") {
    // ActionAuthorized carries actionType to distinguish swap vs lend vs perps
    if (actionType) {
      const at = actionType.toLowerCase();
      if (
        at.includes("lend") ||
        at.includes("deposit") ||
        at.includes("withdraw")
      )
        return "lend";
      if (
        at.includes("open") ||
        at === "openposition" ||
        at === "swapandopenposition"
      )
        return "open_position";
      if (at.includes("close") || at === "closeposition")
        return "close_position";
    }
    if (evt.includes("Open")) return "open_position";
    if (evt.includes("Close")) return "close_position";
    return "swap";
  }
  if (cat === "deposit") return "deposit";
  if (cat === "withdrawal") return "withdraw";
  if (evt === "AgentTransferExecuted") return "transfer";
  return "swap";
}

function rangeToMs(r: string): number {
  const map: Record<string, number> = {
    "1h": 3600000,
    "6h": 21600000,
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
  };
  return map[r] ?? 86400000;
}

// ─── getHealth ───────────────────────────────────────────────────────────────

export async function getHealth(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: "devnet" | "mainnet",
): Promise<HealthData> {
  try {
    const state = await resolveVaultStateForOwner(
      rpc,
      vault,
      undefined,
      toNet(network),
    );
    const posture = getSecurityPosture(asVaultState(state));
    const alerts = evaluateAlertConditions(state, vault);

    const level =
      posture.criticalFailures.length > 0
        ? ("critical" as const)
        : posture.failCount > 0
          ? ("elevated" as const)
          : ("healthy" as const);

    const critAlerts = alerts.filter((a: any) => a.severity === "critical");
    const lastBlock =
      critAlerts.length > 0
        ? {
            agent: (critAlerts[0].agentAddress as string) || "",
            reason: critAlerts[0].title as string,
            amount: 0n,
            timestamp: Date.now(),
          }
        : undefined;

    const checks = posture.checks.map((c: any) => ({
      name: c.id,
      passed: c.passed,
    }));

    return {
      level,
      blockedCount24h: critAlerts.length,
      checks,
      lastBlock,
      toJSON: () => ({
        level,
        blockedCount24h: critAlerts.length,
        checks,
        lastBlock: lastBlock
          ? { ...lastBlock, amount: bs(lastBlock.amount) }
          : undefined,
      }),
    };
  } catch (err) {
    throw toDxError(err, "OwnerClient.getHealth");
  }
}

// ─── getPolicy ───────────────────────────────────────────────────────────────

export async function getPolicy(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: "devnet" | "mainnet",
): Promise<PolicyData> {
  try {
    const [state, pendingPolicy] = await Promise.all([
      resolveVaultStateForOwner(rpc, vault, undefined, toNet(network)),
      getPendingPolicyForVault(rpc, vault).catch((err: any) => {
        // Account-not-found is expected (no pending update) — return null.
        // Re-throw RPC errors so they're not silently swallowed.
        if (
          err?.message?.includes("could not find") ||
          err?.message?.includes("Account does not exist")
        ) {
          return null;
        }
        throw err;
      }),
    ]);

    const p = state.policy as PolicyConfig;
    const protocols = (p.protocols || []) as Address[];

    const approvedApps = protocols.map((addr: Address) => ({
      name: resolveProtocolName(addr),
      programId: addr as string,
    }));

    const modeMap: Record<number, PolicyData["protocolMode"]> = {
      0: "unrestricted",
      1: "whitelist",
      2: "blacklist",
    };

    const dailyCap = p.dailySpendingCapUsd as bigint;
    const maxPerTrade = p.maxTransactionSizeUsd ?? 0n;
    const protocolCaps = (p.protocolCaps || []) as bigint[];
    const sessionExpiry = p.sessionExpirySlots as bigint;
    const policyVer = (p.policyVersion ?? 0n) as bigint;
    const timelockSec = Number(p.timelockDuration);

    let pendingUpdate: PolicyData["pendingUpdate"];
    if (pendingPolicy) {
      const pp = pendingPolicy as PendingPolicyUpdate;
      const executesAtSec = Number(pp.executesAt ?? 0);
      const appliesAt = Number.isFinite(executesAtSec)
        ? executesAtSec * 1000
        : 0;
      const nowSec = Math.floor(Date.now() / 1000);

      // Decode each Option<T> field from PendingPolicyUpdate. Only Some fields
      // land in `changes`. 14 fields total — every timelockable PolicyConfig field.
      // Source: programs/sigil/src/state/pending_policy.rs
      const changes: Partial<PolicyChanges> = {};
      if (isSome(pp.dailySpendingCapUsd))
        changes.dailyCap = pp.dailySpendingCapUsd.value;
      if (isSome(pp.maxTransactionAmountUsd))
        changes.maxPerTrade = pp.maxTransactionAmountUsd.value;
      if (isSome(pp.protocols)) changes.approvedApps = pp.protocols.value;
      if (isSome(pp.protocolMode))
        changes.protocolMode = modeMap[pp.protocolMode.value] || "unrestricted";
      if (isSome(pp.hasProtocolCaps))
        changes.hasProtocolCaps = pp.hasProtocolCaps.value;
      if (isSome(pp.protocolCaps)) changes.protocolCaps = pp.protocolCaps.value;
      if (isSome(pp.canOpenPositions))
        changes.canOpenPositions = pp.canOpenPositions.value;
      if (isSome(pp.maxConcurrentPositions))
        changes.maxConcurrentPositions = pp.maxConcurrentPositions.value;
      if (isSome(pp.maxSlippageBps))
        changes.maxSlippageBps = pp.maxSlippageBps.value;
      if (isSome(pp.maxLeverageBps))
        changes.leverageLimit = pp.maxLeverageBps.value;
      if (isSome(pp.allowedDestinations))
        changes.allowedDestinations = pp.allowedDestinations.value;
      if (isSome(pp.developerFeeRate))
        changes.developerFeeRate = pp.developerFeeRate.value;
      if (isSome(pp.sessionExpirySlots))
        changes.sessionExpirySlots = pp.sessionExpirySlots.value;
      if (isSome(pp.timelockDuration))
        changes.timelock = Number(pp.timelockDuration.value);

      pendingUpdate = {
        changes,
        appliesAt,
        canApply: executesAtSec > 0 && executesAtSec <= nowSec,
        canCancel: true,
      };
    }

    return {
      dailyCap,
      maxPerTrade,
      approvedApps,
      protocolMode: modeMap[p.protocolMode] || "unrestricted",
      hasProtocolCaps: p.hasProtocolCaps as boolean,
      protocolCaps,
      canOpenPositions: p.canOpenPositions as boolean,
      maxConcurrentPositions: p.maxConcurrentPositions as number,
      maxSlippageBps: p.maxSlippageBps as number,
      leverageLimitBps: p.maxLeverageBps as number,
      allowedDestinations: (p.allowedDestinations || []) as string[],
      developerFeeRate: p.developerFeeRate as number,
      sessionExpirySlots: sessionExpiry,
      timelockSeconds: timelockSec,
      policyVersion: policyVer,
      pendingUpdate,
      toJSON: () => ({
        dailyCap: bs(dailyCap),
        maxPerTrade: bs(maxPerTrade),
        approvedApps,
        protocolMode: modeMap[p.protocolMode] || "unrestricted",
        hasProtocolCaps: p.hasProtocolCaps,
        protocolCaps: protocolCaps.map(bs),
        canOpenPositions: p.canOpenPositions,
        maxConcurrentPositions: p.maxConcurrentPositions,
        maxSlippageBps: p.maxSlippageBps,
        leverageLimitBps: p.maxLeverageBps,
        allowedDestinations: (p.allowedDestinations || []) as string[],
        developerFeeRate: p.developerFeeRate,
        sessionExpirySlots: bs(sessionExpiry),
        timelockSeconds: timelockSec,
        policyVersion: bs(policyVer),
        pendingUpdate: pendingUpdate
          ? {
              changes: serializeBigints(pendingUpdate.changes) as Record<
                string,
                unknown
              >,
              appliesAt: pendingUpdate.appliesAt,
              canApply: pendingUpdate.canApply,
              canCancel: pendingUpdate.canCancel,
            }
          : undefined,
      }),
    };
  } catch (err) {
    throw toDxError(err, "OwnerClient.getPolicy");
  }
}
