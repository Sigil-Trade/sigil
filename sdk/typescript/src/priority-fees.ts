import {
  Connection,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";

// ─── Known Protocol Program IDs ──────────────────────────────────────────────
// Must match integrations/jupiter.ts, flash-trade.ts, drift.ts, kamino.ts
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUPITER_LEND_PROGRAM = "JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu";
const FLASH_TRADE_PROGRAM = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn";
const DRIFT_PROGRAM = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBNtSVAwMHjZi1";
const KAMINO_LEND_PROGRAM = "KLend2g3cP87ber8p1S4JQoTnbs78GDYAHB6h4WjSD9";

// ─── CU Budget Defaults ─────────────────────────────────────────────────────
// Measured via LiteSVM. Phalnx overhead (validate+finalize) is 52–62K CU.
// External DeFi instruction CU varies by protocol; we add generous headroom.

/** Phalnx overhead only (no external DeFi): ~55K measured + 45K buffer */
export const CU_AGENT_TRANSFER = 200_000;

/** Phalnx + Jupiter single-hop swap: ~56K validate + ~250K swap + buffer */
export const CU_JUPITER_SWAP = 600_000;

/** Phalnx + Jupiter multi-hop swap: ~62K validate + ~500K swap + buffer */
export const CU_JUPITER_MULTI_HOP = 900_000;

/** Phalnx + Flash Trade position action: ~48K validate + ~400K flash + buffer */
export const CU_FLASH_TRADE = 800_000;

/** Phalnx + Jupiter Lend deposit/withdraw: ~55K validate + ~200K lend + buffer */
export const CU_JUPITER_LEND = 400_000;

/** Phalnx + Drift Protocol action: ~55K validate + ~500K drift + buffer */
export const CU_DRIFT = 800_000;

/** Phalnx + Kamino Lend deposit/borrow/withdraw: ~55K validate + ~200K lend + buffer */
export const CU_KAMINO_LEND = 400_000;

/** Fallback for unknown DeFi protocols */
export const CU_DEFAULT_COMPOSED = 800_000;

/** Vault creation (initialize + register agent) */
export const CU_VAULT_CREATION = 400_000;

/** Single owner instruction (sync positions, revoke agent, etc.) */
export const CU_OWNER_ACTION = 200_000;

/**
 * Detect CU budget based on the DeFi instructions in a composed transaction.
 * Returns a right-sized CU limit with headroom.
 */
export function estimateComposedCU(
  defiInstructions: TransactionInstruction[],
): number {
  if (defiInstructions.length === 0) return CU_AGENT_TRANSFER;

  const programIds = defiInstructions.map((ix) => ix.programId.toBase58());

  const hasJupiter = programIds.some((id) => id === JUPITER_PROGRAM);
  const hasJupiterLend = programIds.some((id) => id === JUPITER_LEND_PROGRAM);
  const hasFlashTrade = programIds.some((id) => id === FLASH_TRADE_PROGRAM);
  const hasDrift = programIds.some((id) => id === DRIFT_PROGRAM);
  const hasKaminoLend = programIds.some((id) => id === KAMINO_LEND_PROGRAM);

  if (hasJupiter && defiInstructions.length > 2) return CU_JUPITER_MULTI_HOP;
  if (hasJupiter) return CU_JUPITER_SWAP;
  if (hasJupiterLend) return CU_JUPITER_LEND;
  if (hasFlashTrade) return CU_FLASH_TRADE;
  if (hasDrift) return CU_DRIFT;
  if (hasKaminoLend) return CU_KAMINO_LEND;

  return CU_DEFAULT_COMPOSED;
}

// ─── Priority Fee Strategy ──────────────────────────────────────────────────

export type PriorityLevel = "low" | "medium" | "high" | "very_high";

export interface PriorityFeeConfig {
  /** Fee estimation strategy. "auto" detects Helius from connection URL. Default: "auto" */
  strategy?: "auto" | "helius" | "rpc" | "static";
  /** Cache TTL in milliseconds. Default: 10_000 (10 seconds) */
  cacheTtlMs?: number;
  /** Static fallback fee in microLamports per CU. Default: 10_000 */
  fallbackMicroLamports?: number;
  /** Priority level for fee estimation. Default: "high" */
  defaultLevel?: PriorityLevel;
  /** Maximum fee cap in microLamports per CU to prevent overspend. Default: 1_000_000 */
  maxMicroLamports?: number;
}

const LEVEL_PERCENTILES: Record<PriorityLevel, number> = {
  low: 25,
  medium: 50,
  high: 75,
  very_high: 95,
};

const HELIUS_LEVELS: Record<PriorityLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  very_high: "VeryHigh",
};

interface CacheEntry {
  microLamports: number;
  expiresAt: number;
}

/**
 * Priority fee estimator with 3-layer fallback and caching.
 *
 * Layer 1: Helius getPriorityFeeEstimate (auto-detected from URL)
 * Layer 2: Standard RPC getRecentPrioritizationFees + percentile
 * Layer 3: Static fallback
 *
 * Zero-friction: agents never need to configure or call this directly.
 * The composer/wrap modules use it automatically.
 */
export class PriorityFeeEstimator {
  private readonly config: Required<PriorityFeeConfig>;
  private readonly cache = new Map<PriorityLevel, CacheEntry>();
  private readonly isHelius: boolean;

  constructor(
    private readonly connection: Connection,
    config?: PriorityFeeConfig,
  ) {
    this.config = {
      strategy: config?.strategy ?? "auto",
      cacheTtlMs: config?.cacheTtlMs ?? 10_000,
      fallbackMicroLamports: config?.fallbackMicroLamports ?? 10_000,
      defaultLevel: config?.defaultLevel ?? "high",
      maxMicroLamports: config?.maxMicroLamports ?? 1_000_000,
    };

    // Auto-detect Helius from connection endpoint URL
    if (this.config.strategy === "auto") {
      const endpoint = (connection as any)._rpcEndpoint ?? "";
      this.isHelius = /helius/i.test(endpoint);
    } else {
      this.isHelius = this.config.strategy === "helius";
    }
  }

  /**
   * Get the estimated priority fee in microLamports/CU.
   * Returns a cached value if available and fresh.
   */
  async estimate(level?: PriorityLevel): Promise<number> {
    const targetLevel = level ?? this.config.defaultLevel;

    // Check cache
    const cached = this.cache.get(targetLevel);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.microLamports;
    }

    let fee: number | null = null;

    // Layer 1: Helius enhanced API
    if (this.isHelius) {
      fee = await this.estimateHelius(targetLevel);
    }

    // Layer 2: Standard RPC percentile
    if (fee === null) {
      fee = await this.estimateRpc(targetLevel);
    }

    // Layer 3: Static fallback
    if (fee === null) {
      fee = this.config.fallbackMicroLamports;
    }

    // Cap to prevent runaway fees
    fee = Math.min(fee, this.config.maxMicroLamports);

    // Cache result
    this.cache.set(targetLevel, {
      microLamports: fee,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });

    return fee;
  }

  /**
   * Build a ComputeBudgetProgram.setComputeUnitPrice instruction
   * using the estimated priority fee.
   */
  async buildPriorityFeeIx(
    level?: PriorityLevel,
  ): Promise<TransactionInstruction> {
    const microLamports = await this.estimate(level);
    return ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  }

  private async estimateHelius(level: PriorityLevel): Promise<number | null> {
    try {
      const endpoint = (this.connection as any)._rpcEndpoint;
      if (!endpoint) return null;

      const body = {
        jsonrpc: "2.0",
        id: "phalnx-fee-estimate",
        method: "getPriorityFeeEstimate",
        params: [
          {
            options: {
              recommended: true,
              priorityLevel: HELIUS_LEVELS[level],
            },
          },
        ],
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) return null;

      const json = (await response.json()) as Record<string, any>;
      const estimate = json?.result?.priorityFeeEstimate;
      if (typeof estimate === "number" && estimate >= 0) {
        return Math.ceil(estimate);
      }

      return null;
    } catch {
      return null;
    }
  }

  private async estimateRpc(level: PriorityLevel): Promise<number | null> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) return null;

      const sorted = fees
        .map((f) => f.prioritizationFee)
        .filter((f) => f > 0)
        .sort((a, b) => a - b);

      if (sorted.length === 0) return this.config.fallbackMicroLamports;

      const percentile = LEVEL_PERCENTILES[level];
      const index = Math.min(
        Math.ceil((percentile / 100) * sorted.length) - 1,
        sorted.length - 1,
      );

      return sorted[index];
    } catch {
      return null;
    }
  }
}

/** Singleton-per-connection fee estimator cache */
const estimatorCache = new WeakMap<Connection, PriorityFeeEstimator>();

/**
 * Get or create a PriorityFeeEstimator for a connection.
 * Re-uses the same estimator (and its internal cache) for the same connection.
 */
export function getEstimator(
  connection: Connection,
  config?: PriorityFeeConfig,
): PriorityFeeEstimator {
  let estimator = estimatorCache.get(connection);
  if (!estimator) {
    estimator = new PriorityFeeEstimator(connection, config);
    estimatorCache.set(connection, estimator);
  }
  return estimator;
}
