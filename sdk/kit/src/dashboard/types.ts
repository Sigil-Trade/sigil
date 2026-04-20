/**
 * @usesigil/kit/dashboard — Type definitions for the OwnerClient DX layer.
 *
 * Design principles:
 * - All amounts are bigint (6-decimal USD). No string formatting.
 * - Every return type has toJSON() for MCP/REST serialization (bigint → string).
 * - No UI concerns: no colors, icons, labels, or locale-specific strings.
 */

import type { Address, TransactionSigner } from "../kit-adapter.js";
import type { Rpc, SolanaRpcApi } from "../kit-adapter.js";
import type { ConstraintEntryArgs } from "../generated/types/constraintEntry.js";
import type { ResolvedVaultStateForOwner } from "../state-resolver.js";
import type { VaultPnL } from "../balance-tracker.js";
import type { VaultActivityItem } from "../event-analytics.js";
import type { PendingPolicyUpdate } from "../generated/accounts/pendingPolicyUpdate.js";
import type { SecurityPosture, Alert } from "../security-analytics.js";
import type { SpendingBreakdown } from "../spending-analytics.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface OwnerClientConfig {
  rpc: Rpc<SolanaRpcApi>;
  vault: Address;
  owner: TransactionSigner;
  network: "devnet" | "mainnet";
}

// ─── Transaction Types ───────────────────────────────────────────────────────

export interface TxResult {
  signature: string;
  toJSON(): { signature: string };
}

export interface TxOpts {
  /** Compute unit budget. Default: 200_000 (CU_OWNER_ACTION). */
  computeUnits?: number;
  /** Priority fee in micro-lamports. Default: 0. */
  priorityFeeMicroLamports?: number;
  /**
   * Constraint enforcement mode. Default: true (strict).
   * When false, agents can execute instructions that don't match any constraint entry.
   * Only applies to createConstraints and queueConstraintsUpdate.
   */
  strictMode?: boolean;
}

// ─── Vault State ─────────────────────────────────────────────────────────────

export interface VaultState {
  vault: {
    address: string;
    status: "active" | "frozen" | "closed";
    owner: string;
    agentCount: number;
    /** Lifetime USD volume (6-decimal). */
    totalVolume: bigint;
    totalFees: bigint;
  };
  balance: {
    /** Sum of all stablecoin ATAs (6-decimal USD). */
    total: bigint;
    tokens: TokenBalance[];
  };
  pnl: {
    /** Percentage P&L. 2.4 = +2.4%, -1.5 = -1.5%. */
    percent: number;
    /** Absolute P&L (6-decimal USD). Negative = loss. */
    absolute: bigint;
  };
  health: {
    level: "healthy" | "elevated" | "critical";
    alertCount: number;
    checks: HealthCheck[];
  };
  toJSON(): SerializedVaultState;
}

export interface TokenBalance {
  mint: string;
  amount: bigint;
  decimals: number;
}

export interface HealthCheck {
  name: string;
  passed: boolean;
}

// ─── Agent Data ──────────────────────────────────────────────────────────────

export interface AgentData {
  address: string;
  status: "active" | "paused";
  /** Human-readable capability label (Disabled/Observer/Operator). */
  capabilityLabel: string;
  /** Numeric capability: 0=Disabled, 1=Observer, 2=Operator. */
  capability: number;
  spending: {
    /** 24h rolling spend (6-decimal USD). */
    amount: bigint;
    /** Per-agent cap (6-decimal USD). */
    limit: bigint;
    /** Utilization: 0-100. */
    percent: number;
  };
  lastActionType: string;
  /** Protocol name from getProtocolName(). */
  lastActionProtocol: string;
  /** Unix ms. */
  lastActionTimestamp: number;
  blockedCount24h: number;
  toJSON(): SerializedAgentData;
}

// ─── Spending Data ───────────────────────────────────────────────────────────

export interface SpendingData {
  global: {
    /** 24h rolling spend (6-decimal USD). */
    today: bigint;
    cap: bigint;
    remaining: bigint;
    /** Utilization: 0-100. */
    percent: number;
    /** Milliseconds until cap hit at current velocity. */
    rundownMs: number;
  };
  /** 144 epoch buckets from SpendingEpoch[]. */
  chart: ChartPoint[];
  protocolBreakdown: ProtocolBreakdownEntry[];
  toJSON(): SerializedSpendingData;
}

export interface ChartPoint {
  /** ISO timestamp. */
  time: string;
  /** Raw numeric for chart axis. */
  amount: number;
}

export interface ProtocolBreakdownEntry {
  /** Human-readable name from getProtocolName(). */
  name: string;
  programId: string;
  amount: bigint;
  percent: number;
}

// ─── Activity Data ───────────────────────────────────────────────────────────

// ActivityType: "open_position" and "close_position" literals removed with
// position counter deletion (council 9-1 vote, 2026-04-19). All trade events
// now categorize as "swap" by default; "lend" still discriminated for
// deposit/withdraw flows.
export type ActivityType =
  | "swap"
  | "lend"
  | "transfer"
  | "deposit"
  | "withdraw";

export interface ActivityRow {
  id: string;
  /** Unix ms. */
  timestamp: number;
  type: ActivityType;
  /** Protocol name from getProtocolName(). */
  protocol: string;
  /** Program ID. */
  protocolId: string;
  /** Full pubkey. */
  agent: string;
  /** 6-decimal USD. */
  amount: bigint;
  status: "approved" | "blocked";
  /**
   * On-chain error name from errors.rs (e.g., "SpendingCapExceeded").
   * Only present for blocked transactions.
   */
  reason?: string;
  txSignature?: string;
  toJSON(): SerializedActivityRow;
}

export interface ActivityFilters {
  agent?: string;
  protocol?: string;
  status?: "approved" | "blocked";
  timeRange?: "1h" | "6h" | "24h" | "7d" | "30d";
  /** Filter rows by ActivityType (swap, open_position, close_position, transfer, deposit, withdraw, lend). */
  type?: ActivityType;
  /** Max events to fetch. Default: 50. */
  limit?: number;
}

export interface ActivityData {
  rows: ActivityRow[];
  summary: {
    total: number;
    approved: number;
    blocked: number;
    /** Total USD volume (6-decimal). */
    volume: bigint;
  };
  toJSON(): SerializedActivityData;
}

// ─── Health Data ─────────────────────────────────────────────────────────────

export interface HealthData {
  level: "healthy" | "elevated" | "critical";
  blockedCount24h: number;
  checks: HealthCheck[];
  lastBlock?: {
    agent: string;
    /**
     * On-chain error name from errors.rs (e.g., "SpendingCapExceeded").
     */
    reason: string;
    amount: bigint;
    /** Unix ms. */
    timestamp: number;
  };
  toJSON(): SerializedHealthData;
}

// ─── Policy Data ─────────────────────────────────────────────────────────────

export interface PolicyData {
  // Spending
  dailyCap: bigint;
  maxPerTrade: bigint;
  // Protocols
  approvedApps: { name: string; programId: string }[];
  protocolMode: "whitelist" | "blacklist" | "unrestricted";
  /** Whether per-protocol caps are enabled (policy.rs:69). */
  hasProtocolCaps: boolean;
  /** Parallel array to approvedApps (6-decimal USD each). */
  protocolCaps: bigint[];
  /** Raw BPS. 50 = 0.5%. */
  maxSlippageBps: number;
  /** Raw BPS. 500 = 5x. */
  leverageLimitBps: number;
  // Destinations
  allowedDestinations: string[];
  // Fees
  /** BPS, capped at MAX_DEVELOPER_FEE_RATE (500). */
  developerFeeRate: number;
  // Session
  sessionExpirySlots: bigint;
  // Governance
  /** Minimum 1800 (MIN_TIMELOCK_DURATION, TOCTOU fix). */
  timelockSeconds: number;
  /** Incremented on every apply (TOCTOU fix — agents check this). */
  policyVersion: bigint;
  // Pending changes
  pendingUpdate?: {
    changes: Partial<PolicyChanges>;
    /** Unix ms. */
    appliesAt: number;
    canApply: boolean;
    canCancel: boolean;
  };
  toJSON(): SerializedPolicyData;
}

// ─── Overview (S14) ──────────────────────────────────────────────────────────

/**
 * Shared context passed to the `build*` composition helpers.
 *
 * Contains the pre-fetched raw data needed to derive any of the five view
 * types (vault, agents, spending, health, policy) plus the raw activity list.
 *
 * `getOverview()` resolves state once, derives PnL from it via
 * `getVaultPnLFromState`, fetches activity and pending-policy in parallel,
 * then passes the same context to every `build*` helper so state-derived
 * values (posture, breakdown, alerts) are computed exactly once.
 *
 * Most consumers should use {@link OwnerClient.getOverview} or the individual
 * read methods; this interface is exposed for advanced composition (custom
 * dashboards, test harnesses that need to inject fixtures).
 *
 * @experimental The field shape of `OverviewContext` — particularly the three
 * memoized derivations (`posture`, `breakdown`, `alerts`) — is considered
 * experimental and may change without a major bump while the build* helpers
 * are iterated on. If you depend on this surface, pin your SDK version and
 * watch the changeset.
 */
export interface OverviewContext {
  /** Vault PDA (needed for fields that reference the vault address directly). */
  vault: Address;
  state: ResolvedVaultStateForOwner;
  /** From `getVaultPnL`. When absent, `buildVaultState` returns zero P&L. */
  pnl?: VaultPnL;
  /** 100 most recent raw events. When absent, `buildAgents` returns empty last-action fields. */
  activity?: VaultActivityItem[];
  /** `null` when no pending update exists. When absent, `buildPolicy` returns no pending update. */
  pendingPolicy?: PendingPolicyUpdate | null;
  /**
   * Memoized `getSecurityPosture(state)` — pre-populated by `getOverview` so
   * `buildVaultState` and `buildHealth` share one computation. When absent,
   * each helper derives it from `state` on demand.
   */
  posture?: SecurityPosture;
  /**
   * Memoized `getSpendingBreakdown(state)` — pre-populated by `getOverview`.
   * When absent, `buildSpending` derives it from `state` on demand.
   */
  breakdown?: SpendingBreakdown;
  /**
   * Memoized `evaluateAlertConditions(state, vault)` — pre-populated by
   * `getOverview`. When absent, `buildHealth` derives it on demand.
   */
  alerts?: Alert[];
}

/**
 * Single-call overview bundle for a vault.
 *
 * Returns the same five view types as the individual read methods plus the
 * raw 100-most-recent activity rows (configurable via
 * `GetOverviewOptions.activityLimit`). The five reads called separately each
 * re-resolve vault state; `getOverview` resolves it once and derives PnL
 * from that resolved state — saves one full state resolution vs. the
 * previous implementation. The activity fetch (`getSignaturesForAddress` +
 * sequential `getTransaction` × activityLimit) dominates wall time when
 * `includeActivity: true`.
 *
 * Activity is returned **unfiltered**. To filter, call
 * {@link OwnerClient.getActivity} with explicit `ActivityFilters`.
 *
 * @experimental Introduced by S14 alongside the `build*` composition helpers.
 * Field shape (and the memoized-context pipeline beneath it) may change before
 * v1.0. Pin your SDK version if you depend on this surface.
 */
export interface OverviewData {
  vault: VaultState;
  agents: AgentData[];
  spending: SpendingData;
  health: HealthData;
  policy: PolicyData;
  /** 100 most recent rows, unfiltered. Apply filters via `getActivity(filters)`. */
  activity: ActivityRow[];
  toJSON(): SerializedOverviewData;
}

/**
 * Options controlling what `getOverview` fetches.
 *
 * @experimental Introduced by S14. Additional options (filtered activity,
 * partial posture derivation, per-section skip flags) may be added before
 * v1.0 without a major bump.
 */
export interface GetOverviewOptions {
  /**
   * When `false`, skip the `getVaultActivity` RPC and return `activity: []`.
   * Default: `true`. Useful for headless agents that only need policy/health.
   *
   * ⚠️ **Side effect on `agents[*]`.** Per-agent last-action enrichment
   * (lastActionType / lastActionProtocol / lastActionTimestamp /
   * blockedCount24h) is derived from the same activity fetch. When
   * `includeActivity: false`, those fields return empty-string / 0 on every
   * agent. If you need the agent last-action fields, keep activity enabled
   * (or lower cost with `activityLimit`).
   */
  includeActivity?: boolean;
  /**
   * Override the activity fetch size. Defaults to 100 (see
   * `DEFAULT_OVERVIEW_ACTIVITY_LIMIT`). `getVaultActivity` issues one
   * `getSignaturesForAddress` followed by up to `activityLimit` sequential
   * `getTransaction` calls — this is the only lever on activity RPC cost.
   */
  activityLimit?: number;
}

// ─── Mutation Inputs ─────────────────────────────────────────────────────────

/**
 * Policy change input. All fields optional — only specified fields are changed.
 * All 15 on-chain policy fields represented (verified: policy.rs).
 *
 * Note: timelock values < 1800 are rejected on-chain (TimelockTooShort, TOCTOU fix).
 */
export interface PolicyChanges {
  dailyCap?: bigint;
  maxPerTrade?: bigint;
  approvedApps?: Address[];
  protocolMode?: "whitelist" | "blacklist" | "unrestricted";
  hasProtocolCaps?: boolean;
  protocolCaps?: bigint[];
  maxSlippageBps?: number;
  /** BPS. */
  leverageLimit?: number;
  allowedDestinations?: Address[];
  /** BPS. */
  developerFeeRate?: number;
  sessionExpirySlots?: bigint;
  /** Seconds. Minimum 1800 on-chain. */
  timelock?: number;
}

/**
 * Re-export from generated types. Byte-level constraint matching — the on-chain
 * program validates instruction data fields against these rules.
 */
export type { ConstraintEntryArgs as ConstraintEntry };

// ─── Discovery ───────────────────────────────────────────────────────────────

export interface DiscoveredVault {
  /** Vault PDA, verified by client-side PDA re-derivation. */
  address: string;
  vaultId: bigint;
  status: "active" | "frozen";
  agentCount: number;
  toJSON(): SerializedDiscoveredVault;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Normalized error type for all OwnerClient operations.
 *
 * Security note: recovery strings are for human display only.
 * MCP servers and AI agents must NOT execute recovery suggestions automatically.
 */
export interface DxError {
  /** On-chain error code (6000-6071) or SDK error code (7000+). */
  code: number;
  /** Human-readable error message. */
  message: string;
  /**
   * Advisory recovery steps — NEVER parse or execute programmatically.
   * These are for human display in UI toast/alert messages.
   */
  recovery: string[];
}

// ─── Serialized Types (toJSON output) ────────────────────────────────────────
// These mirror the main types but with bigint → string for JSON compatibility.

/** @internal */
export interface SerializedVaultState {
  vault: {
    address: string;
    status: "active" | "frozen" | "closed";
    owner: string;
    agentCount: number;
    totalVolume: string;
    totalFees: string;
  };
  balance: {
    total: string;
    tokens: { mint: string; amount: string; decimals: number }[];
  };
  pnl: { percent: number; absolute: string };
  health: { level: string; alertCount: number; checks: HealthCheck[] };
}

/** @internal */
export interface SerializedAgentData {
  address: string;
  status: string;
  capabilityLabel: string;
  capability: number;
  spending: { amount: string; limit: string; percent: number };
  lastActionType: string;
  lastActionProtocol: string;
  lastActionTimestamp: number;
  blockedCount24h: number;
}

/** @internal */
export interface SerializedSpendingData {
  global: {
    today: string;
    cap: string;
    remaining: string;
    percent: number;
    rundownMs: number;
  };
  chart: ChartPoint[];
  protocolBreakdown: {
    name: string;
    programId: string;
    amount: string;
    percent: number;
  }[];
}

/** @internal */
export interface SerializedActivityRow {
  id: string;
  timestamp: number;
  type: string;
  protocol: string;
  protocolId: string;
  agent: string;
  amount: string;
  status: string;
  reason?: string;
  txSignature?: string;
}

/** @internal */
export interface SerializedActivityData {
  rows: SerializedActivityRow[];
  summary: { total: number; approved: number; blocked: number; volume: string };
}

/** @internal */
export interface SerializedHealthData {
  level: string;
  blockedCount24h: number;
  checks: HealthCheck[];
  lastBlock?: {
    agent: string;
    reason: string;
    amount: string;
    timestamp: number;
  };
}

/** @internal */
export interface SerializedPolicyData {
  dailyCap: string;
  maxPerTrade: string;
  approvedApps: { name: string; programId: string }[];
  protocolMode: string;
  hasProtocolCaps: boolean;
  protocolCaps: string[];
  maxSlippageBps: number;
  leverageLimitBps: number;
  allowedDestinations: string[];
  developerFeeRate: number;
  sessionExpirySlots: string;
  timelockSeconds: number;
  policyVersion: string;
  pendingUpdate?: {
    changes: Record<string, unknown>;
    appliesAt: number;
    canApply: boolean;
    canCancel: boolean;
  };
}

/** @internal */
export interface SerializedDiscoveredVault {
  address: string;
  vaultId: string;
  status: string;
  agentCount: number;
}

/** @internal */
export interface SerializedOverviewData {
  vault: SerializedVaultState;
  agents: SerializedAgentData[];
  spending: SerializedSpendingData;
  health: SerializedHealthData;
  policy: SerializedPolicyData;
  activity: SerializedActivityRow[];
}
