/**
 * Privy TEE Attestation Provider
 *
 * Privy uses AWS Nitro Enclaves. Attestation documents are not
 * publicly exposed — but API-based custody verification is available
 * via verifyProviderCustody(). Returns ProviderVerified when custody
 * is confirmed, ProviderTrusted as fallback.
 */

import type { WalletLike, TeeWallet } from "../wallet-types.js";
import {
  AttestationStatus,
  type AttestationResult,
  type AttestationConfig,
} from "../types.js";
import { isTransportError, redactCause } from "../../network-errors.js";

export async function verifyPrivy(
  wallet: WalletLike,
  _config?: AttestationConfig,
): Promise<AttestationResult> {
  // Kit Address is already base58 — no conversion needed
  const publicKey = wallet.publicKey;
  const teeWallet = wallet as TeeWallet;

  // Attempt API-based custody verification
  if (typeof teeWallet.verifyProviderCustody === "function") {
    try {
      const verified = await teeWallet.verifyProviderCustody();
      if (verified) {
        return {
          status: AttestationStatus.ProviderVerified,
          provider: "privy",
          publicKey,
          metadata: {
            provider: "privy",
            enclaveType: "nitro",
            verifiedAt: Date.now(),
          },
          message:
            "Privy wallet custody verified via API — address matches TEE-managed key.",
        };
      }
      // API call succeeded but address didn't match
      return {
        status: AttestationStatus.Failed,
        provider: "privy",
        publicKey,
        metadata: { provider: "privy", verifiedAt: Date.now() },
        message: "Privy custody verification failed: address mismatch.",
      };
    } catch (err: unknown) {
      // API call failed. Previously this path silently downgraded to
      // ProviderTrusted. Now fail closed with Failed + structural
      // transport classification and a redacted cause. See crossmint.ts
      // for the full rationale.
      const transport = isTransportError(err);
      const cause = redactCause(err);
      return {
        status: AttestationStatus.Failed,
        provider: "privy",
        publicKey,
        metadata: {
          provider: "privy",
          enclaveType: "nitro",
          verifiedAt: Date.now(),
          rawAttestation: { transport, cause },
        },
        message: transport
          ? "Privy custody verification failed: transport error reaching the custody API. Retry after network recovery."
          : `Privy custody verification failed: unexpected error from custody API. Cause: ${cause.message ?? cause.name ?? cause.code ?? "unknown"}`,
      };
    }
  }

  // Fallback: no verifyProviderCustody() available
  return {
    status: AttestationStatus.ProviderTrusted,
    provider: "privy",
    publicKey,
    metadata: {
      provider: "privy",
      enclaveType: "nitro",
      verifiedAt: Date.now(),
    },
    message:
      "Privy wallet trusted via managed AWS Nitro Enclave infrastructure. " +
      "Custody verification unavailable — implement verifyProviderCustody() for ProviderVerified status.",
  };
}
