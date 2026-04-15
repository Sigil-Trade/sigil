/**
 * CustodyAdapter — Kit-native interface for custody providers.
 *
 * Bridges third-party custody adapters (Turnkey, Fireblocks, Crossmint, etc.)
 * to @solana/kit's TransactionSigner interface.
 *
 * This is the standardized 3-method contract that Phase 8 custody packages
 * will implement. The bridge function converts any CustodyAdapter into a
 * TransactionPartialSigner usable anywhere Kit expects a signer.
 */

import type { Address, TransactionSigner } from "@solana/kit";
import type { AttestationResult } from "./tee/types.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import { SIGIL_ERROR__SDK__SIGNATURE_INVALID } from "./errors/codes.js";

// ─── Interface ──────────────────────────────────────────────────────────────

/**
 * Standardized interface for custody providers.
 *
 * Implementors:
 * - `@usesigil/custody/turnkey` — TEE + Ed25519
 * - `@usesigil/custody/crossmint` — API-verified TEE
 * - `@usesigil/custody/privy` — Embedded wallets
 *
 * 3-method contract:
 * - getPublicKey(): Address of the custody-managed signing key
 * - sign(): Raw Ed25519 signature over arbitrary bytes
 * - attestation() (optional): TEE attestation proof
 */
export interface CustodyAdapter {
  /** Get the public key (address) of the custody-managed signing key. */
  getPublicKey(): Address;

  /**
   * Sign arbitrary bytes. Returns a 64-byte Ed25519 signature.
   * The adapter handles key access (TEE, MPC, HSM, etc.) internally.
   */
  sign(bytes: Uint8Array): Promise<Uint8Array>;

  /**
   * Optional: Retrieve TEE attestation proof for the custody key.
   * Returns null if the provider doesn't support attestation.
   */
  attestation?(): Promise<AttestationResult | null>;
}

// ─── Bridge ─────────────────────────────────────────────────────────────────

/**
 * Bridge a CustodyAdapter to Kit's TransactionSigner interface.
 *
 * Returns a TransactionPartialSigner — custody adapters do pure signing
 * (no transaction modification).
 *
 * Usage:
 * ```ts
 * const adapter: CustodyAdapter = new TurnkeyCustodyAdapter(config);
 * const signer = custodyAdapterToTransactionSigner(adapter);
 * // signer is now usable anywhere Kit expects a TransactionSigner
 * ```
 */
export function custodyAdapterToTransactionSigner(
  adapter: CustodyAdapter,
): TransactionSigner {
  const address = adapter.getPublicKey();

  return {
    address,
    async signTransactions<T extends { messageBytes: Uint8Array }>(
      transactions: readonly T[],
    ): Promise<readonly Record<string, Uint8Array>[]> {
      const results: Record<string, Uint8Array>[] = [];

      for (const tx of transactions) {
        const sig = await adapter.sign(tx.messageBytes);
        if (!(sig instanceof Uint8Array)) {
          throw new SigilSdkDomainError(
            SIGIL_ERROR__SDK__SIGNATURE_INVALID,
            `Custody adapter signature must be Uint8Array, got ${typeof sig}`,
            { context: { reason: `wrong-type:${typeof sig}` } },
          );
        }
        if (sig.length !== 64) {
          throw new SigilSdkDomainError(
            SIGIL_ERROR__SDK__SIGNATURE_INVALID,
            `Custody adapter returned invalid signature: expected 64 bytes, got ${sig.length}`,
            { context: { reason: `wrong-length:${sig.length}` } },
          );
        }
        results.push({ [address]: sig });
      }

      return results;
    },
  } as TransactionSigner;
}
