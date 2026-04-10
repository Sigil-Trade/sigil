/**
 * Constraint operator enum — mirrors on-chain ConstraintOperator.
 * Originally Codama-generated, now maintained in @sigil-trade/constraints.
 */

import {
  combineCodec,
  getEnumDecoder,
  getEnumEncoder,
  type FixedSizeCodec,
  type FixedSizeDecoder,
  type FixedSizeEncoder,
} from "@solana/kit";

export enum ConstraintOperator {
  Eq,
  Ne,
  Gte,
  Lte,
  GteSigned,
  LteSigned,
  Bitmask,
}

export type ConstraintOperatorArgs = ConstraintOperator;

export function getConstraintOperatorEncoder(): FixedSizeEncoder<ConstraintOperatorArgs> {
  return getEnumEncoder(ConstraintOperator);
}

export function getConstraintOperatorDecoder(): FixedSizeDecoder<ConstraintOperator> {
  return getEnumDecoder(ConstraintOperator);
}

export function getConstraintOperatorCodec(): FixedSizeCodec<
  ConstraintOperatorArgs,
  ConstraintOperator
> {
  return combineCodec(
    getConstraintOperatorEncoder(),
    getConstraintOperatorDecoder(),
  );
}
