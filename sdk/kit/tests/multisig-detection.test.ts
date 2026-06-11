/**
 * Phase 9 Batch E — unit tests for multisig-detection (ISC-12..15, 98, 99, 149).
 *
 * Focus: pure-function checks on the exported discriminator + the
 * SquadsV4 program-ID constant. The RPC-driven `isSquadsV4Owned` path
 * is exercised via LiteSVM elsewhere; here we lock down the local
 * invariants so a regen of the SQUADS V4 SDK or a tweak to the
 * discriminator derivation surfaces immediately.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import {
  SQUADS_V4_MULTISIG_DISCRIMINATOR,
  SQUADS_V4_PROGRAM_ID,
} from "../src/multisig-detection.js";

describe("multisig-detection — invariants", () => {
  it("discriminator is exactly 8 bytes", () => {
    expect(SQUADS_V4_MULTISIG_DISCRIMINATOR).to.be.instanceOf(Uint8Array);
    expect(SQUADS_V4_MULTISIG_DISCRIMINATOR).to.have.lengthOf(8);
  });

  it('discriminator derives deterministically from sha256("account:Multisig")', () => {
    // Re-derive in-test to confirm the module-load computation matches
    // the documented formula. Any drift (e.g. someone changing the tag
    // string or the slice length) fails this test, not silently in prod.
    const tag = new TextEncoder().encode("account:Multisig");
    // Lazy require of the same helper used at module load, so this is a
    // true round-trip check rather than a self-tautology.
    const { sha256 } = require("../src/canonical-encode.js");
    const expected = sha256(tag).slice(0, 8) as Uint8Array;
    expect(Array.from(SQUADS_V4_MULTISIG_DISCRIMINATOR)).to.deep.equal(
      Array.from(expected),
    );
  });

  it("SQUADS_V4_PROGRAM_ID matches the published Squads V4 mainnet+devnet address", () => {
    // Cross-check against the value in Squads V4 docs as of 2026-05-18
    // (https://docs.squads.so/main/v/development/squads-v4/program-addresses).
    expect(SQUADS_V4_PROGRAM_ID).to.equal(
      "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
    );
  });
});
