/**
 * TEE Attestation Dispatcher
 *
 * Main entry point for TEE attestation verification.
 * Detects the provider from the wallet, routes to the appropriate verifier,
 * manages caching, and enforces requireAttestation + minAttestationLevel.
 */

import type { WalletLike, TeeWallet } from "./wallet-types.js";
import { isTeeWallet } from "./wallet-types.js";
import { TeeAttestationError } from "./wallet-types.js";
import { AttestationCache, DEFAULT_CACHE_TTL_MS } from "./cache.js";
import {
  AttestationStatus,
  type AttestationResult,
  type AttestationConfig,
  type AttestationLevel,
  type TeeProvider,
} from "./types.js";
import { verifyCrossmint } from "./providers/crossmint.js";
import { verifyPrivy } from "./providers/privy.js";
import { verifyTurnkey } from "./providers/turnkey.js";

/** Module-level singleton cache. */
const globalCache = new AttestationCache(DEFAULT_CACHE_TTL_MS);

/** Detect the TEE provider from a wallet. */
function detectProvider(wallet: WalletLike): TeeProvider | null {
  if (!isTeeWallet(wallet)) return null;
  const provider = (wallet as TeeWallet).provider.toLowerCase();
  if (
    provider === "crossmint" ||
    provider === "turnkey" ||
    provider === "privy"
  ) {
    return provider as TeeProvider;
  }
  return null;
}

/** Check if an attestation status meets the minimum required level. */
function attestationStatusMeetsLevel(
  status: AttestationStatus,
  level: AttestationLevel,
): boolean {
  const levelOrder: Record<AttestationLevel, number> = {
    provider_trusted: 0,
    provider_verified: 1,
    cryptographic: 2,
  };
  const statusToLevel: Record<string, number> = {
    [AttestationStatus.ProviderTrusted]: 0,
    [AttestationStatus.ProviderVerified]: 1,
    [AttestationStatus.CryptographicallyVerified]: 2,
  };
  const statusLevel = statusToLevel[status];
  if (statusLevel === undefined) return false; // Failed/Unavailable never meet any level
  return statusLevel >= levelOrder[level];
}

/**
 * Verify TEE attestation for a wallet.
 *
 * Flow:
 * 1. Check cache (unless cacheTtlMs === 0)
 * 2. Detect provider from wallet
 * 3. Route to provider-specific verifier
 * 4. Cache successful results only (`Failed` and `Unavailable` never cache)
 * 5. Fire `onVerified` on success; fire `onDegraded` on non-verified status
 * 6. Enforce `requireAttestation` — throws `TeeAttestationError` with
 *    `.result` attached when verification didn't reach a verified status
 * 7. Enforce `minAttestationLevel`
 *
 * **Safe-by-default behavior (changed in PR 1.B safety lockdown).**
 * `requireAttestation` now defaults to `true`, so a call like
 * `verifyTeeAttestation(wallet)` with no config throws on any degraded
 * outcome instead of silently returning a Failed/Unavailable result.
 * Consumers that want the old forgiving behavior must pass
 * `{ requireAttestation: false, onDegraded: ... }` — the callback is
 * mandatory under the forgiving path; omitting it is treated as the
 * silent-failure vector this default was introduced to prevent and
 * yields an immediate throw.
 */
export async function verifyTeeAttestation(
  wallet: WalletLike,
  config?: AttestationConfig,
): Promise<AttestationResult> {
  // Safe-by-default: `requireAttestation` implicitly true when unset.
  // Consumers who want the forgiving path must say so explicitly AND
  // supply `onDegraded` — otherwise we would silently re-introduce the
  // vulnerability this default fixes.
  const requireAttestation = config?.requireAttestation ?? true;
  if (!requireAttestation && typeof config?.onDegraded !== "function") {
    throw new TeeAttestationError(
      "verifyTeeAttestation called with `requireAttestation: false` but no `onDegraded` callback. " +
        "Omitting the callback is a silent-degradation vector — supply `onDegraded` to observe degraded results, " +
        "or remove `requireAttestation: false` to fail closed.",
    );
  }

  // Kit Address is already base58 — no conversion needed
  const publicKey = wallet.publicKey;
  const cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const useCache = Number.isFinite(cacheTtlMs) && cacheTtlMs > 0;

  // H3: Include config-sensitive params in cache key so different configs
  // don't share results (e.g., different expectedPcr3 values).
  const cacheKey = config?.expectedPcr3
    ? `${publicKey}:pcr3=${config.expectedPcr3}`
    : publicKey;

  // Step 1: Cache check
  let result: AttestationResult | undefined;
  if (useCache) {
    result = globalCache.get(cacheKey);
  }

  // Step 2-3: Verify if not cached
  if (!result) {
    const provider = detectProvider(wallet);

    if (!provider) {
      // TeeProvider is required by AttestationResult — "crossmint" used as
      // placeholder for unrecognized wallets. Status is Unavailable so the
      // provider value is informational only and not acted upon.
      result = {
        status: AttestationStatus.Unavailable,
        provider: "crossmint" as TeeProvider,
        publicKey,
        metadata: {
          provider: "crossmint" as TeeProvider,
          verifiedAt: Date.now(),
        },
        message: "Wallet does not expose a recognized TEE provider.",
      };
    } else {
      switch (provider) {
        case "crossmint":
          result = await verifyCrossmint(wallet, config);
          break;
        case "privy":
          result = await verifyPrivy(wallet, config);
          break;
        case "turnkey":
          result = await verifyTurnkey(wallet as TeeWallet, config);
          break;
        default:
          result = {
            status: AttestationStatus.Unavailable,
            provider,
            publicKey,
            metadata: { provider, verifiedAt: Date.now() },
            message: `Unknown provider: ${provider}`,
          };
      }
    }

    // Cache only verified outcomes — `Failed` and `Unavailable` should
    // allow the next call to retry. The previous `isCustodyFallback`
    // guard is unnecessary now that custody-API errors surface as
    // `Failed` (which is excluded from this allowlist).
    if (
      useCache &&
      (result.status === AttestationStatus.CryptographicallyVerified ||
        result.status === AttestationStatus.ProviderVerified ||
        result.status === AttestationStatus.ProviderTrusted)
    ) {
      globalCache.set(cacheKey, result, cacheTtlMs);
    }
  }

  // Step 5: Fire onVerified / onDegraded callbacks.
  // Both are wrapped in try/catch so a consumer exception in their
  // telemetry wire-up cannot abort an otherwise valid verification.
  const isVerified =
    result.status === AttestationStatus.CryptographicallyVerified ||
    result.status === AttestationStatus.ProviderVerified ||
    result.status === AttestationStatus.ProviderTrusted;

  if (isVerified) {
    try {
      config?.onVerified?.(result);
    } catch {
      // Attestation succeeded — callback errors are non-fatal
    }
  } else {
    try {
      config?.onDegraded?.(result);
    } catch {
      // Degraded callback errors are non-fatal — we still throw below
      // if `requireAttestation` is true, so the caller's observability
      // wire-up being broken doesn't cascade into a silent pass.
    }
  }

  // Step 6: Enforce requireAttestation. Default `true` after PR 1.B.
  // Throws carry the full result so Sentry-style tooling deserializes
  // `err.result.status`, `.provider`, `.metadata.verifiedAt` without
  // callsite instrumentation.
  if (requireAttestation && !isVerified) {
    throw new TeeAttestationError(
      `TEE attestation required but verification ${result.status}: ${result.message} ` +
        `Set \`requireAttestation: false\` with an \`onDegraded\` callback to proceed without verification.`,
      result,
    );
  }

  // Step 7: Enforce minAttestationLevel. Defaults to ProviderVerified when
  // requireAttestation is true and no explicit level is set — prevents
  // ProviderTrusted from passing silently under the safe-by-default path.
  const effectiveMinLevel =
    config?.minAttestationLevel ??
    (requireAttestation ? AttestationStatus.ProviderVerified : undefined);
  if (effectiveMinLevel) {
    if (!attestationStatusMeetsLevel(result.status, effectiveMinLevel)) {
      throw new TeeAttestationError(
        `Attestation level ${result.status} does not meet minimum required level: ${effectiveMinLevel}`,
        result,
      );
    }
  }

  return result;
}

/** Clear the global attestation cache (useful for testing). */
export function clearAttestationCache(): void {
  globalCache.clear();
}

/** Delete a single entry from the global cache. */
/** Delete all cache entries for a wallet (including PCR3-suffixed variants). */
export function deleteFromAttestationCache(publicKey: string): boolean {
  const directDeleted = globalCache.delete(publicKey);
  const prefixDeleted = globalCache.deleteByPrefix(`${publicKey}:`);
  return directDeleted || prefixDeleted > 0;
}

/**
 * Get the global attestation cache instance (for testing/inspection only).
 * @internal
 */
export function getGlobalCache(): AttestationCache {
  return globalCache;
}
