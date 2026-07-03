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
// M1-04: ConstraintEntryArgs import removed (constraints engine deleted).
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
  /**
   * AL2 mainnet confirmation gate (H-9, Phase 10 Bucket 1). Mirrors the
   * `SigilClientConfig.requireMainnetConfirmation` knob on the seal-side
   * client so destructive owner mutations get the same opt-in
   * confirmation barrier.
   *
   * Three states:
   *   - `true`  → every mutation on mainnet MUST be called with
   *               `{ mainnetConfirmed: true }` or it throws
   *               `SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED`.
   *   - `false` → explicit opt-out; no throw, no warn (e.g. CI fixtures
   *               that intentionally exercise mainnet codepaths).
   *   - `undefined` (default in 0.16.x) → no throw, but mainnet mutations
   *               called without `mainnetConfirmed: true` emit a warning
   *               via {@link getSigilModuleLogger}. v1.0 will flip the
   *               default to `true`; adopt early by setting `true` here.
   *
   * On devnet the gate is ignored regardless of this setting.
   */
  requireMainnetConfirmation?: boolean;
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
  // strictMode option removed in V2: every constraint entry is strictly
  // enforced on-chain. Callers no longer pass a mode flag.
  /**
   * AL2 mainnet confirmation gate (H-9, Phase 10 Bucket 1). Set to
   * `true` to confirm a mutation is intentional on mainnet. Required
   * when `OwnerClientConfig.requireMainnetConfirmation === true`. See
   * the field docs on `OwnerClientConfig` for the full state matrix.
   */
  mainnetConfirmed?: boolean;
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
    /**
     * Observe-only kill switch (AgentVault.observe_only). When true, every
     * `validate_and_authorize` rejects (ObserveOnlyModeBlocksExecute) — a hard
     * execute-path stop independent of freeze. Written by `setObserveOnly`,
     * readable here for parity. Optional for backward-compatible construction
     * (pre-0.25 callers) + MCP round-trip of older JSON; the resolver always
     * populates it.
     */
    observeOnly?: boolean;
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
  /** Filter rows by ActivityType (swap, lend, transfer, deposit, withdraw). */
  type?: ActivityType;
  /** Max events to fetch. Default: 50. */
  limit?: number;
  /**
   * Pagination cursor — fetch signatures strictly OLDER than this one. Pass
   * the previous page's {@link ActivityData.nextCursor} to page backwards.
   * Threaded into `getSignaturesForAddress({ before })`.
   */
  before?: string;
  /**
   * Pagination cursor — fetch signatures until this one (older bound).
   * Threaded into `getSignaturesForAddress({ until })`.
   */
  until?: string;
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
  /**
   * Oldest signature in the underlying fetch page — pass as
   * {@link ActivityFilters.before} to load the next (older) page. `null` when
   * the fetch returned fewer than `limit` signatures (end of history). Tracks
   * the RAW signature page, independent of any client-side row filtering.
   * Optional for backward-compatible construction + round-trip of pre-0.25 JSON.
   */
  nextCursor?: string | null;
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

/**
 * One entry of the verified-build gate read-back (Item 2). Index-aligned to
 * {@link PolicyData.approvedApps}: `approvedApps[i]` ↔ `protocolHashes[i]`.
 * Mirrors `PolicyConfig.protocol_hashes[i]` — an all-zero on-chain entry means
 * the gate is DISARMED for that protocol.
 */
export interface ProtocolHashInfo {
  /** Program address the pin applies to (same as `approvedApps[i].programId`). */
  programId: string;
  /** True when a non-zero build hash is pinned — `validate_and_authorize` enforces it. */
  armed: boolean;
  /** Hex-encoded 32-byte program-data SHA-256 when armed; `null` when disarmed. */
  hash: string | null;
}

/**
 * One entry of the first-time-destination graylist read-back (Item 2). Mirrors
 * `PolicyConfig.destination_graylist[i]` — a destination that is allowlisted but
 * still within its 24h friction window (or awaiting owner promotion).
 */
export interface GraylistEntry {
  /** Destination wallet/PDA pubkey (also present in `allowedDestinations`). */
  destination: string;
  /** Unix seconds at which the destination unlocks without owner promotion. */
  unlockUnix: bigint;
}

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
  // Destinations
  allowedDestinations: string[];
  // Fees
  /** BPS, capped at MAX_DEVELOPER_FEE_RATE (500). */
  developerFeeRate: number;
  // Session
  sessionExpirySeconds: bigint;
  // Governance
  /** Minimum 1800 (MIN_TIMELOCK_DURATION, TOCTOU fix). */
  timelockSeconds: number;
  /** Incremented on every apply (TOCTOU fix — agents check this). */
  policyVersion: bigint;
  // ── Advanced security controls (read-back parity — 0.25 Item 2) ──────────
  // These fields are WRITABLE via PolicyChanges but were previously not
  // READABLE. All optional for backward-compatible construction of PolicyData
  // (pre-0.25 callers) + MCP round-trip of older JSON; the resolver always
  // populates them from the decoded PolicyConfig.
  /** TA-09 elevated-mutation cosign gate (PolicyConfig.cosign_required). */
  cosignRequired?: boolean;
  /**
   * D-5 reactivate-time cosigner (PolicyConfig.cosign_session_pubkey). `null`
   * when unset (on-chain default `Pubkey::default()` — gate disabled).
   */
  cosignSessionPubkey?: Address | null;
  /**
   * TA-12 hard floor on combined USDC+USDT balance, 6-decimal USD
   * (PolicyConfig.stable_balance_floor). `0n` = no floor.
   */
  stableBalanceFloor?: bigint;
  /**
   * TA-14 rolling-24h per-recipient outflow cap, 6-decimal USD
   * (PolicyConfig.per_recipient_daily_cap_usd). `null` = no per-recipient cap
   * (on-chain default `0`).
   */
  perRecipientDailyCapUsd?: bigint | null;
  /**
   * Destination access-control mode (PolicyConfig.destination_mode). Raw u8:
   * `0` = Restricted (the only value the current program accepts).
   */
  destinationMode?: number;
  /**
   * F-Q6 delay (seconds) before an OPERATOR grant takes effect
   * (PolicyConfig.operator_grant_delay_seconds). `0n` = no delay.
   */
  operatorGrantDelaySeconds?: bigint;
  /**
   * Verified-build gate state per approved protocol (PolicyConfig.protocol_hashes),
   * index-aligned to {@link approvedApps}. See {@link ProtocolHashInfo}.
   */
  protocolHashes?: ProtocolHashInfo[];
  /**
   * First-time-destination graylist (PolicyConfig.destination_graylist) —
   * allowlisted destinations still inside their 24h friction window. See
   * {@link GraylistEntry}.
   */
  graylist?: GraylistEntry[];
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

// ─── Risk Metrics (S11) ──────────────────────────────────────────────────────

/**
 * Risk-tilt summary derived from current spending + alert state.
 *
 * Composed from:
 * - {@link getSpendingVelocity} — `currentRate` becomes `spendingVelocity`
 *   (USD/hour at the latest 30-minute observation), `isAccelerating` and
 *   `timeToCapSeconds` are passed through directly.
 * - The 24h cap projection — `capVelocity` is the percent of the daily cap
 *   that would be consumed in 24h at the current rate (0 when there is no
 *   cap configured).
 * - {@link evaluateAlertConditions} — the highest severity present is mapped
 *   to `riskLevel` via: any `critical` ⇒ `"critical"`; otherwise any
 *   `warning` ⇒ `"high"`; otherwise any `info` ⇒ `"elevated"`; otherwise
 *   `"low"`.
 *
 * The four-level `riskLevel` is intentionally coarser than the on-chain
 * health levels — it's meant for a single risk badge in the UI, not for
 * matching the security checklist's pass/fail.
 */
export interface RiskMetrics {
  /** Percentage of the daily cap projected to be consumed in 24h at the current rate. 0 if no cap configured. */
  capVelocity: number;
  /** Current spend rate in 6-decimal USD per hour (from getSpendingVelocity). */
  spendingVelocity: bigint;
  riskLevel: "low" | "elevated" | "high" | "critical";
  isAccelerating: boolean;
  /** Seconds until the cap is projected to be hit. `null` when not approaching. */
  timeToCapSeconds: number | null;
  toJSON(): SerializedRiskMetrics;
}

// ─── Audit Trail (S12) ───────────────────────────────────────────────────────

/**
 * Categories of activity returned in the audit trail.
 *
 * The audit trail is the governance/security subset of `getVaultActivity`:
 * trades, deposits, withdrawals, and fee accruals are excluded as routine
 * operating activity. Each variant maps 1:1 to an {@link EventCategory}
 * value from the underlying activity stream.
 */
export type AuditEventType =
  | "policy_change"
  | "agent_change"
  | "vault_security";

/**
 * One row of the audit trail — a governance, agent-management, or security
 * event drawn from the vault's activity stream.
 *
 * Returned by {@link OwnerClient.getAuditTrail}. The list is filtered to the
 * subset of `getVaultActivity` whose category is in
 * `{policy, agent, security}`; trade/deposit/withdrawal/fee events
 * are excluded as routine operating activity.
 */
export interface AuditTrailEntry {
  /** Unix milliseconds. */
  timestamp: number;
  eventType: AuditEventType;
  /**
   * Originating event name (e.g. `"PolicyChangeApplied"`, `"AgentRegistered"`,
   * `"VaultFrozen"`) preserved verbatim from the underlying decoded event for
   * downstream filtering and UI labels.
   */
  eventName: string;
  /**
   * Address that initiated the action. For agent events this is the agent's
   * own pubkey when present; for policy/security events the originating
   * decoder may not surface an actor — the empty string is used as a
   * sentinel "no actor recorded" value rather than `null` so the field
   * always serializes as a string.
   */
  actor: string;
  /** Human-readable summary from `describeEvent()` — safe to render directly. */
  details: string;
  txSignature: string;
  toJSON(): SerializedAuditTrailEntry;
}

/**
 * Filtering options for {@link OwnerClient.getAuditTrail}.
 *
 * `since` and `limit` are independent: `since` filters the post-fetch event
 * stream by timestamp, while `limit` controls the underlying
 * {@link getVaultActivity} fetch size (default 100). When both are passed,
 * the fetch is sized to `limit` and any events older than `since` are
 * dropped after categorization.
 */
export interface AuditTrailOptions {
  /**
   * Activity fetch size cap. Defaults to 100 — matches the default window
   * used by {@link getAgents} and {@link getOverview}. Larger values
   * proportionally increase RPC cost (`getSignaturesForAddress` +
   * `getTransaction × limit`).
   */
  limit?: number;
  /**
   * Lower bound on `timestamp` (Unix ms). Entries with `timestamp < since`
   * are excluded.
   */
  since?: number;
}

// ─── Mutation Inputs ─────────────────────────────────────────────────────────

/**
 * Policy change input. All fields optional — only specified fields change; the
 * rest fall through to the live policy value at the on-chain merge.
 *
 * Routing (audit 2026-06-12) — elevation is DIRECTION-dependent (raising a cap
 * is elevated, lowering it is not; lowering the stable floor is elevated, raising
 * it is not), so it is NOT a per-field property. The same input type serves both
 * paths; choose by the NET effect of your change:
 *   - `queuePolicyUpdate(changes)` — net effect NOT elevated (owner-only signature).
 *   - `queuePolicyElevated(changes, cosigner)` — net effect IS elevated (raises a
 *     cap, expands an allowlist, lowers the stable floor, raises the per-recipient
 *     cap, weakens protocol caps, or disables cosign). On a cosign_required vault
 *     these require a cosigner.
 * Fail-closed on misroute: a cosigner on a non-elevated change → InvalidPermissions
 * (6036); an elevated change with no cosigner → ErrCosignRequired (6080).
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
  allowedDestinations?: Address[];
  /** BPS. */
  developerFeeRate?: number;
  sessionExpirySeconds?: bigint;
  /** Seconds. Minimum 1800 on-chain. */
  timelock?: number;
  /**
   * Destination access-control mode for `agent_transfer` (F-4).
   * `0` = Restricted (default — destination must be in `allowedDestinations`).
   * `1` = OpenWithCap (destination unrestricted; only the daily cap throttles).
   * Owner must explicitly opt into OpenWithCap via the timelocked path.
   */
  destinationMode?: number;
  // ── Cosign-gated-capable fields (audit 2026-06-12) ──────────────────────
  // Direction matters for elevation (see the interface docstring): these are
  // settable on EITHER path. Route through queuePolicyElevated (+ cosigner)
  // when the net change is elevated, queuePolicyUpdate otherwise.
  /** Stable-balance floor ($ × 1e6). LOWERING it is elevated (weakens custody); raising it is not. */
  stableBalanceFloor?: bigint;
  /** Per-recipient rolling-24h cap ($ × 1e6). RAISING it is elevated; lowering it is not. */
  perRecipientDailyCapUsd?: bigint;
  /** Toggle cosign_required. DISABLING (true→false) is elevated (one-way ratchet); enabling is not. */
  cosignRequired?: boolean;
  /** D-5 reactivate-time cosigner pubkey (gates instant-operator reactivation). Not an elevation trigger. */
  cosignSessionPubkey?: Address;
  /** F-Q6 operator-grant delay in seconds (gates OPERATOR seating). Not an elevation trigger. */
  operatorGrantDelaySeconds?: bigint;
  /**
   * Item 1 (verified-build gate arming) — per-protocol build-hash pins for
   * `PolicyConfig.protocol_hashes`, keyed by the protocol's program address
   * (must already be in the vault's `protocols` allowlist). Each value is
   * either:
   *   - a 32-byte program-data SHA-256 (from {@link computeVerifiedBuildHash})
   *     to ARM the gate for that protocol — `validate_and_authorize` then
   *     rejects (6116/6117) if the deployed build no longer matches, OR
   *   - the literal `"disarm"` to clear an armed pin (set it back to zeroes).
   *
   * On-chain semantics are WHOLE-ARRAY replace, so the SDK seeds the full
   * 10-entry array from the LIVE policy and applies only these deltas —
   * protocols you don't mention keep their current pin.
   *
   * CONSTRAINTS (enforced by the mutation builders, fail-closed):
   *   - Cannot be combined with `approvedApps` in the same update (reordering
   *     the allowlist would mis-align the live-seeded hashes — the on-chain
   *     digest would still match, silently pinning the wrong hash to the wrong
   *     protocol). Change the allowlist first, then arm in a separate update.
   *   - DISARMING (nonzero→zero) on a `cosign_required` vault is elevated —
   *     route it through `queuePolicyElevated`. Arming / re-pinning stay on the
   *     standard timelock path.
   *
   * @remarks Once armed, a legitimate upgrade of the target program bricks
   *   `seal()` for that protocol (6116/6117) until the owner re-pins the new
   *   hash — recoverable via a standard (non-elevated) re-arm.
   */
  protocolHashes?: ReadonlyMap<Address, Uint8Array | "disarm">;
}

// M1-04: the ConstraintEntry re-export was removed with the constraints engine.

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
  /**
   * Error code. Range encodes category:
   *   - 6000-6080 → on-chain Anchor program error (see Rust error codes)
   *   - 7000-7099 → SDK / dashboard logic error
   *   - 7100-7199 → RPC / network error
   *   - 7999      → DX_ERROR_CODE_UNMAPPED sentinel
   *
   * FE should NOT hard-code range checks — use `categorizeDxError()`
   * instead. The range layout may evolve and the helper is the
   * canonical classification.
   */
  code: number;
  /** Human-readable error message. Safe to render directly. */
  message: string;
  /**
   * Advisory recovery steps — NEVER parse or execute programmatically.
   * These are for human display in UI toast/alert messages (FE↔BE
   * covenant D3).
   */
  recovery: string[];
  /**
   * True iff the transaction reached the Sigil on-chain program and was
   * rejected by program logic (Anchor error codes 6000-6080). When
   * true, the FE renders a specific "the vault's rules prevented this"
   * message instead of a generic error. When false, the failure was
   * client-side, RPC, or network — the caller may retry.
   *
   * Shipped as part of FE↔BE contract v2.2 commitment C2. Always
   * populated by `toDxError()`; never undefined on a properly
   * normalized error.
   */
  onChainReverted: boolean;
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
    /** AgentVault.observe_only. Optional for round-trip of pre-0.25 JSON. */
    observeOnly?: boolean;
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
  /** Oldest fetched signature, or null at end of history. */
  nextCursor?: string | null;
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
  allowedDestinations: string[];
  developerFeeRate: number;
  sessionExpirySeconds: string;
  timelockSeconds: number;
  policyVersion: string;
  // Advanced security controls (0.25 Item 2) — bigint → string; optional for
  // round-trip of pre-0.25 JSON.
  cosignRequired?: boolean;
  cosignSessionPubkey?: string | null;
  stableBalanceFloor?: string;
  perRecipientDailyCapUsd?: string | null;
  destinationMode?: number;
  operatorGrantDelaySeconds?: string;
  protocolHashes?: { programId: string; armed: boolean; hash: string | null }[];
  graylist?: { destination: string; unlockUnix: string }[];
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

/** @internal */
export interface SerializedRiskMetrics {
  capVelocity: number;
  spendingVelocity: string;
  riskLevel: string;
  isAccelerating: boolean;
  timeToCapSeconds: number | null;
}

/** @internal */
export interface SerializedAuditTrailEntry {
  timestamp: number;
  eventType: string;
  eventName: string;
  actor: string;
  details: string;
  txSignature: string;
}

// ─── Pending Ownership Transfer (0.25 Item 2) ────────────────────────────────

/**
 * Read-back of an in-flight ownership transfer (PendingOwnershipTransfer PDA).
 *
 * Returned by `getPendingOwnership`; `null` when no transfer is queued. The
 * on-chain accept gate is WALL-CLOCK based (`unix_now - queued_at >=
 * min_delay_seconds`), so the maturation time is surfaced as `executesAtUnix`
 * (Unix seconds), NOT a slot. `queuedAtSlot` is the freshness slot the program
 * records; it is exposed verbatim but is not the accept deadline.
 */
export interface PendingOwnershipData {
  /** Target owner — the pubkey that must sign `acceptOwnershipTransfer`. */
  newOwner: string;
  /** Owner at queue time — the pubkey that can `cancelOwnershipTransfer`. */
  currentOwner: string;
  /** `Clock::unix_timestamp` (seconds) at queue time. */
  queuedAt: bigint;
  /** Owner-configured timelock in seconds (default 172800 / 48h). */
  minDelaySeconds: bigint;
  /**
   * Unix seconds at/after which `acceptOwnershipTransfer` may land
   * (`queuedAt + minDelaySeconds`). Multiply by 1000 for a JS Date.
   */
  executesAtUnix: bigint;
  /** True when the accept path is the Squads V4 multisig variant. */
  isMultisigTarget: boolean;
  /** Slot recorded at queue time (freshness; not the accept deadline). */
  queuedAtSlot: bigint;
  toJSON(): SerializedPendingOwnershipData;
}

/** @internal */
export interface SerializedPendingOwnershipData {
  newOwner: string;
  currentOwner: string;
  queuedAt: string;
  minDelaySeconds: string;
  executesAtUnix: string;
  isMultisigTarget: boolean;
  queuedAtSlot: string;
}
