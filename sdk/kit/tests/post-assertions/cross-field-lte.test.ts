/**
 * Unit tests for the CrossFieldLte builder `leverageCapLteBps`.
 *
 * Covers:
 *   1. Happy path — a well-formed call produces a valid PostAssertionEntry.
 *   2. Output passes the on-chain-mirroring validator — closes the loop so
 *      the builder can never silently produce an entry that Rust would
 *      reject.
 *   3. Jupiter Perpetuals runtime reject (Phase 2 PRD ISC-37 + anti-ISC-A1).
 *   4. Range / integrality / equality checks on offsets and maxBps.
 *
 * Every rejection test asserts the SPECIFIC error class so a future
 * regression that swaps one failure mode for another is caught.
 */
import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  leverageCapLteBps,
  JUPITER_PERPS_PROGRAM_ADDRESS,
  JupiterPerpsPostAssertionUnsupportedError,
} from "../../src/post-assertions/cross-field-lte.js";
import { validatePostAssertionEntries } from "../../src/dashboard/post-assertion-validation.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const TARGET =
  "FLaShtradeTarget111111111111111111111111111" as unknown as Address;
const FLASH_TRADE_PROGRAM =
  "FLaShhi25chVvuchprnYt5egbQoeK3LeZqQ6mTGNJeAW" as unknown as Address;
const JUPITER_V6 =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as unknown as Address;
const JUPITER_PERPS = JUPITER_PERPS_PROGRAM_ADDRESS;

function validOpts() {
  return {
    targetAccount: TARGET,
    targetAccountOwnerProgram: FLASH_TRADE_PROGRAM,
    fieldAOffset: 140, // sizeUsd
    fieldBOffset: 172, // collateralUsd
    maxBps: 100_000, // 10x
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────

describe("leverageCapLteBps — emits valid PostAssertionEntry", () => {
  it("produces an entry with crossFieldFlags=0x01 (CrossFieldLte enabled)", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(entry.crossFieldFlags).to.equal(0x01);
  });

  it("sets offset = fieldAOffset (field_A)", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(entry.offset).to.equal(140);
  });

  it("sets crossFieldOffsetB = fieldBOffset (field_B)", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(entry.crossFieldOffsetB).to.equal(172);
  });

  it("sets crossFieldMultiplierBps = maxBps", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(entry.crossFieldMultiplierBps).to.equal(100_000);
  });

  it("sets assertionMode=0 (Absolute, required for CrossField)", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(entry.assertionMode).to.equal(0);
  });

  it("sets valueLen=8 (u64 field)", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(entry.valueLen).to.equal(8);
  });

  it("pads expectedValue to exactly valueLen bytes", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(entry.expectedValue.length).to.equal(entry.valueLen);
  });

  it("sets operator=3 (Lte) as semantic hint", () => {
    // The on-chain program ignores operator when CrossField flag is set,
    // but we populate Lte for any human inspecting the raw entry.
    const entry = leverageCapLteBps(validOpts());
    expect(entry.operator).to.equal(3);
  });

  it("passes targetAccount through unchanged", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(entry.targetAccount).to.equal(TARGET);
  });
});

// ─── Loop-closure: output passes the validator ───────────────────────────

describe("leverageCapLteBps — output passes validatePostAssertionEntries", () => {
  it("accepts a 10x cap against Flash Trade offsets", () => {
    const entry = leverageCapLteBps(validOpts());
    expect(() => validatePostAssertionEntries([entry])).to.not.throw();
  });

  it("accepts a 100x cap (multiplier = 1_000_000 BPS)", () => {
    const entry = leverageCapLteBps({ ...validOpts(), maxBps: 1_000_000 });
    expect(() => validatePostAssertionEntries([entry])).to.not.throw();
  });

  it("accepts maxBps at u32 max", () => {
    const entry = leverageCapLteBps({ ...validOpts(), maxBps: 0xffffffff });
    expect(() => validatePostAssertionEntries([entry])).to.not.throw();
  });

  it("accepts an entry alongside a plain Absolute entry in the same batch", () => {
    const crossField = leverageCapLteBps(validOpts());
    const absolute = {
      ...crossField,
      offset: 200,
      crossFieldOffsetB: 0,
      crossFieldMultiplierBps: 0,
      crossFieldFlags: 0,
      expectedValue: new Uint8Array(8).fill(
        0x42,
      ) as unknown as (typeof crossField)["expectedValue"],
    };
    expect(() =>
      validatePostAssertionEntries([absolute, crossField]),
    ).to.not.throw();
  });
});

// ─── Jupiter Perpetuals runtime reject (ISC-37, anti-ISC-A1) ─────────────

describe("leverageCapLteBps — Jupiter Perpetuals safety rail", () => {
  it("throws JupiterPerpsPostAssertionUnsupportedError when target is owned by Jupiter Perps", () => {
    expect(() =>
      leverageCapLteBps({
        ...validOpts(),
        targetAccountOwnerProgram: JUPITER_PERPS,
      }),
    ).to.throw(JupiterPerpsPostAssertionUnsupportedError);
  });

  it("error message explains the keeper-fulfillment silent-bypass reason", () => {
    let caught: unknown;
    try {
      leverageCapLteBps({
        ...validOpts(),
        targetAccountOwnerProgram: JUPITER_PERPS,
      });
    } catch (err) {
      caught = err;
    }
    const err = caught as Error;
    expect(err.message).to.include("keeper-fulfillment");
    expect(err.message).to.include("pre-execution");
    expect(err.message).to.include("InstructionConstraints");
    expect(err.message).to.include("LEVERAGE-ENFORCEMENT.md");
  });

  it("error message explicitly states Jupiter Perps IS still supported (via pre-execution)", () => {
    let caught: unknown;
    try {
      leverageCapLteBps({
        ...validOpts(),
        targetAccountOwnerProgram: JUPITER_PERPS,
      });
    } catch (err) {
      caught = err;
    }
    const err = caught as Error;
    // The docblock guarantees the error message distinguishes "post-
    // execution not viable" from "Jupiter is blocked." Regression guard
    // against a future overreach that bans Jupiter entirely.
    expect(err.message).to.include("Jupiter Perps remains");
    expect(err.message).to.include("fully supported");
  });

  it("does NOT reject Jupiter V6 (swap aggregator, not perpetuals)", () => {
    expect(() =>
      leverageCapLteBps({
        ...validOpts(),
        targetAccountOwnerProgram: JUPITER_V6,
      }),
    ).to.not.throw();
  });

  it("does NOT reject Flash Trade or other non-Jupiter-Perps programs", () => {
    expect(() =>
      leverageCapLteBps({
        ...validOpts(),
        targetAccountOwnerProgram: FLASH_TRADE_PROGRAM,
      }),
    ).to.not.throw();
  });

  it("reject fires BEFORE offset / maxBps validation (Jupiter is the first check)", () => {
    // If a caller passes Jupiter Perps + invalid offsets, the Jupiter error
    // wins — that's the diagnostic you actually need.
    let caught: unknown;
    try {
      leverageCapLteBps({
        targetAccount: TARGET,
        targetAccountOwnerProgram: JUPITER_PERPS,
        fieldAOffset: -1, // would also fail integrality check
        fieldBOffset: 172,
        maxBps: 100_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(JupiterPerpsPostAssertionUnsupportedError);
  });
});

// ─── Input validation — offsets ──────────────────────────────────────────

describe("leverageCapLteBps — offset range / integrality", () => {
  it("rejects negative fieldAOffset", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), fieldAOffset: -1 }),
    ).to.throw(RangeError, /fieldAOffset/);
  });

  it("rejects fieldAOffset > u16 (65536)", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), fieldAOffset: 65536 }),
    ).to.throw(RangeError, /fieldAOffset/);
  });

  it("rejects non-integer fieldAOffset", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), fieldAOffset: 140.5 }),
    ).to.throw(RangeError);
  });

  it("rejects NaN fieldAOffset", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), fieldAOffset: Number.NaN }),
    ).to.throw(RangeError);
  });

  it("accepts fieldAOffset=0 (lower bound)", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), fieldAOffset: 0, fieldBOffset: 1 }),
    ).to.not.throw();
  });

  it("accepts fieldAOffset=65535 (u16 max)", () => {
    expect(() =>
      leverageCapLteBps({
        ...validOpts(),
        fieldAOffset: 65535,
        fieldBOffset: 0,
      }),
    ).to.not.throw();
  });

  it("rejects fieldAOffset == fieldBOffset (ratio of same field is nonsensical)", () => {
    expect(() =>
      leverageCapLteBps({
        ...validOpts(),
        fieldAOffset: 140,
        fieldBOffset: 140,
      }),
    ).to.throw(RangeError, /must differ/);
  });

  it("applies the same range checks to fieldBOffset", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), fieldBOffset: -1 }),
    ).to.throw(RangeError, /fieldBOffset/);
    expect(() =>
      leverageCapLteBps({ ...validOpts(), fieldBOffset: 65536 }),
    ).to.throw(RangeError, /fieldBOffset/);
    expect(() =>
      leverageCapLteBps({ ...validOpts(), fieldBOffset: 3.14 }),
    ).to.throw(RangeError);
  });
});

// ─── Input validation — maxBps ───────────────────────────────────────────

describe("leverageCapLteBps — maxBps range / integrality", () => {
  it("rejects maxBps=0 (collapses ratio to always-fail)", () => {
    expect(() => leverageCapLteBps({ ...validOpts(), maxBps: 0 })).to.throw(
      RangeError,
      /maxBps/,
    );
  });

  it("rejects negative maxBps", () => {
    expect(() => leverageCapLteBps({ ...validOpts(), maxBps: -1 })).to.throw(
      RangeError,
    );
  });

  it("rejects non-integer maxBps (100_000.5 would truncate on-chain)", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), maxBps: 100_000.5 }),
    ).to.throw(RangeError);
  });

  it("rejects maxBps > u32 max (2^32)", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), maxBps: 0x1_0000_0000 }),
    ).to.throw(RangeError);
  });

  it("rejects Infinity maxBps", () => {
    expect(() =>
      leverageCapLteBps({
        ...validOpts(),
        maxBps: Number.POSITIVE_INFINITY,
      }),
    ).to.throw(RangeError);
  });

  it("accepts maxBps=1 (minimum valid)", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), maxBps: 1 }),
    ).to.not.throw();
  });

  it("accepts maxBps=0xffffffff (u32 max)", () => {
    expect(() =>
      leverageCapLteBps({ ...validOpts(), maxBps: 0xffffffff }),
    ).to.not.throw();
  });
});
