/**
 * x402 Error Classes — Kit-native
 *
 * Five distinct error types for x402 payment handling.
 * Each maps to a specific SDK error code (7024-7030).
 */

/** Malformed PAYMENT-REQUIRED header (code 7024). */
export class X402ParseError extends Error {
  readonly code = 7024;
  constructor(message: string) {
    super(`x402 parse error: ${message}`);
    this.name = "X402ParseError";
  }
}

/** General x402 payment failure (code 7025). */
export class X402PaymentError extends Error {
  readonly code = 7025;
  constructor(message: string) {
    super(`x402 payment error: ${message}`);
    this.name = "X402PaymentError";
  }
}

/** No compatible Solana payment option (code 7026). */
export class X402UnsupportedError extends Error {
  readonly code = 7026;
  constructor(message: string) {
    super(`x402 unsupported: ${message}`);
    this.name = "X402UnsupportedError";
  }
}

/** payTo address not in destination allowlist (code 7027). */
export class X402DestinationBlockedError extends Error {
  readonly code = 7027;
  constructor(
    public readonly payTo: string,
    message?: string,
  ) {
    super(
      message ??
        `x402 destination blocked: payTo ${payTo} is not in the allowed destinations list`,
    );
    this.name = "X402DestinationBlockedError";
  }
}

/** Duplicate payment detected within replay window (code 7028). */
export class X402ReplayError extends Error {
  readonly code = 7028;
  constructor(
    public readonly nonceKey: string,
    message?: string,
  ) {
    super(
      message ??
        `x402 replay detected: duplicate payment for nonce ${nonceKey}`,
    );
    this.name = "X402ReplayError";
  }
}
