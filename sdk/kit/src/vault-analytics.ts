/**
 * Vault analytics — health assessment and one-call summary.
 *
 * getVaultHealth(): Pure function (no RPC) — derives health, cap metrics,
 * security checks from already-resolved vault state.
 *
 * getVaultSummary(): Async function — parallel RPC calls for state, P&L,
 * balances, pending policy. Returns everything a vault detail page needs.
 */

import type { Address, Rpc, SolanaRpcApi } from "./kit-adapter.js";
import { computeUtilizationPercent } from "./math-utils.js";
import type {
  ResolvedVaultState,
  ResolvedVaultStateForOwner,
} from "./state-resolver.js";
import { VaultStatus } from "./generated/types/vaultStatus.js";
import {
  resolveVaultStateForOwner,
  getPendingPolicyForVault,
} from "./state-resolver.js";
import { isAccountNotFoundError } from "./dashboard/errors.js";
import {
  getVaultPnL,
  getVaultTokenBalances,
  type VaultPnL,
  type TokenBalance,
} from "./balance-tracker.js";
import { getSpendingVelocity } from "./spending-analytics.js";
import {
  FULL_CAPABILITY,
  PROTOCOL_MODE_ALLOWLIST,
  EPOCH_DURATION,
  NUM_EPOCHS,
  type Network,
} from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VaultSecurityCheck {
  id: string;
  label: string;
  passed: boolean;
  severity: "critical" | "warning" | "info";
}

export interface VaultHealth {
  status: "Active" | "Frozen" | "Closed";
  /** Active + has agents + not approaching caps */
  isHealthy: boolean;
  agentCount: number;
  pausedAgentCount: number;
  openPositions: number;
  activeEscrowCount: number;
  /** 0-100 percentage of daily cap used */
  capUtilization: number;
  /** USD base units remaining in 24h window */
  capRemaining: bigint;
  /** Seconds until the oldest epoch rolls off and frees cap space. */
  capResetsIn: number;
  /** Seconds until cap would be hit at current rate. null = safe. */
  timeToCapAtCurrentRate: number | null;
  hasConstraints: boolean;
  hasTimelock: boolean;
  timelockDuration: number;
  hasPendingPolicyChange: boolean;
  /** Unix timestamp of most recent tracker activity. 0 if none. */
  lastActivityTimestamp: number;
  securityChecks: VaultSecurityCheck[];
}

export interface VaultStats {
  totalTransactions: bigint;
  totalVolume: bigint;
  totalFeesCollected: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  createdAt: bigint;
  /** Days since vault creation (min 1) */
  ageInDays: number;
  /** totalVolume / ageInDays (0 if vault < 1 day old) */
  avgDailyVolume: bigint;
  /** totalVolume / totalTransactions (0 if no transactions) */
  avgTransactionSize: bigint;
  /** totalFeesCollected as BPS of totalVolume */
  feeRate: number;
}

export interface VaultSummary {
  address: Address;
  owner: Address;
  vaultId: bigint;
  health: VaultHealth;
  pnl: VaultPnL;
  tokenBalances: TokenBalance[];
  totalValueUsd: bigint;
  state: ResolvedVaultStateForOwner;
  stats: VaultStats;
}

// ─── getVaultHealth ──────────────────────────────────────────────────────────

/**
 * Single-call vault health assessment. Pure function — no RPC.
 *
 * Derives isHealthy, capUtilization, capResetsIn, security checks from
 * already-resolved vault state. The dashboard vault card renders this directly.
 */
export function getVaultHealth(
  state: ResolvedVaultState | ResolvedVaultStateForOwner,
  nowUnix: bigint,
): VaultHealth {
  const { vault, policy, tracker, globalBudget, constraints } = state;

  // VaultStatus is a numeric enum (Active=0, Frozen=1, Closed=2).
  // Use reverse mapping for display string.
  const STATUS_NAMES: Record<number, VaultHealth["status"]> = {
    [VaultStatus.Active]: "Active",
    [VaultStatus.Frozen]: "Frozen",
    [VaultStatus.Closed]: "Closed",
  };
  const status = STATUS_NAMES[vault.status as number] ?? "Closed";
  const agentCount = vault.agents.length;
  const pausedAgentCount = vault.agents.filter((a) => a.paused).length;

  // Cap utilization
  const capUtilization = computeUtilizationPercent(
    globalBudget.spent24h,
    globalBudget.cap,
  );

  // Cap reset time: when does the oldest epoch in the window roll off?
  let capResetsIn = 0;
  if (tracker) {
    const epochDuration = BigInt(EPOCH_DURATION);
    const currentEpoch = nowUnix / epochDuration;
    let oldestEpoch = currentEpoch;
    for (const bucket of tracker.buckets) {
      if (bucket.usdAmount > 0n && bucket.epochId > 0n) {
        if (
          bucket.epochId >= currentEpoch - BigInt(NUM_EPOCHS) &&
          bucket.epochId < oldestEpoch
        ) {
          oldestEpoch = bucket.epochId;
        }
      }
    }
    const expiresAt = (oldestEpoch + BigInt(NUM_EPOCHS)) * epochDuration;
    capResetsIn = Math.max(0, Number(expiresAt - nowUnix));
  }

  // Velocity for time-to-cap
  const velocity = getSpendingVelocity(tracker, nowUnix, globalBudget);

  // Security checks
  const securityChecks: VaultSecurityCheck[] = [
    {
      id: "no-full-perms",
      label: "No agent has full capability",
      passed: !vault.agents.some(
        (a) => a.capability === Number(FULL_CAPABILITY),
      ),
      severity: "critical",
    },
    {
      id: "cap-configured",
      label: "Daily spending cap is configured",
      passed: policy.dailySpendingCapUsd > 0n,
      severity: "critical",
    },
    {
      id: "agent-limits",
      label: "All agents have spending limits",
      passed: vault.agents.every((a) => a.spendingLimitUsd > 0n),
      severity: "warning",
    },
    {
      id: "protocol-allowlist",
      label: "Protocol mode is allowlist",
      passed: policy.protocolMode === PROTOCOL_MODE_ALLOWLIST,
      severity: "warning",
    },
    {
      id: "timelock-enabled",
      label: "Policy timelock is enabled",
      passed: policy.timelockDuration > 0n,
      severity: "warning",
    },
    {
      id: "slippage-reasonable",
      label: "Max slippage below 10%",
      passed: policy.maxSlippageBps < 1000,
      severity: "warning",
    },
    {
      id: "constraints-configured",
      label: "Instruction constraints are set",
      passed: constraints !== null,
      severity: "info",
    },
  ];

  const criticalFailures = securityChecks.filter(
    (c) => c.severity === "critical" && !c.passed,
  );

  const isHealthy =
    status === "Active" &&
    agentCount > 0 &&
    pausedAgentCount < agentCount &&
    capUtilization < 95 &&
    criticalFailures.length === 0;

  return {
    status,
    isHealthy,
    agentCount,
    pausedAgentCount,
    openPositions: vault.openPositions,
    activeEscrowCount: vault.activeEscrowCount,
    capUtilization,
    capRemaining: globalBudget.remaining,
    capResetsIn,
    timeToCapAtCurrentRate: velocity.timeToCapSeconds,
    hasConstraints: constraints !== null,
    hasTimelock: policy.timelockDuration > 0n,
    timelockDuration: Number(policy.timelockDuration),
    hasPendingPolicyChange: false, // Overridden by getVaultSummary()
    lastActivityTimestamp:
      tracker && tracker.lastWriteEpoch > 0n
        ? Number(tracker.lastWriteEpoch * BigInt(EPOCH_DURATION))
        : 0,
    securityChecks,
  };
}

// ─── getVaultSummary ─────────────────────────────────────────────────────────

/**
 * Complete vault summary in one call. Parallel RPC for state, P&L, balances,
 * pending policy. Returns everything the vault detail page header needs.
 */
export async function getVaultSummary(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: Network = "mainnet-beta",
): Promise<VaultSummary> {
  const [state, pnl, tokenBalances, pendingPolicy] = await Promise.all([
    resolveVaultStateForOwner(rpc, vault, undefined, network),
    getVaultPnL(rpc, vault, network),
    getVaultTokenBalances(rpc, vault, network),
    getPendingPolicyForVault(rpc, vault).catch((err: unknown) => {
      // Account-not-found is expected (no pending update) — return null.
      // Re-throw everything else (RPC transport, decode failures) so the
      // caller surfaces real errors rather than silently seeing
      // `pendingPolicy: null` on an unrelated outage.
      if (isAccountNotFoundError(err)) return null;
      throw err;
    }),
  ]);

  const nowUnix = state.resolvedAtTimestamp;
  const health = getVaultHealth(state, nowUnix);
  health.hasPendingPolicyChange = pendingPolicy !== null;

  const v = state.vault;
  const createdAtSec = Number(v.createdAt);
  const nowSec = Number(nowUnix);
  const ageInDays = Math.max(1, Math.floor((nowSec - createdAtSec) / 86400));

  const stats: VaultStats = {
    totalTransactions: v.totalTransactions,
    totalVolume: v.totalVolume,
    totalFeesCollected: v.totalFeesCollected,
    totalDeposited: v.totalDepositedUsd,
    totalWithdrawn: v.totalWithdrawnUsd,
    createdAt: v.createdAt,
    ageInDays,
    avgDailyVolume: ageInDays > 0 ? v.totalVolume / BigInt(ageInDays) : 0n,
    avgTransactionSize:
      v.totalTransactions > 0n ? v.totalVolume / v.totalTransactions : 0n,
    feeRate:
      v.totalVolume > 0n
        ? Number((v.totalFeesCollected * 10000n) / v.totalVolume)
        : 0,
  };

  const totalValueUsd =
    state.stablecoinBalances.usdc + state.stablecoinBalances.usdt;

  return {
    address: vault,
    owner: v.owner,
    vaultId: v.vaultId,
    health,
    pnl,
    tokenBalances,
    totalValueUsd,
    state,
    stats,
  };
}
