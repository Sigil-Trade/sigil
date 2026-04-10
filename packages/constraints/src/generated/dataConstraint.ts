/**
 * DataConstraint type — byte offset + operator + value.
 * Originally Codama-generated, now maintained in @sigil-trade/constraints.
 */

import {
  addDecoderSizePrefix,
  addEncoderSizePrefix,
  combineCodec,
  getBytesDecoder,
  getBytesEncoder,
  getStructDecoder,
  getStructEncoder,
  getU16Decoder,
  getU16Encoder,
  getU32Decoder,
  getU32Encoder,
  type Codec,
  type Decoder,
  type Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  getConstraintOperatorDecoder,
  getConstraintOperatorEncoder,
  type ConstraintOperator,
  type ConstraintOperatorArgs,
} from "./constraintOperator.js";

export type DataConstraint = {
  offset: number;
  operator: ConstraintOperator;
  value: ReadonlyUint8Array;
};

export type DataConstraintArgs = {
  offset: number;
  operator: ConstraintOperatorArgs;
  value: ReadonlyUint8Array;
};

export function getDataConstraintEncoder(): Encoder<DataConstraintArgs> {
  return getStructEncoder([
    ["offset", getU16Encoder()],
    ["operator", getConstraintOperatorEncoder()],
    ["value", addEncoderSizePrefix(getBytesEncoder(), getU32Encoder())],
  ]);
}

export function getDataConstraintDecoder(): Decoder<DataConstraint> {
  return getStructDecoder([
    ["offset", getU16Decoder()],
    ["operator", getConstraintOperatorDecoder()],
    ["value", addDecoderSizePrefix(getBytesDecoder(), getU32Decoder())],
  ]);
}

export function getDataConstraintCodec(): Codec<
  DataConstraintArgs,
  DataConstraint
> {
  return combineCodec(getDataConstraintEncoder(), getDataConstraintDecoder());
}
