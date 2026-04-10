/**
 * @sigil-trade/constraints — Private constraint encoding pipeline
 *
 * This package contains Sigil's novel constraint compilation, assembly,
 * and validation logic. It is published to GitHub Packages (private,
 * org-scoped) and is NOT available on public npm.
 *
 * Consumed by:
 *   - sigil-dashboard (constraint builder UI)
 *   - @usesigil/mcp (MCP server, future)
 *   - Internal tooling
 *
 * Dependencies:
 *   - @solana/kit (public, for Address/codec types)
 */

// Wire types (encoding/decoding for Borsh serialization)
export {
  ConstraintOperator,
  type ConstraintOperatorArgs,
  getConstraintOperatorEncoder,
  getConstraintOperatorDecoder,
  getConstraintOperatorCodec,
} from "./generated/constraintOperator.js";

export {
  type DataConstraint,
  type DataConstraintArgs,
  getDataConstraintEncoder,
  getDataConstraintDecoder,
  getDataConstraintCodec,
} from "./generated/dataConstraint.js";

export {
  type AccountConstraint,
  type AccountConstraintArgs,
  getAccountConstraintEncoder,
  getAccountConstraintDecoder,
  getAccountConstraintCodec,
} from "./generated/accountConstraint.js";

export {
  type ConstraintEntry,
  type ConstraintEntryArgs,
  getConstraintEntryEncoder,
  getConstraintEntryDecoder,
  getConstraintEntryCodec,
} from "./generated/constraintEntry.js";

// Schema types
export type {
  FieldType,
  SchemaField,
  InstructionSchema,
  ProtocolSchema,
  RuleParamValue,
  ActionRule,
  CompiledConstraint,
  RuleParam,
  RuleTypeMetadata,
  ProtocolDescriptor,
} from "./types.js";

// Constraint helpers (encoding + assembly + validation)
export {
  getSchema,
  makeDiscriminatorConstraint,
  makeLteConstraint,
  makeGteConstraint,
  makeEqConstraint,
  makeNeConstraint,
  makeBitmaskConstraint,
  makeAccountConstraint,
  assembleEntries,
} from "./constraint-helpers.js";
