/**
 * @usesigil/kit/dashboard — Type definitions for the OwnerClient DX layer.
 *
 * Design principles:
 * - All amounts are bigint (6-decimal USD). No string formatting.
 * - Every return type has toJSON() for MCP/REST serialization (bigint → string).
 * - No UI concerns: no colors, icons, labels, or locale-specific strings.
 */

import type { Address, TransactionSigner } from "@solana/kit";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { ConstraintEntryArgs } from "../generated/types/constraintEntry.js";

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
    openPositions: number;
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
  /** Human-readable permission names from permissionsToStrings(). */
  permissions: string[];
  /** Raw bitmask for programmatic use. */
  permissionBitmask: bigint;
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

export type ActivityType =
  | "swap"
  | "lend"
  | "transfer"
  | "open_position"
  | "close_position"
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
  // Positions
  canOpenPositions: boolean;
  maxConcurrentPositions: number;
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
  canOpenPositions?: boolean;
  maxConcurrentPositions?: number;
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
    openPositions: number;
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
  permissions: string[];
  permissionBitmask: string;
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
  canOpenPositions: boolean;
  maxConcurrentPositions: number;
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
