/**
 * Shared managed-TEE provider verification logic.
 *
 * PR 3.B F039: Crossmint (Intel TDX) and Privy (AWS Nitro) are ~95%
 * identical — they differ only in provider name, enclave type, and
 * infrastructure description. This factory extracts the shared flow:
 *
 *   1. Attempt API-based custody verification via verifyProviderCustody()
 *   2. On success → ProviderVerified
 *   3. On mismatch → Failed
 *   4. On throw → Failed with structural transport classification (fail-closed)
 *   5. No method available → ProviderTrusted (managed-infrastructure fallback)
 */

import type { WalletLike, TeeWallet } from "../wallet-types.js";
import {
  AttestationStatus,
  type AttestationResult,
  type AttestationConfig,
  type TeeProvider,
} from "../types.js";
import { isTransportError, redactCause } from "../../network-errors.js";

export interface ManagedProviderConfig {
  /** Provider identifier (e.g., "crossmint", "privy"). */
  provider: TeeProvider;
  /** TEE enclave type (e.g., "tdx", "nitro"). */
  enclaveType: string;
  /** Human-readable infrastructure description for the trusted fallback message. */
  infrastructureDescription: string;
}

/**
 * Create a verification function for a managed TEE provider.
 *
 * The returned function implements the standard 5-step flow documented above.
 * Both `verifyCrossmint` and `verifyPrivy` are thin wrappers around this.
 */
export function createManagedVerifier(
  config: ManagedProviderConfig,
): (
  wallet: WalletLike,
  attestConfig?: AttestationConfig,
) => Promise<AttestationResult> {
  const { provider, enclaveType, infrastructureDescription } = config;

  return async (
    wallet: WalletLike,
    _attestConfig?: AttestationConfig,
  ): Promise<AttestationResult> => {
    const publicKey = wallet.publicKey;
    const teeWallet = wallet as TeeWallet;

    // Attempt API-based custody verification
    if (typeof teeWallet.verifyProviderCustody === "function") {
      try {
        const verified = await teeWallet.verifyProviderCustody();
        if (verified) {
          return {
            status: AttestationStatus.ProviderVerified,
            provider,
            publicKey,
            metadata: { provider, enclaveType, verifiedAt: Date.now() },
            message: `${capitalize(provider)} wallet custody verified via API — address matches TEE-managed key.`,
          };
        }
        return {
          status: AttestationStatus.Failed,
          provider,
          publicKey,
          metadata: { provider, verifiedAt: Date.now() },
          message: `${capitalize(provider)} custody verification failed: address mismatch.`,
        };
      } catch (err: unknown) {
        const transport = isTransportError(err);
        const cause = redactCause(err);
        return {
          status: AttestationStatus.Failed,
          provider,
          publicKey,
          metadata: {
            provider,
            enclaveType,
            verifiedAt: Date.now(),
            rawAttestation: { transport, cause },
          },
          message: transport
            ? `${capitalize(provider)} custody verification failed: transport error reaching the custody API. Retry after network recovery.`
            : `${capitalize(provider)} custody verification failed: unexpected error from custody API. Cause: ${cause.message ?? cause.name ?? cause.code ?? "unknown"}`,
        };
      }
    }

    // Fallback: no verifyProviderCustody() available
    return {
      status: AttestationStatus.ProviderTrusted,
      provider,
      publicKey,
      metadata: { provider, enclaveType, verifiedAt: Date.now() },
      message:
        `${capitalize(provider)} wallet trusted via managed ${infrastructureDescription}. ` +
        "Custody verification unavailable — implement verifyProviderCustody() for ProviderVerified status.",
    };
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
