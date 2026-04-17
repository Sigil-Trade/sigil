import { describe, it } from "mocha";
import { expect } from "chai";

import { parseUsd } from "../../src/helpers/parse-usd.js";
import { SIGIL_ERROR__SDK__INVALID_AMOUNT } from "../../src/errors/codes.js";
import { SigilSdkDomainError } from "../../src/errors/sdk.js";

describe("parseUsd — happy path", () => {
  it("$0 → 0n", () => {
    expect(parseUsd("$0")).to.equal(0n);
  });

  it("$0.01 → 10_000n (one cent)", () => {
    expect(parseUsd("$0.01")).to.equal(10_000n);
  });

  it("$1 → 1_000_000n", () => {
    expect(parseUsd("$1")).to.equal(1_000_000n);
  });

  it("$1.5 → 1_500_000n (right-pads fractional to 6 decimals)", () => {
    expect(parseUsd("$1.5")).to.equal(1_500_000n);
  });

  it("$100.000001 → 100_000_001n (full 6-decimal precision)", () => {
    expect(parseUsd("$100.000001")).to.equal(100_000_001n);
  });

  it("$999999999999999 → 999_999_999_999_999_000_000n (15-digit whole max)", () => {
    expect(parseUsd("$999999999999999")).to.equal(999_999_999_999_999_000_000n);
  });

  it("$500 → 500_000_000n (plan SAFETY_PRESETS.development daily cap)", () => {
    expect(parseUsd("$500")).to.equal(500_000_000n);
  });

  it("$100 → 100_000_000n (plan SAFETY_PRESETS.development per-agent cap)", () => {
    expect(parseUsd("$100")).to.equal(100_000_000n);
  });
});

describe("parseUsd — malformed input", () => {
  const cases: Array<{ input: string; reason: string }> = [
    { input: "1.0", reason: "missing leading $" },
    { input: "$", reason: "empty amount after $" },
    { input: "$1.", reason: "trailing dot, no fraction digits" },
    { input: "$1.1234567", reason: "more than 6 fractional digits" },
    { input: "$-1", reason: "negative sign not allowed" },
    { input: "$1,000", reason: "commas (thousands separators) not allowed" },
    { input: "$1e3", reason: "exponent notation not allowed" },
    { input: "$1 ", reason: "trailing whitespace not allowed" },
    { input: " $1", reason: "leading whitespace not allowed" },
    { input: "$$1", reason: "double dollar sign not allowed" },
    { input: "$1.5a", reason: "non-digit suffix not allowed" },
    { input: "$1234567890123456", reason: "more than 15 whole digits" },
    { input: "", reason: "empty string" },
    { input: "$1.5.2", reason: "multiple decimal points not allowed" },
    { input: "$00", reason: "leading-zero whole (H4 fix)" },
    { input: "$01", reason: "leading-zero whole (H4 fix)" },
    { input: "$007", reason: "leading-zero whole (H4 fix)" },
    { input: "$0100.5", reason: "leading-zero whole (H4 fix)" },
  ];

  for (const { input, reason } of cases) {
    it(`rejects "${input}" (${reason})`, () => {
      expect(() => parseUsd(input)).to.throw(SigilSdkDomainError);
    });
  }

  it("error carries SIGIL_ERROR__SDK__INVALID_AMOUNT code", () => {
    try {
      parseUsd("$1,000");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_AMOUNT,
      );
    }
  });

  it("error context includes the original input", () => {
    try {
      parseUsd("$bad");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      const ctx = (err as SigilSdkDomainError).context as { input?: string };
      expect(ctx?.input).to.equal("$bad");
    }
  });
});

describe("parseUsd — type guard", () => {
  it("rejects non-string input with INVALID_AMOUNT error", () => {
    expect(() => parseUsd(42 as unknown as string)).to.throw(
      SigilSdkDomainError,
    );
    expect(() => parseUsd(null as unknown as string)).to.throw(
      SigilSdkDomainError,
    );
    expect(() => parseUsd(undefined as unknown as string)).to.throw(
      SigilSdkDomainError,
    );
  });
});
