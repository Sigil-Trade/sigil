/**
 * @usesigil/kit/dashboard — Read functions for OwnerClient.
 *
 * Each function is stateless (fetches fresh from RPC), composes existing
 * SDK functions, and returns raw values with toJSON() for MCP serialization.
 *
 * S14: the five view types are composed by pure `build*` helpers that take a
 * shared {@link OverviewContext}. The existing reads each assemble their own
 * context with minimal fetches; `getOverview` fetches once and shares the
 * context across all helpers so derived values (security posture etc.) are
 * computed exactly once.
 */

import { isSome } from "../kit-adapter.js";
import type { Address, Rpc, SolanaRpcApi } from "../kit-adapter.js";
import { getSigilModuleLogger } from "../logger.js";
import { toDxError, isAccountNotFoundError } from "./errors.js";
import { redactCause } from "../network-errors.js";
import { computeUtilizationPercent } from "../math-utils.js";
import {
  resolveVaultStateForOwner,
  getSpendingHistory,
  getPendingPolicyForVault,
} from "../state-resolver.js";
import { getVaultPnL, getVaultPnLFromState } from "../balance-tracker.js";
import { getSecurityPosture } from "../security-analytics.js";
import { evaluateAlertConditions } from "../security-analytics.js";
import type { SecurityCheck, Alert } from "../security-analytics.js";
import { getAgentProfile } from "../agent-analytics.js";
import { getSpendingBreakdown } from "../spending-analytics.js";
import type { SpendingBreakdown } from "../spending-analytics.js";
import { getVaultActivity } from "../event-analytics.js";
import type { VaultActivityItem } from "../event-analytics.js";
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
  OverviewContext,
  OverviewData,
  GetOverviewOptions,
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

/**
 * Default size of the activity window included in `getOverview`. Consumers
 * may override via `GetOverviewOptions.activityLimit`.
 *
 * The value matches `getAgents`' existing per-agent enrichment window so one
 * fetch serves both the overview's activity feed and the agents' last-action
 * fields without inflating RPC cost.
 */
export const DEFAULT_OVERVIEW_ACTIVITY_LIMIT = 100;

// Shared account-not-found predicate now lives in `./errors.js` — see
// `isAccountNotFoundError` for the typed-primary + substring-fallback
// implementation covering four Solana error codes.

// ─── Build helpers (pure composition — no RPC) ───────────────────────────────
// Each helper accepts an OverviewContext and returns one view type. `getOverview`
// pre-populates memoized derivations (posture/breakdown/alerts) so repeat calls
// share one computation; existing reads pass a minimal ctx and the helper
// derives what it needs from `ctx.state`.

/**
 * Guard for state fields that `resolveVaultStateForOwner` normally guarantees.
 *
 * `state.vault` and `state.policy` are non-null on any success path from the
 * resolver, but consumers that hand-construct an {@link OverviewContext} for
 * testing or custom composition could pass a partial shape. Fail fast with a
 * labeled error instead of a cryptic "cannot read properties of null".
 */
function requireCtxField<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new Error(
      `[dashboard/reads] OverviewContext.state.${field} is required but missing`,
    );
  }
  return value;
}

/**
 * Compose {@link VaultState} from a pre-fetched {@link OverviewContext}.
 *
 * Requires `ctx.state`. Uses `ctx.pnl` when present; otherwise defaults to
 * zero P&L. Uses `ctx.posture` when memoized; otherwise computes from state.
 *
 * @experimental Part of the `build*` composition surface introduced alongside
 * `getOverview` (S14). Signature and JSON shape may shift before v1.0; if you
 * depend on it, pin your SDK version and watch the changeset.
 *
 * @see OwnerClient.getOverview — the stable single-call alternative that
 * pre-populates a full {@link OverviewContext} for you.
 */
export function buildVaultState(ctx: OverviewContext): VaultState {
  const v = requireCtxField(ctx.state.vault, "vault") as AgentVault;
  const posture = ctx.posture ?? getSecurityPosture(asVaultState(ctx.state));
  const pnlPercent =
    ctx.pnl && Number.isFinite(ctx.pnl.pnlPercent) ? ctx.pnl.pnlPercent : 0;
  const pnlAbsolute = ctx.pnl ? ctx.pnl.pnl : 0n;

  const bal = ctx.state.stablecoinBalances;
  const total = bal.usdc + bal.usdt;

  const tokens = [
    ...(bal.usdc > 0n ? [{ mint: "USDC", amount: bal.usdc, decimals: 6 }] : []),
    ...(bal.usdt > 0n ? [{ mint: "USDT", amount: bal.usdt, decimals: 6 }] : []),
  ];

  const checks = posture.checks.map((c: SecurityCheck) => ({
    name: c.id,
    passed: c.passed,
  }));
  const level =
    posture.criticalFailures.length > 0
      ? ("critical" as const)
      : posture.failCount > 0
        ? ("elevated" as const)
        : ("healthy" as const);

  const vaultAddr = ctx.vault;
  const status = (
    v.status === 0 ? "active" : v.status === 1 ? "frozen" : "closed"
  ) as VaultState["vault"]["status"];

  return {
    vault: {
      address: vaultAddr,
      status,
      owner: v.owner as string,
      agentCount: v.agents?.length ?? 0,
      totalVolume: v.totalVolume,
      totalFees: v.totalFeesCollected,
    },
    balance: { total, tokens },
    pnl: { percent: pnlPercent, absolute: pnlAbsolute },
    health: { level, alertCount: posture.failCount, checks },
    toJSON: () => ({
      vault: {
        address: vaultAddr,
        status,
        owner: v.owner as string,
        agentCount: v.agents?.length ?? 0,
        totalVolume: bs(v.totalVolume),
        totalFees: bs(v.totalFeesCollected),
      },
      balance: {
        total: bs(total),
        tokens: tokens.map((t) => ({ ...t, amount: bs(t.amount) })),
      },
      pnl: { percent: pnlPercent, absolute: bs(pnlAbsolute) },
      health: { level, alertCount: posture.failCount, checks },
    }),
  };
}

/**
 * Compose {@link AgentData}[] from a pre-fetched {@link OverviewContext}.
 *
 * Requires `ctx.state`. Uses `ctx.activity` to populate per-agent last-action
 * and blocked-count fields; when absent, those fields default to empty/zero.
 *
 * @experimental Part of the `build*` composition surface (S14). Signature and
 * JSON shape may shift before v1.0.
 *
 * @see OwnerClient.getOverview — the stable single-call alternative that
 * pre-populates a full {@link OverviewContext} for you.
 */
export function buildAgents(ctx: OverviewContext): AgentData[] {
  const state = ctx.state;
  const v = requireCtxField(state.vault, "vault") as AgentVault;
  const vaultAgents = v.agents;
  if (!vaultAgents || vaultAgents.length === 0) return [];

  const activity = ctx.activity ?? [];
  const blockedCutoffMs = Date.now() - 24 * 3600 * 1000;

  return vaultAgents.map((entry) => {
    const addr = entry.pubkey;
    const profile = getAgentProfile(asVaultState(state), addr);
    const budget = state.allAgentBudgets.get(addr);

    const spentAmt = budget?.spent24h ?? 0n;
    const capAmt = budget?.cap ?? 0n;
    const pct = computeUtilizationPercent(spentAmt, capAmt);

    // Items are newest-first (getSignaturesForAddress ordering).
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
}

/**
 * Compose {@link SpendingData} from a pre-fetched {@link OverviewContext}.
 *
 * Requires `ctx.state`. Uses `ctx.breakdown` when memoized.
 *
 * @experimental Part of the `build*` composition surface (S14). Signature and
 * JSON shape may shift before v1.0.
 *
 * @see OwnerClient.getOverview — the stable single-call alternative that
 * pre-populates a full {@link OverviewContext} for you.
 */
export function buildSpending(ctx: OverviewContext): SpendingData {
  const state = ctx.state;
  const breakdown = ctx.breakdown ?? getSpendingBreakdown(asVaultState(state));
  const nowUnix = BigInt(Math.floor(Date.now() / 1000));
  const epochs = getSpendingHistory(state.tracker, nowUnix);

  const chart: ChartPoint[] = epochs.map((e) => ({
    time: new Date(e.timestamp * 1000).toISOString(),
    amount: Number(e.usdAmount) / 1_000_000,
  }));

  const { spent24h: spent, cap, remaining } = state.globalBudget;
  const percent = computeUtilizationPercent(spent, cap);
  const velocityPerMs = spent > 0n ? Number(spent) / (24 * 3600 * 1000) : 0;
  const rundown =
    velocityPerMs > 0 && remaining > 0n
      ? Math.floor(Number(remaining) / velocityPerMs)
      : 0;

  const protoBreak = breakdown.byProtocol.map(
    (p: SpendingBreakdown["byProtocol"][number]) => ({
      name: resolveProtocolName(p.protocol),
      programId: p.protocol as string,
      amount: p.spent24h,
      percent: p.utilization,
    }),
  );

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
}

/**
 * Compose {@link HealthData} from a pre-fetched {@link OverviewContext}.
 *
 * Requires `ctx.state.vault` when neither `ctx.posture` nor `ctx.alerts` is
 * memoized (downstream `getSecurityPosture` / `evaluateAlertConditions`
 * dereference it). Fully memoized callers can pass a minimal state shape.
 *
 * @experimental Part of the `build*` composition surface (S14). Signature and
 * JSON shape may shift before v1.0.
 *
 * @see OwnerClient.getOverview — the stable single-call alternative that
 * pre-populates a full {@link OverviewContext} for you.
 */
export function buildHealth(ctx: OverviewContext): HealthData {
  // When both posture and alerts are memoized, the helpers below never run
  // and state.vault is untouched — the memoized path is the whole point of
  // OverviewContext. Guard only when at least one derivation will execute.
  if (ctx.posture === undefined || ctx.alerts === undefined) {
    requireCtxField(ctx.state.vault, "vault");
  }
  const posture = ctx.posture ?? getSecurityPosture(asVaultState(ctx.state));
  const alerts = ctx.alerts ?? evaluateAlertConditions(ctx.state, ctx.vault);

  const level =
    posture.criticalFailures.length > 0
      ? ("critical" as const)
      : posture.failCount > 0
        ? ("elevated" as const)
        : ("healthy" as const);

  const critAlerts = alerts.filter((a: Alert) => a.severity === "critical");
  const lastBlock =
    critAlerts.length > 0
      ? {
          agent: (critAlerts[0].agentAddress as string) || "",
          reason: critAlerts[0].title as string,
          amount: 0n,
          timestamp: Date.now(),
        }
      : undefined;

  const checks = posture.checks.map((c: SecurityCheck) => ({
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
}

/**
 * Compose {@link PolicyData} from a pre-fetched {@link OverviewContext}.
 *
 * Requires `ctx.state`. Uses `ctx.pendingPolicy` (which may be `null` to mean
 * "confirmed no pending update"); when `undefined` treats as no pending update.
 *
 * @experimental Part of the `build*` composition surface (S14). Signature and
 * JSON shape may shift before v1.0.
 *
 * @see OwnerClient.getOverview — the stable single-call alternative that
 * pre-populates a full {@link OverviewContext} for you.
 */
export function buildPolicy(ctx: OverviewContext): PolicyData {
  const state = ctx.state;
  const pendingPolicy = ctx.pendingPolicy ?? null;

  const p = requireCtxField(state.policy, "policy") as PolicyConfig;
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
    // pp.executesAt is a Solana timestamp (seconds since epoch) — always within
    // Number.MAX_SAFE_INTEGER for realistic chain state, so Number() is safe.
    const executesAtSec = Number(pp.executesAt ?? 0);
    const appliesAt = executesAtSec * 1000;
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
}

/**
 * Map raw {@link VaultActivityItem}[] to {@link ActivityRow}[] with stable
 * derived IDs and toJSON serializers. Pure — no filtering applied.
 *
 * Both `getActivity` (which then filters) and `getOverview` (which returns
 * unfiltered) consume the output.
 *
 * @experimental Part of the `build*` composition surface (S14). Signature and
 * JSON shape may shift before v1.0.
 *
 * @see OwnerClient.getOverview — the stable single-call alternative that
 * pre-populates a full {@link OverviewContext} for you.
 */
export function buildActivityRows(
  items: readonly VaultActivityItem[],
): ActivityRow[] {
  return items.map((item) => {
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
    return buildVaultState({ vault, state, pnl });
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
    // Single getVaultActivity call is shared across all agents (N+1 prevention).
    // Activity is enrichment, so a fetch failure degrades gracefully to empty
    // last-action fields. Window: 100 most recent signatures — large enough to
    // surface last action for low-volume agents without inflating RPC cost.
    //
    // Fix for docs/SECURITY-FINDINGS-2026-04-07.md Finding 5: the previous
    // Graceful degradation with observable failure (activity is enrichment,
    // not core). Previously used a bare `.catch(() => [])` that silently
    // returned empty on any Helius rate-limit or outage; now logs a
    // redacted cause so operators can correlate "last action: never" with
    // an actual upstream error.
    const [state, activity] = await Promise.all([
      resolveVaultStateForOwner(rpc, vault, undefined, toNet(network)),
      getVaultActivity(rpc, vault, 100, toNet(network)).catch(
        (err: unknown) => {
          // Redact via `redactCause` (PR 1.B discipline) — a Helius URL
          // carrying an API key in the path would otherwise leak into
          // the console.warn.
          const cause = redactCause(err);
          getSigilModuleLogger().warn(
            "[OwnerClient.getAgents] activity enrichment failed — falling back to empty last-action fields",
            { cause: cause.message ?? cause.name ?? cause.code ?? "unknown" },
          );
          return [];
        },
      ),
    ]);
    return buildAgents({ vault, state, activity });
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
    return buildSpending({ vault, state });
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
    let rows = buildActivityRows(items);

    if (filters?.agent) rows = rows.filter((r) => r.agent === filters.agent);
    if (filters?.protocol)
      rows = rows.filter(
        (r) =>
          r.protocolId === filters.protocol || r.protocol === filters.protocol,
      );
    if (filters?.status) rows = rows.filter((r) => r.status === filters.status);
    if (filters?.type) rows = rows.filter((r) => r.type === filters.type);
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
    // Position counter deletion (council 9-1 vote, 2026-04-19) collapsed all
    // trade events into "swap" by default. Legacy actionType decode is still
    // honored for historical (pre-v6) events in storage — "lend" is preserved
    // for deposit/withdraw-style lending actions that aren't stablecoin flows.
    if (actionType) {
      const at = actionType.toLowerCase();
      if (
        at.includes("lend") ||
        at.includes("deposit") ||
        at.includes("withdraw")
      )
        return "lend";
    }
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
    return buildHealth({ vault, state });
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
      getPendingPolicyForVault(rpc, vault).catch((err: unknown) => {
        // Account-not-found is expected (no pending update) — return null.
        // Re-throw RPC errors so they're not silently swallowed.
        if (isAccountNotFoundError(err)) return null;
        throw err;
      }),
    ]);
    return buildPolicy({ vault, state, pendingPolicy });
  } catch (err) {
    throw toDxError(err, "OwnerClient.getPolicy");
  }
}

// ─── getOverview (S14) ───────────────────────────────────────────────────────

/**
 * Single-call overview bundle — resolves vault state once, composes all five
 * view types (vault, agents, spending, health, policy) plus a raw activity
 * list, with PnL derived from the resolved state (no duplicate resolve).
 *
 * **Actual RPC shape.** Calling the five individual reads duplicates the
 * vault-state resolution up to five times. `getOverview` resolves state
 * exactly once and computes PnL from it via {@link getVaultPnLFromState}.
 * The activity fetch is independent: `getVaultActivity(limit)` issues one
 * `getSignaturesForAddress` followed by up to `limit` sequential
 * `getTransaction` calls, so the wall-time cost of the activity feed
 * dominates regardless of this method. Net savings vs. five separate reads:
 * state resolution count drops from ~5 → 1.
 *
 * Activity is **unfiltered**. For filtered activity, call {@link getActivity}
 * with `ActivityFilters`.
 *
 * Graceful degradation: activity fetch failure degrades to empty activity
 * (same observable pattern as `getAgents`, documented in
 * `docs/SECURITY-FINDINGS-2026-04-07.md` Finding 5); pending-policy
 * account-not-found is treated as "no pending update" (same as `getPolicy`).
 * **PnL and state-resolution errors are NOT degraded** and propagate via
 * `toDxError`. A pending-policy error that is NOT account-not-found (e.g.
 * network failure) also propagates — it is NOT treated as "no pending
 * update", even on the `includeActivity: false` lightweight path.
 */
export async function getOverview(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: "devnet" | "mainnet",
  options?: GetOverviewOptions,
): Promise<OverviewData> {
  try {
    const includeActivity = options?.includeActivity ?? true;
    const activityLimit =
      options?.activityLimit ?? DEFAULT_OVERVIEW_ACTIVITY_LIMIT;
    const net = toNet(network);

    // Fan out every independent fetch in one Promise.all. State resolution,
    // activity, and pending-policy have no cross-dependency, so wall time
    // collapses to the slowest of the three. PnL is derived from state
    // synchronously after — one state resolve, zero duplication.
    const [state, activity, pendingPolicy] = await Promise.all([
      resolveVaultStateForOwner(rpc, vault, undefined, net),
      includeActivity
        ? getVaultActivity(rpc, vault, activityLimit, net).catch(
            (err: unknown) => {
              // Same graceful-degradation pattern as getAgents. Redacted
              // via the PR 1.B `redactCause` discipline so upstream
              // request URLs / tokens don't end up in stdout.
              const cause = redactCause(err);
              getSigilModuleLogger().warn(
                "[OwnerClient.getOverview] activity fetch failed — falling back to empty",
                {
                  cause: cause.message ?? cause.name ?? cause.code ?? "unknown",
                },
              );
              return [] as VaultActivityItem[];
            },
          )
        : Promise.resolve<VaultActivityItem[] | undefined>(undefined),
      getPendingPolicyForVault(rpc, vault).catch((err: unknown) => {
        if (isAccountNotFoundError(err)) return null;
        throw err;
      }),
    ]);

    // PnL is pure from resolved state — no extra RPC.
    const pnl = getVaultPnLFromState(state);

    // Compute the three state-derived values exactly once and memoize on ctx.
    // Every build* helper reads these via the `ctx.field ?? derive()` fallback
    // so the memoized value short-circuits re-derivation.
    const posture = getSecurityPosture(asVaultState(state));
    const breakdown = getSpendingBreakdown(asVaultState(state));
    const alerts = evaluateAlertConditions(state, vault);

    const ctx: OverviewContext = {
      vault,
      state,
      pnl,
      activity,
      pendingPolicy,
      posture,
      breakdown,
      alerts,
    };

    const vaultView = buildVaultState(ctx);
    const agentsView = buildAgents(ctx);
    const spendingView = buildSpending(ctx);
    const healthView = buildHealth(ctx);
    const policyView = buildPolicy(ctx);
    const activityRows = buildActivityRows(activity ?? []);

    return {
      vault: vaultView,
      agents: agentsView,
      spending: spendingView,
      health: healthView,
      policy: policyView,
      activity: activityRows,
      toJSON: () => ({
        vault: vaultView.toJSON(),
        agents: agentsView.map((a) => a.toJSON()),
        spending: spendingView.toJSON(),
        health: healthView.toJSON(),
        policy: policyView.toJSON(),
        activity: activityRows.map((r) => r.toJSON()),
      }),
    };
  } catch (err) {
    throw toDxError(err, "OwnerClient.getOverview");
  }
}
