/**
 * Kit-native CU estimation + priority fee estimation.
 *
 * CU constants match the existing SDK values (measured via LiteSVM).
 * 3-layer fallback: Helius → Kit RPC → static.
 */

import type { Instruction, Rpc, SolanaRpcApi } from "@solana/kit";

// ─── Known Protocol Program Addresses ────────────────────────────────────────

const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUPITER_LEND_PROGRAM = "JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu";
const FLASH_TRADE_PROGRAM = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn";
const DRIFT_PROGRAM = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBNtSVAwMHjZi1";
const KAMINO_LEND_PROGRAM = "KLend2g3cP87ber8p1S4JQoTnbs78GDYAHB6h4WjSD9";

// ─── CU Budget Defaults ─────────────────────────────────────────────────────

export const CU_AGENT_TRANSFER = 200_000;
export const CU_JUPITER_SWAP = 600_000;
export const CU_JUPITER_MULTI_HOP = 900_000;
export const CU_FLASH_TRADE = 800_000;
export const CU_JUPITER_LEND = 400_000;
export const CU_DRIFT = 800_000;
export const CU_KAMINO_LEND = 400_000;
export const CU_DEFAULT_COMPOSED = 800_000;
export const CU_VAULT_CREATION = 400_000;
export const CU_OWNER_ACTION = 200_000;

/**
 * Detect CU budget based on the DeFi instructions in a composed transaction.
 * Uses `programAddress` (Kit convention, not `programId`).
 */
export function estimateComposedCU(defiInstructions: Instruction[]): number {
  if (defiInstructions.length === 0) return CU_AGENT_TRANSFER;

  const programAddresses = defiInstructions.map(
    (ix) => ix.programAddress as string,
  );

  const hasJupiter = programAddresses.some((id) => id === JUPITER_PROGRAM);
  const hasJupiterLend = programAddresses.some(
    (id) => id === JUPITER_LEND_PROGRAM,
  );
  const hasFlashTrade = programAddresses.some(
    (id) => id === FLASH_TRADE_PROGRAM,
  );
  const hasDrift = programAddresses.some((id) => id === DRIFT_PROGRAM);
  const hasKaminoLend = programAddresses.some(
    (id) => id === KAMINO_LEND_PROGRAM,
  );

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
  strategy?: "auto" | "helius" | "rpc" | "static";
  cacheTtlMs?: number;
  fallbackMicroLamports?: number;
  defaultLevel?: PriorityLevel;
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
 * Layer 2: Kit RPC getRecentPrioritizationFees + percentile
 * Layer 3: Static fallback
 */
export class PriorityFeeEstimator {
  private readonly config: Required<PriorityFeeConfig>;
  private readonly cache = new Map<PriorityLevel, CacheEntry>();
  private readonly isHelius: boolean;

  constructor(
    private readonly rpcEndpoint: string,
    private readonly rpc: Rpc<SolanaRpcApi> | null,
    config?: PriorityFeeConfig,
  ) {
    this.config = {
      strategy: config?.strategy ?? "auto",
      cacheTtlMs: config?.cacheTtlMs ?? 10_000,
      fallbackMicroLamports: config?.fallbackMicroLamports ?? 10_000,
      defaultLevel: config?.defaultLevel ?? "high",
      maxMicroLamports: config?.maxMicroLamports ?? 1_000_000,
    };

    if (this.config.strategy === "auto") {
      this.isHelius = /helius/i.test(this.rpcEndpoint);
    } else {
      this.isHelius = this.config.strategy === "helius";
    }
  }

  async estimate(level?: PriorityLevel): Promise<number> {
    const targetLevel = level ?? this.config.defaultLevel;

    const cached = this.cache.get(targetLevel);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.microLamports;
    }

    let fee: number | null = null;

    // Layer 1: Helius
    if (this.isHelius) {
      fee = await this.estimateHelius(targetLevel);
    }

    // Layer 2: Standard RPC
    if (fee === null && this.rpc) {
      fee = await this.estimateRpc(targetLevel);
    }

    // Layer 3: Static
    if (fee === null) {
      fee = this.config.fallbackMicroLamports;
    }

    fee = Math.min(fee, this.config.maxMicroLamports);

    this.cache.set(targetLevel, {
      microLamports: fee,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });

    return fee;
  }

  private async estimateHelius(level: PriorityLevel): Promise<number | null> {
    try {
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

      const response = await fetch(this.rpcEndpoint, {
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
      if (!this.rpc) return null;

      const fees = await this.rpc.getRecentPrioritizationFees().send();
      if (!fees || fees.length === 0) return null;

      const sorted = fees
        .map((f) => Number(f.prioritizationFee))
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
