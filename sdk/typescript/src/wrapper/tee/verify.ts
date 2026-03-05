/**
 * TEE Attestation Dispatcher
 *
 * Main entry point for TEE attestation verification.
 * Detects the provider from the wallet, routes to the appropriate verifier,
 * manages caching, and enforces requireAttestation + minAttestationLevel.
 */

import type { WalletLike, TeeWallet } from "../shield";
import { isTeeWallet } from "../shield";
import { TeeAttestationError } from "../errors";
import { AttestationCache, DEFAULT_CACHE_TTL_MS } from "./cache";
import {
  AttestationStatus,
  type AttestationResult,
  type AttestationConfig,
  type AttestationLevel,
  type TeeProvider,
} from "./types";
import { verifyCrossmint } from "./providers/crossmint";
import { verifyPrivy } from "./providers/privy";
import { verifyTurnkey } from "./providers/turnkey";

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
 * 4. Cache result
 * 5. Fire onVerified callback on success
 * 6. If requireAttestation is true and verification failed, throw
 * 7. If minAttestationLevel is set and not met, throw
 */
export async function verifyTeeAttestation(
  wallet: WalletLike,
  config?: AttestationConfig,
): Promise<AttestationResult> {
  const publicKey = wallet.publicKey.toBase58();
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

    // M6: Only cache successful results — failed/unavailable should allow retry.
    // Also skip caching ProviderTrusted results from API failures (custodyCheckFailed)
    // so the next call can retry the custody API and potentially get ProviderVerified.
    const isCustodyFallback =
      result.metadata.rawAttestation &&
      typeof result.metadata.rawAttestation === "object" &&
      (result.metadata.rawAttestation as Record<string, unknown>)
        .custodyCheckFailed === true;
    if (
      useCache &&
      !isCustodyFallback &&
      (result.status === AttestationStatus.CryptographicallyVerified ||
        result.status === AttestationStatus.ProviderVerified ||
        result.status === AttestationStatus.ProviderTrusted)
    ) {
      globalCache.set(cacheKey, result, cacheTtlMs);
    }
  }

  // Step 5: onVerified callback
  // H5: Wrap in try-catch to prevent user callback errors from aborting vault creation
  if (
    result.status === AttestationStatus.CryptographicallyVerified ||
    result.status === AttestationStatus.ProviderVerified ||
    result.status === AttestationStatus.ProviderTrusted
  ) {
    try {
      config?.onVerified?.(result);
    } catch {
      // Attestation succeeded — callback errors are non-fatal
    }
  }

  // C3: Enforce requireAttestation ALWAYS — including on cache hits.
  // Previously, the early cache return bypassed this check entirely.
  if (config?.requireAttestation) {
    if (
      result.status !== AttestationStatus.CryptographicallyVerified &&
      result.status !== AttestationStatus.ProviderVerified &&
      result.status !== AttestationStatus.ProviderTrusted
    ) {
      throw new TeeAttestationError(
        `TEE attestation required but verification ${result.status}: ${result.message}`,
      );
    }
  }

  // Enforce minAttestationLevel if configured
  if (config?.minAttestationLevel) {
    if (
      !attestationStatusMeetsLevel(result.status, config.minAttestationLevel)
    ) {
      throw new TeeAttestationError(
        `Attestation level ${result.status} does not meet minimum required level: ${config.minAttestationLevel}`,
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
export function deleteFromAttestationCache(publicKey: string): boolean {
  return globalCache.delete(publicKey);
}

/**
 * Get the global attestation cache instance (for testing/inspection only).
 * @internal
 */
export function getGlobalCache(): AttestationCache {
  return globalCache;
}
