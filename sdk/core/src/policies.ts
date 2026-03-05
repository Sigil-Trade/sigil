import { KNOWN_TOKENS } from "./registry";
import { ShieldConfigError } from "./errors";

/** Policy configuration for the Phalnx wrapper (pure string addresses) */
export interface ShieldPolicies {
  /** Maximum spend per rolling window, per token. e.g. "500 USDC/day" or { mint, amount } */
  maxSpend?: SpendLimit | SpendLimit[] | string | string[];
  /** Maximum single transaction size in lamports-equivalent value */
  maxTransactionSize?: bigint | string;
  /** Allowed protocol program IDs (base58 strings) */
  allowedProtocols?: string[];
  /** Allowed token mints (base58 strings) */
  allowedTokens?: string[];
  /** Block unknown (unregistered) program IDs. Default: true */
  blockUnknownPrograms?: boolean;
  /** Maximum transactions per time window */
  rateLimit?: RateLimitConfig;
}

export interface SpendLimit {
  /** SPL token mint address (base58 string) */
  mint: string;
  /** Maximum amount in token's native decimals (e.g. 500_000_000 for 500 USDC) */
  amount: bigint;
  /** Window duration in milliseconds. Default: 86_400_000 (24h) */
  windowMs?: number;
}

export interface RateLimitConfig {
  /** Max number of transactions in the window */
  maxTransactions: number;
  /** Window duration in milliseconds. Default: 3_600_000 (1 hour) */
  windowMs?: number;
}

/** Result from a custom policy check */
export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Analysis of a transaction's contents (pure string addresses) */
export interface TransactionAnalysis {
  /** Program IDs invoked by the transaction (base58 strings) */
  programIds: string[];
  /** Token transfers detected in the transaction */
  transfers: TokenTransfer[];
  /** Total estimated value of outgoing transfers, in lamports-equivalent */
  estimatedValueLamports: bigint;
}

export interface TokenTransfer {
  /** Token mint address (base58 string) */
  mint: string;
  /** Amount in native token decimals */
  amount: bigint;
  /** "outgoing" = tokens leaving the wallet, "incoming" = tokens arriving */
  direction: "outgoing" | "incoming" | "unknown";
  /** Destination account (base58 string) */
  destination?: string;
}

/** Default secure policies — applied when shield() is called with no config */
export const DEFAULT_POLICIES: Required<
  Pick<ShieldPolicies, "blockUnknownPrograms" | "rateLimit">
> & { maxSpend: SpendLimit[] } = {
  maxSpend: [
    {
      // 1000 USDC/day default cap
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: BigInt(1_000_000_000), // 1000 * 10^6
      windowMs: 86_400_000,
    },
    {
      // 1000 USDT/day default cap
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      amount: BigInt(1_000_000_000),
      windowMs: 86_400_000,
    },
    {
      // 10 SOL/day default cap
      mint: "So11111111111111111111111111111111111111112",
      amount: BigInt(10_000_000_000), // 10 * 10^9
      windowMs: 86_400_000,
    },
  ],
  blockUnknownPrograms: true,
  rateLimit: {
    maxTransactions: 60,
    windowMs: 3_600_000, // 1 hour
  },
};

const WINDOW_ALIASES: Record<string, number> = {
  "/day": 86_400_000,
  "/hour": 3_600_000,
  "/hr": 3_600_000,
  "/min": 60_000,
  "/minute": 60_000,
};

/**
 * Parse a human-readable spend limit string like "500 USDC/day" into a SpendLimit.
 */
export function parseSpendLimit(input: string): SpendLimit {
  const trimmed = input.trim();

  // Match pattern: "<amount> <symbol>/<window>"
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s+(\w+)(\/\w+)?$/);
  if (!match) {
    throw new ShieldConfigError(
      `Invalid spend limit format: "${input}". Expected format: "500 USDC/day"`,
    );
  }

  const [, amountStr, symbol, windowStr] = match;
  const windowMs = windowStr ? WINDOW_ALIASES[windowStr] : 86_400_000;
  if (windowStr && !windowMs) {
    throw new ShieldConfigError(
      `Unknown time window: "${windowStr}". Supported: /day, /hour, /hr, /min, /minute`,
    );
  }

  // Find token by symbol
  let foundMint: string | undefined;
  let foundDecimals: number | undefined;
  for (const [mint, info] of KNOWN_TOKENS) {
    if (info.symbol.toUpperCase() === symbol.toUpperCase()) {
      foundMint = mint;
      foundDecimals = info.decimals;
      break;
    }
  }

  if (!foundMint || foundDecimals === undefined) {
    throw new ShieldConfigError(
      `Unknown token symbol: "${symbol}". Use a known token (USDC, USDT, SOL, wBTC, wETH, mSOL, jitoSOL, bSOL) or pass a SpendLimit object with the mint address.`,
    );
  }

  const amountFloat = parseFloat(amountStr);
  const amountNative = BigInt(Math.round(amountFloat * 10 ** foundDecimals));

  return {
    mint: foundMint,
    amount: amountNative,
    windowMs,
  };
}

/** Internal resolved policy representation */
export interface ResolvedPolicies {
  spendLimits: SpendLimit[];
  maxTransactionSize: bigint | undefined;
  allowedProtocols: Set<string> | undefined;
  allowedTokens: Set<string> | undefined;
  blockUnknownPrograms: boolean;
  rateLimit: Required<RateLimitConfig>;
}

/**
 * Normalize user-provided policies into a resolved internal format.
 */
export function resolvePolicies(input?: ShieldPolicies): ResolvedPolicies {
  const resolved: ResolvedPolicies = {
    spendLimits: [...DEFAULT_POLICIES.maxSpend],
    maxTransactionSize: undefined,
    allowedProtocols: undefined,
    allowedTokens: undefined,
    blockUnknownPrograms: DEFAULT_POLICIES.blockUnknownPrograms,
    rateLimit: {
      maxTransactions: DEFAULT_POLICIES.rateLimit.maxTransactions,
      windowMs: DEFAULT_POLICIES.rateLimit.windowMs ?? 3_600_000,
    },
  };

  if (!input) return resolved;

  // Parse spend limits
  if (input.maxSpend !== undefined) {
    const limits = Array.isArray(input.maxSpend)
      ? input.maxSpend
      : [input.maxSpend];
    resolved.spendLimits = limits.map((l) =>
      typeof l === "string" ? parseSpendLimit(l) : l,
    );
  }

  // Max transaction size
  if (input.maxTransactionSize !== undefined) {
    resolved.maxTransactionSize =
      typeof input.maxTransactionSize === "string"
        ? parseSpendLimit(input.maxTransactionSize).amount
        : input.maxTransactionSize;
  }

  // Allowed protocols
  if (input.allowedProtocols !== undefined) {
    resolved.allowedProtocols = new Set(input.allowedProtocols);
  }

  // Allowed tokens
  if (input.allowedTokens !== undefined) {
    resolved.allowedTokens = new Set(input.allowedTokens);
  }

  // Block unknown programs
  if (input.blockUnknownPrograms !== undefined) {
    resolved.blockUnknownPrograms = input.blockUnknownPrograms;
  }

  // Rate limit
  if (input.rateLimit !== undefined) {
    resolved.rateLimit = {
      maxTransactions: input.rateLimit.maxTransactions,
      windowMs: input.rateLimit.windowMs ?? 3_600_000,
    };
  }

  return resolved;
}
