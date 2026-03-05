export { ShieldDeniedError, ShieldConfigError } from "@phalnx/core";
export type { PolicyViolation } from "@phalnx/core";

/**
 * Thrown when harden() or withVault() is called without a TEE wallet
 * and unsafeSkipTeeCheck is not set to true.
 */
export class TeeRequiredError extends Error {
  constructor() {
    super(
      "TEE wallet required. Phalnx requires a TEE-backed wallet (Crossmint, Turnkey, or Privy) " +
        "for production use. Pass a TeeWallet, set teeProvider in options, or set " +
        "unsafeSkipTeeCheck: true for devnet testing only.",
    );
    this.name = "TeeRequiredError";
  }
}

/**
 * Base error for TEE remote attestation failures.
 */
export class TeeAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeeAttestationError";
  }
}

/**
 * Thrown when the attestation certificate chain is invalid or untrusted.
 */
export class AttestationCertChainError extends TeeAttestationError {
  constructor(message: string) {
    super(message);
    this.name = "AttestationCertChainError";
  }
}

/**
 * Thrown when a PCR (Platform Configuration Register) value does not match
 * the expected measurement.
 */
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
