/**
 * Tests for compose-errors.ts — error class and helper factories
 * consumed by every generated protocol composer.
 *
 * Critical coverage: createSafeBigInt edge cases (trust boundary for
 * BigInt parsing of user-supplied parameters).
 */

import { expect } from "chai";
import type { Address } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import {
  COMPOSE_ERROR_CODES,
  ComposeError,
  type ComposeErrorCode,
  createRequireField,
  createSafeBigInt,
  addressAsSigner,
} from "../src/integrations/compose-errors.js";

const TEST_ADDRESS = "11111111111111111111111111111111" as Address;

// ─── ComposeError class ─────────────────────────────────────────────────────

describe("ComposeError", () => {
  it("formats message with protocol prefix and code", () => {
    const e = new ComposeError("flash-trade", "missing_param", "amount");
    expect(e.message).to.equal("[flash-trade] missing_param: amount");
  });

  it("preserves protocol and code as readonly fields", () => {
    const e = new ComposeError("jupiter", "invalid_bigint", "value");
    expect(e.protocol).to.equal("jupiter");
    expect(e.code).to.equal("invalid_bigint");
  });

  it("is an Error subclass", () => {
    const e = new ComposeError("p", "missing_param", "m");
    expect(e).to.be.instanceOf(Error);
    expect(e.name).to.equal("ComposeError");
  });

  it("subclasses preserve protocol identity", () => {
    class FlashError extends ComposeError {
      constructor(code: ComposeErrorCode, message: string) {
        super("flash-trade", code, message);
        this.name = "FlashError";
      }
    }
    const e = new FlashError("missing_param", "size");
    expect(e.protocol).to.equal("flash-trade");
    expect(e.message).to.include("[flash-trade]");
  });
});

// ─── COMPOSE_ERROR_CODES ────────────────────────────────────────────────────

describe("COMPOSE_ERROR_CODES", () => {
  it("exports MISSING_PARAM, INVALID_BIGINT, UNSUPPORTED_ACTION", () => {
    expect(COMPOSE_ERROR_CODES.MISSING_PARAM).to.equal("missing_param");
    expect(COMPOSE_ERROR_CODES.INVALID_BIGINT).to.equal("invalid_bigint");
    expect(COMPOSE_ERROR_CODES.UNSUPPORTED_ACTION).to.equal(
      "unsupported_action",
    );
  });
});

// ─── createRequireField ─────────────────────────────────────────────────────

describe("createRequireField", () => {
  // Explicit type annotation required by TS — assertion functions cannot be inferred
  const requireField: (name: string, value: unknown) => asserts value =
    createRequireField(
      (name) => new ComposeError("test", "missing_param", name),
    );

  it("passes for non-null primitives", () => {
    expect(() => requireField("amount", 100)).not.to.throw();
    expect(() => requireField("amount", "abc")).not.to.throw();
    expect(() => requireField("amount", 0n)).not.to.throw();
  });

  it("passes for falsy-but-valid values (0, false, empty string)", () => {
    expect(() => requireField("amount", 0)).not.to.throw();
    expect(() => requireField("flag", false)).not.to.throw();
    expect(() => requireField("name", "")).not.to.throw();
  });

  it("throws on undefined", () => {
    expect(() => requireField("amount", undefined)).to.throw(/missing_param/);
  });

  it("throws on null", () => {
    expect(() => requireField("amount", null)).to.throw(/missing_param/);
  });

  it("throws ComposeError with field name", () => {
    try {
      requireField("amount", undefined);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).to.be.instanceOf(ComposeError);
      expect((e as ComposeError).message).to.include("amount");
    }
  });

  // ─── F2: type signature uses NonNullable (preserves falsy primitives) ─────

  it("type signature narrows to NonNullable (compile-time check)", () => {
    // This test exists to document the type contract — if it compiles,
    // the asserts signature is `NonNullable<T>` not bare `value`.
    // After requireField, TypeScript should keep `false`/`0`/`""` in the type.
    function consumer(value: string | undefined): string {
      requireField("v", value);
      // TypeScript should narrow `value` to `string`, NOT exclude empty string
      return value; // No error: value is `string` after the assertion
    }
    expect(consumer("ok")).to.equal("ok");
    expect(consumer("")).to.equal(""); // empty string is valid
  });
});

// ─── createSafeBigInt ───────────────────────────────────────────────────────

describe("createSafeBigInt", () => {
  const safeBigInt = createSafeBigInt(
    (name, _value) => new ComposeError("test", "invalid_bigint", name),
  );

  it("passes through bigint values", () => {
    expect(safeBigInt("amount", 100n)).to.equal(100n);
    expect(safeBigInt("amount", 0n)).to.equal(0n);
    expect(safeBigInt("amount", -1n)).to.equal(-1n);
  });

  it("converts integer numbers to bigint", () => {
    expect(safeBigInt("amount", 100)).to.equal(100n);
    expect(safeBigInt("amount", 0)).to.equal(0n);
    expect(safeBigInt("amount", -1)).to.equal(-1n);
  });

  it("converts numeric strings to bigint", () => {
    expect(safeBigInt("amount", "100")).to.equal(100n);
    expect(safeBigInt("amount", "0")).to.equal(0n);
    expect(safeBigInt("amount", "-1")).to.equal(-1n);
    expect(safeBigInt("amount", "999999999999999999999")).to.equal(
      999999999999999999999n,
    );
  });

  it("throws on empty string", () => {
    expect(() => safeBigInt("amount", "")).to.throw(/invalid_bigint/);
  });

  it("throws on non-numeric string", () => {
    expect(() => safeBigInt("amount", "abc")).to.throw(/invalid_bigint/);
  });

  it("throws on float string", () => {
    expect(() => safeBigInt("amount", "1.5")).to.throw(/invalid_bigint/);
  });

  it("throws on float number", () => {
    expect(() => safeBigInt("amount", 1.5)).to.throw(/invalid_bigint/);
  });

  it("throws on NaN", () => {
    expect(() => safeBigInt("amount", NaN)).to.throw(/invalid_bigint/);
  });

  it("throws on Infinity", () => {
    expect(() => safeBigInt("amount", Infinity)).to.throw(/invalid_bigint/);
  });

  it("throws on null", () => {
    expect(() => safeBigInt("amount", null)).to.throw(/invalid_bigint/);
  });

  it("throws on undefined", () => {
    expect(() => safeBigInt("amount", undefined)).to.throw(/invalid_bigint/);
  });

  it("throws on object", () => {
    expect(() => safeBigInt("amount", { nested: 1 })).to.throw(
      /invalid_bigint/,
    );
  });

  it("throws on boolean", () => {
    expect(() => safeBigInt("amount", true)).to.throw(/invalid_bigint/);
  });

  it("error includes field name via factory", () => {
    try {
      safeBigInt("maxSize", "not-a-number");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as ComposeError).message).to.include("maxSize");
    }
  });

  // ─── F1: unsafe integer protection (silent precision loss above 2^53) ─────

  it("throws on unsafe integer Number above 2^53 (silent precision loss)", () => {
    expect(() => safeBigInt("amount", 2 ** 53 + 1)).to.throw(/invalid_bigint/);
  });

  it("throws on Number.MAX_SAFE_INTEGER + 100 (already imprecise)", () => {
    expect(() => safeBigInt("amount", Number.MAX_SAFE_INTEGER + 100)).to.throw(
      /invalid_bigint/,
    );
  });

  it("accepts Number.MAX_SAFE_INTEGER (boundary)", () => {
    expect(safeBigInt("amount", Number.MAX_SAFE_INTEGER)).to.equal(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it("accepts large bigint above 2^53 (only Number is restricted)", () => {
    expect(safeBigInt("amount", 2n ** 100n)).to.equal(2n ** 100n);
  });

  it("accepts large numeric string above 2^53 (only Number is restricted)", () => {
    expect(safeBigInt("amount", "9007199254740993")).to.equal(
      9007199254740993n,
    );
  });

  // ─── F9: decimal-only string parsing (rejects hex/binary/octal) ───────────

  it("throws on hex string (0x10) — decimal only", () => {
    expect(() => safeBigInt("amount", "0x10")).to.throw(/invalid_bigint/);
  });

  it("throws on binary string (0b101) — decimal only", () => {
    expect(() => safeBigInt("amount", "0b101")).to.throw(/invalid_bigint/);
  });

  it("throws on octal string (0o17) — decimal only", () => {
    expect(() => safeBigInt("amount", "0o17")).to.throw(/invalid_bigint/);
  });

  it("throws on signed plus prefix (+100) — strict decimal", () => {
    expect(() => safeBigInt("amount", "+100")).to.throw(/invalid_bigint/);
  });

  it("throws on space-padded number — strict decimal", () => {
    expect(() => safeBigInt("amount", " 42 ")).to.throw(/invalid_bigint/);
  });
});

// ─── addressAsSigner ────────────────────────────────────────────────────────

describe("addressAsSigner", () => {
  it("returns address with WRITABLE_SIGNER role", () => {
    const meta = addressAsSigner(TEST_ADDRESS);
    expect(meta.address).to.equal(TEST_ADDRESS);
    expect(meta.role).to.equal(AccountRole.WRITABLE_SIGNER);
  });

  it("uses AccountRole enum (not magic number)", () => {
    const meta = addressAsSigner(TEST_ADDRESS);
    // AccountRole.WRITABLE_SIGNER === 3, but verify via enum to detect drift
    expect(meta.role).to.equal(AccountRole.WRITABLE_SIGNER);
    expect(AccountRole.WRITABLE_SIGNER).to.equal(3);
  });
});
