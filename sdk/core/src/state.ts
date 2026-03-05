/**
 * Client-side spending state tracker.
 * Maintains rolling windows for spend tracking and rate limiting.
 * Supports optional persistence via a pluggable storage backend.
 */

export interface SpendEntry {
  /** Token mint address (base58) */
  mint: string;
  /** Amount in native token decimals */
  amount: bigint;
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

export interface TxEntry {
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

/** Pluggable storage interface for persistence */
export interface ShieldStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY_SPENDS = "phalnx:spends";
const STORAGE_KEY_TXS = "phalnx:txs";

/** Max entries to keep in each tracker to prevent unbounded growth */
const MAX_SPEND_ENTRIES = 500;
const MAX_TX_ENTRIES = 500;

export class ShieldState {
  private spendEntries: SpendEntry[] = [];
  private txEntries: TxEntry[] = [];
  private storage: ShieldStorage | null;

  constructor(storage?: ShieldStorage) {
    this.storage = storage ?? detectStorage();
    this.load();
  }

  /**
   * Record a spend event for a token.
   */
  recordSpend(mint: string, amount: bigint): void {
    this.spendEntries.push({
      mint,
      amount,
      timestamp: Date.now(),
    });

    // Trim to max entries
    if (this.spendEntries.length > MAX_SPEND_ENTRIES) {
      this.spendEntries = this.spendEntries.slice(-MAX_SPEND_ENTRIES);
    }

    this.persist();
  }

  /**
   * Record a transaction event for rate limiting.
   */
  recordTransaction(): void {
    this.txEntries.push({ timestamp: Date.now() });

    if (this.txEntries.length > MAX_TX_ENTRIES) {
      this.txEntries = this.txEntries.slice(-MAX_TX_ENTRIES);
    }

    this.persist();
  }

  /**
   * Get total spend for a token mint within the given time window.
   */
  getSpendInWindow(mint: string, windowMs: number): bigint {
    const cutoff = Date.now() - windowMs;
    let total = BigInt(0);
    for (const entry of this.spendEntries) {
      if (entry.mint === mint && entry.timestamp >= cutoff) {
        total += entry.amount;
      }
    }
    return total;
  }

  /**
   * Get number of transactions within the given time window.
   */
  getTransactionCountInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let count = 0;
    for (const entry of this.txEntries) {
      if (entry.timestamp >= cutoff) {
        count++;
      }
    }
    return count;
  }

  /**
   * Remove expired entries older than the given window.
   */
  pruneExpired(maxWindowMs: number): void {
    const cutoff = Date.now() - maxWindowMs;
    this.spendEntries = this.spendEntries.filter((e) => e.timestamp >= cutoff);
    this.txEntries = this.txEntries.filter((e) => e.timestamp >= cutoff);
    this.persist();
  }

  /**
   * Save current state for potential rollback (used by signAllTransactions).
   */
  checkpoint(): { spends: SpendEntry[]; txs: TxEntry[] } {
    return {
      spends: [...this.spendEntries],
      txs: [...this.txEntries],
    };
  }

  /**
   * Restore state to a previous checkpoint (undo phantom spends).
   */
  rollback(cp: { spends: SpendEntry[]; txs: TxEntry[] }): void {
    this.spendEntries = cp.spends;
    this.txEntries = cp.txs;
    this.persist();
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.spendEntries = [];
    this.txEntries = [];
    this.persist();
  }

  /** Load state from storage */
  private load(): void {
    if (!this.storage) return;

    try {
      const spendsRaw = this.storage.getItem(STORAGE_KEY_SPENDS);
      if (spendsRaw) {
        const parsed = JSON.parse(spendsRaw) as Array<{
          mint: string;
          amount: string;
          timestamp: number;
        }>;
        this.spendEntries = parsed.map((e) => ({
          mint: e.mint,
          amount: BigInt(e.amount),
          timestamp: e.timestamp,
        }));
      }
    } catch {
      this.spendEntries = [];
    }

    try {
      const txsRaw = this.storage.getItem(STORAGE_KEY_TXS);
      if (txsRaw) {
        this.txEntries = JSON.parse(txsRaw) as TxEntry[];
      }
    } catch {
      this.txEntries = [];
    }
  }

  /** Persist state to storage */
  private persist(): void {
    if (!this.storage) return;

    try {
      const spendsJson = JSON.stringify(
        this.spendEntries.map((e) => ({
          mint: e.mint,
          amount: e.amount.toString(),
          timestamp: e.timestamp,
        })),
      );
      this.storage.setItem(STORAGE_KEY_SPENDS, spendsJson);

      const txsJson = JSON.stringify(this.txEntries);
      this.storage.setItem(STORAGE_KEY_TXS, txsJson);
    } catch {
      // Storage unavailable — continue with in-memory only
    }
  }
}

/**
 * Detect available storage backend.
 * Returns localStorage if available (browser), null otherwise (Node.js).
 */
function detectStorage(): ShieldStorage | null {
  try {
    if (typeof globalThis !== "undefined") {
      const g = globalThis as Record<string, unknown>;
      if (g.localStorage) {
        return g.localStorage as ShieldStorage;
      }
    }
  } catch {
    // localStorage not available
  }
  return null;
}
