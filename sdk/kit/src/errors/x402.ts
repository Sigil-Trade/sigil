/**
 * SigilX402Error — domain class for HTTP 402 payment errors.
 *
 * Leaf classes (`X402ParseError`, `X402PaymentError`, `X402UnsupportedError`,
 * `X402DestinationBlockedError`, `X402ReplayError`) extend this and live in
 * `src/x402/errors.ts`. They are NOT defined here.
 *
 * Step 7 re-homes the leaves and migrates `.code` from numeric literals
 * (7024-7028) to canonical SigilErrorCode strings, preserving the numeric
 * values via `.legacyNumericCode` getter for one-minor migration ramp.
 *
 * The `instanceof X402ParseError` re-throw guard in `src/x402/codec.ts:87`
 * continues to work — leaf class name preserved.
 */

import { SigilError } from "./base.js";
import type { SigilX402ErrorCode } from "./codes.js";

export class SigilX402Error<
  TCode extends SigilX402ErrorCode = SigilX402ErrorCode,
> extends SigilError<TCode> {
  override name: string = "SigilX402Error";
}
