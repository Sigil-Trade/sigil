/**
 * Crossmint TEE Attestation Provider
 *
 * Crossmint uses Intel TDX enclaves. Attestation documents are not
 * publicly exposed — but API-based custody verification is available
 * via verifyProviderCustody(). Returns ProviderVerified when custody
 * is confirmed, ProviderTrusted as fallback.
 */

import type { WalletLike, TeeWallet } from "../wallet-types.js";
import {
  AttestationStatus,
  type AttestationResult,
  type AttestationConfig,
} from "../types";

export async function verifyCrossmint(
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
          provider: "crossmint",
          publicKey,
          metadata: {
            provider: "crossmint",
            enclaveType: "tdx",
            verifiedAt: Date.now(),
          },
          message:
            "Crossmint wallet custody verified via API — address matches TEE-managed key.",
        };
      }
      // API call succeeded but address didn't match
      return {
        status: AttestationStatus.Failed,
        provider: "crossmint",
        publicKey,
        metadata: { provider: "crossmint", verifiedAt: Date.now() },
        message: "Crossmint custody verification failed: address mismatch.",
      };
    } catch {
      // API call failed — return ProviderTrusted with distinct message.
      // rawAttestation.custodyCheckFailed signals to the dispatcher that this
      // downgraded result should not be cached (allows retry on next call).
      return {
        status: AttestationStatus.ProviderTrusted,
        provider: "crossmint",
        publicKey,
        metadata: {
          provider: "crossmint",
          enclaveType: "tdx",
          verifiedAt: Date.now(),
          rawAttestation: { custodyCheckFailed: true },
        },
        message:
          "Crossmint wallet trusted via managed Intel TDX infrastructure. " +
          "Custody verification API call failed — falling back to ProviderTrusted.",
      };
    }
  }

  // Fallback: no verifyProviderCustody() available
  return {
    status: AttestationStatus.ProviderTrusted,
    provider: "crossmint",
    publicKey,
    metadata: {
      provider: "crossmint",
      enclaveType: "tdx",
      verifiedAt: Date.now(),
    },
    message:
      "Crossmint wallet trusted via managed Intel TDX infrastructure. " +
      "Custody verification unavailable — implement verifyProviderCustody() for ProviderVerified status.",
  };
}
