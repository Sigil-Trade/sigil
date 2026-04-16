/**
 * Shared math utilities for analytics modules.
 *
 * PR 3.B F037: computeUtilizationPercent extracted from 18 duplicate sites
 * across agent-analytics, spending-analytics, protocol-analytics, balance-
 * tracker, and dashboard/reads.
 */

/**
 * Calculate utilization as a percentage (0–100) with 2-decimal precision.
 *
 * Uses bigint-safe computation: `(spent * 10000) / cap` in bigint space,
 * then divides by 100 in Number space for the percentage. Returns 0 when
 * cap is zero (no budget = no utilization, not division-by-zero).
 *
 * @example computeUtilizationPercent(250_000_000n, 500_000_000n) // → 50
 * @example computeUtilizationPercent(0n, 0n)                     // → 0
 */
export function computeUtilizationPercent(spent: bigint, cap: bigint): number {
  return cap > 0n ? Number((spent * 10000n) / cap) / 100 : 0;
}

/**
 * Herfindahl-Hirschman Index (0-1) for concentration analysis.
 *
 * H ≈ 1/N: evenly distributed among N entities.
 * H = 1: single entity dominates.
 *
 * Uses bigint-safe computation: share is calculated in bigint space (scaled
 * to 10000 BPS) before converting to Number, avoiding precision loss for
 * values up to ~$900 trillion.
 */
export function computeHerfindahl(values: bigint[]): number {
  const total = values.reduce((sum, v) => sum + v, 0n);
  if (total === 0n) return 0;

  let sumSquares = 0;
  for (const v of values) {
    if (v === 0n) continue;
    // Compute share in bigint space (BPS precision) to avoid Number() on raw bigints
    const shareBps = Number((v * 10000n) / total);
    const share = shareBps / 10000;
    sumSquares += share * share;
  }

  return sumSquares;
}

/**
 * Calculate P&L as a percentage with 2-decimal precision.
 * C1 audit fix: handles SIGNED numerators (negative P&L → negative %).
 */
export function computePnlPercent(pnl: bigint, investment: bigint): number {
  return investment > 0n ? Number((pnl * 10000n) / investment) / 100 : 0;
}
