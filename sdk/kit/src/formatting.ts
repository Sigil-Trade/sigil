/**
 * Display formatting functions for USD, percentages, time, addresses, and token amounts.
 *
 * Design decisions:
 * - All USD formatting takes bigint (6-decimal stablecoin base units) and converts to display.
 * - Never use Number() on raw bigint amounts > 2^53 — precision loss. The division by 10^6
 *   is safe because the result fits in Number range (< $18.4 trillion).
 * - Locale: en-US hardcoded. International formatting is a future concern.
 *
 * This module is Phase 6 P0 from ANALYTICS-DATA-LAYER-PLAN, pulled forward into Step 5.5
 * to eliminate overlap. Every other analytics module depends on these formatters.
 */

import type { Address } from "@solana/kit";
import { STABLECOIN_USD_FACTOR } from "./types.js";

// ─── Cached Intl Formatters ─────────────────────────────────────────────────

/** Full stablecoin precision (6 decimals = 1 micro-dollar). Default for SDK output. */
const usdFormatter6 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
});

const usdFormatter2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdFormatter0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const usdFormatterCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const numberFormatter = new Intl.NumberFormat("en-US");

const numberFormatterCompact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Convert stablecoin base units (6 decimals) to a Number in dollars. Safe for < $18.4T. */
function usdToNumber(absAmount: bigint): number {
  return (
    Number(absAmount / STABLECOIN_USD_FACTOR) +
    Number(absAmount % STABLECOIN_USD_FACTOR) / 1_000_000
  );
}

// ─── USD Formatting ──────────────────────────────────────────────────────────

/**
 * Format a stablecoin base-unit amount as a USD string.
 *
 * Default: full stablecoin precision (6 decimals). UI can truncate by passing decimals=2.
 *
 * @param amount - Raw amount in stablecoin base units (6 decimals). e.g., 500_000_000n = $500.000000
 * @param decimals - Display decimal places (default 6 = full precision). Use 2 for display, 0 for KPI cards.
 * @returns Formatted string like "$1,234.567890" (default) or "$1,234.57" (decimals=2)
 */
export function formatUsd(amount: bigint, decimals = 6): string {
  const isNegative = amount < 0n;
  const absAmount = isNegative ? -amount : amount;
  const dollarValue = usdToNumber(absAmount);

  // Use cached formatter for common decimal counts, dynamic for others
  const formatter =
    decimals === 6
      ? usdFormatter6
      : decimals === 2
        ? usdFormatter2
        : decimals === 0
          ? usdFormatter0
          : new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
              minimumFractionDigits: decimals,
              maximumFractionDigits: decimals,
            });

  const formatted = formatter.format(dollarValue);
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Format USD amount in compact notation for KPI cards and small spaces.
 *
 * @param amount - Raw amount in stablecoin base units (6 decimals)
 * @returns Compact string like "$1.2K", "$3.5M", "$0.00"
 */
export function formatUsdCompact(amount: bigint): string {
  const isNegative = amount < 0n;
  const absAmount = isNegative ? -amount : amount;
  const dollarValue = usdToNumber(absAmount);

  const formatted = usdFormatterCompact.format(dollarValue);
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Format USD with explicit sign for P&L display.
 *
 * @param amount - Raw amount in stablecoin base units (can be negative for losses)
 * @param decimals - Display decimal places (default 6 = full precision). Use 2 for display.
 * @returns "+$234.560000" for gains, "-$89.120000" for losses, "$0.000000" for zero
 */
export function formatUsdSigned(amount: bigint, decimals = 6): string {
  if (amount === 0n) return formatUsd(0n, decimals);
  if (amount > 0n) return `+${formatUsd(amount, decimals)}`;
  return formatUsd(amount, decimals); // formatUsd already handles negative
}

// ─── Percentage Formatting ───────────────────────────────────────────────────

/**
 * Format a number as a percentage string.
 *
 * @param value - Percentage value (e.g., 24.7 for 24.7%)
 * @param decimals - Decimal places (default 1)
 * @returns "24.7%" or "0.0%"
 */
export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format percentage with explicit sign for P&L display.
 *
 * @param value - Percentage value (positive = gain, negative = loss)
 * @returns "+24.7%" or "-5.2%" or "0.0%"
 */
export function formatPercentSigned(value: number, decimals = 1): string {
  // Scale threshold to match display precision: 0.05 for 1 dec, 0.005 for 2 dec, etc.
  const threshold = 0.5 * Math.pow(10, -decimals);
  if (Math.abs(value) < threshold) return `0.${"0".repeat(decimals)}%`;
  if (value > 0) return `+${value.toFixed(decimals)}%`;
  return `${value.toFixed(decimals)}%`;
}

// ─── Time Formatting ─────────────────────────────────────────────────────────

/**
 * Format a duration in seconds as a human-readable string.
 *
 * @param seconds - Duration in seconds (positive)
 * @returns "2h 15m", "45m", "3d 12h", "< 1m"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return "0m";
  if (seconds < 60) return "< 1m";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/**
 * Format a Unix timestamp as a relative time string.
 *
 * @param timestamp - Unix timestamp in seconds
 * @returns "just now", "2m ago", "3h ago", "2d ago"
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

/**
 * Format a Unix timestamp as time-until string.
 *
 * @param timestamp - Future Unix timestamp in seconds
 * @returns "in 2h 15m", "in 45m", "expired"
 */
export function formatTimeUntil(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = timestamp - now;

  if (diff <= 0) return "expired";
  return `in ${formatDuration(diff)}`;
}

// ─── Address Formatting ──────────────────────────────────────────────────────

/**
 * Truncate a Solana address for display.
 *
 * @param address - Full base58 address
 * @param chars - Characters to show on each side (default 4)
 * @returns "7Kp3...xQ2m"
 */
export function formatAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

// ─── Token Amount Formatting ─────────────────────────────────────────────────

/**
 * Format a token amount with symbol at full token precision.
 *
 * Default: full decimals for the token (6 for USDC, 9 for SOL). UI can truncate.
 *
 * @param amount - Raw amount in base units
 * @param decimals - Token decimals (6 for USDC, 9 for SOL)
 * @param symbol - Token symbol ("USDC", "SOL")
 * @param displayDecimals - Override display precision (default: full token decimals)
 * @returns "1,234.560000 USDC" or "0.123456789 SOL"
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  symbol: string,
  displayDecimals?: number,
): string {
  const isNegative = amount < 0n;
  const absAmount = isNegative ? -amount : amount;
  const factor = 10n ** BigInt(decimals);
  const whole = absAmount / factor;
  const frac = absAmount % factor;

  const fracDigits = displayDecimals ?? decimals;
  const fracStr = frac
    .toString()
    .padStart(decimals, "0")
    .slice(0, fracDigits);

  const wholeFormatted = numberFormatter.format(Number(whole));
  const result = fracDigits > 0
    ? `${wholeFormatted}.${fracStr} ${symbol}`
    : `${wholeFormatted} ${symbol}`;
  return isNegative ? `-${result}` : result;
}

/**
 * Format token amount in compact notation.
 *
 * @param amount - Raw amount in base units
 * @param decimals - Token decimals
 * @param symbol - Token symbol
 * @returns "1.2K USDC", "3.5M SOL"
 */
export function formatTokenAmountCompact(
  amount: bigint,
  decimals: number,
  symbol: string,
): string {
  const factor = 10n ** BigInt(decimals);
  const value =
    Number(amount / factor) + Number(amount % factor) / Number(factor);

  const formatted = numberFormatterCompact.format(value);
  return `${formatted} ${symbol}`;
}
