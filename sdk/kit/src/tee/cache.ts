/**
 * TEE Attestation Cache
 *
 * TTL-based cache for attestation results, keyed by base58 public key.
 * Pattern follows PriorityFeeEstimator in priority-fees.ts.
 */

import type { AttestationResult } from "./types.js";

interface CacheEntry {
  result: AttestationResult;
  expiresAt: number;
}

/** Default cache TTL: 1 hour */
export const DEFAULT_CACHE_TTL_MS = 3_600_000;

/** Maximum number of entries allowed in the cache to prevent unbounded memory growth. */
const MAX_CACHE_ENTRIES = 1000;

export class AttestationCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    ttlMs: number = DEFAULT_CACHE_TTL_MS,
    maxEntries: number = MAX_CACHE_ENTRIES,
  ) {
    // M5: Guard against NaN/negative/non-finite TTL values
    this.ttlMs =
      Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_CACHE_TTL_MS;
    this.maxEntries =
      Number.isFinite(maxEntries) && maxEntries > 0
        ? maxEntries
        : MAX_CACHE_ENTRIES;
  }

  /** Get a cached result if it exists and hasn't expired. */
  get(publicKey: string): AttestationResult | undefined {
    const entry = this.cache.get(publicKey);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(publicKey);
      return undefined;
    }
    return entry.result;
  }

  /** Store a result in the cache. Optional per-entry TTL overrides the default. */
  set(publicKey: string, result: AttestationResult, ttlMs?: number): void {
    // M4: Evict oldest entry when cache is full to prevent unbounded memory growth
    if (this.cache.size >= this.maxEntries && !this.cache.has(publicKey)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    const effectiveTtl =
      ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs > 0
        ? ttlMs
        : this.ttlMs;
    this.cache.set(publicKey, {
      result,
      expiresAt: Date.now() + effectiveTtl,
    });
  }

  /** Remove a specific entry. */
  delete(publicKey: string): boolean {
    return this.cache.delete(publicKey);
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of entries currently in cache (including expired). */
  get size(): number {
    return this.cache.size;
  }
}
