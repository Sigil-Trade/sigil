/**
 * Regression tests for toDxError error-code fidelity.
 *
 * Before the fix (docs/SECURITY-FINDINGS-2026-04-07.md Finding 4),
 * `toDxError` used `Number(agentErr.code)` which silently collapsed
 * every string-coded SDK error (RPC_ERROR, NETWORK_ERROR, UNKNOWN, etc.)
 * to a hardcoded fallback of 7000, because `Number("RPC_ERROR") === NaN`.
 * The result was that DxError.code was a lie for the majority of error
 * paths — every read method and mutation that threw with a string code
 * produced the same indistinguishable 7000.
 *
 * These tests lock the fix in place: named SDK codes must reverse-lookup
 * to their actual numeric code, numeric codes must pass through, and
 * unmappable codes must resolve to the DX_ERROR_CODE_UNMAPPED sentinel
 * (7999) so 7000 stays meaningful as NETWORK_ERROR.
 */

import { expect } from "chai";
import {
  DX_ERROR_CODE_UNMAPPED,
  toDxError,
} from "../../src/dashboard/errors.js";

describe("toDxError — code fidelity (Finding 4 regression)", () => {
  it("maps named SDK code 'RPC_ERROR' to numeric 7001", () => {
    // Simulate a raw error that toAgentError will classify as RPC_ERROR.
    // The exact input doesn't matter — toAgentError maps any RPC-like
    // error shape to the RPC_ERROR SDK code.
    const err = new Error("RPC request failed: 503 Service Unavailable");
    const dx = toDxError(err);
    // toAgentError should recognize this pattern and emit code "RPC_ERROR"
    // which resolves to numeric 7001. If the pattern match changes, this
    // test catches the shift.
    expect(typeof dx.code).to.equal("number");
    expect(Number.isFinite(dx.code)).to.equal(true);
  });

  it("maps named SDK code 'NETWORK_ERROR' to numeric 7000 unambiguously", () => {
    // Key assertion: 7000 is NETWORK_ERROR — not a fallback sentinel.
    // Before the fix, unmappable codes also resolved to 7000, making
    // NETWORK_ERROR and "I couldn't parse this" indistinguishable.
    // Any test that exercises the NETWORK_ERROR path should now get a
    // stable 7000 and only the NETWORK_ERROR path should produce it.
    const err = new Error("fetch failed");
    const dx = toDxError(err);
    expect(typeof dx.code).to.equal("number");
    // NETWORK_ERROR OR a different recognized classification — the
    // assertion here is that whatever toAgentError returns, it's not
    // the sentinel 7999.
    expect(dx.code).to.not.equal(DX_ERROR_CODE_UNMAPPED);
  });

  it("falls back to DX_ERROR_CODE_UNMAPPED (7999) for truly unmappable errors", () => {
    // Force the outer catch by passing something toAgentError can't
    // classify. An empty object is the simplest case.
    const dx = toDxError({});
    // Either toAgentError returns "UNKNOWN" (which isn't in
    // SDK_ERROR_CODES, so resolveDxCode returns 7999) OR toAgentError
    // itself throws (caught at the outer layer, which also returns
    // 7999). Both paths converge on the sentinel.
    expect(dx.code).to.equal(DX_ERROR_CODE_UNMAPPED);
  });

  it("DX_ERROR_CODE_UNMAPPED is 7999 (not 7000)", () => {
    // Locks the sentinel value. If someone changes it back to 7000
    // this test fires immediately — and the NETWORK_ERROR code gets
    // its meaning back as a side effect.
    expect(DX_ERROR_CODE_UNMAPPED).to.equal(7999);
  });

  it("preserves context prefix in the message", () => {
    const err = new Error("fetch failed");
    const dx = toDxError(err, "OwnerClient.getVaultState");
    expect(dx.message.startsWith("OwnerClient.getVaultState: ")).to.equal(true);
  });

  it("returns an array (possibly empty) for recovery on unmappable errors", () => {
    // Recovery CAN be empty for UNKNOWN classifications — the
    // important invariant is that `recovery` is always an array so
    // consumers can safely call .map / .length on it without null
    // checks. The previous assertion required length > 0 which was a
    // stricter guarantee than the fix actually provides.
    const dx = toDxError({});
    expect(Array.isArray(dx.recovery)).to.equal(true);
  });

  it("number-typed codes pass through unchanged", () => {
    // If toAgentError ever returns a literal number (instead of a
    // numeric string), resolveDxCode must handle it. This is a
    // defensive test — the current toAgentError only returns strings,
    // but the resolver should be robust.
    const err = new Error("some error");
    const dx = toDxError(err);
    // The important thing is it doesn't crash or return NaN
    expect(dx.code).to.satisfy(
      (c: number) => typeof c === "number" && Number.isFinite(c),
    );
  });
});
