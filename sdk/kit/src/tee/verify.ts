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
import { redactCause } from "../network-errors.js";
import { getSigilModuleLogger } from "../logger.js";

/**
 * Cache-key delimiter. `|` is chosen over `:` because base58 cannot
 * contain `|` (or `:`), but `:` looks like part of a URL scheme and
 * `deleteByPrefix(\`${publicKey}:\`)` would ambiguously match any
 * future suffix scheme. `|` eliminates that fragility.
 */
const CACHE_KEY_DELIMITER = "|";

/**
 * Guarded introspection — a hostile wallet can expose `publicKey` or
 * `provider` as throwing getters and bypass the entire `TeeAttestationError`
 * contract by making the raw getter error escape `verifyTeeAttestation`.
 * Returns `undefined` on any throw; caller treats that as a synthetic
 * Failed result.
 */
function readWalletIdentity(
  wallet: WalletLike,
): { publicKey: string; detected: TeeProvider | null } | { error: unknown } {
  try {
    const publicKey = wallet.publicKey;
    if (typeof publicKey !== "string" || publicKey.length === 0) {
      return { error: new Error("wallet.publicKey is not a non-empty string") };
    }
    // `detectProvider` touches `isTeeWallet` which reads `wallet.provider`
    // — include it in the same guard so a provider-getter throw doesn't
    // bypass the contract either.
    const detected = detectProvider(wallet);
    return { publicKey, detected };
  } catch (err: unknown) {
    return { error: err };
  }
}

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

  // Guarded introspection — a throwing `publicKey` or `provider` getter
  // would otherwise bypass every safety check below by escaping with a
  // raw exception the caller didn't contract for.
  const identity = readWalletIdentity(wallet);
  if ("error" in identity) {
    const syntheticResult: AttestationResult = {
      status: AttestationStatus.Failed,
      provider: "crossmint" as TeeProvider, // placeholder — real provider unreadable
      publicKey: "<unreadable>",
      metadata: {
        provider: "crossmint" as TeeProvider,
        verifiedAt: Date.now(),
        rawAttestation: {
          introspectionFailed: true,
          cause: redactCause(identity.error),
        },
      },
      message:
        "Wallet rejected attestation introspection — `publicKey` or `provider` getter threw. " +
        "This indicates a hostile or buggy wallet adapter.",
    };
    if (requireAttestation) {
      throw new TeeAttestationError(syntheticResult.message, syntheticResult);
    }
    try {
      config?.onDegraded?.(syntheticResult);
    } catch (cbErr: unknown) {
      getSigilModuleLogger().debug(
        `[@usesigil/kit/tee] onDegraded callback threw (non-fatal): ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
      );
    }
    return syntheticResult;
  }
  const publicKey = identity.publicKey;
  const detectedProvider = identity.detected;

  const cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const useCache = Number.isFinite(cacheTtlMs) && cacheTtlMs > 0;

  // H3: Include config-sensitive params in cache key so different configs
  // don't share results (e.g., different expectedPcr3 values). Delimiter
  // is `|` so `deleteByPrefix(\`${publicKey}${DELIMITER}\`)` is unambiguous
  // — base58 cannot contain `|`.
  const cacheKey = config?.expectedPcr3
    ? `${publicKey}${CACHE_KEY_DELIMITER}pcr3=${config.expectedPcr3}`
    : publicKey;

  // Step 1: Cache check
  let result: AttestationResult | undefined;
  if (useCache) {
    result = globalCache.get(cacheKey);
  }

  // Step 2-3: Verify if not cached
  if (!result) {
    const provider = detectedProvider;

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

  // Classification.
  const isVerifiedStatus =
    result.status === AttestationStatus.CryptographicallyVerified ||
    result.status === AttestationStatus.ProviderVerified ||
    result.status === AttestationStatus.ProviderTrusted;

  // Step 5a: Enforce requireAttestation. Default `true` after PR 1.B.
  // This fires BEFORE the success callback so `onVerified` never fires
  // on a result the dispatcher is about to reject.
  if (requireAttestation && !isVerifiedStatus) {
    try {
      config?.onDegraded?.(result);
    } catch (cbErr: unknown) {
      getSigilModuleLogger().debug(
        `[@usesigil/kit/tee] onDegraded callback threw (non-fatal): ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
      );
    }
    throw new TeeAttestationError(
      `TEE attestation required but verification ${result.status}: ${result.message} ` +
        `Set \`requireAttestation: false\` with an \`onDegraded\` callback to proceed without verification.`,
      result,
    );
  }

  // Step 5b: Enforce minAttestationLevel. Defaults to "provider_verified"
  // when requireAttestation is true and no explicit level is set — prevents
  // ProviderTrusted from passing silently under the safe-by-default path.
  //
  // Note the literal string: `AttestationLevel` and `AttestationStatus` are
  // distinct union/enum types whose values overlap for `provider_trusted`
  // and `provider_verified` but diverge for the cryptographic tier
  // (`"cryptographic"` vs `"cryptographically_verified"`). Using the
  // literal here ensures a future maintainer raising the default bar
  // cannot accidentally pass an enum value that fails level lookup.
  const effectiveMinLevel: AttestationLevel | undefined =
    config?.minAttestationLevel ??
    (requireAttestation ? "provider_verified" : undefined);
  if (effectiveMinLevel) {
    if (!attestationStatusMeetsLevel(result.status, effectiveMinLevel)) {
      try {
        config?.onDegraded?.(result);
      } catch (cbErr: unknown) {
        getSigilModuleLogger().debug(
          `[@usesigil/kit/tee] onDegraded callback threw (non-fatal): ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
        );
      }
      throw new TeeAttestationError(
        `Attestation level ${result.status} does not meet minimum required level: ${effectiveMinLevel}`,
        result,
      );
    }
  }

  // Step 5c: Level checks passed (or were skipped). Only fire `onVerified`
  // now — never on a result the dispatcher is about to throw over.
  // `onDegraded` for the "returns Failed without throwing" path fires
  // here too, since the caller opted into the forgiving mode.
  if (isVerifiedStatus) {
    try {
      config?.onVerified?.(result);
    } catch (cbErr: unknown) {
      getSigilModuleLogger().debug(
        `[@usesigil/kit/tee] onVerified callback threw (non-fatal): ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
      );
    }
  } else {
    try {
      config?.onDegraded?.(result);
    } catch (cbErr: unknown) {
      getSigilModuleLogger().debug(
        `[@usesigil/kit/tee] onDegraded callback threw (non-fatal): ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
      );
    }
  }

  return result;
}

/** Clear the global attestation cache (useful for testing). */
export function clearAttestationCache(): void {
  globalCache.clear();
}

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
