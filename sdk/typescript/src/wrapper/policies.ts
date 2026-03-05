import { PublicKey } from "@solana/web3.js";
import * as Core from "@phalnx/core";

// Re-export core types that don't need Solana adaptation
export type { RateLimitConfig, PolicyCheckResult } from "@phalnx/core";
export { DEFAULT_POLICIES, parseSpendLimit } from "@phalnx/core";

/** Policy configuration for the Phalnx wrapper (accepts PublicKey or string) */
export interface ShieldPolicies {
  /** Maximum spend per rolling 24h window, per token. e.g. "500 USDC/day" or { mint, amount } */
  maxSpend?: SpendLimit | SpendLimit[] | string | string[];
  /** Maximum single transaction size in lamports-equivalent value */
  maxTransactionSize?: bigint | string;
  /** Allowed protocol program IDs. If set, only these + system programs are allowed. */
  allowedProtocols?: (PublicKey | string)[];
  /** Allowed token mints for transfers. If set, only these tokens can be sent. */
  allowedTokens?: (PublicKey | string)[];
  /** Block unknown (unregistered) program IDs. Default: true */
  blockUnknownPrograms?: boolean;
  /** Maximum transactions per time window */
  rateLimit?: Core.RateLimitConfig;
  /** Custom policy evaluation hook — runs AFTER built-in checks */
  customCheck?: (analysis: TransactionAnalysis) => Core.PolicyCheckResult;
}

export interface SpendLimit {
  /** SPL token mint address */
  mint: PublicKey | string;
  /** Maximum amount in token's native decimals (e.g. 500_000_000 for 500 USDC) */
  amount: bigint;
  /** Window duration in milliseconds. Default: 86_400_000 (24h) */
  windowMs?: number;
}

/** Analysis of a transaction's contents, passed to policy engine and custom checks */
export interface TransactionAnalysis {
  /** Program IDs invoked by the transaction */
  programIds: PublicKey[];
  /** Token transfers detected in the transaction */
  transfers: TokenTransfer[];
  /** Total estimated value of outgoing transfers, in lamports-equivalent */
  estimatedValueLamports: bigint;
}

export interface TokenTransfer {
  mint: PublicKey;
  amount: bigint;
  /** "outgoing" = tokens leaving the wallet, "incoming" = tokens arriving */
  direction: "outgoing" | "incoming" | "unknown";
  /** Destination account */
  destination?: PublicKey;
}

/** Summary of current spending state relative to policy limits */
export interface SpendingSummary {
  tokens: Array<{
    mint: string;
    symbol: string | undefined;
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
}

/** Internal resolved policy representation (extends core with customCheck) */
export interface ResolvedPolicies extends Core.ResolvedPolicies {
  customCheck:
    | ((analysis: TransactionAnalysis) => Core.PolicyCheckResult)
    | undefined;
}

/**
 * Normalize user-provided policies into a resolved internal format.
 * Handles PublicKey → string conversion, string parsing, defaults, and validation.
 */
export function resolvePolicies(input?: ShieldPolicies): ResolvedPolicies {
  // Convert Solana-aware input to core format
  const coreInput: Core.ShieldPolicies | undefined = input
    ? {
        maxSpend:
          input.maxSpend !== undefined
            ? convertSpendLimits(input.maxSpend)
            : undefined,
        maxTransactionSize: input.maxTransactionSize,
        allowedProtocols: input.allowedProtocols?.map((p) =>
          typeof p === "string" ? p : p.toBase58(),
        ),
        allowedTokens: input.allowedTokens?.map((t) =>
          typeof t === "string" ? t : t.toBase58(),
        ),
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

/** Convert wrapper SpendLimit (PublicKey | string mint) to core SpendLimit (string mint) */
function convertSpendLimits(
  input: SpendLimit | SpendLimit[] | string | string[],
): Core.SpendLimit | Core.SpendLimit[] | string | string[] {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    // Check if all elements are strings
    if (input.every((l): l is string => typeof l === "string")) {
      return input;
    }
    // Otherwise convert each element to Core.SpendLimit
    return (input as (SpendLimit | string)[]).map((l): Core.SpendLimit => {
      if (typeof l === "string") return Core.parseSpendLimit(l);
      return {
        mint: typeof l.mint === "string" ? l.mint : l.mint.toBase58(),
        amount: l.amount,
        windowMs: l.windowMs,
      };
    });
  }
  return {
    mint: typeof input.mint === "string" ? input.mint : input.mint.toBase58(),
    amount: input.amount,
    windowMs: input.windowMs,
  };
}

/**
 * Convert wrapper TransactionAnalysis (PublicKey-based) to core format (string-based).
 */
export function toCoreAnalysis(
  analysis: TransactionAnalysis,
): Core.TransactionAnalysis {
  return {
    programIds: analysis.programIds.map((p) => p.toBase58()),
    transfers: analysis.transfers.map((t) => ({
      mint: t.mint.toBase58(),
      amount: t.amount,
      direction: t.direction,
      destination: t.destination?.toBase58(),
    })),
    estimatedValueLamports: analysis.estimatedValueLamports,
  };
}
