/**
 * Unit tests for `flashTradeLeverageCap` — the Flash Trade leverage cap preset.
 *
 * Two responsibilities:
 *
 *  1. **Drift-check** — the preset's hard-coded byte offsets (140 for
 *     `size_usd`, 172 for `collateral_usd`) MUST match the live Flash Trade
 *     Position account layout shipped with `flash-sdk`. This test reloads
 *     the IDL from `flash-sdk/dist/idl/perpetuals.json` at test time and
 *     recomputes offsets — any future bump that shifts fields fails this
 *     test before a broken preset can ship.
 *
 *  2. **Contract** — valid construction produces a `PostAssertionEntry` that
 *     round-trips through `validatePostAssertionEntries` without error, and
 *     invalid `maxLeverage` inputs throw `FlashTradeLeverageOutOfRangeError`
 *     with the typed `code` field intact for DxError-style FE branching.
 */
import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  flashTradeLeverageCap,
  FlashTradeLeverageOutOfRangeError,
  FLASH_TRADE_POSITION_SIZE_USD_OFFSET,
  FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET,
  MIN_LEVERAGE_X,
  MAX_LEVERAGE_X,
} from "../../src/post-assertions/presets/flash-trade.js";
import { validatePostAssertionEntries } from "../../src/dashboard/post-assertion-validation.js";
import FLASH_IDL from "flash-sdk/dist/idl/perpetuals.json" with { type: "json" };

// ─── Fixtures ─────────────────────────────────────────────────────────────

const POSITION_ACCOUNT =
  "PosiTi0nFlaShTradEaCc0uNt11111111111111111111" as unknown as Address;

// Primitive sizes for on-disk Borsh layout of Anchor accounts.
// Flash Trade uses Anchor's default Borsh serialization (no padding between
// fields), so primitives + arrays-of-primitives compose directly.
const PRIMITIVE_SIZES: Readonly<Record<string, number>> = {
  pubkey: 32,
  i64: 8,
  u64: 8,
  i32: 4,
  u32: 4,
  i16: 2,
  u16: 2,
  i8: 1,
  u8: 1,
  bool: 1,
  i128: 16,
  u128: 16,
};

// Hand-computed sizes for Flash Trade custom types we care about inside the
// Position account. Keep narrowly scoped — we only need OraclePrice for this
// test (price: u64 + exponent: i32 = 12 bytes).
const CUSTOM_TYPE_SIZES: Readonly<Record<string, number>> = {
  OraclePrice: 12,
};

interface IdlField {
  name: string;
  type: IdlType;
}

type IdlType =
  | string
  | { defined: { name: string } | string }
  | { array: [IdlType, number] };

function typeSize(t: IdlType): number {
  if (typeof t === "string") {
    const size = PRIMITIVE_SIZES[t];
    if (size === undefined) {
      throw new Error(`Unknown primitive type: ${t}`);
    }
    return size;
  }
  if ("defined" in t) {
    const name = typeof t.defined === "string" ? t.defined : t.defined.name;
    const size = CUSTOM_TYPE_SIZES[name];
    if (size === undefined) {
      throw new Error(
        `Unknown custom type: ${name} — add to CUSTOM_TYPE_SIZES if this test needs to span it`,
      );
    }
    return size;
  }
  if ("array" in t) {
    const [inner, n] = t.array;
    return typeSize(inner) * n;
  }
  throw new Error(`Unsupported IDL type: ${JSON.stringify(t)}`);
}

/**
 * Compute the byte offset of a field inside an Anchor-serialized account,
 * starting from byte 0 of the account data (NOT after the discriminator —
 * the caller adds 8 if they want post-discriminator offsets).
 */
function fieldOffsetWithDiscriminator(
  fields: readonly IdlField[],
  target: string,
): number {
  let offset = 8; // Anchor discriminator
  for (const f of fields) {
    if (f.name === target) return offset;
    offset += typeSize(f.type);
  }
  throw new Error(`Field "${target}" not found`);
}

interface IdlTypeDef {
  name: string;
  type: {
    kind: "struct";
    fields: IdlField[];
  };
}

interface Idl {
  types: IdlTypeDef[];
}

// ─── Drift-check ──────────────────────────────────────────────────────────

describe("flashTradeLeverageCap — drift-check against flash-sdk IDL", () => {
  it("flash-sdk ships a Position type definition", () => {
    const idl = FLASH_IDL as unknown as Idl;
    const position = idl.types.find((t) => t.name === "Position");
    expect(position).to.exist;
    expect(position!.type.kind).to.equal("struct");
    expect(position!.type.fields.length).to.be.greaterThan(0);
  });

  it(`size_usd offset MUST equal ${FLASH_TRADE_POSITION_SIZE_USD_OFFSET} (pinned)`, () => {
    const idl = FLASH_IDL as unknown as Idl;
    const position = idl.types.find((t) => t.name === "Position");
    const computed = fieldOffsetWithDiscriminator(
      position!.type.fields,
      "size_usd",
    );
    expect(computed).to.equal(FLASH_TRADE_POSITION_SIZE_USD_OFFSET);
  });

  it(`collateral_usd offset MUST equal ${FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET} (pinned)`, () => {
    const idl = FLASH_IDL as unknown as Idl;
    const position = idl.types.find((t) => t.name === "Position");
    const computed = fieldOffsetWithDiscriminator(
      position!.type.fields,
      "collateral_usd",
    );
    expect(computed).to.equal(FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET);
  });

  it("size_usd and collateral_usd are both u64", () => {
    const idl = FLASH_IDL as unknown as Idl;
    const position = idl.types.find((t) => t.name === "Position");
    const fields = position!.type.fields;
    expect(fields.find((f) => f.name === "size_usd")?.type).to.equal("u64");
    expect(fields.find((f) => f.name === "collateral_usd")?.type).to.equal(
      "u64",
    );
  });
});

// ─── Contract tests ───────────────────────────────────────────────────────

describe("flashTradeLeverageCap — contract", () => {
  it("valid construction produces a PostAssertionEntry the validator accepts", () => {
    const entry = flashTradeLeverageCap({
      positionAccount: POSITION_ACCOUNT,
      maxLeverage: 5,
    });
    // validator must NOT throw
    validatePostAssertionEntries([entry]);
    // sanity — the entry targets the correct account + CrossFieldLte shape
    expect(entry.targetAccount).to.equal(POSITION_ACCOUNT);
    expect(entry.offset).to.equal(FLASH_TRADE_POSITION_SIZE_USD_OFFSET);
    expect(entry.crossFieldOffsetB).to.equal(
      FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET,
    );
    // 5x leverage → 50_000 bps
    expect(entry.crossFieldMultiplierBps).to.equal(50_000);
    // CrossFieldLte enable bit = bit 0 of crossFieldFlags
    expect(entry.crossFieldFlags & 0x01).to.equal(0x01);
  });

  it("maxLeverage = 1 (boundary min) succeeds", () => {
    expect(() =>
      flashTradeLeverageCap({
        positionAccount: POSITION_ACCOUNT,
        maxLeverage: MIN_LEVERAGE_X,
      }),
    ).to.not.throw();
  });

  it("maxLeverage = 100 (boundary max) succeeds", () => {
    expect(() =>
      flashTradeLeverageCap({
        positionAccount: POSITION_ACCOUNT,
        maxLeverage: MAX_LEVERAGE_X,
      }),
    ).to.not.throw();
  });

  it("maxLeverage = 0 throws FlashTradeLeverageOutOfRangeError", () => {
    expect(() =>
      flashTradeLeverageCap({
        positionAccount: POSITION_ACCOUNT,
        maxLeverage: 0,
      }),
    ).to.throw(FlashTradeLeverageOutOfRangeError);
  });

  it("maxLeverage = 101 throws FlashTradeLeverageOutOfRangeError", () => {
    expect(() =>
      flashTradeLeverageCap({
        positionAccount: POSITION_ACCOUNT,
        maxLeverage: 101,
      }),
    ).to.throw(FlashTradeLeverageOutOfRangeError);
  });

  it("non-integer maxLeverage throws FlashTradeLeverageOutOfRangeError", () => {
    expect(() =>
      flashTradeLeverageCap({
        positionAccount: POSITION_ACCOUNT,
        maxLeverage: 5.5,
      }),
    ).to.throw(FlashTradeLeverageOutOfRangeError);
  });

  it("NaN maxLeverage throws FlashTradeLeverageOutOfRangeError", () => {
    expect(() =>
      flashTradeLeverageCap({
        positionAccount: POSITION_ACCOUNT,
        maxLeverage: NaN,
      }),
    ).to.throw(FlashTradeLeverageOutOfRangeError);
  });

  it("FlashTradeLeverageOutOfRangeError carries DxError-compatible code + recovery", () => {
    try {
      flashTradeLeverageCap({
        positionAccount: POSITION_ACCOUNT,
        maxLeverage: 0,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).to.be.instanceOf(FlashTradeLeverageOutOfRangeError);
      const typed = err as FlashTradeLeverageOutOfRangeError;
      expect(typed.code).to.equal(7009);
      expect(typed.message).to.include("maxLeverage");
      expect(typed.recovery).to.be.an("array").with.length.greaterThan(0);
      expect(typed.received).to.equal(0);
    }
  });
});
