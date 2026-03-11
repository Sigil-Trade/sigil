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

/** Type guard to detect TEE-backed wallets. */
export function isTeeWallet(wallet: WalletLike): wallet is TeeWallet {
  return (
    "provider" in wallet &&
    typeof (wallet as Record<string, unknown>).provider === "string" &&
    ((wallet as Record<string, unknown>).provider as string).length > 0
  );
}

/** Error class for TEE attestation failures. */
export class TeeAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeeAttestationError";
  }
}

/** Error class for certificate chain validation failures. */
export class AttestationCertChainError extends TeeAttestationError {
  constructor(message: string) {
    super(message);
    this.name = "AttestationCertChainError";
  }
}

/** Error class for PCR value mismatch. */
export class AttestationPcrMismatchError extends TeeAttestationError {
  readonly pcrIndex: number;
  readonly expected: string;
  readonly actual: string;

  constructor(pcrIndex: number, expected: string, actual: string) {
    super(`PCR${pcrIndex} mismatch: expected ${expected}, got ${actual}`);
    this.name = "AttestationPcrMismatchError";
    this.pcrIndex = pcrIndex;
    this.expected = expected;
    this.actual = actual;
  }
}
