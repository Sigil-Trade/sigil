/**
 * Kit-native policy engine for Phalnx.
 */

import type { Address } from "@solana/kit";
import * as Core from "@phalnx/core";
import { isStablecoinMint, type Network } from "./types.js";

// Re-export core types that don't need Solana adaptation
export type { RateLimitConfig, PolicyCheckResult } from "@phalnx/core";
export { DEFAULT_POLICIES, parseSpendLimit } from "@phalnx/core";

/** Policy configuration for the Phalnx wrapper (accepts Address or string) */
export interface ShieldPolicies {
  /** Maximum spend per rolling 24h window, per token. e.g. "500 USDC/day" or { mint, amount } */
  maxSpend?: SpendLimit | SpendLimit[] | string | string[];
  /** Maximum single transaction size in lamports-equivalent value */
  maxTransactionSize?: bigint | string;
  /** Allowed protocol program IDs. If set, only these + system programs are allowed. */
  allowedProtocols?: (Address | string)[];
  /** Allowed token mints for transfers. If set, only these tokens can be sent. */
  allowedTokens?: (Address | string)[];
  /** Block unknown (unregistered) program IDs. Default: true */
  blockUnknownPrograms?: boolean;
  /** Maximum transactions per time window */
  rateLimit?: Core.RateLimitConfig;
  /** Custom policy evaluation hook — runs AFTER built-in checks */
  customCheck?: (analysis: TransactionAnalysis) => Core.PolicyCheckResult;
}

export interface SpendLimit {
  /** SPL token mint address */
  mint: Address | string;
  /** Maximum amount in token's native decimals (e.g. 500_000_000 for 500 USDC) */
  amount: bigint;
  /** Window duration in milliseconds. Default: 86_400_000 (24h) */
  windowMs?: number;
}

/** Analysis of a transaction's contents, passed to policy engine and custom checks */
export interface TransactionAnalysis {
  /** Program IDs invoked by the transaction */
  programIds: Address[];
  /** Token transfers detected in the transaction */
  transfers: TokenTransfer[];
  /** Total estimated value of outgoing transfers, in lamports-equivalent */
  estimatedValueLamports: bigint;
}

export interface TokenTransfer {
  mint: Address;
  amount: bigint;
  /** "outgoing" = tokens leaving the wallet, "incoming" = tokens arriving */
  direction: "outgoing" | "incoming" | "unknown";
  /** Destination account */
  destination?: Address;
}

/** Internal resolved policy representation (extends core with customCheck) */
export interface ResolvedPolicies extends Core.ResolvedPolicies {
  customCheck:
    | ((analysis: TransactionAnalysis) => Core.PolicyCheckResult)
    | undefined;
}

/**
 * Normalize user-provided policies into a resolved internal format.
 * Kit Address is already a string, so conversion is trivial.
 */
export function resolvePolicies(input?: ShieldPolicies): ResolvedPolicies {
  const coreInput: Core.ShieldPolicies | undefined = input
    ? {
        maxSpend:
          input.maxSpend !== undefined
            ? convertSpendLimits(input.maxSpend)
            : undefined,
        maxTransactionSize: input.maxTransactionSize,
        // Address is already a string — direct pass-through
        allowedProtocols: input.allowedProtocols?.map((p) => p as string),
        allowedTokens: input.allowedTokens?.map((t) => t as string),
        blockUnknownPrograms: input.blockUnknownPrograms,
        rateLimit: input.rateLimit,
      }
    : undefined;

  const coreResolved = Core.resolvePolicies(coreInput);

  return {
    ...coreResolved,
    customCheck: input?.customCheck ?? undefined,
  };
}

/** Convert SpendLimit (Address | string mint) to core SpendLimit (string mint) */
function convertSpendLimits(
  input: SpendLimit | SpendLimit[] | string | string[],
): Core.SpendLimit | Core.SpendLimit[] | string | string[] {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    if (input.every((l): l is string => typeof l === "string")) {
      return input;
    }
    return (input as (SpendLimit | string)[]).map((l): Core.SpendLimit => {
      if (typeof l === "string") return Core.parseSpendLimit(l);
      return {
        mint: l.mint as string,
        amount: l.amount,
        windowMs: l.windowMs,
      };
    });
  }
  return {
    mint: input.mint as string,
    amount: input.amount,
    windowMs: input.windowMs,
  };
}

/**
 * Convert wrapper TransactionAnalysis (Address-based) to core format (string-based).
 * Trivial since Kit Address IS a string.
 */
export function toCoreAnalysis(
  analysis: TransactionAnalysis,
): Core.TransactionAnalysis {
  return {
    programIds: analysis.programIds.map((p) => p as string),
    transfers: analysis.transfers.map((t) => ({
      mint: t.mint as string,
      amount: t.amount,
      direction: t.direction,
      destination: t.destination as string | undefined,
    })),
    estimatedValueLamports: analysis.estimatedValueLamports,
  };
}

/**
 * Validate that spend limit mints are recognized stablecoins.
 * Returns warnings for unrecognized mints (does not throw).
 */
export function validateSpendLimitMints(
  resolved: ResolvedPolicies,
  network: Network,
): string[] {
  const warnings: string[] = [];
  if (!resolved.spendLimits) return warnings;
  for (const limit of resolved.spendLimits) {
    if (!isStablecoinMint(limit.mint as Address, network)) {
      warnings.push(
        `Spend limit mint ${limit.mint} is not a recognized stablecoin on ${network}. ` +
          `On-chain enforcement uses stablecoin-only USD tracking.`,
      );
    }
  }
  return warnings;
}
