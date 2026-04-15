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
import { SigilTeeError } from "../errors/tee.js";
import {
  SIGIL_ERROR__TEE__ATTESTATION_FAILED,
  SIGIL_ERROR__TEE__CERT_CHAIN_INVALID,
  SIGIL_ERROR__TEE__PCR_MISMATCH,
  type SigilTeeErrorCode,
} from "../errors/codes.js";

/**
 * Error class for TEE attestation failures.
 *
 * Carries the full {@link AttestationResult} (when available) so structured
 * observability tooling — Sentry's `captureException`, Datadog's custom
 * error metrics — picks up `err.result.status`, `.provider`, and
 * `.metadata.verifiedAt` automatically without callsite instrumentation.
 * Prefer this over a separate `onDegraded` callback when throwing.
 *
 * Per UD2 (PR 2.A): rebased on `SigilTeeError`, which extends `SigilError`.
 * `instanceof TeeAttestationError` checks survive (class name + .result
 * preserved); `instanceof SigilTeeError` and `instanceof SigilError` checks
 * now also work. The two re-throw guards in `tee/providers/turnkey.ts:359`
 * and `:563` continue to work because the class identity is unchanged.
 */
export class TeeAttestationError extends SigilTeeError<SigilTeeErrorCode> {
  /**
   * The attestation result that triggered this error, when available.
   * `undefined` for subclasses thrown before a result is constructed
   * (certificate-chain parse failure, PCR mismatch on an incomplete result).
   */
  public readonly result?: AttestationResult;

  constructor(
    message: string,
    result?: AttestationResult,
    code: SigilTeeErrorCode = SIGIL_ERROR__TEE__ATTESTATION_FAILED,
    extraContext?: Record<string, unknown>,
  ) {
    // PR 2.A C1 fix (silent-failure-hunter Finding 4): subclasses must be able
    // to merge their own context fields into the typed-context map. Without
    // this, AttestationPcrMismatchError.pcrIndex/expected/actual were stored
    // as sibling instance fields only — `err.context.pcrIndex` was undefined
    // even though SigilErrorContext[SIGIL_ERROR__TEE__PCR_MISMATCH] declared
    // it required. Subclasses now pass their context-extension fields via
    // extraContext to satisfy the per-code context contract at runtime.
    super(code, message, {
      context: { result, ...(extraContext ?? {}) } as never,
    });
    this.name = "TeeAttestationError";
    this.result = result;
  }
}

/** Error class for certificate chain validation failures. */
export class AttestationCertChainError extends TeeAttestationError {
  constructor(message: string, result?: AttestationResult) {
    super(message, result, SIGIL_ERROR__TEE__CERT_CHAIN_INVALID);
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
    // PR 2.A C1 fix: pass pcrIndex/expected/actual into the typed context so
    // `err.context.pcrIndex` etc. resolve at runtime, matching the
    // SigilErrorContext[SIGIL_ERROR__TEE__PCR_MISMATCH] shape declared in
    // sdk/kit/src/errors/context.ts. Direct fields preserved for back-compat.
    super(
      `PCR${pcrIndex} mismatch: expected ${expected}, got ${actual}`,
      result,
      SIGIL_ERROR__TEE__PCR_MISMATCH,
      { pcrIndex, expected, actual },
    );
    this.name = "AttestationPcrMismatchError";
    this.pcrIndex = pcrIndex;
    this.expected = expected;
    this.actual = actual;
  }
}
