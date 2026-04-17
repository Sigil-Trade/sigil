/**
 * TransactionExecutor — Kit-native transaction pipeline.
 *
 * Steps:
 *   9. Compose versioned transaction (blockhash + compile)
 *  10. Simulate (fail-closed)
 *  11. Sign
 *  12. Send + confirm, parse events
 */

import type {
  Address,
  Instruction,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
  AddressesByLookupTableAddress,
} from "./kit-adapter.js";
import { getBase64EncodedWireTransaction } from "./kit-adapter.js";

import {
  composeSigilTransaction,
  measureTransactionSize,
  MAX_TX_SIZE,
} from "./composer.js";
import { AltCache } from "./alt-loader.js";
import { getSigilModuleLogger } from "./logger.js";
import {
  simulateBeforeSend,
  adjustCU,
  RISK_FLAG_FULL_DRAIN,
  type SimulationResult,
  type SimulationOptions,
  type RiskFlag,
  type DrainThresholds,
} from "./simulation.js";
import { parseSigilEvents, type SigilEvent } from "./events.js";
import {
  BlockhashCache,
  signAndEncode,
  sendAndConfirmTransaction,
  type SendAndConfirmOptions,
} from "./rpc-helpers.js";
import { estimateComposedCU } from "./priority-fees.js";
import { SigilRpcError } from "./errors/rpc.js";
import {
  SIGIL_ERROR__RPC__SIMULATION_FAILED,
  SIGIL_ERROR__RPC__DRAIN_DETECTED,
} from "./errors/codes.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecuteTransactionParams {
  /** Fee payer address (typically the agent) */
  feePayer: Address;
  /** The validate_and_authorize instruction */
  validateIx: Instruction;
  /** DeFi protocol instruction(s) to sandwich */
  defiInstructions: Instruction[];
  /** The finalize_session instruction */
  finalizeIx: Instruction;
  /** Optional: override CU limit */
  computeUnits?: number;
  /** Optional: priority fee in microLamports per CU */
  priorityFeeMicroLamports?: number;
  /** Resolved address lookup tables for transaction compression */
  addressLookupTables?: AddressesByLookupTableAddress;
  /** Vault monitoring context for drain detection during simulation.
   *  Populated from SealResult.vaultContext by the caller. */
  vaultMonitoring?: {
    vaultAddress: string;
    monitorAccounts: string[];
    preBalances: Map<string, bigint>;
    totalVaultBalance: bigint;
    knownRecipients?: Set<string>;
  };
}

export interface ExecuteTransactionResult {
  /** Transaction signature (base58) */
  signature: string;
  /** Compute units consumed (from simulation) */
  unitsConsumed?: number;
  /** Transaction logs */
  logs?: string[];
  /** Parsed Sigil events */
  events: SigilEvent[];
  /** Risk flag warnings (LARGE_OUTFLOW, UNKNOWN_RECIPIENT) — non-blocking */
  warnings?: RiskFlag[];
}

export interface TransactionExecutorOptions {
  /** Blockhash cache TTL in milliseconds */
  blockhashCacheTtlMs?: number;
  /** Send+confirm options */
  confirmOptions?: SendAndConfirmOptions;
  /**
   * Dangerously skip simulation and drain detection (default: false).
   * Council mandate (4-0 verdict, Decision 6): requires string literal confirmation
   * to prevent accidental production bypass. Only use in test environments.
   *
   * @example
   * // Correct: explicit acknowledgment
   * { dangerouslySkipSimulation: "I_UNDERSTAND_DRAIN_DETECTION_IS_DISABLED" }
   * // Wrong: boolean (type error)
   * { dangerouslySkipSimulation: true }
   */
  dangerouslySkipSimulation?: "I_UNDERSTAND_DRAIN_DETECTION_IS_DISABLED";
  /** @deprecated Use dangerouslySkipSimulation instead. Will be removed in next major. */
  skipSimulation?: boolean;
  /** Configurable drain detection thresholds (defaults: 50% warning, 95% block) */
  drainThresholds?: DrainThresholds;
}

// ─── TransactionExecutor ────────────────────────────────────────────────────

export class TransactionExecutor {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly agent: TransactionSigner;
  private readonly blockhashCache: BlockhashCache;
  private readonly confirmOptions: SendAndConfirmOptions;
  private readonly _skipSimulation: boolean;
  private readonly _drainThresholds?: DrainThresholds;
  private altCache?: AltCache;

  constructor(
    rpc: Rpc<SolanaRpcApi>,
    agent: TransactionSigner,
    options?: TransactionExecutorOptions,
  ) {
    this.rpc = rpc;
    this.agent = agent;
    this.blockhashCache = new BlockhashCache(options?.blockhashCacheTtlMs);
    this.confirmOptions = options?.confirmOptions ?? {};
    this._skipSimulation =
      options?.dangerouslySkipSimulation ===
        "I_UNDERSTAND_DRAIN_DETECTION_IS_DISABLED" ||
      options?.skipSimulation === true;
    if (this._skipSimulation) {
      if (
        options?.skipSimulation === true &&
        !options?.dangerouslySkipSimulation
      ) {
        getSigilModuleLogger().warn(
          "[Sigil] DEPRECATION: skipSimulation is deprecated. " +
            'Use dangerouslySkipSimulation: "I_UNDERSTAND_DRAIN_DETECTION_IS_DISABLED" instead.',
        );
      }
      getSigilModuleLogger().warn(
        "[Sigil] WARNING: Simulation and drain detection are DISABLED. " +
          "This should only be used in testing environments, never in production.",
      );
    }
    this._drainThresholds = options?.drainThresholds;
  }

  /**
   * Resolve ALT addresses via cached RPC fetch.
   * Returns a map of ALT address → resolved addresses.
   */
  async resolveAlts(
    rpc: Rpc<SolanaRpcApi>,
    altAddresses: Address[],
  ): Promise<AddressesByLookupTableAddress> {
    if (!this.altCache) this.altCache = new AltCache();
    return this.altCache.resolve(rpc, altAddresses);
  }

  /**
   * Step 9: Compose a versioned transaction from instructions + cached blockhash.
   */
  async composeTransaction(params: ExecuteTransactionParams) {
    const blockhash = await this.blockhashCache.get(this.rpc);

    const computeUnits =
      params.computeUnits ?? estimateComposedCU(params.defiInstructions);

    const compiledTx = composeSigilTransaction({
      feePayer: params.feePayer,
      validateIx: params.validateIx,
      defiInstructions: params.defiInstructions,
      finalizeIx: params.finalizeIx,
      blockhash,
      computeUnits,
      priorityFeeMicroLamports: params.priorityFeeMicroLamports,
      addressLookupTables: params.addressLookupTables,
    });

    // Check wire size after compose (with or without ALTs)
    const { byteLength, withinLimit } = measureTransactionSize(compiledTx);
    if (!withinLimit) {
      const altsApplied =
        params.addressLookupTables != null &&
        Object.keys(params.addressLookupTables).length > 0;

      const err = Object.assign(
        new Error(
          altsApplied
            ? `Transaction ${byteLength}B exceeds ${MAX_TX_SIZE}B limit even with ALTs applied. Simplify the DeFi route.`
            : `Transaction ${byteLength}B exceeds ${MAX_TX_SIZE}B limit. ALT fetch may have failed — retry, or simplify the route.`,
        ),
        {
          code: 7033,
          context: { byteLength, limit: MAX_TX_SIZE, altsApplied },
        },
      );
      throw err;
    }

    return { compiledTx, computeUnits, blockhash };
  }

  /**
   * Step 10: Simulate the transaction. Fail-closed — failure blocks sending.
   * If CU consumed differs >20% from estimate, re-composes.
   */
  async simulate(
    params: ExecuteTransactionParams,
    compiledTx: ReturnType<typeof composeSigilTransaction>,
    estimatedCU: number,
    blockhash: { blockhash: string; lastValidBlockHeight: bigint },
  ): Promise<{
    simulation: SimulationResult;
    recomposedTx?: ReturnType<typeof composeSigilTransaction>;
    finalCU: number;
  }> {
    const wireBase64 = getBase64EncodedWireTransaction(compiledTx);

    // Build simulation options from vault monitoring context + drain thresholds
    const simOptions: SimulationOptions | undefined = params.vaultMonitoring
      ? {
          monitorAccounts: params.vaultMonitoring.monitorAccounts,
          preBalances: params.vaultMonitoring.preBalances,
          vaultAddress: params.vaultMonitoring.vaultAddress,
          totalVaultBalance: params.vaultMonitoring.totalVaultBalance,
          knownRecipients: params.vaultMonitoring.knownRecipients,
          drainThresholds: this._drainThresholds,
        }
      : undefined;

    const simulation = await simulateBeforeSend(
      this.rpc,
      wireBase64,
      simOptions,
    );

    if (!simulation.success) {
      return { simulation, finalCU: estimatedCU };
    }

    // Check if CU adjustment is needed
    const adjustedCU = adjustCU(estimatedCU, simulation.unitsConsumed);
    if (adjustedCU !== estimatedCU) {
      // Re-compose with adjusted CU — reuse blockhash from initial compose
      const recomposedTx = composeSigilTransaction({
        feePayer: params.feePayer,
        validateIx: params.validateIx,
        defiInstructions: params.defiInstructions,
        finalizeIx: params.finalizeIx,
        blockhash,
        computeUnits: adjustedCU,
        priorityFeeMicroLamports: params.priorityFeeMicroLamports,
        addressLookupTables: params.addressLookupTables,
      });
      return { simulation, recomposedTx, finalCU: adjustedCU };
    }

    return { simulation, finalCU: estimatedCU };
  }

  /**
   * Steps 11+12: Sign, send, and confirm the transaction.
   */
  async signSendConfirm(
    compiledTx: ReturnType<typeof composeSigilTransaction>,
  ): Promise<{ signature: string; logs?: string[] }> {
    const wireBase64 = await signAndEncode(this.agent, compiledTx);
    const signature = await sendAndConfirmTransaction(
      this.rpc,
      wireBase64,
      this.confirmOptions,
    );
    return { signature };
  }

  /**
   * Full pipeline: compose → simulate → sign → send → parse events.
   * Steps 9-12 in one call.
   */
  async executeTransaction(
    params: ExecuteTransactionParams,
  ): Promise<ExecuteTransactionResult> {
    // Step 9: Compose
    const { compiledTx, computeUnits, blockhash } =
      await this.composeTransaction(params);

    // Step 10: Simulate (unless skipped)
    let txToSign = compiledTx;
    let simLogs: string[] | undefined;
    let unitsConsumed: number | undefined;
    const riskWarnings: RiskFlag[] = [];

    if (!this._skipSimulation) {
      const { simulation, recomposedTx } = await this.simulate(
        params,
        compiledTx,
        computeUnits,
        blockhash,
      );

      if (!simulation.success) {
        const errMsg =
          simulation.error?.suggestion ??
          simulation.error?.message ??
          "Simulation failed";
        throw new SigilRpcError(
          SIGIL_ERROR__RPC__SIMULATION_FAILED,
          `Simulation failed: ${errMsg}`,
        );
      }

      // Drain detection: FULL_DRAIN blocks TX, others are warnings
      if (simulation.riskFlags.length > 0) {
        if (simulation.riskFlags.includes(RISK_FLAG_FULL_DRAIN)) {
          throw new SigilRpcError(
            SIGIL_ERROR__RPC__DRAIN_DETECTED,
            `Transaction blocked: drain detection triggered (${simulation.riskFlags.join(", ")})`,
            { context: { reason: simulation.riskFlags.join(",") } },
          );
        }
        riskWarnings.push(...simulation.riskFlags);
      }

      simLogs = simulation.logs;
      unitsConsumed = simulation.unitsConsumed;
      if (recomposedTx) {
        txToSign = recomposedTx;
      }
    }

    // Steps 11+12: Sign, send, confirm
    const { signature } = await this.signSendConfirm(txToSign);

    // Parse events from simulation logs (best-effort)
    const events = simLogs ? parseSigilEvents(simLogs) : [];

    return {
      signature,
      unitsConsumed,
      logs: simLogs,
      events,
      warnings: riskWarnings.length > 0 ? riskWarnings : undefined,
    };
  }
}
