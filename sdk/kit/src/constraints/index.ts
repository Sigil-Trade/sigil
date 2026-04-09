// Constraint Builder — public API surface
// Consumed by dashboard via @usesigil/kit/constraints subpath export

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
} from "./protocols/constraint-helpers.js";
