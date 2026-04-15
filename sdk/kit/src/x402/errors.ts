/**
 * x402 Error Classes — Kit-native
 *
 * Five distinct error types for x402 payment handling.
 *
 * PR 2.A: Re-homed under SigilX402Error per UD1 (Architect's recommendation —
 * single canonical .code). The historical numeric codes (7024-7028) are
 * preserved as `.legacyNumericCode` getters for one-minor migration ramp;
 * deletion targeted at v1.0. New typed discrimination uses the SigilErrorCode
 * string-literal `.code` field on the SigilError base.
 *
 * The `instanceof X402ParseError` re-throw guard at src/x402/codec.ts:87
 * continues to work because class identity is unchanged.
 */

import { SigilX402Error } from "../errors/x402.js";
import {
  SIGIL_ERROR__X402__HEADER_MALFORMED,
  SIGIL_ERROR__X402__PAYMENT_FAILED,
  SIGIL_ERROR__X402__UNSUPPORTED,
  SIGIL_ERROR__X402__DESTINATION_BLOCKED,
  SIGIL_ERROR__X402__REPLAY,
} from "../errors/codes.js";

/** Malformed PAYMENT-REQUIRED header. Legacy numeric code: 7024. */
export class X402ParseError extends SigilX402Error<
  typeof SIGIL_ERROR__X402__HEADER_MALFORMED
> {
  /** @deprecated Use `err.code === SIGIL_ERROR__X402__HEADER_MALFORMED`. Removed at v1.0. */
  readonly legacyNumericCode = 7024 as const;
  constructor(message: string) {
    super(SIGIL_ERROR__X402__HEADER_MALFORMED, `x402 parse error: ${message}`, {
      context: { legacyNumericCode: 7024 },
    });
    this.name = "X402ParseError";
  }
}

/** General x402 payment failure. Legacy numeric code: 7025. */
export class X402PaymentError extends SigilX402Error<
  typeof SIGIL_ERROR__X402__PAYMENT_FAILED
> {
  /** @deprecated Use `err.code === SIGIL_ERROR__X402__PAYMENT_FAILED`. Removed at v1.0. */
  readonly legacyNumericCode = 7025 as const;
  constructor(message: string) {
    super(SIGIL_ERROR__X402__PAYMENT_FAILED, `x402 payment error: ${message}`, {
      context: { legacyNumericCode: 7025 },
    });
    this.name = "X402PaymentError";
  }
}

/** No compatible Solana payment option. Legacy numeric code: 7026. */
export class X402UnsupportedError extends SigilX402Error<
  typeof SIGIL_ERROR__X402__UNSUPPORTED
> {
  /** @deprecated Use `err.code === SIGIL_ERROR__X402__UNSUPPORTED`. Removed at v1.0. */
  readonly legacyNumericCode = 7026 as const;
  constructor(message: string) {
    super(SIGIL_ERROR__X402__UNSUPPORTED, `x402 unsupported: ${message}`, {
      context: { legacyNumericCode: 7026 },
    });
    this.name = "X402UnsupportedError";
  }
}

/** payTo address not in destination allowlist. Legacy numeric code: 7027. */
export class X402DestinationBlockedError extends SigilX402Error<
  typeof SIGIL_ERROR__X402__DESTINATION_BLOCKED
> {
  /** @deprecated Use `err.code === SIGIL_ERROR__X402__DESTINATION_BLOCKED`. Removed at v1.0. */
  readonly legacyNumericCode = 7027 as const;
  constructor(
    public readonly payTo: string,
    message?: string,
  ) {
    super(
      SIGIL_ERROR__X402__DESTINATION_BLOCKED,
      message ??
        `x402 destination blocked: payTo ${payTo} is not in the allowed destinations list`,
      { context: { payTo, legacyNumericCode: 7027 } },
    );
    this.name = "X402DestinationBlockedError";
  }
}

/** Duplicate payment detected within replay window. Legacy numeric code: 7028. */
export class X402ReplayError extends SigilX402Error<
  typeof SIGIL_ERROR__X402__REPLAY
> {
  /** @deprecated Use `err.code === SIGIL_ERROR__X402__REPLAY`. Removed at v1.0. */
  readonly legacyNumericCode = 7028 as const;
  constructor(
    public readonly nonceKey: string,
    message?: string,
  ) {
    super(
      SIGIL_ERROR__X402__REPLAY,
      message ??
        `x402 replay detected: duplicate payment for nonce ${nonceKey}`,
      { context: { nonceKey, legacyNumericCode: 7028 } },
    );
    this.name = "X402ReplayError";
  }
}
