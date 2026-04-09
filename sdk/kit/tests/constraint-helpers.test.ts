/**
 * Tests for constraint-helpers.ts — value encoding, operator selection,
 * range validation, and assembly bridge.
 *
 * Critical coverage: encodeValue() overflow/underflow protection
 * (the fix for audit findings C1 + C2). These tests prevent silent
 * regression to wrong on-chain constraints.
 */

import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  ConstraintOperator,
  type DataConstraintArgs,
} from "../src/generated/index.js";
import {
  getSchema,
  makeDiscriminatorConstraint,
  makeLteConstraint,
  makeGteConstraint,
  makeEqConstraint,
  makeNeConstraint,
  makeBitmaskConstraint,
  makeAccountConstraint,
  assembleEntries,
} from "../src/constraints/protocols/constraint-helpers.js";
import type {
  ProtocolSchema,
  InstructionSchema,
  CompiledConstraint,
} from "../src/constraints/types.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TEST_PROGRAM = "11111111111111111111111111111111" as Address;
const TEST_DISC = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function makeTestSchema(): InstructionSchema {
  return {
    name: "openPosition",
    discriminator: TEST_DISC,
    fields: [
      { name: "amountU8", offset: 8, type: "u8", size: 1 },
      { name: "amountU16", offset: 9, type: "u16", size: 2 },
      { name: "amountU32", offset: 11, type: "u32", size: 4 },
      { name: "amountU64", offset: 15, type: "u64", size: 8 },
      { name: "amountU128", offset: 23, type: "u128", size: 16 },
      { name: "amountI8", offset: 39, type: "i8", size: 1 },
      { name: "amountI16", offset: 40, type: "i16", size: 2 },
      { name: "amountI64", offset: 42, type: "i64", size: 8 },
      { name: "amountI128", offset: 50, type: "i128", size: 16 },
      { name: "isActive", offset: 66, type: "bool", size: 1 },
      { name: "owner", offset: 67, type: "pubkey", size: 32 },
      { name: "permissions", offset: 99, type: "u32", size: 4 },
    ],
    accounts: { vault: 0, market: 1, custody: 2 },
    dataSize: 103,
  };
}

function makeTestProtocolSchema(): ProtocolSchema {
  return {
    protocolId: "test-protocol",
    programAddress: TEST_PROGRAM,
    instructions: new Map([["openPosition", makeTestSchema()]]),
  };
}

// ─── makeDiscriminatorConstraint ────────────────────────────────────────────

describe("makeDiscriminatorConstraint", () => {
  it("creates Eq constraint at offset 0 with discriminator bytes", () => {
    const c = makeDiscriminatorConstraint(TEST_DISC);
    expect(c.offset).to.equal(0);
    expect(c.operator).to.equal(ConstraintOperator.Eq);
    expect(c.value).to.deep.equal(TEST_DISC);
  });

  it("rejects empty discriminator", () => {
    expect(() => makeDiscriminatorConstraint(new Uint8Array(0))).to.throw(
      "cannot be empty",
    );
  });

  it("rejects 4-byte truncated discriminator", () => {
    expect(() =>
      makeDiscriminatorConstraint(new Uint8Array([1, 2, 3, 4])),
    ).to.throw("Expected 8-byte");
  });

  it("rejects 7-byte off-by-one short discriminator", () => {
    expect(() => makeDiscriminatorConstraint(new Uint8Array(7))).to.throw(
      "Expected 8-byte",
    );
  });

  it("rejects 9-byte off-by-one long discriminator", () => {
    expect(() => makeDiscriminatorConstraint(new Uint8Array(9))).to.throw(
      "Expected 8-byte",
    );
  });

  it("rejects 16-byte oversized discriminator", () => {
    expect(() => makeDiscriminatorConstraint(new Uint8Array(16))).to.throw(
      "Expected 8-byte",
    );
  });
});

// ─── encodeValue (via makeLteConstraint) — VALID encoding ───────────────────

describe("encodeValue (via makeLteConstraint) — valid encodings", () => {
  const schema = makeTestSchema();

  it("encodes $500 USD (500_000_000) as u64 LE", () => {
    const c = makeLteConstraint(schema, "amountU64", 500_000_000n);
    expect([...c.value]).to.deep.equal([
      0x00, 0x65, 0xcd, 0x1d, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(c.offset).to.equal(15);
    expect(c.operator).to.equal(ConstraintOperator.Lte);
  });

  it("encodes 0 as u8", () => {
    const c = makeLteConstraint(schema, "amountU8", 0n);
    expect([...c.value]).to.deep.equal([0x00]);
  });

  it("encodes 255 as u8 (max)", () => {
    const c = makeLteConstraint(schema, "amountU8", 255n);
    expect([...c.value]).to.deep.equal([0xff]);
  });

  it("encodes max u64 (2^64 - 1) as 8 bytes of 0xff", () => {
    const c = makeLteConstraint(schema, "amountU64", 2n ** 64n - 1n);
    expect([...c.value]).to.deep.equal(Array(8).fill(0xff));
  });

  it("encodes 1e18 as u128 LE", () => {
    const c = makeLteConstraint(
      schema,
      "amountU128",
      1_000_000_000_000_000_000n,
    );
    expect([...c.value]).to.deep.equal([
      0x00, 0x00, 0x64, 0xa7, 0xb3, 0xb6, 0xe0, 0x0d, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
  });

  it("encodes -1 as i64 (all 0xff two's complement)", () => {
    const c = makeGteConstraint(schema, "amountI64", -1n);
    expect([...c.value]).to.deep.equal(Array(8).fill(0xff));
    expect(c.operator).to.equal(ConstraintOperator.GteSigned);
  });

  it("encodes -128 as i8 (0x80, the minimum)", () => {
    const c = makeGteConstraint(schema, "amountI8", -128n);
    expect([...c.value]).to.deep.equal([0x80]);
  });

  it("encodes 127 as i8 (0x7f, the maximum)", () => {
    const c = makeLteConstraint(schema, "amountI8", 127n);
    expect([...c.value]).to.deep.equal([0x7f]);
  });
});

// ─── encodeValue — OVERFLOW/UNDERFLOW protection (audit C1 + C2) ────────────

describe("encodeValue — overflow/underflow protection", () => {
  const schema = makeTestSchema();

  it("throws on u8 overflow (256)", () => {
    expect(() => makeLteConstraint(schema, "amountU8", 256n)).to.throw(
      /out of range/,
    );
  });

  it("throws on u8 overflow (1000)", () => {
    expect(() => makeLteConstraint(schema, "amountU8", 1000n)).to.throw(
      /out of range/,
    );
  });

  it("throws on u16 overflow (65536)", () => {
    expect(() => makeLteConstraint(schema, "amountU16", 65536n)).to.throw(
      /out of range/,
    );
  });

  it("throws on u32 overflow (2^32)", () => {
    expect(() => makeLteConstraint(schema, "amountU32", 2n ** 32n)).to.throw(
      /out of range/,
    );
  });

  it("throws on u64 overflow (2^64)", () => {
    expect(() => makeLteConstraint(schema, "amountU64", 2n ** 64n)).to.throw(
      /out of range/,
    );
  });

  it("throws on i8 underflow (-129)", () => {
    expect(() => makeGteConstraint(schema, "amountI8", -129n)).to.throw(
      /out of range/,
    );
  });

  it("throws on i8 overflow (128)", () => {
    expect(() => makeLteConstraint(schema, "amountI8", 128n)).to.throw(
      /out of range/,
    );
  });

  it("throws on i64 underflow (-2^63 - 1)", () => {
    expect(() =>
      makeGteConstraint(schema, "amountI64", -(2n ** 63n) - 1n),
    ).to.throw(/out of range/);
  });

  it("throws on negative value in unsigned field", () => {
    expect(() => makeLteConstraint(schema, "amountU64", -1n)).to.throw(
      /out of range/,
    );
  });
});

// ─── Signed operator auto-selection ─────────────────────────────────────────

describe("signed operator auto-selection", () => {
  const schema = makeTestSchema();

  it("uses Lte for unsigned u64", () => {
    const c = makeLteConstraint(schema, "amountU64", 100n);
    expect(c.operator).to.equal(ConstraintOperator.Lte);
  });

  it("uses LteSigned for i8", () => {
    const c = makeLteConstraint(schema, "amountI8", 50n);
    expect(c.operator).to.equal(ConstraintOperator.LteSigned);
  });

  it("uses LteSigned for i16", () => {
    const c = makeLteConstraint(schema, "amountI16", 1000n);
    expect(c.operator).to.equal(ConstraintOperator.LteSigned);
  });

  it("uses LteSigned for i64", () => {
    const c = makeLteConstraint(schema, "amountI64", 1000n);
    expect(c.operator).to.equal(ConstraintOperator.LteSigned);
  });

  it("uses LteSigned for i128", () => {
    const c = makeLteConstraint(schema, "amountI128", 1000n);
    expect(c.operator).to.equal(ConstraintOperator.LteSigned);
  });

  it("uses Gte for unsigned u64", () => {
    const c = makeGteConstraint(schema, "amountU64", 100n);
    expect(c.operator).to.equal(ConstraintOperator.Gte);
  });

  it("uses GteSigned for i64", () => {
    const c = makeGteConstraint(schema, "amountI64", 100n);
    expect(c.operator).to.equal(ConstraintOperator.GteSigned);
  });

  it("uses Eq for both signed and unsigned (signedness-agnostic)", () => {
    const cu = makeEqConstraint(schema, "amountU64", 100n);
    const ci = makeEqConstraint(schema, "amountI64", 100n);
    expect(cu.operator).to.equal(ConstraintOperator.Eq);
    expect(ci.operator).to.equal(ConstraintOperator.Eq);
  });
});

// ─── Operator rejection on bool/pubkey ──────────────────────────────────────

describe("operator rejection on bool/pubkey", () => {
  const schema = makeTestSchema();

  it("rejects Lte on bool field", () => {
    expect(() => makeLteConstraint(schema, "isActive", 1n)).to.throw(
      /Boolean field/,
    );
  });

  it("rejects Gte on bool field", () => {
    expect(() => makeGteConstraint(schema, "isActive", 1n)).to.throw(
      /Boolean field/,
    );
  });

  it("allows Eq on bool field", () => {
    const c = makeEqConstraint(schema, "isActive", 1n);
    expect(c.operator).to.equal(ConstraintOperator.Eq);
  });

  it("allows Ne on bool field", () => {
    const c = makeNeConstraint(schema, "isActive", 0n);
    expect(c.operator).to.equal(ConstraintOperator.Ne);
  });

  it("rejects Lte on pubkey field", () => {
    expect(() => makeLteConstraint(schema, "owner", 0n)).to.throw(
      /Pubkey field/,
    );
  });

  it("rejects Eq on pubkey field (use makeAccountConstraint)", () => {
    expect(() => makeEqConstraint(schema, "owner", 0n)).to.throw(
      /Pubkey field/,
    );
  });
});

// ─── makeFieldConstraint — schema lookup ────────────────────────────────────

describe("makeFieldConstraint — schema lookup", () => {
  const schema = makeTestSchema();

  it("throws on unknown field name", () => {
    expect(() => makeLteConstraint(schema, "nonexistent", 100n)).to.throw(
      /Unknown field/,
    );
  });

  it("error lists available fields", () => {
    expect(() => makeLteConstraint(schema, "nonexistent", 100n)).to.throw(
      /amountU64/,
    );
  });

  it("rejects negative offset (defensive)", () => {
    const badSchema: InstructionSchema = {
      ...schema,
      fields: [{ name: "broken", offset: -1, type: "u8", size: 1 }],
    };
    expect(() => makeLteConstraint(badSchema, "broken", 100n)).to.throw(
      /invalid offset/,
    );
  });
});

// ─── makeNeConstraint ───────────────────────────────────────────────────────

describe("makeNeConstraint", () => {
  const schema = makeTestSchema();

  it("creates Ne constraint with correct value", () => {
    const c = makeNeConstraint(schema, "amountU64", 0n);
    expect(c.operator).to.equal(ConstraintOperator.Ne);
    expect(c.offset).to.equal(15);
    expect([...c.value]).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("uses Ne for both signed and unsigned (no signed variant)", () => {
    const cu = makeNeConstraint(schema, "amountU64", 100n);
    const ci = makeNeConstraint(schema, "amountI64", 100n);
    expect(cu.operator).to.equal(ConstraintOperator.Ne);
    expect(ci.operator).to.equal(ConstraintOperator.Ne);
  });
});

// ─── makeBitmaskConstraint ──────────────────────────────────────────────────

describe("makeBitmaskConstraint", () => {
  const schema = makeTestSchema();

  it("creates Bitmask constraint with mask bytes", () => {
    const c = makeBitmaskConstraint(schema, "permissions", 0b1010);
    expect(c.operator).to.equal(ConstraintOperator.Bitmask);
    expect(c.offset).to.equal(99);
    expect([...c.value]).to.deep.equal([0x0a, 0x00, 0x00, 0x00]);
  });

  it("rejects negative mask", () => {
    expect(() => makeBitmaskConstraint(schema, "permissions", -1n)).to.throw(
      /non-negative/,
    );
  });

  it("rejects mask exceeding field range", () => {
    expect(() => makeBitmaskConstraint(schema, "amountU8", 256n)).to.throw(
      /exceeds u8/,
    );
  });

  it("rejects bitmask on bool field", () => {
    expect(() => makeBitmaskConstraint(schema, "isActive", 1n)).to.throw(
      /integer fields/,
    );
  });

  it("rejects bitmask on pubkey field", () => {
    expect(() => makeBitmaskConstraint(schema, "owner", 1n)).to.throw(
      /integer fields/,
    );
  });
});

// ─── makeAccountConstraint ──────────────────────────────────────────────────

describe("makeAccountConstraint", () => {
  it("creates account constraint with index and expected address", () => {
    const c = makeAccountConstraint(TEST_PROGRAM, 2);
    expect(c.index).to.equal(2);
    expect(c.expected).to.equal(TEST_PROGRAM);
  });
});

// ─── getSchema ──────────────────────────────────────────────────────────────

describe("getSchema", () => {
  const protoSchema = makeTestProtocolSchema();

  it("returns instruction schema by action name", () => {
    const ix = getSchema(protoSchema, "openPosition");
    expect(ix.name).to.equal("openPosition");
    expect(ix.fields).to.have.lengthOf(12);
  });

  it("throws on unknown action with available list", () => {
    expect(() => getSchema(protoSchema, "nonexistent")).to.throw(
      /Unknown action/,
    );
  });

  it("includes available actions in error message", () => {
    expect(() => getSchema(protoSchema, "nonexistent")).to.throw(
      /openPosition/,
    );
  });
});

// ─── assembleEntries ────────────────────────────────────────────────────────

describe("assembleEntries", () => {
  const validCompiled: CompiledConstraint = {
    discriminator: TEST_DISC,
    dataConstraints: [makeDiscriminatorConstraint(TEST_DISC)],
    accountConstraints: [],
  };

  it("bridges CompiledConstraint[] to ConstraintEntryArgs[] with programId", () => {
    const entries = assembleEntries(TEST_PROGRAM, [validCompiled]);
    expect(entries).to.have.lengthOf(1);
    expect(entries[0].programId).to.equal(TEST_PROGRAM);
    expect(entries[0].dataConstraints).to.deep.equal(
      validCompiled.dataConstraints,
    );
    expect(entries[0].accountConstraints).to.deep.equal([]);
  });

  it("preserves dataConstraints and accountConstraints unchanged", () => {
    const acctC = makeAccountConstraint(TEST_PROGRAM, 1);
    const compiled: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [makeDiscriminatorConstraint(TEST_DISC)],
      accountConstraints: [acctC],
    };
    const entries = assembleEntries(TEST_PROGRAM, [compiled]);
    expect(entries[0].accountConstraints).to.deep.equal([acctC]);
  });

  it("rejects entry with no data and no account constraints", () => {
    const empty: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [],
      accountConstraints: [],
    };
    expect(() => assembleEntries(TEST_PROGRAM, [empty])).to.throw(
      /at least one/,
    );
  });

  it("rejects > 64 entries (MAX_CONSTRAINT_ENTRIES)", () => {
    const many = Array(65).fill(validCompiled);
    expect(() => assembleEntries(TEST_PROGRAM, many)).to.throw(
      /exceeds max 64/,
    );
  });

  it("accepts exactly 64 entries", () => {
    const max = Array(64).fill(validCompiled);
    expect(() => assembleEntries(TEST_PROGRAM, max)).not.to.throw();
  });

  it("rejects entry with > 8 data constraints", () => {
    const dc = makeDiscriminatorConstraint(TEST_DISC);
    const tooMany: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: Array(9).fill(dc),
      accountConstraints: [],
    };
    expect(() => assembleEntries(TEST_PROGRAM, [tooMany])).to.throw(
      /exceeds max 8/,
    );
  });

  it("rejects entry with > 5 account constraints", () => {
    const ac = makeAccountConstraint(TEST_PROGRAM, 0);
    const tooMany: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [makeDiscriminatorConstraint(TEST_DISC)],
      accountConstraints: Array(6).fill(ac),
    };
    expect(() => assembleEntries(TEST_PROGRAM, [tooMany])).to.throw(
      /exceeds max 5/,
    );
  });

  it("returns empty array for empty input", () => {
    const entries = assembleEntries(TEST_PROGRAM, []);
    expect(entries).to.deep.equal([]);
  });
});

// ─── Constants sync (regression guard) ──────────────────────────────────────

describe("constants sync with on-chain Rust", () => {
  it("MAX_CONSTRAINT_ENTRIES matches Rust (64)", () => {
    // If this fails, also update programs/sigil/src/state/constraints.rs
    const validCompiled: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [makeDiscriminatorConstraint(TEST_DISC)],
      accountConstraints: [],
    };
    expect(() =>
      assembleEntries(TEST_PROGRAM, Array(64).fill(validCompiled)),
    ).not.to.throw();
    expect(() =>
      assembleEntries(TEST_PROGRAM, Array(65).fill(validCompiled)),
    ).to.throw();
  });

  it("MAX_DATA_CONSTRAINTS_PER_ENTRY matches Rust (8)", () => {
    // 8 unique data constraints: discriminator at offset 0, then 7 more at unique offsets
    const at8: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [
        makeDiscriminatorConstraint(TEST_DISC),
        ...Array.from({ length: 7 }, (_, i) => ({
          offset: 8 + i,
          operator: ConstraintOperator.Eq,
          value: new Uint8Array([i]),
        })),
      ],
      accountConstraints: [],
    };
    expect(() => assembleEntries(TEST_PROGRAM, [at8])).not.to.throw();
  });

  it("MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY matches Rust (5)", () => {
    // 5 unique account constraints at distinct indices
    const at5: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [makeDiscriminatorConstraint(TEST_DISC)],
      accountConstraints: Array.from({ length: 5 }, (_, i) =>
        makeAccountConstraint(TEST_PROGRAM, i),
      ),
    };
    expect(() => assembleEntries(TEST_PROGRAM, [at5])).not.to.throw();
  });
});

// ─── Coverage gaps from audit ───────────────────────────────────────────────

describe("makeNeConstraint — additional coverage", () => {
  const schema = makeTestSchema();

  it("rejects on pubkey field (use makeAccountConstraint instead)", () => {
    expect(() => makeNeConstraint(schema, "owner", 0n)).to.throw(
      /Pubkey field/,
    );
  });
});

describe("makeBitmaskConstraint — additional coverage", () => {
  it("rejects negative offset (defensive)", () => {
    const badSchema: InstructionSchema = {
      name: "broken",
      discriminator: TEST_DISC,
      fields: [{ name: "broken", offset: -1, type: "u32", size: 4 }],
      accounts: {},
      dataSize: 12,
    };
    expect(() => makeBitmaskConstraint(badSchema, "broken", 1n)).to.throw(
      /invalid offset/,
    );
  });

  it("rejects mask of 0n (no-op constraint that matches every instruction)", () => {
    const schema = makeTestSchema();
    expect(() => makeBitmaskConstraint(schema, "permissions", 0n)).to.throw(
      /no-op/,
    );
  });

  it("rejects mask of 0 (number, same as 0n)", () => {
    const schema = makeTestSchema();
    expect(() => makeBitmaskConstraint(schema, "permissions", 0)).to.throw(
      /no-op/,
    );
  });
});

// ─── Tests for new validations (audit fixes F4, F5) ─────────────────────────

describe("encodeValue — corrupted schema defense", () => {
  it("rejects field with NaN size", () => {
    const badSchema: InstructionSchema = {
      name: "broken",
      discriminator: TEST_DISC,
      fields: [{ name: "broken", offset: 0, type: "u8", size: NaN }],
      accounts: {},
      dataSize: 0,
    };
    expect(() => makeLteConstraint(badSchema, "broken", 1n)).to.throw(
      /invalid size/,
    );
  });

  it("rejects field with float size", () => {
    const badSchema: InstructionSchema = {
      name: "broken",
      discriminator: TEST_DISC,
      fields: [{ name: "broken", offset: 0, type: "u8", size: 1.5 }],
      accounts: {},
      dataSize: 0,
    };
    expect(() => makeLteConstraint(badSchema, "broken", 1n)).to.throw(
      /invalid size/,
    );
  });

  it("rejects field with NaN offset", () => {
    const badSchema: InstructionSchema = {
      name: "broken",
      discriminator: TEST_DISC,
      fields: [{ name: "broken", offset: NaN, type: "u8", size: 1 }],
      accounts: {},
      dataSize: 0,
    };
    expect(() => makeLteConstraint(badSchema, "broken", 1n)).to.throw(
      /invalid offset/,
    );
  });

  it("rejects field with float offset", () => {
    const badSchema: InstructionSchema = {
      name: "broken",
      discriminator: TEST_DISC,
      fields: [{ name: "broken", offset: 1.5, type: "u8", size: 1 }],
      accounts: {},
      dataSize: 0,
    };
    expect(() => makeLteConstraint(badSchema, "broken", 1n)).to.throw(
      /invalid offset/,
    );
  });
});

// ─── Tests for assembleEntries new validations (audit fixes F6, F7, F8) ────

describe("assembleEntries — duplicate detection (F6)", () => {
  it("rejects duplicate data constraint offsets in one entry", () => {
    const compiled: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [
        makeDiscriminatorConstraint(TEST_DISC),
        // Two more constraints at the same offset
        {
          offset: 8,
          operator: ConstraintOperator.Eq,
          value: new Uint8Array([1]),
        },
        {
          offset: 8,
          operator: ConstraintOperator.Eq,
          value: new Uint8Array([2]),
        },
      ],
      accountConstraints: [],
    };
    expect(() => assembleEntries(TEST_PROGRAM, [compiled])).to.throw(
      /duplicate data constraint at offset 8/,
    );
  });

  it("rejects duplicate account constraint indices in one entry", () => {
    const compiled: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [makeDiscriminatorConstraint(TEST_DISC)],
      accountConstraints: [
        makeAccountConstraint(TEST_PROGRAM, 1),
        makeAccountConstraint(TEST_PROGRAM, 1),
      ],
    };
    expect(() => assembleEntries(TEST_PROGRAM, [compiled])).to.throw(
      /duplicate account constraint at index 1/,
    );
  });
});

describe("assembleEntries — discriminator invariant (F7)", () => {
  it("rejects entry with missing discriminator constraint", () => {
    // dataConstraints[0] is NOT a discriminator constraint — privilege escalation hazard
    const compiled: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [
        // First constraint targets offset 8, not 0 — discriminator missing
        {
          offset: 8,
          operator: ConstraintOperator.Eq,
          value: new Uint8Array([1]),
        },
      ],
      accountConstraints: [],
    };
    expect(() => assembleEntries(TEST_PROGRAM, [compiled])).to.throw(
      /must be the discriminator Eq constraint/,
    );
  });

  it("rejects entry where first constraint has wrong discriminator value", () => {
    const wrongDisc = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    const compiled: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [
        // discriminator field declares TEST_DISC, but constraint uses wrongDisc
        { offset: 0, operator: ConstraintOperator.Eq, value: wrongDisc },
      ],
      accountConstraints: [],
    };
    expect(() => assembleEntries(TEST_PROGRAM, [compiled])).to.throw(
      /must be the discriminator Eq constraint/,
    );
  });

  it("rejects entry with only account constraints (A5 discriminator anchor required)", () => {
    // Fix A5 (docs/SECURITY-FINDINGS-2026-04-07.md Finding 1): account-only
    // entries matched ANY instruction on the program_id, enabling
    // privilege escalation via account-layout conflation. Every entry
    // must now include a discriminator anchor as its first data
    // constraint — this inversion is the regression guard.
    const compiled: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [],
      accountConstraints: [makeAccountConstraint(TEST_PROGRAM, 0)],
    };
    expect(() => assembleEntries(TEST_PROGRAM, [compiled])).to.throw(
      /at least one data constraint/,
    );
  });
});

describe("assembleEntries — defensive array clone (F8)", () => {
  it("returned arrays are not the same references as input", () => {
    const compiled: CompiledConstraint = {
      discriminator: TEST_DISC,
      dataConstraints: [makeDiscriminatorConstraint(TEST_DISC)],
      accountConstraints: [makeAccountConstraint(TEST_PROGRAM, 0)],
    };
    const entries = assembleEntries(TEST_PROGRAM, [compiled]);
    // Mutating the input should not affect the returned entry
    expect(entries[0].dataConstraints).to.not.equal(compiled.dataConstraints);
    expect(entries[0].accountConstraints).to.not.equal(
      compiled.accountConstraints,
    );
  });
});
