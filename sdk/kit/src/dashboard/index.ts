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
} from "../kit-adapter.js";

import { SigilSdkDomainError } from "../errors/sdk.js";
import {
  SIGIL_ERROR__SDK__INVALID_CONFIG,
  SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
} from "../errors/codes.js";
import { getSigilModuleLogger } from "../logger.js";
import type { CapabilityTier, UsdBaseUnits } from "../types.js";

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
  DiscoveredVault,
  OverviewData,
  GetOverviewOptions,
  RiskMetrics,
  AuditTrailEntry,
  AuditTrailOptions,
} from "./types.js";
import type {
  ElevatedCosignBundle,
  CosignedActionBundle,
} from "./mutations.js";

import * as reads from "./reads.js";
import * as mutations from "./mutations.js";
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
  DiscoveredVault,
  DxError,
  ChartPoint,
  TokenBalance,
  HealthCheck,
  ProtocolBreakdownEntry,
  OverviewContext,
  OverviewData,
  GetOverviewOptions,
  RiskMetrics,
  AuditTrailEntry,
  AuditTrailOptions,
  AuditEventType,
} from "./types.js";

// ─── fromJSON — MCP round-trip deserialization (PR 3.A) ─────────────────────
export {
  txResultFromJSON,
  vaultStateFromJSON,
  agentDataFromJSON,
  spendingDataFromJSON,
  activityRowFromJSON,
  activityDataFromJSON,
  healthDataFromJSON,
  policyDataFromJSON,
  discoveredVaultFromJSON,
  overviewDataFromJSON,
} from "./from-json.js";

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
  buildAgentDetail,
  buildRiskMetrics,
  buildAuditTrail,
  deriveRiskLevel,
  DEFAULT_OVERVIEW_ACTIVITY_LIMIT,
} from "./reads.js";

// ─── close_vault pending-PDA enumeration (CH-2 Bucket-3 audit 2026-05-23) ────
// Stand-alone helpers for the CH-2 + SFH-01 pending PDAs (pending_owner /
// pending_agent_grant / pending_constraints). Re-exported here so the
// `closeVault` builder in mutations.ts (and external consumers building
// custom close-vault flows) can enumerate every drainable PDA in one call.
// See sdk/kit/src/dashboard/close-vault.ts for the full ordering contract.
export type { CloseVaultPendingAccount } from "./close-vault.js";
export {
  CLOSE_VAULT_PENDING_PDA_ORDER,
  findPendingOwnerPda,
  findPendingAgentGrantPda,
  enumerateExistingPendingPdasForClose,
} from "./close-vault.js";

// ─── Pending ownership transfer read (0.25 punch-list Item 2) ────────────────
// Standalone read (no OwnerClient method — keeps the read-method inventory
// stable). Returns `null` when no transfer is queued.
export { getPendingOwnership } from "./reads.js";
export type { PendingOwnershipData } from "./types.js";

// ─── Send + confirm (0.25 punch-list Item 1 — dashboard-friendly re-export) ──
// The dashboard is the natural consumer of the send/poll primitive: its
// offline-signing / Squads handoff flows build a base64 wire transaction and
// need to send + confirm it. Also on the root barrel (`@usesigil/kit`).
export { sendAndConfirmTransaction } from "../rpc-helpers.js";
export type { SendAndConfirmOptions } from "../rpc-helpers.js";

// ─── Post-execution assertion authoring (Phase 2) ────────────────────────────
// Client-side validator that mirrors the on-chain validate_entries check so
// callers fail fast before burning an RPC round-trip. Typed error surface
// (PostAssertionValidationError) preserves a machine-readable
// `validationCode` string plus the failing `entryIndex` for pinpoint UI
// messaging, WHILE ALSO satisfying DxError structurally (numeric `code`,
// `message`, `recovery: string[]`). See post-assertion-validation.ts
// docblock for why the two-code surface exists.
export type { PostAssertionValidationCode } from "./post-assertion-validation.js";
export {
  PostAssertionValidationError,
  validatePostAssertionEntries,
  DX_CODE_POST_ASSERTION_VALIDATION,
} from "./post-assertion-validation.js";
// Re-export the underlying entry type so dashboard consumers don't have to
// reach into `@usesigil/kit/dist/generated/...` (covenant D1 bans generated
// imports from FE code).
export type { PostAssertionEntry } from "../generated/types/postAssertionEntry.js";

// ─── DxError helpers (FE↔BE contract v2.2 C2) ────────────────────────────────
// `toDxError` is the sole DxError construction funnel. `categorizeDxError`
// classifies a DxError's code into the four UX categories the FE routes to
// ("program" / "user" / "network" / "unknown"). `isOnChainReverted` is the
// public helper for routing specific 6000-range codes to custom UI (the
// constraint-violation banner specifically). Prefer `categorizeDxError`.
export {
  toDxError,
  categorizeDxError,
  isOnChainReverted,
  DX_ERROR_CODE_UNMAPPED,
} from "./errors.js";
export type { DxErrorCategory } from "./errors.js";

/**
 * Owner-side client for Sigil vault management.
 *
 * Design:
 * - Stateless: every read fetches fresh from RPC. No internal cache.
 * - bigint only: all amounts are 6-decimal USD bigint. No formatted strings.
 * - JSON-serializable: every return type has toJSON() for MCP/REST.
 * - Single-vault scope: one client per vault.
 */

/**
 * Create an owner-side vault management client.
 *
 * Returns a plain object with closure-bound methods — NOT a class. This is
 * the recommended way to create an owner client for dashboard/admin use.
 *
 * Pattern matches viem's `createPublicClient()` — functional primitives as
 * the real API, factory for ergonomics (context carrying).
 *
 * @example
 * ```ts
 * import { createOwnerClient } from "@usesigil/kit/dashboard";
 *
 * const client = createOwnerClient({ rpc, vault, owner: signer, network: "devnet" });
 * const state = await client.getVaultState();
 * await client.freezeVault();
 * ```
 */
export function createOwnerClient(config: OwnerClientConfig): OwnerClient {
  // The factory delegates to the class internally. The class IS the implementation
  // and carries all 24+ methods correctly including constraint reads, static
  // discovery, and the full mutation surface. At v1.0 when the class is removed,
  // the factory's internal implementation will be extracted into closure-bound
  // methods (the class body becomes the factory body). For now, the factory is
  // the API migration path: consumers switch `new OwnerClient(...)` →
  // `createOwnerClient(...)` and then at v1.0 the class disappears with zero
  // consumer-facing change.
  return new OwnerClient(config);
}

/**
 * @deprecated Use `createOwnerClient(config)` instead. This class will be
 * removed at v1.0.
 *
 * Migration:
 * ```ts
 * // Before:
 * const client = new OwnerClient({ rpc, vault, owner: signer, network: "devnet" });
 * // After:
 * const client = createOwnerClient({ rpc, vault, owner: signer, network: "devnet" });
 * ```
 */
export class OwnerClient {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly vault: Address;
  readonly owner: TransactionSigner;
  readonly network: "devnet" | "mainnet";
  /**
   * Snapshot of `OwnerClientConfig.requireMainnetConfirmation`. Private +
   * readonly so post-construction mutation of the source config cannot
   * disable the gate. See {@link OwnerClient.assertMainnetConfirmed}.
   */
  private readonly requireMainnetConfirmation?: boolean;

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
    this.requireMainnetConfirmation = config.requireMainnetConfirmation;
  }

  /**
   * AL2 mainnet confirmation gate (H-9, Phase 10 Bucket 1). Run from
   * every OwnerClient mutation method before forwarding to the underlying
   * `mutations.*` builder. Mirrors the seal-side gate in
   * `createSigilClient.executeAndConfirm` so the destructive-owner-action
   * surface and the destructive-agent-action surface share one contract.
   *
   * State table (matches the seal.ts gate):
   *   network    requireFlag   opts.confirmed   outcome
   *   ─────────  ────────────  ──────────────   ───────────────
   *   devnet     (any)         (any)            PROCEED (no-op)
   *   mainnet    true          true             PROCEED
   *   mainnet    true          undefined/false  THROW MAINNET_CONFIRMATION_REQUIRED
   *   mainnet    undefined     undefined        WARN + PROCEED (0.16.x default)
   *   mainnet    undefined     true/false       PROCEED (no warn)
   *   mainnet    false         (any)            PROCEED (no warn — explicit opt-out)
   *
   * @internal Not part of the public surface; used by the mutation methods
   * on this class. Callers should not depend on the helper name or shape.
   */
  private assertMainnetConfirmed(
    methodName: string,
    opts?: { mainnetConfirmed?: boolean },
  ): void {
    if (this.network !== "mainnet") return;
    const gateEnabled = this.requireMainnetConfirmation === true;
    const explicitOptOut = this.requireMainnetConfirmation === false;
    const confirmed = opts?.mainnetConfirmed === true;
    if (gateEnabled && !confirmed) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
        `OwnerClient.${methodName} on mainnet requires \`mainnetConfirmed: true\` ` +
          `in the per-call options or \`requireMainnetConfirmation: false\` on ` +
          `the OwnerClientConfig. ` +
          `Opt-in: ${methodName}(..., { mainnetConfirmed: true }). ` +
          `Opt-out: createOwnerClient({ ..., requireMainnetConfirmation: false }). ` +
          `Docs: https://github.com/Sigil-Trade/sigil/blob/main/sdk/kit/MIGRATION.md`,
        {
          context: {
            method: methodName,
            network: "mainnet",
            vault: this.vault.toString(),
          } as never,
        },
      );
    }
    if (
      !gateEnabled &&
      !explicitOptOut &&
      opts?.mainnetConfirmed === undefined
    ) {
      // §RP Batch K LOW-2 fix: structured logger so consumers' pino /
      // OpenTelemetry pipelines capture the warning. Matches the
      // seal.ts gate's warn behaviour.
      getSigilModuleLogger().warn(
        `[Sigil] OwnerClient.${methodName} called on mainnet without ` +
          `\`mainnetConfirmed: true\`. @usesigil/kit 0.16.x defaults ` +
          `\`requireMainnetConfirmation\` to false; v1.0 will flip the default ` +
          `to true and this call will throw ` +
          `SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED. Adopt early by ` +
          `setting \`requireMainnetConfirmation: true\` on OwnerClientConfig ` +
          `and passing \`mainnetConfirmed: true\` per call, OR silence this ` +
          `warning by explicitly setting \`requireMainnetConfirmation: false\`. ` +
          `See: https://github.com/Sigil-Trade/sigil/blob/main/sdk/kit/MIGRATION.md`,
      );
    }
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

  /**
   * Single-agent detail wrapper around `getAgentProfile` + activity
   * enrichment (S10). Returns the dashboard-friendly {@link AgentData}
   * shape — same fields as one entry in `getAgents()` — for the requested
   * agent. Throws via `toDxError` when the agent is not registered.
   */
  async getAgentDetail(agent: Address): Promise<AgentData> {
    return reads.getAgentDetail(this.rpc, this.vault, agent, this.network);
  }

  /**
   * Risk-tilt summary (S11) — combines spending velocity + alert evaluation
   * into a four-level UI risk badge plus the underlying numeric metrics.
   * Use for the dashboard's "is something concerning right now?" indicator.
   * One state resolution; no activity fetch.
   */
  async getRiskMetrics(): Promise<RiskMetrics> {
    return reads.getRiskMetrics(this.rpc, this.vault, this.network);
  }

  /**
   * Governance + security audit trail (S12) — the policy/agent/security
   * subset of `getVaultActivity`. Trades and fund movements are excluded;
   * for those use `getActivity()`. Default limit is 100; pass `since` to
   * filter to events after a given Unix-ms timestamp.
   */
  async getAuditTrail(opts?: AuditTrailOptions): Promise<AuditTrailEntry[]> {
    return reads.getAuditTrail(this.rpc, this.vault, this.network, opts);
  }

  // ─── Vault Lifecycle ────────────────────────────────────────────────────────

  /** Zero args. Immediate. AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}. */
  async freezeVault(opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("freezeVault", opts);
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
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async resumeVault(
    newAgent?: { address: Address; permissions: CapabilityTier },
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("resumeVault", opts);
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
   * Phase 8 alias for {@link resumeVault} matching the on-chain
   * `reactivate_vault` instruction name. Prefer this in new code.
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async reactivateVault(
    newAgent?: { address: Address; permissions: CapabilityTier },
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("reactivateVault", opts);
    return mutations.reactivateVault(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      newAgent,
      opts,
    );
  }

  /**
   * Phase 8 owner-side observe-only toggle. `newValue: true` puts the
   * vault into read-only mode (all `validate_and_authorize` calls reject);
   * `newValue: false` resumes spending.
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async setObserveOnly(newValue: boolean, opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("setObserveOnly", opts);
    return mutations.setObserveOnly(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      newValue,
      opts,
    );
  }

  /**
   * Phase 8 owner-side queue of a new agent capability grant. The grant
   * becomes effective only after {@link applyAgentGrant} (subject to the
   * cosign_required gate if enabled). `capability` is the on-chain
   * `AgentCapability` discriminant (0=READ_ONLY, 1=OPERATOR, 2=FULL).
   * `spendingLimitUsd` is in 6-decimal USDC units.
   *
   * D-9.3 (Phase 10 Bucket 1): tightened from `number` to the literal
   * union `0 | 1 | 2`. Matches the on-chain enum exactly and gives the
   * dashboard IDE autocomplete. Codama-generated builders keep `number`
   * internally; the OwnerClient is the type boundary.
   */
  async queueAgentGrant(
    agent: Address,
    capability: 0 | 1 | 2,
    spendingLimitUsd: bigint,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("queueAgentGrant", opts);
    return mutations.queueAgentGrant(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      capability,
      spendingLimitUsd,
      opts,
    );
  }

  /**
   * Phase 8 owner-side apply of a previously-queued agent capability
   * grant. Closes the PendingAgentGrant PDA and mutates the agent set.
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async applyAgentGrant(opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("applyAgentGrant", opts);
    return mutations.applyAgentGrant(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  /**
   * Phase 8 owner-side cancel of a previously-queued agent grant. Closes
   * the PendingAgentGrant PDA and returns rent to the owner.
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async cancelAgentGrant(opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("cancelAgentGrant", opts);
    return mutations.cancelAgentGrant(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  /**
   * Permanently closes vault and reclaims rent.
   * Requires: all agents revoked, zero active sessions,
   * constraints closed, no pending policy update.
   * May need computeUnits: 400_000 for complex vaults (default applied).
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async closeVault(opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("closeVault", opts);
    return mutations.closeVault(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  // syncPositions method DELETED — position counter system removed per council
  // decision (9-1 vote, 2026-04-19). See Plans/we-need-to-plan-serialized-summit.md.

  // ─── Fund Management ────────────────────────────────────────────────────────

  /**
   * Token-2022 mints blocked by on-chain program. Standard SPL only (USDC, USDT).
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async deposit(
    mint: Address,
    amount: bigint,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("deposit", opts);
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

  /**
   * Token-2022 mints blocked by on-chain program. Standard SPL only (USDC, USDT).
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async withdraw(
    mint: Address,
    amount: bigint,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("withdraw", opts);
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
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   * @param spendingLimit — per-agent 24h cap in 6-decimal USD. Pass 0n for unlimited (NOT recommended).
   */
  async addAgent(
    agent: Address,
    permissions: CapabilityTier,
    spendingLimit: UsdBaseUnits,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("addAgent", opts);
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

  /**
   * Immediate — protective action, no timelock required.
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async pauseAgent(agent: Address, opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("pauseAgent", opts);
    return mutations.pauseAgent(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      opts,
    );
  }

  /**
   * Immediate — protective action, no timelock required.
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async unpauseAgent(agent: Address, opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("unpauseAgent", opts);
    return mutations.unpauseAgent(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      opts,
    );
  }

  /**
   * Immediate — protective action, no timelock required.
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async revokeAgent(agent: Address, opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("revokeAgent", opts);
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
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   *
   * @param spendingLimit — per-agent 24h cap in 6-decimal USD. Pass 0n for unlimited (NOT recommended).
   */
  async queueAgentPermissions(
    agent: Address,
    permissions: CapabilityTier,
    spendingLimit: UsdBaseUnits,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("queueAgentPermissions", opts);
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

  // ── Elevated-cosign surface (audit 2026-06-12) ──────────────────────────
  // On a cosign_required vault, raising an agent's capability/limit, setting a
  // cooldown, or making an elevated policy change requires a cosigner. Each pair
  // offers single-builder dual-sign (caller holds the cosigner key) and a
  // partial-sign handoff (returns a partial tx + cosign digest for a separate
  // cosigner to complete + send — true 2-of-2).

  /** Elevated agent-permissions queue — single-builder dual-sign. */
  async queueAgentPermissionsElevated(
    agent: Address,
    permissions: CapabilityTier,
    spendingLimit: UsdBaseUnits,
    cooldownSeconds: bigint,
    cosigner: TransactionSigner,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("queueAgentPermissionsElevated", opts);
    return mutations.queueAgentPermissionsElevated(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      permissions,
      spendingLimit,
      cooldownSeconds,
      cosigner,
      opts,
    );
  }

  /** Elevated agent-permissions queue — partial-sign handoff (2-of-2). */
  async buildQueueAgentPermissionsElevated(
    agent: Address,
    permissions: CapabilityTier,
    spendingLimit: UsdBaseUnits,
    cooldownSeconds: bigint,
    cosignSession: Address,
    opts?: TxOpts,
  ): Promise<ElevatedCosignBundle> {
    return mutations.buildQueueAgentPermissionsElevated(
      this.rpc,
      this.vault,
      this.owner,
      agent,
      permissions,
      spendingLimit,
      cooldownSeconds,
      cosignSession,
      opts,
    );
  }

  /** Elevated policy queue — single-builder dual-sign. */
  async queuePolicyElevated(
    changes: PolicyChanges,
    cosigner: TransactionSigner,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("queuePolicyElevated", opts);
    return mutations.queuePolicyElevated(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      changes,
      cosigner,
      opts,
    );
  }

  /** Elevated policy queue — partial-sign handoff (2-of-2). */
  async buildQueuePolicyElevated(
    changes: PolicyChanges,
    cosignSession: Address,
    opts?: TxOpts,
  ): Promise<ElevatedCosignBundle> {
    return mutations.buildQueuePolicyElevated(
      this.rpc,
      this.vault,
      this.owner,
      changes,
      cosignSession,
      opts,
    );
  }

  // ── Partial-sign elevated owner-ops (genuine 2-of-2) — take-over 2026-06-17 ──
  // On a cosign-required vault these ops are rejected (ErrCosignRequired) unless
  // the bound cosigner co-signs. Each returns a partial owner-signed wire tx for
  // the bound cosigner to co-sign + send. Use the owner-only variants only on
  // non-cosign vaults.

  /** Cancel a pending agent grant on a cosign vault — partial-sign handoff. */
  async buildCancelAgentGrantElevated(
    cosignSession: Address,
    opts?: TxOpts,
  ): Promise<CosignedActionBundle> {
    return mutations.buildCancelAgentGrantElevated(
      this.rpc,
      this.vault,
      this.owner,
      cosignSession,
      opts,
    );
  }

  /** Cancel a pending agent-permissions update on a cosign vault — partial-sign. */
  async buildCancelAgentPermissionsElevated(
    agent: Address,
    cosignSession: Address,
    opts?: TxOpts,
  ): Promise<CosignedActionBundle> {
    return mutations.buildCancelAgentPermissionsElevated(
      this.rpc,
      this.vault,
      this.owner,
      agent,
      cosignSession,
      opts,
    );
  }

  /** Cancel a pending policy update on a cosign vault — partial-sign. */
  async buildCancelPendingPolicyElevated(
    cosignSession: Address,
    opts?: TxOpts,
  ): Promise<CosignedActionBundle> {
    return mutations.buildCancelPendingPolicyElevated(
      this.rpc,
      this.vault,
      this.owner,
      cosignSession,
      opts,
    );
  }

  /** Apply a queued agent-permissions update on a cosign vault (H-1) — partial-sign. */
  async buildApplyAgentPermissionsElevated(
    agent: Address,
    cosignSession: Address,
    opts?: TxOpts,
  ): Promise<CosignedActionBundle> {
    return mutations.buildApplyAgentPermissionsElevated(
      this.rpc,
      this.vault,
      this.owner,
      agent,
      cosignSession,
      opts,
    );
  }

  /** Apply a pending policy update that DISABLES cosign on a cosign vault — partial-sign. */
  async buildApplyPendingPolicyElevated(
    cosignSession: Address,
    opts?: TxOpts,
  ): Promise<CosignedActionBundle> {
    return mutations.buildApplyPendingPolicyElevated(
      this.rpc,
      this.vault,
      this.owner,
      cosignSession,
      opts,
    );
  }

  /** Close a cosign-required vault — partial-sign handoff. */
  async buildCloseVaultElevated(
    cosignSession: Address,
    opts?: TxOpts,
  ): Promise<CosignedActionBundle> {
    return mutations.buildCloseVaultElevated(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      cosignSession,
      opts,
    );
  }

  async applyAgentPermissions(
    agent: Address,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("applyAgentPermissions", opts);
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
    this.assertMainnetConfirmed("cancelAgentPermissions", opts);
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
   * AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}.
   */
  async queuePolicyUpdate(
    changes: PolicyChanges,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("queuePolicyUpdate", opts);
    return mutations.queuePolicyUpdate(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      changes,
      opts,
    );
  }

  /** AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}. */
  async applyPendingPolicy(opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("applyPendingPolicy", opts);
    return mutations.applyPendingPolicy(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  /** AL2 mainnet gate: see {@link OwnerClient.assertMainnetConfirmed}. */
  async cancelPendingPolicy(opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("cancelPendingPolicy", opts);
    return mutations.cancelPendingPolicy(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  /**
   * Item 3 — cosigner-signed approval of a queued elevated policy update
   * (completes the 2-of-2 cosign flow before {@link applyPendingPolicy}). The
   * `cosigner` is the fee payer + sole signer; it must equal the vault's bound
   * `cosign_session_pubkey`. AL2 mainnet gate applies.
   */
  async approvePendingPolicy(
    cosigner: TransactionSigner,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("approvePendingPolicy", opts);
    return mutations.approvePendingPolicy(
      this.rpc,
      this.vault,
      cosigner,
      this.network,
      opts,
    );
  }

  /**
   * Item 3 — build (but do not sign) the cosigner's approve_pending_policy
   * transaction AND fetch+decode the pending policy for review. The cosigner's
   * wallet completes the signature and sends. No mainnet gate (returns an
   * unsigned tx — nothing is broadcast here).
   */
  async buildApprovePendingPolicy(
    cosigner: Address,
    opts?: TxOpts,
  ): Promise<mutations.ApprovePendingPolicyReview> {
    return mutations.buildApprovePendingPolicy(
      this.rpc,
      this.vault,
      cosigner,
      opts,
    );
  }

  /**
   * Item 4 — promote a destination from the vault's graylist into the approved
   * `allowed_destinations` allowlist. Owner-signed, immediate. AL2 mainnet gate
   * applies.
   */
  async promoteGraylistDestination(
    destination: Address,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("promoteGraylistDestination", opts);
    return mutations.promoteGraylistDestination(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      destination,
      opts,
    );
  }

  /**
   * Item 4 — record a policy-violation failure for an agent, incrementing its
   * consecutive-failure counter (auto-revokes at `auto_revoke_threshold`).
   * Owner-signed, immediate. `errorCode` is the on-chain policy-violation code
   * (6074..=6091) observed on the failed seal. AL2 mainnet gate applies.
   */
  async recordAgentViolation(
    agent: Address,
    errorCode: number,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("recordAgentViolation", opts);
    return mutations.recordAgentViolation(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      agent,
      errorCode,
      opts,
    );
  }

  // ─── Phase 8 Ownership Transfer (M-2, audit 2026-05-21) ─────────────────────
  //
  // On-chain handlers live at programs/sigil/src/instructions/
  // {initiate,accept,cancel}_ownership_transfer.rs plus the Squads V4
  // accept-multisig variant. Cosign + timelock rules per the Rust handlers
  // are documented on each method below.

  /**
   * Queue an ownership transfer for this vault. The pending PDA carries
   * the target `newOwner` plus the configured timelock (default 48h).
   * The transfer is finalised only by a follow-up
   * {@link OwnerClient.acceptOwnershipTransfer} (wallet) or
   * {@link OwnerClient.acceptOwnershipTransferMultisig} (Squads V4).
   *
   * Cosign: if `policy.cosign_required = true`, the on-chain handler
   * (ISC-129 interim cosign gate) requires a non-owner co-signer. Build
   * the tx with the cosign session pubkey in the signer set; this method
   * does not add it for you.
   *
   * Errors:
   *  - 6094 `ErrPendingOwnershipExists` — a previous transfer is still
   *    pending. Call {@link OwnerClient.cancelOwnershipTransfer} first.
   *  - 6098 `ErrInvalidOwnershipTarget` — `newOwner` is a system program
   *    / sysvar (would permanently brick the vault).
   *  - 6080 `ErrCosignRequired` — cosign-opted-in policy and no co-signer.
   *
   * @param newOwner         Target pubkey for the transfer.
   * @param isMultisigTarget `true` when `newOwner` is a Squads V4
   *                         multisig PDA. The accept handler enforces
   *                         the matching ix variant.
   */
  async initiateOwnershipTransfer(
    newOwner: Address,
    isMultisigTarget: boolean,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("initiateOwnershipTransfer", opts);
    return mutations.initiateOwnershipTransfer(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      newOwner,
      isMultisigTarget,
      opts,
    );
  }

  /**
   * Finalise a previously-initiated ownership transfer when the new
   * owner is a wallet (keypair) signer. The `OwnerClient` must be
   * constructed with the NEW owner as `config.owner` — the on-chain
   * handler verifies the signer matches `pending.new_owner`.
   *
   * Timelock: rejects with 6104 `ErrPendingOwnershipNotReady` if the
   * configured window (default 48h) has not elapsed since
   * {@link OwnerClient.initiateOwnershipTransfer}.
   *
   * Post-condition: `vault.owner` is overwritten with the new owner;
   * `vault.vault_authority` (the immutable PDA seed) is unchanged.
   * Existing PDA-derivation helpers continue to resolve the same
   * vault address.
   */
  async acceptOwnershipTransfer(opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("acceptOwnershipTransfer", opts);
    return mutations.acceptOwnershipTransfer(
      this.rpc,
      this.vault,
      this.owner,
      this.network,
      opts,
    );
  }

  /**
   * Finalise a previously-initiated ownership transfer when the new
   * owner is a Squads V4 multisig PDA. The PDA itself has no private
   * key; the Squads program is the CPI caller. This method's
   * `multisigPda` is the address declared at initiate time; the fee
   * payer is `this.owner` (any wallet that funds the tx — typically a
   * member of the Squads).
   *
   * Caller is responsible for routing this ix through the Squads V4
   * proposal flow so it executes under the Squads program signer seeds.
   *
   * The on-chain handler verifies:
   *   1. `multisig_pda.owner == SQUADS_V4_PROGRAM_ID`
   *   2. `multisig_pda.key() == pending.new_owner`
   *   3. `pending.is_multisig_target == true`
   *
   * Errors mirror {@link OwnerClient.acceptOwnershipTransfer} plus a
   * mismatch rejection if the queued `is_multisig_target` flag does
   * not match.
   */
  async acceptOwnershipTransferMultisig(
    multisigPda: Address,
    opts?: TxOpts,
  ): Promise<TxResult> {
    this.assertMainnetConfirmed("acceptOwnershipTransferMultisig", opts);
    return mutations.acceptOwnershipTransferMultisig(
      this.rpc,
      this.vault,
      multisigPda,
      this.owner,
      this.network,
      opts,
    );
  }

  /**
   * Cancel a queued ownership transfer during the timelock window.
   * `this.owner` MUST match `pending.current_owner` (the pubkey that
   * called {@link OwnerClient.initiateOwnershipTransfer}); the on-chain
   * handler rejects with a require-keys-eq violation otherwise.
   *
   * Closes the pending PDA and returns rent to the current owner. After
   * this lands, {@link OwnerClient.initiateOwnershipTransfer} is
   * callable again.
   *
   * Cosign: D4 symmetric gate — if `policy.cosign_required`,
   * cancellation also requires a non-owner co-signer in the signer set.
   */
  async cancelOwnershipTransfer(opts?: TxOpts): Promise<TxResult> {
    this.assertMainnetConfirmed("cancelOwnershipTransfer", opts);
    return mutations.cancelOwnershipTransfer(
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
