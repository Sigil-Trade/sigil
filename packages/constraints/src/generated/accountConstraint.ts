/**
 * AccountConstraint type — account index + expected pubkey.
 * Originally Codama-generated, now maintained in @sigil-trade/constraints.
 */

import {
  combineCodec,
  getAddressDecoder,
  getAddressEncoder,
  getStructDecoder,
  getStructEncoder,
  getU8Decoder,
  getU8Encoder,
  type Address,
  type FixedSizeCodec,
  type FixedSizeDecoder,
  type FixedSizeEncoder,
} from "@solana/kit";

export type AccountConstraint = { index: number; expected: Address };

export type AccountConstraintArgs = AccountConstraint;

export function getAccountConstraintEncoder(): FixedSizeEncoder<AccountConstraintArgs> {
  return getStructEncoder([
    ["index", getU8Encoder()],
    ["expected", getAddressEncoder()],
  ]);
}

export function getAccountConstraintDecoder(): FixedSizeDecoder<AccountConstraint> {
  return getStructDecoder([
    ["index", getU8Decoder()],
    ["expected", getAddressDecoder()],
  ]);
}

export function getAccountConstraintCodec(): FixedSizeCodec<
  AccountConstraintArgs,
  AccountConstraint
> {
  return combineCodec(
    getAccountConstraintEncoder(),
    getAccountConstraintDecoder(),
  );
}
