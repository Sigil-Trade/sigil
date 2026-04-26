/**
 * Unit tests for the FE↔BE contract v2.2 commitment C2 additions:
 *
 *   1. `DxError.onChainReverted: boolean` — always populated by
 *      `toDxError()`; structural contract for any subclass / direct
 *      construction.
 *   2. `categorizeDxError(e)` — FE routing helper mapping DxError.code
 *      to one of four category strings.
 *   3. `isOnChainReverted(code)` — boolean helper used internally AND
 *      exposed to consumers for targeted 6000-range UI routing.
 *
 * Boundary coverage is the point of this file — the category boundaries
 * between 5999/6000, 6074/6075, 6999/7000, 7099/7100, 7199/7200, and the
 * `DX_ERROR_CODE_UNMAPPED` (7999) sentinel must all route deterministically.
 * A future range split (e.g., RPC codes gaining a new subrange) would
 * fail here first.
 */
import { expect } from "chai";
import {
  toDxError,
  categorizeDxError,
  isOnChainReverted,
  DX_ERROR_CODE_UNMAPPED,
  type DxErrorCategory,
} from "../../src/dashboard/errors.js";
import type { DxError } from "../../src/dashboard/types.js";

// ─── isOnChainReverted ────────────────────────────────────────────────────

describe("isOnChainReverted — exact range boundaries", () => {
  it("true at 6000 (lower bound)", () => {
    expect(isOnChainReverted(6000)).to.equal(true);
  });

  it("true at 6074 (upper bound)", () => {
    expect(isOnChainReverted(6074)).to.equal(true);
  });

  it("false at 5999 (one below)", () => {
    expect(isOnChainReverted(5999)).to.equal(false);
  });

  it("false at 6075 (one above)", () => {
    expect(isOnChainReverted(6075)).to.equal(false);
  });

  it("false for 0 (zero sentinel)", () => {
    expect(isOnChainReverted(0)).to.equal(false);
  });

  it("false for NaN", () => {
    expect(isOnChainReverted(NaN)).to.equal(false);
  });

  it("false for Infinity", () => {
    expect(isOnChainReverted(Infinity)).to.equal(false);
  });

  it("false for negative numbers", () => {
    expect(isOnChainReverted(-1)).to.equal(false);
    expect(isOnChainReverted(-6000)).to.equal(false);
  });
});

// ─── categorizeDxError — boundary coverage ───────────────────────────────

describe("categorizeDxError — exact range boundaries", () => {
  const cases: Array<{
    code: number;
    category: DxErrorCategory;
    description: string;
  }> = [
    // Program range (Anchor 6000-6074)
    { code: 6000, category: "program", description: "program lower bound" },
    { code: 6074, category: "program", description: "program upper bound" },
    { code: 6030, category: "program", description: "mid program range" },

    // User / SDK range (7000-7099)
    { code: 7000, category: "user", description: "user lower bound" },
    { code: 7099, category: "user", description: "user upper bound" },
    { code: 7033, category: "user", description: "mid user range" },

    // Network / RPC range (7100-7199)
    { code: 7100, category: "network", description: "network lower bound" },
    { code: 7199, category: "network", description: "network upper bound" },
    { code: 7150, category: "network", description: "mid network range" },

    // Unknown — outside all defined ranges
    { code: 5999, category: "unknown", description: "one below program range" },
    { code: 6075, category: "unknown", description: "one above program range" },
    { code: 6999, category: "unknown", description: "one below user range" },
    { code: 7200, category: "unknown", description: "one above network range" },
    { code: 7999, category: "unknown", description: "DX_ERROR_CODE_UNMAPPED" },
    { code: 0, category: "unknown", description: "zero" },
  ];

  for (const { code, category, description } of cases) {
    it(`code ${code} → "${category}" (${description})`, () => {
      expect(categorizeDxError({ code })).to.equal(category);
    });
  }

  it("handles NaN as 'unknown'", () => {
    expect(categorizeDxError({ code: NaN })).to.equal("unknown");
  });

  it("handles Infinity as 'unknown'", () => {
    expect(categorizeDxError({ code: Infinity })).to.equal("unknown");
  });

  it("DX_ERROR_CODE_UNMAPPED constant resolves to unknown", () => {
    expect(categorizeDxError({ code: DX_ERROR_CODE_UNMAPPED })).to.equal(
      "unknown",
    );
  });
});

// ─── toDxError — onChainReverted population ──────────────────────────────

describe("toDxError — populates onChainReverted", () => {
  it("normalized DxError carries onChainReverted=false for unmapped error", () => {
    // Force the catch-fallback path: pass a bare Error object that
    // toAgentError can't classify.
    const err = new Error("transport level error");
    const dx = toDxError(err);
    expect(dx.onChainReverted).to.equal(false);
    expect(dx.code).to.equal(DX_ERROR_CODE_UNMAPPED);
  });

  it("normalized DxError carries onChainReverted=true for Anchor code", () => {
    // Simulate a Solana TransactionError with a custom program error at
    // hex 0x1770 = 6000 (SpendingCapExceeded is 6006 / 0x1776, but 0x1770
    // is the first code in the range — confirms the boundary routes
    // correctly through toAgentError → resolveDxCode → isOnChainReverted).
    const err = { message: "custom program error: 0x1776" };
    const dx = toDxError(err);
    expect(dx.code).to.be.at.least(6000);
    expect(dx.code).to.be.at.most(6074);
    expect(dx.onChainReverted).to.equal(true);
  });

  it("DxError is shaped correctly (all 4 required fields present)", () => {
    const dx = toDxError(new Error("test"));
    expect(dx).to.have.property("code").that.is.a("number");
    expect(dx).to.have.property("message").that.is.a("string");
    expect(dx).to.have.property("recovery").that.is.an("array");
    expect(dx).to.have.property("onChainReverted").that.is.a("boolean");
  });

  it("context prefix preserved on normalized error", () => {
    const dx = toDxError(new Error("inner"), "createVault");
    expect(dx.message).to.include("createVault:");
    expect(dx.message).to.include("inner");
  });
});

// ─── categorizeDxError + toDxError composition ───────────────────────────

describe("categorizeDxError + toDxError compose consistently", () => {
  it("a toDxError result routes to the correct category", () => {
    const dx: DxError = toDxError({ message: "custom program error: 0x1776" });
    expect(categorizeDxError(dx)).to.equal("program");
    expect(dx.onChainReverted).to.equal(true);
  });

  it("a fallback DxError routes to 'unknown'", () => {
    const dx: DxError = toDxError(new Error("unclassifiable"));
    expect(categorizeDxError(dx)).to.equal("unknown");
    expect(dx.onChainReverted).to.equal(false);
  });
});
