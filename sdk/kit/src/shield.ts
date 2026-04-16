/**
 * Shield — Kit-native Client-Side Policy Enforcement (Defense-in-Depth)
 *
 * Wraps instruction signing with spending limits, rate limits,
 * program allowlists, and custom checks.
 *
 * IMPORTANT: Shield is a CLIENT-SIDE advisory layer, NOT a security boundary.
 * The on-chain program (validate_and_authorize + finalize_session) provides the
 * hard enforcement of spending caps, permissions, and protocol allowlists.
 * Shield reduces blast radius by catching violations before signing, but callers
 * CAN bypass Shield by using the underlying TransactionSigner directly.
 * This is by design — Shield prevents accidents, on-chain prevents catastrophe.
 *
 * State (spending counters, velocity limits) is in-memory and resets on process
 * restart. Use syncFromOnChain() to re-sync with the authoritative on-chain state.
 */

import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "./kit-adapter.js";
import { getBase64EncodedWireTransaction } from "./kit-adapter.js";
import {
  analyzeInstructions,
  type InspectableInstruction,
  type InstructionAnalysis,
  type TokenTransferInfo,
} from "./inspector.js";
import {
  resolvePolicies,
  type ShieldPolicies,
  type ResolvedPolicies,
  type SpendLimit,
} from "./policies.js";
import { simulateBeforeSend } from "./simulation.js";
import { SIGIL_PROGRAM_ADDRESS } from "./generated/programs/sigil.js";
import { VALIDATE_AND_AUTHORIZE_DISCRIMINATOR } from "./generated/instructions/validateAndAuthorize.js";
import { FINALIZE_SESSION_DISCRIMINATOR } from "./generated/instructions/finalizeSession.js";
import type { AltCache } from "./alt-loader.js";
import {
  resolveVaultState,
  type ResolvedVaultState,
} from "./state-resolver.js";
import { isStablecoinMint, validateNetwork, type Network } from "./types.js";
// Per UD2 (Engineer-reorder via Council): canonical ShieldDeniedError +
// PolicyViolation definitions live in `core/errors.ts`. Imported and
// re-exported here for backwards compatibility with existing import paths.
// The `code?: number` 2nd constructor argument from the historical
// shield.ts version is REMOVED — see changeset for migration notes.
import { ShieldDeniedError, type PolicyViolation } from "./core/errors.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import {
  SIGIL_ERROR__SDK__INVALID_CONFIG,
  SIGIL_ERROR__SDK__SIGNER_INVALID,
} from "./errors/codes.js";

// ─── Re-exports ─────────────────────────────────────────────────────────────
export { ShieldDeniedError, type PolicyViolation };

export interface ShieldCheckResult {
  allowed: boolean;
  violations: PolicyViolation[];
  /** Non-fatal warnings (e.g., ALT index out of bounds during analysis). */
  warnings?: string[];
}

export interface SpendingSummary {
  tokens: Array<{
    mint: Address;
    symbol?: string;
    spent: bigint;
    limit: bigint;
    remaining: bigint;
    windowMs: number;
  }>;
  rateLimit: {
    count: number;
    limit: number;
    remaining: number;
    windowMs: number;
  };
  isPaused: boolean;
  /** On-chain spending state. Undefined when not synced. */
  onChain?: {
    globalSpent24h: bigint;
    globalCap: bigint;
    globalRemaining: bigint;
    agentSpent24h: bigint | null;
    agentCap: bigint | null;
    agentRemaining: bigint | null;
    maxTransactionUsd: bigint;
    localAdditions: bigint;
    syncedAt: bigint;
  };
}

// ─── Shield State ───────────────────────────────────────────────────────────

interface SpendEntry {
  mint: string;
  amount: bigint;
  timestamp: number;
}

interface TxEntry {
  timestamp: number;
}

interface Checkpoint {
  spendEntries: SpendEntry[];
  txEntries: TxEntry[];
  resolvedState: ResolvedVaultState | null;
  localUsdAdditions: bigint;
  network: Network | null;
  enforceUsed: boolean;
}

export class ShieldState {
  private spendEntries: SpendEntry[] = [];
  private txEntries: TxEntry[] = [];

  // On-chain sync state
  private _resolvedState: ResolvedVaultState | null = null;
  private _localUsdAdditions = 0n;
  private _network: Network | null = null;

  // S-7: Mutual exclusivity tracking
  private _enforceUsed = false;

  getSpendInWindow(mint: string, windowMs: number): bigint {
    const cutoff = Date.now() - windowMs;
    return this.spendEntries
      .filter((e) => e.mint === mint && e.timestamp >= cutoff)
      .reduce((sum, e) => sum + e.amount, 0n);
  }

  getTotalSpendInWindow(windowMs: number): bigint {
    const cutoff = Date.now() - windowMs;
    return this.spendEntries
      .filter((e) => e.timestamp >= cutoff)
      .reduce((sum, e) => sum + e.amount, 0n);
  }

  getTransactionCountInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.txEntries.filter((e) => e.timestamp >= cutoff).length;
  }

  recordSpend(mint: string, amount: bigint): void {
    this.spendEntries.push({ mint, amount, timestamp: Date.now() });
    this.prune();
  }

  recordTransaction(): void {
    this.txEntries.push({ timestamp: Date.now() });
    this.prune();
  }

  /** Prune stale entries when arrays exceed threshold. */
  private prune(): void {
    const PRUNE_THRESHOLD = 10_000;
    if (this.spendEntries.length > PRUNE_THRESHOLD) {
      const cutoff = Date.now() - 86_400_000;
      this.spendEntries = this.spendEntries.filter(
        (e) => e.timestamp >= cutoff,
      );
    }
    if (this.txEntries.length > PRUNE_THRESHOLD) {
      const cutoff = Date.now() - 86_400_000;
      this.txEntries = this.txEntries.filter((e) => e.timestamp >= cutoff);
    }
  }

  /** Sync spending baseline from on-chain state. Resets local additions. */
  syncFromOnChain(state: ResolvedVaultState, network?: Network): void {
    this._resolvedState = state;
    this._localUsdAdditions = 0n;
    if (network !== undefined) {
      this._network = network;
    }
  }

  /** Record local USD spend (optimistic addition on top of on-chain baseline). */
  recordUsdSpend(amount: bigint): void {
    this._localUsdAdditions += amount;
  }

  /** Effective 24h global spend: on-chain baseline + local additions. */
  getEffectiveGlobalSpent24h(): bigint {
    if (!this._resolvedState) return this._localUsdAdditions;
    return this._resolvedState.globalBudget.spent24h + this._localUsdAdditions;
  }

  /** Effective 24h remaining against on-chain cap. Returns null if not synced. */
  getEffectiveGlobalRemaining(): bigint | null {
    if (!this._resolvedState) return null;
    const cap = this._resolvedState.globalBudget.cap;
    const spent = this.getEffectiveGlobalSpent24h();
    return spent < cap ? cap - spent : 0n;
  }

  /** Resolved on-chain state, or null if never synced. */
  get resolvedState(): ResolvedVaultState | null {
    return this._resolvedState;
  }

  /** Local USD additions since last sync. */
  get localUsdAdditions(): bigint {
    return this._localUsdAdditions;
  }

  /** Network configured during sync. Null if never synced with network. */
  get network(): Network | null {
    return this._network;
  }

  /** Effective 24h agent spend: on-chain baseline + local additions. Null if no agent budget. */
  getEffectiveAgentSpent24h(): bigint | null {
    if (!this._resolvedState?.agentBudget) return null;
    return this._resolvedState.agentBudget.spent24h + this._localUsdAdditions;
  }

  /** Effective 24h remaining against agent cap. Null if no agent budget or not synced. */
  getEffectiveAgentRemaining(): bigint | null {
    if (!this._resolvedState?.agentBudget) return null;
    const cap = this._resolvedState.agentBudget.cap;
    const spent =
      this._resolvedState.agentBudget.spent24h + this._localUsdAdditions;
    return spent < cap ? cap - spent : 0n;
  }

  /** S-7: Whether enforce() has been called on this state. */
  get enforceUsed(): boolean {
    return this._enforceUsed;
  }

  /** S-7: Mark that enforce() was used. */
  markEnforceUsed(): void {
    this._enforceUsed = true;
  }

  checkpoint(): Checkpoint {
    return {
      spendEntries: [...this.spendEntries],
      txEntries: [...this.txEntries],
      resolvedState: this._resolvedState,
      localUsdAdditions: this._localUsdAdditions,
      network: this._network,
      enforceUsed: this._enforceUsed,
    };
  }

  rollback(cp: Checkpoint): void {
    this.spendEntries = [...cp.spendEntries];
    this.txEntries = [...cp.txEntries];
    this._resolvedState = cp.resolvedState;
    this._localUsdAdditions = cp.localUsdAdditions;
    this._network = cp.network;
    this._enforceUsed = cp.enforceUsed;
  }

  reset(): void {
    this.spendEntries = [];
    this.txEntries = [];
    this._resolvedState = null;
    this._localUsdAdditions = 0n;
    this._network = null;
    this._enforceUsed = false;
  }
}

// ─── Policy Evaluation ──────────────────────────────────────────────────────

/**
 * Evaluate a set of instructions against resolved policies.
 * When state has on-chain sync, also checks vault/agent caps (requires network).
 */
export function evaluateInstructions(
  instructions: InspectableInstruction[],
  signerAddress: Address,
  resolved: ResolvedPolicies,
  state: ShieldState,
  network?: Network,
): { violations: PolicyViolation[]; analysis: InstructionAnalysis } {
  if (network) validateNetwork(network);
  const violations: PolicyViolation[] = [];
  const analysis = analyzeInstructions(instructions, signerAddress);

  // 1. Program allowlist check
  if (resolved.blockUnknownPrograms && resolved.allowedProtocols) {
    for (const pid of analysis.programIds) {
      if (!SYSTEM_PROGRAMS.has(pid) && !resolved.allowedProtocols.has(pid)) {
        violations.push({
          rule: "program_allowlist",
          message: `Program ${pid} is not in the allowed list`,
          suggestion: "Use a protocol that is explicitly allowed by the policy",
        });
      }
    }
  }

  // 2. Spend limit check
  if (resolved.spendLimits) {
    for (const limit of resolved.spendLimits) {
      const windowMs = limit.windowMs ?? 86_400_000;
      const currentSpend = state.getSpendInWindow(limit.mint, windowMs);
      const txSpend = analysis.tokenTransfers
        .filter(
          (t) =>
            t.authority === signerAddress &&
            (t.mint === limit.mint || t.mint === null),
        )
        .reduce((sum, t) => sum + t.amount, 0n);

      if (currentSpend + txSpend > limit.amount) {
        violations.push({
          rule: "spend_limit",
          message: `Spend limit exceeded for ${limit.mint}: ${currentSpend + txSpend} > ${limit.amount}`,
          suggestion:
            "Reduce the transaction amount or wait for the rolling window to reset",
        });
      }
    }
  }

  // 3. Rate limit check
  if (resolved.rateLimit) {
    const count = state.getTransactionCountInWindow(
      resolved.rateLimit.windowMs,
    );
    if (count >= resolved.rateLimit.maxTransactions) {
      violations.push({
        rule: "rate_limit",
        message: `Rate limit exceeded: ${count}/${resolved.rateLimit.maxTransactions} transactions in window`,
        suggestion: "Wait before sending more transactions",
      });
    }
  }

  // 4. Custom check
  if (resolved.customCheck) {
    const customAnalysis = {
      programIds: analysis.programIds,
      transfers: analysis.tokenTransfers.map((t) => ({
        mint: (t.mint ?? "") as Address,
        amount: t.amount,
        direction: (t.authority === signerAddress ? "outgoing" : "unknown") as
          | "outgoing"
          | "incoming"
          | "unknown",
        destination: t.destination,
      })),
      estimatedValueLamports: analysis.estimatedValue,
    };

    const customResult = resolved.customCheck(customAnalysis);
    if (!customResult.allowed) {
      violations.push({
        rule: "custom",
        message: customResult.reason ?? "Custom policy check failed",
        suggestion:
          "Review the custom policy callback and the rejected transaction inputs; adjust the policy or the transaction to satisfy the predicate.",
      });
    }
  }

  // 5. On-chain vault/agent cap check (when synced)
  const effectiveNetwork = network ?? state.network;
  if (state.resolvedState && effectiveNetwork) {
    const rs = state.resolvedState;
    const stablecoinUsdAmount = computeStablecoinUsd(
      analysis.tokenTransfers,
      signerAddress,
      effectiveNetwork,
    );

    if (stablecoinUsdAmount > 0n) {
      // Transaction size
      if (stablecoinUsdAmount > rs.maxTransactionUsd) {
        violations.push({
          rule: "on_chain_tx_size",
          message: `Transaction ${stablecoinUsdAmount} exceeds max ${rs.maxTransactionUsd}`,
          suggestion: "Reduce the transaction amount",
        });
      }

      // Global vault cap
      const effectiveGlobalSpent = state.getEffectiveGlobalSpent24h();
      if (effectiveGlobalSpent + stablecoinUsdAmount > rs.globalBudget.cap) {
        violations.push({
          rule: "on_chain_vault_cap",
          message: `Would exceed on-chain daily cap: ${effectiveGlobalSpent + stablecoinUsdAmount} > ${rs.globalBudget.cap}`,
          suggestion: "Reduce amount or wait for the 24h window to roll",
        });
      }

      // Per-agent cap
      const effectiveAgentSpent = state.getEffectiveAgentSpent24h();
      if (effectiveAgentSpent !== null && rs.agentBudget) {
        if (effectiveAgentSpent + stablecoinUsdAmount > rs.agentBudget.cap) {
          violations.push({
            rule: "on_chain_agent_cap",
            message: `Would exceed agent spend limit: ${effectiveAgentSpent + stablecoinUsdAmount} > ${rs.agentBudget.cap}`,
            suggestion: "Reduce amount or wait",
          });
        }
      }
    }
  }

  return { violations, analysis };
}

import {
  SYSTEM_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ATA_PROGRAM_ADDRESS,
} from "./types.js";

// PR 3.B F036: use canonical constants instead of inline strings.
const SYSTEM_PROGRAMS = new Set<string>([
  SYSTEM_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ATA_PROGRAM_ADDRESS,
]);

/**
 * Sum USD value of outgoing stablecoin transfers only.
 * Plain Transfer instructions have mint=null — skip those.
 * On-chain uses stablecoin identity: USDC/USDT amount / 10^6 = USD.
 */
function computeStablecoinUsd(
  transfers: TokenTransferInfo[],
  signerAddress: Address,
  network: Network,
): bigint {
  return transfers
    .filter(
      (t) =>
        t.authority === signerAddress &&
        t.mint !== null &&
        isStablecoinMint(t.mint, network),
    )
    .reduce((sum, t) => sum + t.amount, 0n);
}

// ─── Shield Function ────────────────────────────────────────────────────────

export interface ShieldOptions {
  onDenied?: (error: ShieldDeniedError) => void;
  onApproved?: () => void;
  onPolicyUpdate?: (policies: ShieldPolicies) => void;
  onPause?: () => void;
  onResume?: () => void;
  /** Enable on-chain spending baseline sync via StateResolver. */
  onChainSync?: {
    rpc: Rpc<SolanaRpcApi>;
    vaultAddress: Address;
    agentAddress: Address;
    network: Network;
  };
  /** S-2: Warn when resolved state is older than this many seconds (default: 300). */
  stalenessWarnThresholdSec?: number;
}

export interface ShieldedContext {
  /** Check instructions against policies without recording */
  check(
    instructions: InspectableInstruction[],
    signerAddress: Address,
  ): ShieldCheckResult;

  /** Check and record — throws ShieldDeniedError if denied */
  enforce(instructions: InspectableInstruction[], signerAddress: Address): void;

  /** Current resolved policies */
  readonly resolvedPolicies: ResolvedPolicies;

  /** Whether enforcement is paused */
  readonly isPaused: boolean;

  /** Update policies */
  updatePolicies(policies: ShieldPolicies): void;

  /** Reset spending state */
  resetState(): void;

  /** Pause enforcement */
  pause(): void;

  /** Resume enforcement */
  resume(): void;

  /** Get spending summary */
  getSpendingSummary(): SpendingSummary;

  /** Sync spending state from on-chain SpendTracker via StateResolver.
   *  Requires onChainSync config in ShieldOptions.
   *  Updates baseline and resets local additions. */
  sync(): Promise<void>;

  /** Whether on-chain sync is configured. */
  readonly hasOnChainSync: boolean;

  /** Internal state (for testing) */
  readonly state: ShieldState;
}

/**
 * Create a Kit-native shield context for client-side policy enforcement.
 *
 * Unlike the web3.js shield() which wraps wallet signing,
 * this works at the instruction level:
 * - check() validates instructions without side effects
 * - enforce() validates and records, throwing on violation
 */
export function shield(
  policies?: ShieldPolicies,
  options?: ShieldOptions,
): ShieldedContext {
  let resolved = resolvePolicies(policies);
  const state = new ShieldState();
  let paused = false;
  const syncConfig = options?.onChainSync;
  if (syncConfig) validateNetwork(syncConfig.network);
  const stalenessThreshold = options?.stalenessWarnThresholdSec ?? 300;

  // S-1: Warn when no onChainSync — spend tracking is ephemeral
  if (!syncConfig) {
    console.warn(
      "[Shield] No onChainSync configured — spend tracking is client-side only " +
        "and will reset on process restart.",
    );
  }

  return {
    check(
      instructions: InspectableInstruction[],
      signerAddress: Address,
    ): ShieldCheckResult {
      if (paused) {
        return {
          allowed: false,
          violations: [
            {
              rule: "paused",
              message:
                "Shield is paused — all operations blocked until resume()",
              suggestion: "Call resume() to re-enable",
            },
          ],
        };
      }

      // S-2: Staleness warning
      _warnIfStale(state, stalenessThreshold);

      const { violations } = evaluateInstructions(
        instructions,
        signerAddress,
        resolved,
        state,
        syncConfig?.network,
      );

      return { allowed: violations.length === 0, violations };
    },

    enforce(
      instructions: InspectableInstruction[],
      signerAddress: Address,
    ): void {
      if (paused) {
        const error = new ShieldDeniedError([
          {
            rule: "paused",
            message: "Shield is paused — all operations blocked until resume()",
            suggestion: "Call resume() to re-enable",
          },
        ]);
        options?.onDenied?.(error);
        throw error;
      }

      // S-2: Staleness warning
      _warnIfStale(state, stalenessThreshold);

      const { violations, analysis } = evaluateInstructions(
        instructions,
        signerAddress,
        resolved,
        state,
        syncConfig?.network,
      );

      if (violations.length > 0) {
        const error = new ShieldDeniedError(violations);
        options?.onDenied?.(error);
        throw error;
      }

      // Record the transaction — reuse analysis from evaluateInstructions
      for (const transfer of analysis.tokenTransfers) {
        if (transfer.authority === signerAddress) {
          state.recordSpend(transfer.mint ?? "", transfer.amount);
        }
      }
      state.recordTransaction();

      // Record aggregate stablecoin USD for on-chain cap tracking
      if (state.resolvedState && syncConfig) {
        const stablecoinUsd = computeStablecoinUsd(
          analysis.tokenTransfers,
          signerAddress,
          syncConfig.network,
        );
        if (stablecoinUsd > 0n) {
          state.recordUsdSpend(stablecoinUsd);
        }
      }

      // S-7: Mark that enforce() was used
      state.markEnforceUsed();

      options?.onApproved?.();
    },

    get resolvedPolicies(): ResolvedPolicies {
      return resolved;
    },

    get isPaused(): boolean {
      return paused;
    },

    updatePolicies(newPolicies: ShieldPolicies): void {
      resolved = resolvePolicies(newPolicies);
      options?.onPolicyUpdate?.(newPolicies);
    },

    resetState(): void {
      state.reset();
    },

    pause(): void {
      paused = true;
      options?.onPause?.();
    },

    resume(): void {
      paused = false;
      options?.onResume?.();
    },

    getSpendingSummary(): SpendingSummary {
      const tokens = (resolved.spendLimits ?? []).map((limit: SpendLimit) => {
        const windowMs = limit.windowMs ?? 86_400_000;
        const spent = state.getSpendInWindow(limit.mint, windowMs);
        const remaining = limit.amount > spent ? limit.amount - spent : 0n;
        return {
          mint: limit.mint as Address,
          spent,
          limit: limit.amount,
          remaining,
          windowMs,
        };
      });

      const rl = resolved.rateLimit ?? {
        maxTransactions: 60,
        windowMs: 3_600_000,
      };
      const txCount = state.getTransactionCountInWindow(rl.windowMs);

      const rs = state.resolvedState;
      const onChain = rs
        ? {
            globalSpent24h: state.getEffectiveGlobalSpent24h(),
            globalCap: rs.globalBudget.cap,
            globalRemaining: state.getEffectiveGlobalRemaining() ?? 0n,
            agentSpent24h: state.getEffectiveAgentSpent24h(),
            agentCap: rs.agentBudget?.cap ?? null,
            agentRemaining: state.getEffectiveAgentRemaining(),
            maxTransactionUsd: rs.maxTransactionUsd,
            localAdditions: state.localUsdAdditions,
            syncedAt: rs.resolvedAtTimestamp,
          }
        : undefined;

      return {
        tokens,
        rateLimit: {
          count: txCount,
          limit: rl.maxTransactions,
          remaining: Math.max(0, rl.maxTransactions - txCount),
          windowMs: rl.windowMs,
        },
        isPaused: paused,
        onChain,
      };
    },

    async sync(): Promise<void> {
      if (!syncConfig) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__INVALID_CONFIG,
          "Cannot sync: onChainSync not configured in ShieldOptions",
          { context: { field: "onChainSync", expected: "OnChainSyncConfig" } },
        );
      }
      const resolved = await resolveVaultState(
        syncConfig.rpc,
        syncConfig.vaultAddress,
        syncConfig.agentAddress,
      );
      state.syncFromOnChain(resolved, syncConfig.network);
    },

    get hasOnChainSync(): boolean {
      return syncConfig !== undefined;
    },

    get state(): ShieldState {
      return state;
    },
  };
}

// ─── Shielded Signer (Pre-Sign Gate) ──────────────────────────────────────

/**
 * Options for the 5-property pre-sign gate.
 */
export interface ShieldedSignerOptions {
  /** Property 3: RPC for fail-closed simulation. */
  rpc?: Rpc<SolanaRpcApi>;
  /** Property 5: Session binding context. */
  sessionContext?: {
    sessionPda: Address;
    expirySlot: bigint;
  };
  /** Skip simulation (testing only). */
  skipSimulation?: boolean;
  /** Property 2: Velocity ceiling thresholds. */
  velocityThresholds?: {
    maxTxPerHour?: number;
    maxUsdPerHour?: bigint;
  };
  /** AltCache for resolving ALT-compressed accounts in compiled transactions.
   *  Populated during compose, read synchronously during sign. */
  altCache?: AltCache;
  /** S-4: Session binding severity. 'hard' throws on incomplete binding, 'soft' warns. Default: 'hard'. */
  sessionBindingSeverity?: "soft" | "hard";
}

/**
 * Create a TransactionSigner that enforces a 5-property pre-sign gate.
 *
 * Intercepts every signing call and runs:
 *   1. Intent-TX correspondence (SOFT — logs warning)
 *   2. Velocity ceiling (HARD — throws)
 *   3. Simulation liveness (HARD — throws)
 *   4. Instruction allowlist via ShieldedContext (HARD — throws)
 *   5. Session binding (SOFT — logs warning)
 *
 * On pass, delegates to the baseSigner. On HARD fail, throws ShieldDeniedError.
 *
 * @param baseSigner - The underlying TransactionSigner to delegate to
 * @param shieldCtx - ShieldedContext providing policy evaluation and state
 * @param options - Optional configuration for each property
 */
export function createShieldedSigner(
  baseSigner: TransactionSigner,
  shieldCtx: ShieldedContext,
  options?: ShieldedSignerOptions,
): TransactionSigner {
  return {
    address: baseSigner.address,
    async modifyAndSignTransactions(
      txs: readonly any[],
    ): Promise<readonly any[]> {
      for (const tx of txs) {
        const instructions = _extractInstructionsFromCompiled(
          tx,
          options?.altCache,
        );

        // Property 2: Velocity ceiling (HARD)
        if (options?.velocityThresholds) {
          checkVelocityCeiling(
            shieldCtx.state,
            instructions,
            baseSigner.address,
            options.velocityThresholds,
          );
        }

        // Property 3: Simulation liveness (HARD)
        if (options?.rpc && !options?.skipSimulation) {
          let wireBase64: ReturnType<typeof getBase64EncodedWireTransaction>;
          try {
            wireBase64 = getBase64EncodedWireTransaction(tx);
          } catch (encodeErr) {
            // Fail-closed: if we can't encode the TX, block signing
            throw new ShieldDeniedError([
              {
                rule: "simulation",
                message: `Cannot encode transaction for simulation: ${encodeErr instanceof Error ? encodeErr.message : "unknown error"}`,
                suggestion: "Ensure the transaction is properly formed",
              },
            ]);
          }
          const result = await simulateBeforeSend(options.rpc, wireBase64);
          if (!result.success) {
            throw new ShieldDeniedError([
              {
                rule: "simulation",
                message: `Simulation failed: ${result.error?.message ?? "unknown error"}`,
                suggestion:
                  result.error?.suggestion ?? "Check transaction validity",
              },
            ]);
          }
        }

        // Property 4: Instruction allowlist (HARD)
        const checkResult = shieldCtx.check(instructions, baseSigner.address);
        if (!checkResult.allowed) {
          throw new ShieldDeniedError(checkResult.violations);
        }

        // Property 5: Session binding (severity controlled by S-4)
        if (options?.sessionContext) {
          checkSessionBinding(
            tx,
            SIGIL_PROGRAM_ADDRESS,
            options?.sessionBindingSeverity ?? "hard",
          );
        }

        // S-7: Warn about double-counting risk if enforce() was already used
        if (shieldCtx.state.enforceUsed) {
          console.warn(
            "[ShieldedSigner] enforce() was already called on this ShieldState — " +
              "using ShieldedSigner after enforce() may double-count spending",
          );
        }

        // All checks passed — record spend and transaction in shared state
        const analysis = analyzeInstructions(instructions, baseSigner.address);
        for (const transfer of analysis.tokenTransfers) {
          if (transfer.authority === baseSigner.address) {
            shieldCtx.state.recordSpend(transfer.mint ?? "", transfer.amount);
          }
        }
        shieldCtx.state.recordTransaction();

        // Record aggregate stablecoin USD for on-chain cap tracking
        if (shieldCtx.state.resolvedState && shieldCtx.state.network) {
          const stablecoinUsd = computeStablecoinUsd(
            analysis.tokenTransfers,
            baseSigner.address,
            shieldCtx.state.network,
          );
          if (stablecoinUsd > 0n) {
            shieldCtx.state.recordUsdSpend(stablecoinUsd);
          }
        }
      }

      // Delegate to base signer
      const signer = baseSigner as TransactionSigner & {
        modifyAndSignTransactions?: (
          ...args: unknown[]
        ) => Promise<readonly unknown[]>;
        signTransactions?: (...args: unknown[]) => Promise<readonly unknown[]>;
      };
      if (signer.modifyAndSignTransactions) {
        return signer.modifyAndSignTransactions(txs);
      } else if (signer.signTransactions) {
        const sigs = await signer.signTransactions(txs);
        return txs.map((tx: any, i: number) => ({
          ...tx,
          signatures: {
            ...tx.signatures,
            ...(sigs[i] as Record<string, unknown>),
          },
        }));
      }
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__SIGNER_INVALID,
        "Unsupported signer type: must implement signTransactions or modifyAndSignTransactions",
        { context: { reason: "missing-sign-method" } },
      );
    },
  } as TransactionSigner;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Extract InspectableInstruction[] from a compiled transaction object.
 * Resolves program addresses from staticAccounts[programAddressIndex].
 * When ALTs are used, resolves ALT-compressed account indices via AltCache.
 *
 * Exported as _extractInstructionsFromCompiled for direct testing.
 */
export function _extractInstructionsFromCompiled(
  tx: any,
  altCache?: AltCache,
  warnings?: string[],
): InspectableInstruction[] {
  const msg = tx.compiledMessage;
  if (!msg?.staticAccounts?.length || !msg?.instructions?.length) {
    return [];
  }

  // Build combined account table: static + ALT-resolved
  let accountTable: Address[] = [...msg.staticAccounts];

  if (msg.addressTableLookups?.length && altCache) {
    // S-3: Resolve ALT index with bounds check, accumulating warnings on OOB
    const resolveAltIndex = (idx: number, resolved: Address[]): Address => {
      if (idx < resolved.length) return resolved[idx];
      warnings?.push(
        `ALT index ${idx} out of bounds (table has ${resolved.length} entries) — account substituted with system program for analysis`,
      );
      return "11111111111111111111111111111111" as Address;
    };

    // Two-pass ordering: Solana compiled messages order ALL writables from
    // ALL lookups first, then ALL readonlys from ALL lookups.
    // Pass 1: ALL writables from ALL lookups (in lookup order)
    for (const lookup of msg.addressTableLookups) {
      const resolved = altCache.getCachedAddresses(
        lookup.lookupTableAddress as Address,
      );
      if (resolved) {
        for (const idx of lookup.writableIndexes ?? []) {
          accountTable.push(resolveAltIndex(idx, resolved));
        }
      }
    }
    // Pass 2: ALL readonlys from ALL lookups
    for (const lookup of msg.addressTableLookups) {
      const resolved = altCache.getCachedAddresses(
        lookup.lookupTableAddress as Address,
      );
      if (resolved) {
        for (const idx of lookup.readonlyIndexes ?? []) {
          accountTable.push(resolveAltIndex(idx, resolved));
        }
      }
    }
  } else if (msg.addressTableLookups?.length) {
    console.warn(
      "[ShieldedSigner] ALT-compressed accounts cannot be resolved without AltCache",
    );
  }

  return msg.instructions.map((ix: any) => ({
    programAddress: accountTable[ix.programAddressIndex] as Address,
    accounts: (ix.accountIndices ?? []).map((i: number) => ({
      address: accountTable[i] as Address,
    })),
    data: ix.data ? new Uint8Array(ix.data) : new Uint8Array(),
  }));
}

/**
 * Property 2: Check velocity ceilings. HARD — throws ShieldDeniedError.
 */
function checkVelocityCeiling(
  state: ShieldState,
  instructions: InspectableInstruction[],
  signerAddress: Address,
  thresholds: NonNullable<ShieldedSignerOptions["velocityThresholds"]>,
): void {
  if (thresholds.maxTxPerHour !== undefined) {
    const count = state.getTransactionCountInWindow(3_600_000);
    if (count >= thresholds.maxTxPerHour) {
      throw new ShieldDeniedError([
        {
          rule: "velocity_ceiling",
          message: `Transaction rate ${count}/${thresholds.maxTxPerHour} per hour exceeded`,
          suggestion: "Wait before sending more transactions",
        },
      ]);
    }
  }

  if (thresholds.maxUsdPerHour !== undefined) {
    const analysis = analyzeInstructions(instructions, signerAddress);
    const currentSpend = state.getTotalSpendInWindow(3_600_000);
    const projectedSpend = currentSpend + analysis.estimatedValue;
    if (projectedSpend > thresholds.maxUsdPerHour) {
      throw new ShieldDeniedError([
        {
          rule: "velocity_ceiling",
          message: `Hourly USD spend ${projectedSpend} exceeds ceiling ${thresholds.maxUsdPerHour}`,
          suggestion:
            "Reduce transaction amounts or wait for the window to reset",
        },
      ]);
    }
  }
}

/**
 * Property 5: Check session binding (validate+finalize sandwich).
 * S-4: severity controls behavior — 'hard' throws, 'soft' warns.
 */
function checkSessionBinding(
  tx: any,
  programAddress: Address,
  severity: "soft" | "hard" = "hard",
): void {
  const msg = tx.compiledMessage;
  if (!msg?.staticAccounts?.length || !msg?.instructions?.length) {
    const message =
      "[ShieldedSigner] Cannot verify session binding: no compiled message";
    if (severity === "hard") {
      throw new ShieldDeniedError([
        {
          rule: "session_binding",
          message,
          suggestion:
            "Compose the transaction with seal()/SigilClient so the validate-and-authorize and finalize-session instructions sandwich the DeFi instruction; do not invoke the program manually.",
        },
      ]);
    }
    console.warn(message);
    return;
  }

  const sigilIxs = msg.instructions.filter(
    (ix: any) => msg.staticAccounts[ix.programAddressIndex] === programAddress,
  );

  if (sigilIxs.length === 0) {
    const message =
      "[ShieldedSigner] No Sigil instructions found in transaction";
    if (severity === "hard") {
      throw new ShieldDeniedError([
        {
          rule: "session_binding",
          message,
          suggestion:
            "Compose the transaction with seal()/SigilClient so the validate-and-authorize and finalize-session instructions sandwich the DeFi instruction; do not invoke the program manually.",
        },
      ]);
    }
    console.warn(message);
    return;
  }

  const firstData = sigilIxs[0].data;
  const lastData = sigilIxs[sigilIxs.length - 1].data;

  const hasValidate =
    firstData &&
    firstData.length >= 8 &&
    matchesDiscriminator(firstData, VALIDATE_AND_AUTHORIZE_DISCRIMINATOR);
  const hasFinalize =
    lastData &&
    lastData.length >= 8 &&
    matchesDiscriminator(lastData, FINALIZE_SESSION_DISCRIMINATOR);

  if (!hasValidate || !hasFinalize) {
    const message = `[ShieldedSigner] Session binding incomplete: validate=${!!hasValidate}, finalize=${!!hasFinalize}`;
    if (severity === "hard") {
      throw new ShieldDeniedError([
        {
          rule: "session_binding",
          message,
          suggestion:
            "Compose the transaction with seal()/SigilClient so the validate-and-authorize and finalize-session instructions sandwich the DeFi instruction; do not invoke the program manually.",
        },
      ]);
    }
    console.warn(message);
  }
}

/**
 * S-2: Warn when resolved state is stale (older than threshold).
 */
function _warnIfStale(state: ShieldState, thresholdSec: number): void {
  if (!state.resolvedState) return;
  const age =
    Math.floor(Date.now() / 1000) -
    Number(state.resolvedState.resolvedAtTimestamp);
  if (age > thresholdSec) {
    console.warn(
      `[Shield] Resolved state is ${age}s old (threshold: ${thresholdSec}s) — call sync() for fresh data`,
    );
  }
}

/**
 * Compare first N bytes of data against a discriminator.
 */
function matchesDiscriminator(
  data:
    | Uint8Array
    | { readonly [index: number]: number; readonly length: number },
  disc:
    | Uint8Array
    | { readonly [index: number]: number; readonly length: number },
): boolean {
  if (data.length < disc.length) return false;
  for (let i = 0; i < disc.length; i++) {
    if (data[i] !== disc[i]) return false;
  }
  return true;
}
