/**
 * Shared math utilities for analytics modules.
 */

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
