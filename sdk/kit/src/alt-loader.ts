/**
 * Cached ALT loader for Sigil composed transactions.
 *
 * Wraps @solana/kit's fetchAddressesForLookupTables with:
 * - TTL-based cache (default 5 min) to avoid repeated RPC calls
 * - Graceful degradation: RPC failure returns empty map (S-4)
 * - Synchronous cache read for ShieldedSigner (S-1)
 * - Deduplication when merging Sigil + protocol ALTs
 */

import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import {
  fetchAddressesForLookupTables,
  type AddressesByLookupTableAddress,
} from "@solana/kit";
import { SigilSdkDomainError } from "./errors/sdk.js";
import { SIGIL_ERROR__SDK__ALT_INTEGRITY } from "./errors/codes.js";

// ─── AltCache ─────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 300_000; // 5 minutes

interface CacheEntry {
  data: AddressesByLookupTableAddress;
  expiresAt: number;
}

export class AltCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs?: number, maxSize?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = maxSize ?? 50;
  }

  /**
   * Resolve ALT addresses via RPC (cached).
   * Returns empty {} on failure (S-4 graceful degradation).
   * Handles partial resolution — if some ALTs don't exist,
   * resolved addresses from other ALTs are still returned.
   */
  async resolve(
    rpc: Rpc<SolanaRpcApi>,
    altAddresses: Address[],
  ): Promise<AddressesByLookupTableAddress> {
    if (altAddresses.length === 0) return {};

    const now = Date.now();
    const uncached: Address[] = [];
    const result: AddressesByLookupTableAddress = {};

    // Check cache for each ALT
    for (const addr of altAddresses) {
      const key = addr as string;
      const entry = this.cache.get(key);
      if (entry && entry.expiresAt > now) {
        // Merge cached data
        Object.assign(result, entry.data);
      } else {
        uncached.push(addr);
      }
    }

    // Fetch uncached ALTs
    if (uncached.length > 0) {
      try {
        const fetched = await fetchAddressesForLookupTables(
          uncached,
          rpc as Parameters<typeof fetchAddressesForLookupTables>[1],
        );

        // Store each ALT separately in cache
        for (const [altAddr, addresses] of Object.entries(fetched)) {
          const cacheEntry: CacheEntry = {
            data: { [altAddr as Address]: addresses },
            expiresAt: now + this.ttlMs,
          };
          this.cache.set(altAddr, cacheEntry);
        }

        // LRU eviction: remove oldest entries when cache exceeds maxSize
        while (this.cache.size > this.maxSize) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
          else break;
        }

        Object.assign(result, fetched);
      } catch (e) {
        // S-4: Graceful degradation — return whatever we have from cache
        // The composer works without ALTs; transactions just may be larger
        console.warn(
          "[AltCache] ALT fetch failed, proceeding without:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    return result;
  }

  /**
   * Synchronous read from cache — used by ShieldedSigner (S-1 fix).
   * Returns undefined if not cached or expired.
   */
  getCachedAddresses(altAddress: Address): Address[] | undefined {
    const entry = this.cache.get(altAddress as string);
    if (!entry || entry.expiresAt <= Date.now()) return undefined;
    return entry.data[altAddress];
  }

  /** Clear all cached entries. */
  invalidate(): void {
    this.cache.clear();
  }
}

// ─── Merge Helper ─────────────────────────────────────────────────────────────

/**
 * Merge Sigil ALT + protocol ALTs, deduplicate by Address equality.
 * Returns a unique list of ALT addresses to resolve.
 */
export function mergeAltAddresses(
  sigilAlt: Address,
  protocolAlts?: Address[],
): Address[] {
  const seen = new Set<string>();
  const merged: Address[] = [];

  // Sigil ALT first
  seen.add(sigilAlt as string);
  merged.push(sigilAlt);

  // Protocol ALTs (e.g. Jupiter route-specific ALTs)
  if (protocolAlts) {
    for (const alt of protocolAlts) {
      const key = alt as string;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(alt);
      }
    }
  }

  return merged;
}

// ─── Sigil ALT Verification ─────────────────────────────────────────────────

/**
 * Verify that the Sigil ALT contains all expected addresses.
 *
 * Throws on mismatch for the Sigil ALT (we control it — mismatch is corruption).
 * Protocol ALTs (Jupiter, Flash Trade) rotate per-route and are NOT verified here.
 *
 * Called after AltCache.resolve() in wrap(). If the Sigil ALT was not resolved
 * (RPC failure / graceful degradation), this is a no-op.
 */
export function verifySigilAlt(
  resolved: AddressesByLookupTableAddress,
  sigilAltAddress: Address,
  expectedContents: Address[],
): void {
  const altAddresses = resolved[sigilAltAddress];
  if (!altAddresses) {
    // ALT not resolved — graceful degradation (S-4) already handles this.
    // Transaction will be larger without ALT compression but still works.
    return;
  }

  const altSet = new Set(altAddresses.map((a) => a as string));
  const missing: Address[] = [];
  for (const expected of expectedContents) {
    if (!altSet.has(expected as string)) {
      missing.push(expected);
    }
  }

  if (missing.length > 0) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__ALT_INTEGRITY,
      `Sigil ALT ${sigilAltAddress} is missing ${missing.length} expected address(es): ` +
        `${missing.join(", ")}. ` +
        `ALT may need extension — run scripts/extend-sigil-alt.ts.`,
      { context: { altAddress: sigilAltAddress, missing: missing.length } },
    );
  }
}
