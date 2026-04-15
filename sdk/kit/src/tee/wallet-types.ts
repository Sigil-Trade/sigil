/**
 * Wallet interface types for TEE attestation — Kit-native.
 *
 * Uses Kit's `Address` (branded base58 string) for public keys.
 * Zero dependency on @solana/web3.js.
 */

import type { Address } from "@solana/kit";

/**
 * A wallet-like object with a Kit Address public key.
 *
 * Kit `Address` is a branded string (`string & { __brand: ... }`), so
 * `wallet.publicKey` is ALREADY base58 — no `.toBase58()` needed.
 */
export interface WalletLike {
  /** Base58-encoded public key as a Kit `Address`. */
  readonly publicKey: Address;
  /** Optional: sign a transaction. Generic — callers cast to specific type. */
  signTransaction?(tx: unknown): Promise<unknown>;
}

/**
 * A TEE-backed wallet with provider identification.
 *
 * Providers: "crossmint" (Intel TDX), "turnkey" (AWS Nitro), "privy" (AWS Nitro).
 */
export interface TeeWallet extends WalletLike {
  /** Provider name: "crossmint" | "turnkey" | "privy". */
  readonly provider: string;
  /**
   * API-based custody verification.
   *
   * Returns `true` if the provider API confirms this address is
   * managed by their TEE infrastructure.
   */
  verifyProviderCustody?(): Promise<boolean>;
  /**
   * Retrieve a cryptographic attestation bundle.
   *
   * Used by Turnkey provider for COSE_Sign1 boot proof + P-256 app proof.
   */
  getAttestation?(): Promise<unknown>;
}

/** Known TEE wallet providers. */
export const VALID_TEE_PROVIDERS = new Set(["crossmint", "privy", "turnkey"]);

/** Type guard to detect TEE-backed wallets. */
export function isTeeWallet(wallet: WalletLike): wallet is TeeWallet {
  return (
    "provider" in wallet &&
    typeof (wallet as Record<string, unknown>).provider === "string" &&
    VALID_TEE_PROVIDERS.has(
      (wallet as Record<string, unknown>).provider as string,
    )
  );
}

// NOTE: `AttestationResult` is imported as a type via forward-reference to
// avoid a circular import between `wallet-types.ts` and `types.ts`
// (`types.ts` imports from `wallet-types.ts` for `WalletLike`/`TeeWallet`
// in practice via `verify.ts`). `result` is optional so existing callers
// that throw without a result continue to compile during the migration.
import type { AttestationResult } from "./types.js";

/**
 * Error class for TEE attestation failures.
 *
 * Carries the full {@link AttestationResult} (when available) so structured
 * observability tooling — Sentry's `captureException`, Datadog's custom
 * error metrics — picks up `err.result.status`, `.provider`, and
 * `.metadata.verifiedAt` automatically without callsite instrumentation.
 * Prefer this over a separate `onDegraded` callback when throwing.
 */
export class TeeAttestationError extends Error {
  /**
   * The attestation result that triggered this error, when available.
   * `undefined` for subclasses thrown before a result is constructed
   * (certificate-chain parse failure, PCR mismatch on an incomplete result).
   */
  public readonly result?: AttestationResult;

  constructor(message: string, result?: AttestationResult) {
    super(message);
    this.name = "TeeAttestationError";
    this.result = result;
  }
}

/** Error class for certificate chain validation failures. */
export class AttestationCertChainError extends TeeAttestationError {
  constructor(message: string, result?: AttestationResult) {
    super(message, result);
    this.name = "AttestationCertChainError";
  }
}

/** Error class for PCR value mismatch. */
export class AttestationPcrMismatchError extends TeeAttestationError {
  readonly pcrIndex: number;
  readonly expected: string;
  readonly actual: string;

  constructor(
    pcrIndex: number,
    expected: string,
    actual: string,
    result?: AttestationResult,
  ) {
    super(
      `PCR${pcrIndex} mismatch: expected ${expected}, got ${actual}`,
      result,
    );
    this.name = "AttestationPcrMismatchError";
    this.pcrIndex = pcrIndex;
    this.expected = expected;
    this.actual = actual;
  }
}
