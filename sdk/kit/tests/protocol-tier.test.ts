/**
 * Unit tests for `@usesigil/kit/protocol-tier`.
 *
 * Locks the tier-resolver contract from FE↔BE contract §5c:
 *   1. Verified programIds short-circuit WITHOUT calling the async check.
 *   2. Unknown programIds with `constrainable: true` → `"unverified"`.
 *   3. Unknown programIds with `constrainable: false` → `"non-constrainable"`.
 *   4. Errors from the caller-provided check propagate — no silent catch.
 */
import { expect } from "chai";
import {
  resolveProtocolTier,
  type CheckConstrainabilityFn,
  type ConstrainabilityResult,
} from "../src/protocol-tier.js";
import { PROTOCOL_ANNOTATIONS } from "../src/protocol-registry/index.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const UNKNOWN_PROGRAM_ID = "11111111111111111111111111111111";

/** Spy that records invocations + returns a configurable result. */
function makeCheckSpy(result: ConstrainabilityResult | Error): {
  fn: CheckConstrainabilityFn;
  calls: string[];
} {
  const calls: string[] = [];
  const fn: CheckConstrainabilityFn = async (programId) => {
    calls.push(programId);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fn, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("resolveProtocolTier — verified short-circuit", () => {
  it("returns 'verified' for a known Jupiter programId WITHOUT calling check", async () => {
    const jupiter = PROTOCOL_ANNOTATIONS.find((a) => a.name === "Jupiter");
    expect(jupiter, "Jupiter annotation present").to.exist;

    const spy = makeCheckSpy({ constrainable: true, idlSource: "registry" }); // would return 'unverified' if called
    const tier = await resolveProtocolTier(jupiter!.programId, spy.fn);

    expect(tier).to.equal("verified");
    expect(spy.calls, "check was NOT called").to.have.lengthOf(0);
  });

  it("returns 'verified' for every registered annotation", async () => {
    // Parametric — the spy SHOULD never be called because every one of these
    // is in the verified registry.
    const spy = makeCheckSpy({ constrainable: false, reason: "missing_idl" });
    for (const a of PROTOCOL_ANNOTATIONS) {
      const tier = await resolveProtocolTier(a.programId, spy.fn);
      expect(tier, `${a.name} resolves to verified`).to.equal("verified");
    }
    expect(
      spy.calls,
      "check never called for any verified program",
    ).to.have.lengthOf(0);
  });
});

describe("resolveProtocolTier — unverified / non-constrainable fallthrough", () => {
  it("returns 'unverified' when check returns constrainable=true", async () => {
    const spy = makeCheckSpy({
      constrainable: true,
      idlSource: "on_chain_metadata",
    });
    const tier = await resolveProtocolTier(UNKNOWN_PROGRAM_ID, spy.fn);

    expect(tier).to.equal("unverified");
    expect(spy.calls, "check called exactly once").to.have.lengthOf(1);
    expect(spy.calls[0]).to.equal(UNKNOWN_PROGRAM_ID);
  });

  it("returns 'non-constrainable' when check returns constrainable=false", async () => {
    const spy = makeCheckSpy({
      constrainable: false,
      reason: "missing_idl",
      detail: "No Anchor IDL account found on-chain",
    });
    const tier = await resolveProtocolTier(UNKNOWN_PROGRAM_ID, spy.fn);

    expect(tier).to.equal("non-constrainable");
    expect(spy.calls, "check called exactly once").to.have.lengthOf(1);
  });

  it("returns 'non-constrainable' for each reason code", async () => {
    const reasons = [
      "missing_idl",
      "binary_only",
      "dynamic_layout",
      "parser_error",
    ] as const;
    for (const reason of reasons) {
      const spy = makeCheckSpy({ constrainable: false, reason });
      const tier = await resolveProtocolTier(UNKNOWN_PROGRAM_ID, spy.fn);
      expect(tier, `reason=${reason}`).to.equal("non-constrainable");
    }
  });
});

describe("resolveProtocolTier — error propagation", () => {
  it("propagates a thrown error from checkConstrainability (no silent catch)", async () => {
    const spy = makeCheckSpy(new Error("RPC timeout"));

    let thrown: unknown = null;
    try {
      await resolveProtocolTier(UNKNOWN_PROGRAM_ID, spy.fn);
    } catch (err) {
      thrown = err;
    }

    expect(thrown, "error propagated").to.be.instanceOf(Error);
    expect((thrown as Error).message).to.include("RPC timeout");
    expect(spy.calls, "check was called before throwing").to.have.lengthOf(1);
  });

  it("does NOT call checkConstrainability when the programId is verified, so a bad implementation never fires", async () => {
    // Defensive: a caller's check might be broken. Verified short-circuit
    // means the whole tier resolver still works for the core registry-hit
    // case even if the async backend is misconfigured.
    const spy = makeCheckSpy(new Error("would throw if called"));
    const jupiter = PROTOCOL_ANNOTATIONS[0];
    const tier = await resolveProtocolTier(jupiter.programId, spy.fn);
    expect(tier).to.equal("verified");
    expect(spy.calls).to.have.lengthOf(0);
  });
});
