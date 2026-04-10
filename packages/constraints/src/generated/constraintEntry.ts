/**
 * ConstraintEntry type — program ID + data constraints + account constraints.
 * Originally Codama-generated, now maintained in @sigil-trade/constraints.
 */

import {
  combineCodec,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getArrayEncoder,
  getStructDecoder,
  getStructEncoder,
  type Address,
  type Codec,
  type Decoder,
  type Encoder,
} from "@solana/kit";
import {
  getAccountConstraintDecoder,
  getAccountConstraintEncoder,
  getDataConstraintDecoder,
  getDataConstraintEncoder,
  type AccountConstraint,
  type AccountConstraintArgs,
  type DataConstraint,
  type DataConstraintArgs,
} from "./index.js";

export type ConstraintEntry = {
  programId: Address;
  dataConstraints: Array<DataConstraint>;
  accountConstraints: Array<AccountConstraint>;
};

export type ConstraintEntryArgs = {
  programId: Address;
  dataConstraints: Array<DataConstraintArgs>;
  accountConstraints: Array<AccountConstraintArgs>;
};

export function getConstraintEntryEncoder(): Encoder<ConstraintEntryArgs> {
  return getStructEncoder([
    ["programId", getAddressEncoder()],
    ["dataConstraints", getArrayEncoder(getDataConstraintEncoder())],
    ["accountConstraints", getArrayEncoder(getAccountConstraintEncoder())],
  ]);
}

export function getConstraintEntryDecoder(): Decoder<ConstraintEntry> {
  return getStructDecoder([
    ["programId", getAddressDecoder()],
    ["dataConstraints", getArrayDecoder(getDataConstraintDecoder())],
    ["accountConstraints", getArrayDecoder(getAccountConstraintDecoder())],
  ]);
}

export function getConstraintEntryCodec(): Codec<
  ConstraintEntryArgs,
  ConstraintEntry
> {
  return combineCodec(getConstraintEntryEncoder(), getConstraintEntryDecoder());
}
