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
 * Pluggable storage backend for NonceTracker persistence.
 * Default: in-memory Map (lost on restart).
 * Production: implement with Redis, SQLite, or file-based storage.
 */
export interface NonceStorage {
  has(key: string): Promise<boolean> | boolean;
  set(key: string, expiresAt: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

/** Default in-memory storage — no persistence across restarts. */
class InMemoryNonceStorage implements NonceStorage {
  private readonly entries = new Map<string, NonceEntry>();

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, expiresAt: number): void {
    this.entries.set(key, { timestamp: expiresAt });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Expose entries for GC iteration */
  [Symbol.iterator](): IterableIterator<[string, NonceEntry]> {
    return this.entries[Symbol.iterator]();
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Tracks x402 payment nonces to prevent duplicate payments.
 *
 * Dedup key: `url|payTo|amount` — same payment to same destination
 * for same resource within window = replay.
 *
 * Pass a `NonceStorage` implementation for persistence across restarts.
 * Without it, replay protection is lost on process restart.
 */
export class NonceTracker {
  private readonly storage: InMemoryNonceStorage;
  private readonly externalStorage: NonceStorage | null;
  private readonly ttlMs: number;

  constructor(options?: { ttlMs?: number; storage?: NonceStorage }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.storage = new InMemoryNonceStorage();
    this.externalStorage = options?.storage ?? null;
  }

  /**
   * Build the dedup key from payment parameters.
   */
  static buildKey(url: string, payTo: string, amount: string): string {
    let normalizedUrl: string;
    try {
      const parsed = new URL(url);
      parsed.search = "";
      normalizedUrl = parsed.toString().replace(/\/$/, "");
    } catch {
      normalizedUrl = url;
    }
    return `${normalizedUrl}|${payTo}|${amount}`;
  }

  /**
   * Check if a payment is a duplicate.
   * Does NOT record — call record() after successful payment.
   */
  async isDuplicate(url: string, payTo: string, amount: string): Promise<boolean> {
    this.gc();
    const key = NonceTracker.buildKey(url, payTo, amount);
    if (this.storage.has(key)) return true;
    if (this.externalStorage) return this.externalStorage.has(key);
    return false;
  }

  /**
   * Check and throw if duplicate.
   * @throws X402ReplayError if the payment was already seen
   */
  async checkOrThrow(url: string, payTo: string, amount: string): Promise<void> {
    if (await this.isDuplicate(url, payTo, amount)) {
      throw new X402ReplayError(NonceTracker.buildKey(url, payTo, amount));
    }
  }

  /**
   * Record a successful payment to prevent replays.
   */
  async record(url: string, payTo: string, amount: string): Promise<void> {
    const key = NonceTracker.buildKey(url, payTo, amount);
    const expiresAt = Date.now() + this.ttlMs;
    this.storage.set(key, expiresAt);
    if (this.externalStorage) await this.externalStorage.set(key, expiresAt);
  }

  /**
   * Number of active (non-expired) in-memory entries.
   */
  get size(): number {
    this.gc();
    return this.storage.size;
  }

  /**
   * Clear all in-memory entries.
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Garbage collect expired in-memory entries.
   */
  private gc(): void {
    const cutoff = Date.now();
    for (const [key, entry] of this.storage) {
      if (entry.timestamp < cutoff) {
        this.storage.delete(key);
      }
    }
  }
}
