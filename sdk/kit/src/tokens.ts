/**
 * Kit-native token resolution + amount helpers.
 *
 * 5-layer resolution: hardcoded stablecoins → well-known registry →
 * base58 parse → (caller can add Jupiter API) → error.
 */

import type { Address } from "@solana/kit";
import {
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  type Network,
} from "./types.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import { SIGIL_ERROR__SDK__INVALID_AMOUNT } from "./errors/codes.js";

export interface ResolvedToken {
  mint: Address;
  decimals: number;
  symbol: string;
}

/** Well-known tokens with hardcoded mints and decimals */
const WELL_KNOWN_TOKENS: Record<
  string,
  Record<Network, { mint: Address; decimals: number }>
> = {
  USDC: {
    devnet: { mint: USDC_MINT_DEVNET, decimals: 6 },
    "mainnet-beta": { mint: USDC_MINT_MAINNET, decimals: 6 },
  },
  USDT: {
    devnet: { mint: USDT_MINT_DEVNET, decimals: 6 },
    "mainnet-beta": { mint: USDT_MINT_MAINNET, decimals: 6 },
  },
  SOL: {
    devnet: {
      mint: "So11111111111111111111111111111111111111112" as Address,
      decimals: 9,
    },
    "mainnet-beta": {
      mint: "So11111111111111111111111111111111111111112" as Address,
      decimals: 9,
    },
  },
  WSOL: {
    devnet: {
      mint: "So11111111111111111111111111111111111111112" as Address,
      decimals: 9,
    },
    "mainnet-beta": {
      mint: "So11111111111111111111111111111111111111112" as Address,
      decimals: 9,
    },
  },
  JUP: {
    devnet: {
      mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" as Address,
      decimals: 6,
    },
    "mainnet-beta": {
      mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" as Address,
      decimals: 6,
    },
  },
  BONK: {
    devnet: {
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" as Address,
      decimals: 5,
    },
    "mainnet-beta": {
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" as Address,
      decimals: 5,
    },
  },
  PYTH: {
    devnet: {
      mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" as Address,
      decimals: 6,
    },
    "mainnet-beta": {
      mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" as Address,
      decimals: 6,
    },
  },
  WIF: {
    devnet: {
      mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" as Address,
      decimals: 6,
    },
    "mainnet-beta": {
      mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" as Address,
      decimals: 6,
    },
  },
  JITO: {
    devnet: {
      mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" as Address,
      decimals: 9,
    },
    "mainnet-beta": {
      mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" as Address,
      decimals: 9,
    },
  },
  RAY: {
    devnet: {
      mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" as Address,
      decimals: 6,
    },
    "mainnet-beta": {
      mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" as Address,
      decimals: 6,
    },
  },
};

/**
 * Check if a string looks like a valid base58 public key.
 */
function isBase58Address(value: string): boolean {
  // Base58 Solana addresses are 32-44 chars, only base58 chars
  if (value.length < 32 || value.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

/**
 * Resolve a token symbol or mint address to a ResolvedToken.
 *
 * Resolution order:
 * 1. Well-known tokens (USDC, USDT, SOL, etc.) — instant, no network
 * 2. Valid base58 address — accept as-is with default decimals
 * 3. Returns null if unresolvable
 */
export function resolveToken(
  tokenOrMint: string,
  network: Network = "mainnet-beta",
): ResolvedToken | null {
  // 1. Check well-known tokens (case-insensitive)
  const upper = tokenOrMint.toUpperCase();
  const known = WELL_KNOWN_TOKENS[upper];
  if (known) {
    const entry = known[network];
    return { mint: entry.mint, decimals: entry.decimals, symbol: upper };
  }

  // 2. Check if it's a valid base58 address
  if (isBase58Address(tokenOrMint)) {
    return {
      mint: tokenOrMint as Address,
      decimals: 6, // default; caller should fetch actual decimals
      symbol: tokenOrMint.slice(0, 4) + "...",
    };
  }

  return null;
}

/**
 * Convert a human-readable amount to base units (bigint).
 *
 * Validates for NaN and negative values (H-6 fix by construction).
 * Example: toBaseUnits(100, 6) === 100_000_000n
 */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!Number.isFinite(num) || num < 0) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_AMOUNT,
      `Invalid amount: ${amount}. Must be a finite non-negative number.`,
      { context: { received: amount } },
    );
  }
  const multiplier = Math.pow(10, decimals);
  const baseUnits = Math.round(num * multiplier);
  return BigInt(baseUnits);
}

/**
 * Convert base units to a human-readable amount.
 * Example: fromBaseUnits(100_000_000n, 6) === 100
 */
export function fromBaseUnits(amount: bigint, decimals: number): number {
  const divisor = Math.pow(10, decimals);
  return Number(amount) / divisor;
}
