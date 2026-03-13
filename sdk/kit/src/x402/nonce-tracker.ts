/**
 * x402 Nonce Tracker — Kit-native
 *
 * Replay prevention via resource+payTo+amount deduplication.
 * Simple string-key dedup with configurable TTL, no crypto dependencies.
 */

import { X402ReplayError } from "./errors.js";

/** Default nonce window: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface NonceEntry {
  timestamp: number;
}

/**
 * Tracks x402 payment nonces to prevent duplicate payments.
 *
 * Dedup key: `url|payTo|amount` — same payment to same destination
 * for same resource within window = replay.
 */
export class NonceTracker {
  private readonly entries = new Map<string, NonceEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Build the dedup key from payment parameters.
   */
  static buildKey(url: string, payTo: string, amount: string): string {
    return `${url}|${payTo}|${amount}`;
  }

  /**
   * Check if a payment is a duplicate.
   * Does NOT record — call record() after successful payment.
   */
  isDuplicate(url: string, payTo: string, amount: string): boolean {
    this.gc();
    const key = NonceTracker.buildKey(url, payTo, amount);
    return this.entries.has(key);
  }

  /**
   * Check and throw if duplicate.
   * @throws X402ReplayError if the payment was already seen
   */
  checkOrThrow(url: string, payTo: string, amount: string): void {
    if (this.isDuplicate(url, payTo, amount)) {
      throw new X402ReplayError(
        NonceTracker.buildKey(url, payTo, amount),
      );
    }
  }

  /**
   * Record a successful payment to prevent replays.
   */
  record(url: string, payTo: string, amount: string): void {
    const key = NonceTracker.buildKey(url, payTo, amount);
    this.entries.set(key, { timestamp: Date.now() });
  }

  /**
   * Number of active (non-expired) entries.
   */
  get size(): number {
    this.gc();
    return this.entries.size;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Garbage collect expired entries.
   */
  private gc(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.timestamp < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}
