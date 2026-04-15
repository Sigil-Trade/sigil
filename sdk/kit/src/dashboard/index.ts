/**
 * @usesigil/kit/dashboard — Owner-side convenience layer for Sigil vaults.
 *
 * Stateless, JSON-serializable, MCP-compatible. One class, one import.
 *
 * @example
 * ```typescript
 * import { OwnerClient } from "@usesigil/kit/dashboard";
 *
 * const owner = new OwnerClient({ rpc, vault, owner: signer, network: "devnet" });
 * const state = await owner.getVaultState();
 * await owner.freezeVault();
 * ```
 */

import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";

import { SigilSdkDomainError } from "../errors/sdk.js";
import { SIGIL_ERROR__SDK__INVALID_CONFIG } from "../errors/codes.js";

import type {
  OwnerClientConfig,
  TxResult,
  TxOpts,
  VaultState,
  AgentData,
  SpendingData,
  ActivityData,
  ActivityFilters,
  HealthData,
  PolicyData,
  PolicyChanges,
  ConstraintEntry,
  DiscoveredVault,
  OverviewData,
  GetOverviewOptions,
} from "./types.js";

import * as reads from "./reads.js";
import * as mutations from "./mutations.js";
import * as constraintReads from "./constraint-reads.js";
import { discoverVaults as discoverVaultsImpl } from "./discover.js";

// Re-export all types for consumers
export type {
  OwnerClientConfig,
  TxResult,
  TxOpts,
  VaultState,
  AgentData,
  SpendingData,
  ActivityData,
  ActivityRow,
  ActivityFilters,
  ActivityType,
  HealthData,
  PolicyData,
  PolicyChanges,
  ConstraintEntry,
  DiscoveredVault,
  DxError,
  ChartPoint,
  TokenBalance,
  HealthCheck,
  ProtocolBreakdownEntry,
  OverviewContext,
  OverviewData,
  GetOverviewOptions,
} from "./types.js";

// ─── Overview composition helpers (S14) ──────────────────────────────────────
// Exported for advanced consumers (custom dashboards, MCP servers, test
// harnesses) that want to pre-fetch raw state once and compose views
// themselves. Most consumers should use OwnerClient.getOverview() instead.
//
// @experimental These helpers and the OverviewContext shape may change while
// the composition surface is iterated on. Pin your SDK version if you depend
// on them directly.
export {
  buildVaultState,
  buildAgents,
  buildSpending,
  buildHealth,
  buildPolicy,
  buildActivityRows,
  DEFAULT_OVERVIEW_ACTIVITY_LIMIT,
} from "./reads.js";

export type { ConstraintsPdaInfo } from "./constraint-reads.js";
export {
  findConstraintsPda,
  findPendingConstraintsPda,
  findPendingCloseConstraintsPda,
  fetchConstraints,
  fetchPendingConstraintsUpdate,
  fetchPendingCloseConstraints,
} from "./constraint-reads.js";

/**
 * Owner-side client for Sigil vault management.
 *
 * Design:
 * - Stateless: every read fetches fresh from RPC. No internal cache.
 * - bigint only: all amounts are 6-decimal USD bigint. No formatted strings.
 * - JSON-serializable: every return type has toJSON() for MCP/REST.
 * - Single-vault scope: one OwnerClient per vault.
 */
export class OwnerClient {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly vault: Address;
  readonly owner: TransactionSigner;
  readonly network: "devnet" | "mainnet";

  constructor(config: OwnerClientConfig) {
    if (!config.rpc)
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "OwnerClientConfig.rpc is required",
        { context: { field: "rpc", expected: "Rpc<SolanaRpcApi>" } },
      );
    if (!config.vault)
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "OwnerClientConfig.vault is required",
        { context: { field: "vault", expected: "Address" } },
      );
    if (!config.owner)
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "OwnerClientConfig.owner is required",
        { context: { field: "owner", expected: "TransactionSigner" } },
      );
    if (!config.network)
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "OwnerClientConfig.network is required",
        { context: { field: "network", expected: "'devnet' | 'mainnet'" } },
      );

    this.rpc = config.rpc;
    this.vault = config.vault;
    this.owner = config.owner;
    this.network = config.network;
  }

  // ─── Reads (stateless, fetch fresh every call) ──────────────────────────────

  async getVaultState(): Promise<VaultState> {
    return reads.getVaultState(this.rpc, this.vault, this.network);
  }

  async getAgents(): Promise<AgentData[]> {
    return reads.getAgents(this.rpc, this.vault, this.network);
  }

  async getSpending(): Promise<SpendingData> {
    return reads.getSpending(this.rpc, this.vault, this.network);
  }

  async getActivity(filters?: ActivityFilters): Promise<ActivityData> {
    return reads.getActivity(this.rpc, this.vault, this.network, filters);
  }

  async getHealth(): Promise<HealthData> {
    return reads.getHealth(this.rpc, this.vault, this.network);
  }

  async getPolicy(): Promise<PolicyData> {
    return reads.getPolicy(this.rpc, this.vault, this.network);
  }

  /**
   * Single-call overview — all five view types plus unfiltered activity.
   *
   * Resolves vault state exactly once (vs. up to 5× when the individual
   * reads are called separately) and derives PnL from that resolved state.
   * The activity fetch is `getSignaturesForAddress` + up to `activityLimit`
   * sequential `getTransaction` calls; it dominates wall time when
   * `includeActivity: true` and can be skipped entirely with
   * `{ includeActivity: false }` at the cost of agents losing their
   * last-action enrichment fields.
   *
   * For filtered activity, use {@link OwnerClient.getActivity} alongside —
   * `getOverview` does not accept `ActivityFilters`.
   */
  async getOverview(options?: GetOverviewOptions): Promise<OverviewData> {
    return reads.getOverview(this.rpc, this.vault, this.network, options);
  }

  // ─── Vault Lifecycle ────────────────────────────────────────────────────────

  /** Zero args. Immediate. */
  async freezeVault(opts?: TxOpts): Promise<TxResult> {
    return mutations.freezeVault(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  /**
   * Reactivates a frozen vault. Optionally adds a new agent during reactivation.
   */
  async resumeVault(
    newAgent?: { address: Address; permissions: bigint },
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.resumeVault(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      newAgent,
      opts,
    );
  }

  /**
   * Permanently closes vault and reclaims rent.
   * Requires: all agents revoked, open_positions == 0.
   * If OpenPositionsExist error, call syncPositions() first.
   * May need computeUnits: 400_000 for complex vaults (default applied).
   */
  async closeVault(opts?: TxOpts): Promise<TxResult> {
    return mutations.closeVault(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  /**
   * Resets position counter when positions drift (e.g., auto-liquidation).
   * @param actualPositions — the real number of open positions (usually 0 after liquidation)
   */
  async syncPositions(
    actualPositions: number = 0,
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.syncPositions(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      actualPositions,
      opts,
    );
  }

  // ─── Fund Management ────────────────────────────────────────────────────────

  /** Token-2022 mints blocked by on-chain program. Standard SPL only (USDC, USDT). */
  async deposit(
    mint: Address,
    amount: bigint,
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.deposit(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      mint,
      amount,
      opts,
    );
  }

  /** Token-2022 mints blocked by on-chain program. Standard SPL only (USDC, USDT). */
  async withdraw(
    mint: Address,
    amount: bigint,
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.withdraw(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      mint,
      amount,
      opts,
    );
  }

  // ─── Agent Management ───────────────────────────────────────────────────────

  /**
   * Immediate — additive, no timelock required.
   * @param spendingLimit — per-agent 24h cap in 6-decimal USD. Pass 0n for unlimited (NOT recommended).
   */
  async addAgent(
    agent: Address,
    permissions: bigint,
    spendingLimit: bigint,
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.addAgent(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      permissions,
      spendingLimit,
      opts,
    );
  }

  /** Immediate — protective action, no timelock required. */
  async pauseAgent(agent: Address, opts?: TxOpts): Promise<TxResult> {
    return mutations.pauseAgent(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      opts,
    );
  }

  /** Immediate — protective action, no timelock required. */
  async unpauseAgent(agent: Address, opts?: TxOpts): Promise<TxResult> {
    return mutations.unpauseAgent(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      opts,
    );
  }

  /** Immediate — protective action, no timelock required. */
  async revokeAgent(agent: Address, opts?: TxOpts): Promise<TxResult> {
    return mutations.revokeAgent(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      opts,
    );
  }

  /**
   * Timelocked — queue/apply/cancel pattern.
   * Direct update_agent_permissions deleted (TOCTOU fix).
   */
  /**
   * @param spendingLimit — per-agent 24h cap in 6-decimal USD. Pass 0n for unlimited (NOT recommended).
   */
  async queueAgentPermissions(
    agent: Address,
    permissions: bigint,
    spendingLimit: bigint,
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.queueAgentPermissions(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      permissions,
      spendingLimit,
      opts,
    );
  }

  async applyAgentPermissions(
    agent: Address,
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.applyAgentPermissions(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      opts,
    );
  }

  async cancelAgentPermissions(
    agent: Address,
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.cancelAgentPermissions(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      opts,
    );
  }

  // ─── Policy (all timelocked — MIN_TIMELOCK_DURATION = 1800s) ────────────────

  /**
   * Direct updatePolicy deleted (TOCTOU fix).
   * All policy changes go through queue/apply with mandatory timelock.
   * Note: timelock values < 1800 are rejected on-chain (TimelockTooShort).
   */
  async queuePolicyUpdate(
    changes: PolicyChanges,
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.queuePolicyUpdate(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      changes,
      opts,
    );
  }

  async applyPendingPolicy(opts?: TxOpts): Promise<TxResult> {
    return mutations.applyPendingPolicy(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  async cancelPendingPolicy(opts?: TxOpts): Promise<TxResult> {
    return mutations.cancelPendingPolicy(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  // ─── Constraint Reads (Phase A1.5) ──────────────────────────────────────

  /** Get the constraints PDA address for this vault. */
  async findConstraintsPda(): Promise<Address> {
    return constraintReads.findConstraintsPda(this.vault);
  }

  /** Fetch the InstructionConstraints account (raw bytes). */
  async fetchConstraints() {
    return constraintReads.fetchConstraints(this.rpc, this.vault);
  }

  /** Fetch the PendingConstraintsUpdate account (raw bytes). */
  async fetchPendingConstraintsUpdate() {
    return constraintReads.fetchPendingConstraintsUpdate(this.rpc, this.vault);
  }

  /** Fetch the PendingCloseConstraints account (raw bytes). */
  async fetchPendingCloseConstraints() {
    return constraintReads.fetchPendingCloseConstraints(this.rpc, this.vault);
  }

  // ─── Constraints (timelocked for modifications/deletion) ────────────────────

  /** Immediate — additive, creates constraints that didn't exist. */
  async createConstraints(
    entries: ConstraintEntry[],
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.createConstraints(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      entries,
      opts,
    );
  }

  /** Timelocked — existing queue/apply pattern. */
  async queueConstraintsUpdate(
    entries: ConstraintEntry[],
    opts?: TxOpts,
  ): Promise<TxResult> {
    return mutations.queueConstraintsUpdate(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      entries,
      opts,
    );
  }

  async applyConstraintsUpdate(opts?: TxOpts): Promise<TxResult> {
    return mutations.applyConstraintsUpdate(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  async cancelConstraintsUpdate(opts?: TxOpts): Promise<TxResult> {
    return mutations.cancelConstraintsUpdate(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  /** Timelocked — direct close_instruction_constraints deleted (TOCTOU fix). */
  async queueCloseConstraints(opts?: TxOpts): Promise<TxResult> {
    return mutations.queueCloseConstraints(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  async applyCloseConstraints(opts?: TxOpts): Promise<TxResult> {
    return mutations.applyCloseConstraints(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  async cancelCloseConstraints(opts?: TxOpts): Promise<TxResult> {
    return mutations.cancelCloseConstraints(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  // ─── Static (pre-client) ────────────────────────────────────────────────────

  /**
   * Discover all vaults owned by an address.
   * Verifies PDAs client-side — rejects RPC results that don't match derivable addresses.
   */
  static async discoverVaults(
    rpc: Rpc<SolanaRpcApi>,
    owner: Address,
    network: "devnet" | "mainnet",
  ): Promise<DiscoveredVault[]> {
    return discoverVaultsImpl(rpc, owner, network);
  }
}
