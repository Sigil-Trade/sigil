/**
 * Unit tests for the client-side PostAssertionEntry validator.
 *
 * Every rejection path in `post-assertion-validation.ts` has a corresponding
 * test here that asserts BOTH:
 *   (a) a `PostAssertionValidationError` is thrown, AND
 *   (b) its `code` matches the specific failure code (not a generic error).
 *
 * This pairing is deliberate — Phase 2 anti-criterion ISC-A2 requires that
 * validation tests "must assert the specific error code + name." A test that
 * only asserts "some error was thrown" would pass even if the validator
 * started silently accepting bad input, masking a regression.
 *
 * Cross-reference: programs/sigil/src/state/post_assertions.rs:118
 * (`validate_entries` — the source of truth this validator mirrors).
 */
import { expect } from "chai";
import type { Address, ReadonlyUint8Array } from "@solana/kit";
import type { PostAssertionEntry } from "../../src/generated/types/postAssertionEntry.js";
import {
  validatePostAssertionEntries,
  PostAssertionValidationError,
  DX_CODE_POST_ASSERTION_VALIDATION,
  type PostAssertionValidationCode,
} from "../../src/dashboard/post-assertion-validation.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────

const DUMMY_TARGET = "11111111111111111111111111111111" as unknown as Address;

function bytes(length: number, fill = 0): ReadonlyUint8Array {
  return new Uint8Array(length).fill(fill) as unknown as ReadonlyUint8Array;
}

/**
 * Build a valid Absolute-mode entry as a starting point. Individual tests
 * clone this and mutate one field to exercise a specific failure path —
 * so we know the failure is attributable to the mutation alone.
 */
function validAbsoluteEntry(): PostAssertionEntry {
  return {
    targetAccount: DUMMY_TARGET,
    offset: 140,
    valueLen: 8,
    operator: 3, // Lte
    expectedValue: bytes(8, 0x11),
    assertionMode: 0, // Absolute
    crossFieldOffsetB: 0,
    crossFieldMultiplierBps: 0,
    crossFieldFlags: 0,
  };
}

/**
 * Build a valid CrossFieldLte entry. Same cloning strategy as above.
 */
function validCrossFieldEntry(): PostAssertionEntry {
  return {
    targetAccount: DUMMY_TARGET,
    offset: 140, // field_A (e.g. sizeUsd)
    valueLen: 8,
    operator: 3, // Lte
    expectedValue: bytes(8, 0x00),
    assertionMode: 0, // must be Absolute for CrossFieldLte
    crossFieldOffsetB: 172, // field_B (e.g. collateralUsd)
    crossFieldMultiplierBps: 100_000, // 10x
    crossFieldFlags: 0x01, // CrossFieldLte enabled
  };
}

/**
 * Assert that the validator throws a PostAssertionValidationError with a
 * specific `validationCode` (the string discriminator) and (optionally) a
 * specific `entryIndex`. Also verifies DxError-compatibility by checking
 * the numeric `code` and the presence of a `recovery: string[]`.
 *
 * Fails loudly if a different code is produced, no error is thrown, or
 * the error doesn't expose the DxError-compatible fields.
 */
function expectReject(
  entries: unknown,
  validationCode: PostAssertionValidationCode,
  entryIndex: number | null = null,
): PostAssertionValidationError {
  let caught: unknown;
  try {
    // Cast to any so the helper can also exercise the Array.isArray guard
    // (passing non-array inputs) without TS objections.
    validatePostAssertionEntries(entries as readonly PostAssertionEntry[]);
  } catch (err) {
    caught = err;
  }

  expect(
    caught,
    `expected throw with validationCode=${validationCode}`,
  ).to.be.instanceOf(PostAssertionValidationError);
  const err = caught as PostAssertionValidationError;
  expect(err.validationCode).to.equal(validationCode);
  // DxError compatibility: every validation error carries the SDK numeric
  // code + a recovery array the UI can render.
  expect(err.code).to.equal(DX_CODE_POST_ASSERTION_VALIDATION);
  expect(err.recovery).to.be.an("array").with.length.greaterThan(0);
  if (entryIndex !== null) {
    expect(err.entryIndex).to.equal(entryIndex);
  }
  return err;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("validatePostAssertionEntries — batch-level rules", () => {
  it("accepts 1 to 4 entries without throwing", () => {
    for (const n of [1, 2, 3, 4]) {
      const entries = Array.from({ length: n }, () => validAbsoluteEntry());
      expect(() => validatePostAssertionEntries(entries)).to.not.throw();
    }
  });

  it("rejects zero entries with entry_count_out_of_range", () => {
    const err = expectReject([], "entry_count_out_of_range");
    expect(err.entryIndex).to.be.null;
    expect(err.message).to.include("must be 1..=4");
    expect(err.message).to.include("got 0");
  });

  it("rejects 5 entries with entry_count_out_of_range", () => {
    const entries = Array.from({ length: 5 }, () => validAbsoluteEntry());
    const err = expectReject(entries, "entry_count_out_of_range");
    expect(err.entryIndex).to.be.null;
    expect(err.message).to.include("got 5");
  });
});

describe("validatePostAssertionEntries — per-entry value_len", () => {
  it("rejects value_len=0 with value_len_out_of_range", () => {
    const e = validAbsoluteEntry();
    e.valueLen = 0;
    const err = expectReject([e], "value_len_out_of_range", 0);
    expect(err.message).to.include("value_len must be 1..=32");
    expect(err.message).to.include("got 0");
  });

  it("rejects value_len=33 with value_len_out_of_range", () => {
    const e = validAbsoluteEntry();
    e.valueLen = 33;
    e.expectedValue = bytes(33);
    const err = expectReject([e], "value_len_out_of_range", 0);
    expect(err.message).to.include("got 33");
  });

  it("accepts value_len=32 (upper bound) without throwing", () => {
    const e = validAbsoluteEntry();
    e.valueLen = 32;
    e.expectedValue = bytes(32);
    expect(() => validatePostAssertionEntries([e])).to.not.throw();
  });
});

describe("validatePostAssertionEntries — expected_value length", () => {
  it("rejects expected_value shorter than value_len", () => {
    const e = validAbsoluteEntry();
    e.valueLen = 8;
    e.expectedValue = bytes(4); // too short
    const err = expectReject([e], "expected_value_too_short", 0);
    expect(err.message).to.include("has 4 bytes");
    expect(err.message).to.include("value_len=8");
  });

  it("accepts expected_value LONGER than value_len (extra bytes ignored)", () => {
    // The Rust check is `expected_value.len() >= value_len`, not `==`.
    // Extra trailing bytes are allowed (on-chain program only reads value_len bytes).
    const e = validAbsoluteEntry();
    e.valueLen = 4;
    e.expectedValue = bytes(8);
    expect(() => validatePostAssertionEntries([e])).to.not.throw();
  });
});

describe("validatePostAssertionEntries — operator range", () => {
  it("accepts operator=0 through 6", () => {
    for (const op of [0, 1, 2, 3, 4, 5, 6]) {
      const e = validAbsoluteEntry();
      e.operator = op;
      expect(() => validatePostAssertionEntries([e])).to.not.throw(
        `operator=${op} should be accepted`,
      );
    }
  });

  it("rejects operator=7 with operator_out_of_range", () => {
    const e = validAbsoluteEntry();
    e.operator = 7;
    const err = expectReject([e], "operator_out_of_range", 0);
    expect(err.message).to.include("operator must be an integer 0..=6");
    expect(err.message).to.include("got 7");
  });

  it("rejects operator=255 with operator_out_of_range", () => {
    const e = validAbsoluteEntry();
    e.operator = 255;
    expectReject([e], "operator_out_of_range", 0);
  });
});

describe("validatePostAssertionEntries — assertion_mode range", () => {
  it("accepts assertion_mode=0 through 3", () => {
    for (const mode of [0, 1, 2, 3]) {
      const e = validAbsoluteEntry();
      e.assertionMode = mode;
      // delta modes require value_len <= 8; the fixture is already at 8.
      expect(() => validatePostAssertionEntries([e])).to.not.throw(
        `assertion_mode=${mode} should be accepted`,
      );
    }
  });

  it("rejects assertion_mode=4 with assertion_mode_out_of_range", () => {
    const e = validAbsoluteEntry();
    e.assertionMode = 4;
    const err = expectReject([e], "assertion_mode_out_of_range", 0);
    expect(err.message).to.include("assertion_mode must be an integer 0..=3");
    expect(err.message).to.include("got 4");
  });
});

describe("validatePostAssertionEntries — delta mode value_len cap", () => {
  it("rejects delta mode 1 (MaxDecrease) with value_len=16", () => {
    const e = validAbsoluteEntry();
    e.assertionMode = 1;
    e.valueLen = 16;
    e.expectedValue = bytes(16);
    const err = expectReject([e], "delta_mode_value_len_too_large", 0);
    expect(err.message).to.include("delta assertion_mode=1");
    expect(err.message).to.include("value_len <= 8");
  });

  it("rejects delta mode 2 (MaxIncrease) with value_len=9", () => {
    const e = validAbsoluteEntry();
    e.assertionMode = 2;
    e.valueLen = 9;
    e.expectedValue = bytes(9);
    expectReject([e], "delta_mode_value_len_too_large", 0);
  });

  it("rejects delta mode 3 (NoChange) with value_len=32", () => {
    const e = validAbsoluteEntry();
    e.assertionMode = 3;
    e.valueLen = 32;
    e.expectedValue = bytes(32);
    expectReject([e], "delta_mode_value_len_too_large", 0);
  });

  it("accepts delta mode 1 with value_len=8 (exactly at the cap)", () => {
    const e = validAbsoluteEntry();
    e.assertionMode = 1;
    e.valueLen = 8;
    e.expectedValue = bytes(8);
    expect(() => validatePostAssertionEntries([e])).to.not.throw();
  });
});

describe("validatePostAssertionEntries — CrossFieldLte enabled", () => {
  it("accepts a well-formed CrossFieldLte entry", () => {
    expect(() =>
      validatePostAssertionEntries([validCrossFieldEntry()]),
    ).to.not.throw();
  });

  it("rejects CrossFieldLte with value_len=16 (cross_field_value_len_too_large)", () => {
    const e = validCrossFieldEntry();
    e.valueLen = 16;
    e.expectedValue = bytes(16);
    const err = expectReject([e], "cross_field_value_len_too_large", 0);
    expect(err.message).to.include("CrossFieldLte requires value_len <= 8");
  });

  it("rejects CrossFieldLte combined with assertion_mode=1 (delta)", () => {
    const e = validCrossFieldEntry();
    e.assertionMode = 1;
    const err = expectReject([e], "cross_field_requires_absolute_mode", 0);
    expect(err.message).to.include("assertion_mode=0 (Absolute)");
    expect(err.message).to.include("got 1");
  });

  it("rejects CrossFieldLte with multiplier_bps=0", () => {
    const e = validCrossFieldEntry();
    e.crossFieldMultiplierBps = 0;
    const err = expectReject([e], "cross_field_multiplier_must_be_positive", 0);
    expect(err.message).to.include("multiplier_bps must be > 0");
  });

  it("rejects CrossFieldLte with unknown flag bits set (0x03)", () => {
    const e = validCrossFieldEntry();
    e.crossFieldFlags = 0x03; // bit 0 (valid) + bit 1 (reserved)
    const err = expectReject([e], "cross_field_unknown_flags", 0);
    expect(err.message).to.include("reserved bits set: 0x03");
  });

  it("rejects CrossFieldLte with 0xFF flags (all reserved bits set)", () => {
    const e = validCrossFieldEntry();
    e.crossFieldFlags = 0xff;
    const err = expectReject([e], "cross_field_unknown_flags", 0);
    expect(err.message).to.include("0xff");
  });
});

describe("validatePostAssertionEntries — CrossFieldLte disabled", () => {
  it("rejects crossFieldOffsetB != 0 when flag disabled", () => {
    const e = validAbsoluteEntry();
    e.crossFieldOffsetB = 172;
    e.crossFieldMultiplierBps = 0;
    e.crossFieldFlags = 0;
    const err = expectReject(
      [e],
      "cross_field_disabled_fields_must_be_zero",
      0,
    );
    expect(err.message).to.include("cross_field_offset_b=172");
  });

  it("rejects crossFieldMultiplierBps != 0 when flag disabled", () => {
    const e = validAbsoluteEntry();
    e.crossFieldOffsetB = 0;
    e.crossFieldMultiplierBps = 100_000;
    e.crossFieldFlags = 0;
    expectReject([e], "cross_field_disabled_fields_must_be_zero", 0);
  });

  it("accepts plain Absolute entry with all CrossField fields zero", () => {
    // This is exactly validAbsoluteEntry — sanity-check that the default
    // fixture passes so the mutation tests above aren't passing for the
    // wrong reason.
    expect(() =>
      validatePostAssertionEntries([validAbsoluteEntry()]),
    ).to.not.throw();
  });
});

describe("validatePostAssertionEntries — input shape guards", () => {
  it("rejects null input with entries_not_an_array", () => {
    const err = expectReject(null, "entries_not_an_array");
    expect(err.entryIndex).to.be.null;
    expect(err.message).to.include("must be an array");
  });

  it("rejects undefined input with entries_not_an_array", () => {
    const err = expectReject(undefined, "entries_not_an_array");
    expect(err.entryIndex).to.be.null;
  });

  it("rejects non-array objects (e.g. {length: 3})", () => {
    expectReject({ length: 3 }, "entries_not_an_array");
  });

  it("rejects a batch that contains a null entry", () => {
    // Null at index 1; index 0 is valid, would have passed.
    const err = expectReject(
      [validAbsoluteEntry(), null as unknown as PostAssertionEntry],
      "entries_contain_null",
      1,
    );
    expect(err.message).to.include("is null");
  });

  it("rejects a batch that contains an undefined entry", () => {
    const err = expectReject(
      [undefined as unknown as PostAssertionEntry, validAbsoluteEntry()],
      "entries_contain_null",
      0,
    );
    expect(err.message).to.include("is undefined");
  });
});

describe("validatePostAssertionEntries — integer/negative rejection (security audit HIGH)", () => {
  // These cases would pass a one-sided `> MAX` check but on-chain Codama
  // encoders either truncate silently (fractions) or throw a SolanaError
  // (negatives) — both are foot-guns. The validator now catches them.

  it("rejects negative operator (was: one-sided > MAX missed -1)", () => {
    const e = validAbsoluteEntry();
    e.operator = -1;
    expectReject([e], "operator_out_of_range", 0);
  });

  it("rejects negative assertionMode", () => {
    const e = validAbsoluteEntry();
    e.assertionMode = -1;
    expectReject([e], "assertion_mode_out_of_range", 0);
  });

  it("rejects negative valueLen", () => {
    const e = validAbsoluteEntry();
    e.valueLen = -1;
    expectReject([e], "value_len_out_of_range", 0);
  });

  it("rejects negative offset", () => {
    const e = validAbsoluteEntry();
    e.offset = -1;
    expectReject([e], "offset_out_of_range", 0);
  });

  it("rejects negative crossFieldFlags", () => {
    const e = validAbsoluteEntry();
    e.crossFieldFlags = -1;
    expectReject([e], "cross_field_flags_out_of_range", 0);
  });

  it("rejects negative crossFieldMultiplierBps", () => {
    const e = validCrossFieldEntry();
    e.crossFieldMultiplierBps = -1;
    expectReject([e], "cross_field_multiplier_bps_out_of_range", 0);
  });

  it("rejects non-integer valueLen (was: 8.5 → passed, silently truncated)", () => {
    const e = validAbsoluteEntry();
    e.valueLen = 8.5;
    expectReject([e], "value_len_out_of_range", 0);
  });

  it("rejects non-integer crossFieldFlags (was: 0.5 → bitwise-truncated to 0)", () => {
    const e = validAbsoluteEntry();
    e.crossFieldFlags = 0.5;
    expectReject([e], "cross_field_flags_out_of_range", 0);
  });

  it("rejects NaN for valueLen", () => {
    const e = validAbsoluteEntry();
    e.valueLen = Number.NaN;
    expectReject([e], "value_len_out_of_range", 0);
  });

  it("rejects Infinity for crossFieldMultiplierBps", () => {
    const e = validCrossFieldEntry();
    e.crossFieldMultiplierBps = Number.POSITIVE_INFINITY;
    expectReject([e], "cross_field_multiplier_bps_out_of_range", 0);
  });

  it("rejects string coerced to number field (TS bypass via `any`)", () => {
    const e = validAbsoluteEntry() as unknown as Record<string, unknown>;
    e.valueLen = "8";
    expectReject(
      [e as unknown as PostAssertionEntry],
      "value_len_out_of_range",
      0,
    );
  });

  it("rejects offset > u16 range (65536)", () => {
    const e = validAbsoluteEntry();
    e.offset = 65536;
    expectReject([e], "offset_out_of_range", 0);
  });

  it("rejects crossFieldMultiplierBps > u32 range", () => {
    const e = validCrossFieldEntry();
    e.crossFieldMultiplierBps = 0x1_0000_0000; // 2^32
    expectReject([e], "cross_field_multiplier_bps_out_of_range", 0);
  });

  it("rejects crossFieldFlags > u8 range (256)", () => {
    const e = validAbsoluteEntry();
    e.crossFieldFlags = 256;
    expectReject([e], "cross_field_flags_out_of_range", 0);
  });
});

describe("validatePostAssertionEntries — DxError compatibility (security audit CRITICAL)", () => {
  it("attaches numeric DxError code to every thrown validation error", () => {
    const err = expectReject([], "entry_count_out_of_range");
    expect(err.code).to.equal(DX_CODE_POST_ASSERTION_VALIDATION);
    expect(err.code).to.equal(7008);
  });

  it("populates recovery array with the entry index when present", () => {
    const e = validAbsoluteEntry();
    e.valueLen = 0;
    const err = expectReject([e], "value_len_out_of_range", 0);
    expect(err.recovery[0]).to.include("index 0");
    expect(err.recovery[0]).to.include("value_len_out_of_range");
  });

  it("populates recovery array for batch-level failures", () => {
    const err = expectReject([], "entry_count_out_of_range");
    expect(err.recovery[0]).to.include("entry_count_out_of_range");
    expect(err.recovery[0]).to.not.include("index");
  });

  it("preserves validationCode discriminator on .validationCode", () => {
    const e = validCrossFieldEntry();
    e.assertionMode = 1;
    const err = expectReject([e], "cross_field_requires_absolute_mode", 0);
    // Both .code (numeric) and .validationCode (string) exposed.
    expect(err.code).to.equal(DX_CODE_POST_ASSERTION_VALIDATION);
    expect(err.validationCode).to.equal("cross_field_requires_absolute_mode");
  });
});

describe("validatePostAssertionEntries — entry index reporting", () => {
  it("reports the failing entry's index when a later entry is bad", () => {
    // Batch of 3 entries: [0] ok, [1] ok, [2] bad → error should point at 2.
    const good = validAbsoluteEntry();
    const bad = validAbsoluteEntry();
    bad.valueLen = 0;
    const err = expectReject([good, good, bad], "value_len_out_of_range", 2);
    expect(err.message).to.include("PostAssertion[2]");
    expect(err.entryIndex).to.equal(2);
  });

  it("reports null entryIndex for batch-level (entry count) failures", () => {
    const err = expectReject([], "entry_count_out_of_range", null);
    expect(err.entryIndex).to.be.null;
  });

  it("stops at the FIRST failing entry (does not aggregate)", () => {
    // The on-chain program's loop returns on first require! failure, so we
    // mirror that. Three bad entries → error reports index 0, not 1 or 2.
    const bad0 = validAbsoluteEntry();
    bad0.valueLen = 0;
    const bad1 = validAbsoluteEntry();
    bad1.operator = 99;
    const bad2 = validAbsoluteEntry();
    bad2.assertionMode = 99;
    const err = expectReject([bad0, bad1, bad2], "value_len_out_of_range", 0);
    expect(err.entryIndex).to.equal(0);
  });
});
