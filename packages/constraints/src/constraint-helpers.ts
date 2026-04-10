/**
 * Constraint Builder Helpers
 *
 * Functions for constructing constraint entries from protocol schemas.
 * Generated {proto}-descriptor.ts files import from "./constraint-helpers.js".
 *
 * Reuses Codama-generated types — does NOT redeclare ConstraintOperator,
 * DataConstraintArgs, AccountConstraintArgs, or ConstraintEntryArgs.
 */

import type { Address, ReadonlyUint8Array } from "@solana/kit";
import {
  ConstraintOperator,
  type DataConstraintArgs,
  type AccountConstraintArgs,
  type ConstraintEntryArgs,
} from "./generated/index.js";
import type {
  ProtocolSchema,
  InstructionSchema,
  CompiledConstraint,
  FieldType,
} from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────
// MUST stay in sync with programs/sigil/src/state/constraints.rs lines 5-8.
// If those Rust constants change, update these AND update the on-chain program.

const MAX_DATA_CONSTRAINTS_PER_ENTRY = 8; // Rust: MAX_DATA_CONSTRAINTS_PER_ENTRY
const MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY = 5; // Rust: MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY
const MAX_CONSTRAINT_ENTRIES = 64; // Rust: MAX_CONSTRAINT_ENTRIES
const MAX_VALUE_BYTES = 32; // Rust: MAX_CONSTRAINT_VALUE_LEN

// ─── Field Range Validation ─────────────────────────────────────────────────

const FIELD_RANGES: Partial<Record<FieldType, [bigint, bigint]>> = {
  u8: [0n, 255n],
  i8: [-128n, 127n],
  bool: [0n, 1n],
  u16: [0n, 65535n],
  i16: [-32768n, 32767n],
  u32: [0n, 4294967295n],
  i32: [-2147483648n, 2147483647n],
  u64: [0n, (1n << 64n) - 1n],
  i64: [-(1n << 63n), (1n << 63n) - 1n],
  u128: [0n, (1n << 128n) - 1n],
  i128: [-(1n << 127n), (1n << 127n) - 1n],
};

function isSignedType(type: FieldType): boolean {
  return (
    type === "i8" ||
    type === "i16" ||
    type === "i32" ||
    type === "i64" ||
    type === "i128"
  );
}

// ─── Value Encoding ─────────────────────────────────────────────────────────

/**
 * Encode a numeric value as little-endian bytes of the given byte width.
 * Throws on overflow (value exceeds unsigned range) or underflow (negative
 * value exceeds signed range). Supports BigInt for u128/i128.
 */
function encodeValue(
  value: bigint | number,
  byteWidth: number,
): ReadonlyUint8Array {
  // Reject NaN, floats, and out-of-range widths.
  // NaN comparisons return false so the < / > checks alone wouldn't catch it.
  if (
    !Number.isInteger(byteWidth) ||
    byteWidth < 1 ||
    byteWidth > MAX_VALUE_BYTES
  ) {
    throw new Error(
      `Value byte width must be an integer 1-${MAX_VALUE_BYTES}, got ${byteWidth}`,
    );
  }

  const val = typeof value === "number" ? BigInt(value) : value;

  // Two's complement for negative values — validate range first
  let unsigned: bigint;
  if (val < 0n) {
    const min = -(1n << BigInt(byteWidth * 8 - 1));
    if (val < min) {
      throw new Error(
        `Signed value ${val} underflows ${byteWidth}-byte range (min: ${min})`,
      );
    }
    unsigned = (1n << BigInt(byteWidth * 8)) + val;
  } else {
    unsigned = val;
  }

  const bytes = new Uint8Array(byteWidth);
  let remaining = unsigned;
  for (let i = 0; i < byteWidth; i++) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  // Overflow check: high bits were truncated
  if (remaining !== 0n) {
    const max = (1n << BigInt(byteWidth * 8)) - 1n;
    throw new Error(
      `Value ${val} overflows ${byteWidth}-byte unsigned range (max: ${max})`,
    );
  }

  return bytes;
}

// ─── Schema Lookup ──────────────────────────────────────────────────────────

/**
 * Look up an instruction schema by action name.
 * Throws if the action is not found in the protocol schema.
 */
export function getSchema(
  schema: ProtocolSchema,
  action: string,
): InstructionSchema {
  const ix = schema.instructions.get(action);
  if (!ix) {
    throw new Error(
      `Unknown action "${action}" in protocol "${schema.protocolId}". ` +
        `Available: ${[...schema.instructions.keys()].join(", ")}`,
    );
  }
  return ix;
}

// ─── Constraint Factories ───────────────────────────────────────────────────

/**
 * Create a discriminator constraint (exact match at offset 0).
 * Validates that the discriminator is exactly 8 bytes (Anchor standard).
 */
export function makeDiscriminatorConstraint(
  discriminator: Uint8Array,
): DataConstraintArgs {
  if (discriminator.length === 0) {
    throw new Error("Discriminator cannot be empty");
  }
  if (discriminator.length !== 8) {
    throw new Error(
      `Expected 8-byte Anchor discriminator, got ${discriminator.length} bytes`,
    );
  }
  // Match on-chain A5 invariant (constraints.rs:144): reject all-zero discriminators
  if (discriminator.every((b) => b === 0)) {
    throw new Error(
      "Discriminator cannot be all zeros — on-chain A5 invariant rejects this",
    );
  }
  return {
    offset: 0,
    operator: ConstraintOperator.Eq,
    value: discriminator,
  };
}

/**
 * Look up a field in the schema and create a data constraint with the
 * appropriate operator. Automatically selects signed operators for i-types.
 * Validates value range against field type and rejects nonsensical operators.
 */
function makeFieldConstraint(
  schema: InstructionSchema,
  fieldName: string,
  value: bigint | number,
  unsignedOp: ConstraintOperator,
  signedOp: ConstraintOperator,
): DataConstraintArgs {
  const field = schema.fields.find((f) => f.name === fieldName);
  if (!field) {
    throw new Error(
      `Unknown field "${fieldName}" in instruction "${schema.name}". ` +
        `Available: ${schema.fields.map((f) => f.name).join(", ")}`,
    );
  }

  // Defensive: schema offsets and sizes should always be valid integers,
  // but validate to catch corrupted schemas (NaN passes < 0 check via IEEE-754).
  if (!Number.isInteger(field.offset) || field.offset < 0) {
    throw new Error(`Field "${fieldName}" has invalid offset ${field.offset}`);
  }
  if (!Number.isInteger(field.size) || field.size < 1) {
    throw new Error(`Field "${fieldName}" has invalid size ${field.size}`);
  }

  // Reject nonsensical operators on bool and pubkey fields
  if (
    field.type === "bool" &&
    unsignedOp !== ConstraintOperator.Eq &&
    unsignedOp !== ConstraintOperator.Ne
  ) {
    throw new Error(
      `Boolean field "${fieldName}" only supports Eq/Ne operators, not comparison operators`,
    );
  }
  if (field.type === "pubkey") {
    throw new Error(
      `Pubkey field "${fieldName}" should use makeAccountConstraint, not numeric comparison`,
    );
  }

  // Validate value range against field type
  const val = typeof value === "number" ? BigInt(value) : value;
  const range = FIELD_RANGES[field.type];
  if (range && (val < range[0] || val > range[1])) {
    throw new Error(
      `Value ${val} out of range for ${field.type} field "${fieldName}" (${range[0]} to ${range[1]})`,
    );
  }

  const operator = isSignedType(field.type) ? signedOp : unsignedOp;
  const encoded = encodeValue(value, field.size);

  return {
    offset: field.offset,
    operator,
    value: encoded,
  };
}

/**
 * Create a less-than-or-equal constraint on a schema field.
 * Auto-selects LteSigned for i-type fields.
 */
export function makeLteConstraint(
  schema: InstructionSchema,
  fieldName: string,
  maxValue: bigint,
): DataConstraintArgs {
  return makeFieldConstraint(
    schema,
    fieldName,
    maxValue,
    ConstraintOperator.Lte,
    ConstraintOperator.LteSigned,
  );
}

/**
 * Create a greater-than-or-equal constraint on a schema field.
 * Auto-selects GteSigned for i-type fields.
 */
export function makeGteConstraint(
  schema: InstructionSchema,
  fieldName: string,
  minValue: bigint,
): DataConstraintArgs {
  return makeFieldConstraint(
    schema,
    fieldName,
    minValue,
    ConstraintOperator.Gte,
    ConstraintOperator.GteSigned,
  );
}

/**
 * Create an exact-match constraint on a schema field.
 */
export function makeEqConstraint(
  schema: InstructionSchema,
  fieldName: string,
  value: bigint | number,
): DataConstraintArgs {
  return makeFieldConstraint(
    schema,
    fieldName,
    value,
    ConstraintOperator.Eq,
    ConstraintOperator.Eq,
  );
}

/**
 * Create a not-equal constraint on a schema field.
 * Useful for blocklisting specific values (e.g., "leverage must not be 0").
 */
export function makeNeConstraint(
  schema: InstructionSchema,
  fieldName: string,
  value: bigint | number,
): DataConstraintArgs {
  return makeFieldConstraint(
    schema,
    fieldName,
    value,
    ConstraintOperator.Ne,
    ConstraintOperator.Ne,
  );
}

/**
 * Create a bitmask constraint on a schema field.
 * On-chain semantics: (actual & mask) == mask — all bits set in mask must be set in actual.
 * Useful for permission flag fields where specific bits must be enabled.
 */
export function makeBitmaskConstraint(
  schema: InstructionSchema,
  fieldName: string,
  mask: bigint | number,
): DataConstraintArgs {
  const field = schema.fields.find((f) => f.name === fieldName);
  if (!field) {
    throw new Error(
      `Unknown field "${fieldName}" in instruction "${schema.name}". ` +
        `Available: ${schema.fields.map((f) => f.name).join(", ")}`,
    );
  }
  if (!Number.isInteger(field.offset) || field.offset < 0) {
    throw new Error(`Field "${fieldName}" has invalid offset ${field.offset}`);
  }
  if (!Number.isInteger(field.size) || field.size < 1) {
    throw new Error(`Field "${fieldName}" has invalid size ${field.size}`);
  }
  if (field.type === "pubkey" || field.type === "bool") {
    throw new Error(
      `Bitmask constraint only valid on integer fields, not ${field.type}`,
    );
  }
  // Bitmask is always unsigned — it operates on raw bits
  const val = typeof mask === "number" ? BigInt(mask) : mask;
  if (val < 0n) {
    throw new Error(`Bitmask value must be non-negative, got ${val}`);
  }
  // Reject mask of 0 — `(actual & 0) == 0` is always true on-chain,
  // making this a no-op constraint that matches every instruction.
  // This is a security-relevant silent failure — caller probably meant
  // makeEqConstraint(schema, field, 0) to require the field equal zero.
  if (val === 0n) {
    throw new Error(
      `Bitmask value of 0 is a no-op (matches every instruction). ` +
        `Use makeEqConstraint with value 0 to require field "${fieldName}" equal 0.`,
    );
  }
  const range = FIELD_RANGES[field.type];
  if (range && val > range[1]) {
    throw new Error(
      `Bitmask ${val} exceeds ${field.type} range (max: ${range[1]})`,
    );
  }
  return {
    offset: field.offset,
    operator: ConstraintOperator.Bitmask,
    value: encodeValue(val, field.size),
  };
}

/**
 * Create an account constraint requiring a specific pubkey at a given index.
 */
export function makeAccountConstraint(
  expected: Address,
  index: number,
): AccountConstraintArgs {
  return { index, expected };
}

// ─── Assembly Bridge ────────────────────────────────────────────────────────

/**
 * Bridge from CompiledConstraint[] (descriptor output) to
 * ConstraintEntryArgs[] (OwnerClient.createConstraints input).
 *
 * Each CompiledConstraint becomes one ConstraintEntryArgs with the
 * given programAddress. Validation:
 * - Per-entry size limits (data ≤ 8, account ≤ 5)
 * - Total entry count ≤ MAX_CONSTRAINT_ENTRIES
 * - Non-empty entries
 * - No duplicate offsets within data constraints (prevents always-fails entries)
 * - No duplicate indices within account constraints
 * - First data constraint must match the declared discriminator (prevents
 *   privilege escalation if a descriptor author forgets the disc constraint)
 *
 * Returns a defensively-cloned array — caller mutations to the input do not
 * affect the returned entries.
 */
export function assembleEntries(
  programAddress: Address,
  compiledRules: CompiledConstraint[],
): ConstraintEntryArgs[] {
  if (compiledRules.length > MAX_CONSTRAINT_ENTRIES) {
    throw new Error(
      `Too many constraint entries: ${compiledRules.length} exceeds max ${MAX_CONSTRAINT_ENTRIES}`,
    );
  }

  return compiledRules.map((compiled, i) => {
    // Fix A5: every entry must have at least one data constraint, and
    // the first must be the discriminator anchor (enforced below). An
    // entry with empty dataConstraints would match ANY instruction on
    // the program_id — privilege escalation via account-layout
    // conflation. Supersedes the older "at least one of data OR
    // account" rule. See docs/SECURITY-FINDINGS-2026-04-07.md Finding 1.
    if (compiled.dataConstraints.length === 0) {
      throw new Error(
        `Entry ${i}: must have at least one data constraint ` +
          `(the discriminator anchor). Use ` +
          `makeDiscriminatorConstraint(compiled.discriminator) ` +
          `as the first entry.`,
      );
    }
    if (compiled.dataConstraints.length > MAX_DATA_CONSTRAINTS_PER_ENTRY) {
      throw new Error(
        `Entry ${i}: ${compiled.dataConstraints.length} data constraints exceeds max ${MAX_DATA_CONSTRAINTS_PER_ENTRY}`,
      );
    }
    if (
      compiled.accountConstraints.length > MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY
    ) {
      throw new Error(
        `Entry ${i}: ${compiled.accountConstraints.length} account constraints exceeds max ${MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY}`,
      );
    }

    // Reject duplicate offsets — two constraints at the same offset are
    // always-fails (only one byte sequence can match both).
    const dcOffsets = new Set<number>();
    for (const dc of compiled.dataConstraints) {
      if (dcOffsets.has(dc.offset)) {
        throw new Error(
          `Entry ${i}: duplicate data constraint at offset ${dc.offset} ` +
            `(an entry with two constraints at the same offset is always-fails — ` +
            `split into separate entries if you want OR semantics)`,
        );
      }
      dcOffsets.add(dc.offset);
    }
    const acIndices = new Set<number>();
    for (const ac of compiled.accountConstraints) {
      if (acIndices.has(ac.index)) {
        throw new Error(
          `Entry ${i}: duplicate account constraint at index ${ac.index}`,
        );
      }
      acIndices.add(ac.index);
    }

    // Enforce discriminator invariant: dataConstraints[0] must match the
    // declared discriminator. Without this, a descriptor author who
    // forgets to include the discriminator constraint produces an entry
    // that matches ANY instruction with the same program_id — privilege
    // escalation. After Fix A5 this check always runs because empty
    // dataConstraints is rejected earlier.
    {
      const first = compiled.dataConstraints[0];
      const expected = compiled.discriminator;
      const actual = first.value;
      let match =
        first.offset === 0 &&
        first.operator === ConstraintOperator.Eq &&
        actual.length === expected.length;
      if (match) {
        for (let k = 0; k < expected.length; k++) {
          if (actual[k] !== expected[k]) {
            match = false;
            break;
          }
        }
      }
      if (!match) {
        throw new Error(
          `Entry ${i}: dataConstraints[0] must be the discriminator Eq constraint ` +
            `at offset 0 matching compiled.discriminator. ` +
            `Use makeDiscriminatorConstraint(compiled.discriminator) as the first entry.`,
        );
      }
    }

    // Defensive shallow clone — caller mutations to compiled.dataConstraints
    // / compiled.accountConstraints after this call must not affect the
    // returned entries (the validation above operated on a snapshot).
    return {
      programId: programAddress,
      dataConstraints: [...compiled.dataConstraints],
      accountConstraints: [...compiled.accountConstraints],
    };
  });
}
