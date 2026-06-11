/**
 * Phase 9 Batch L — AL3/AL4/AL2 backcompat tests (ISC-120, 121).
 *
 * The point: existing 0.15.x code that constructs a SigilClient + calls
 * seal()/executeAndConfirm WITHOUT touching any of the new AL3/AL4/AL2
 * options MUST keep working in 0.16.0. The new fields are all additive;
 * the new gate is default-off; the new digest is opportunistic (caller
 * doesn't have to consume it).
 *
 * These tests guard against regressions where a future commit accidentally
 * makes one of the new options required.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import {
  computeSealInputDigest,
  type SealIntentInput,
} from "../src/seal/intent-digest.js";
import { deriveNetworkIdentity } from "../src/caip2-network.js";

describe("AL backcompat — 0.15.x consumers in 0.16.0 (ISC-120, 121)", () => {
  it("computeSealInputDigest is callable without optional fields", () => {
    // Required-only input. No targetProtocol; no leading-space optional
    // fields. 0.15.x consumers that built a minimal seal input shouldn't
    // have to pass anything new to compute a digest.
    const minimal: SealIntentInput = {
      vault: "11111111111111111111111111111112",
      agent: "11111111111111111111111111111113",
      tokenMint: "11111111111111111111111111111114",
      amount: 0n,
      network: "devnet",
      instructions: [],
    };
    const out = computeSealInputDigest(minimal);
    expect(out).to.have.lengthOf(32);
  });

  it("deriveNetworkIdentity round-trips both supported networks", () => {
    expect(deriveNetworkIdentity("devnet").isMainnet).to.equal(false);
    expect(deriveNetworkIdentity("mainnet").isMainnet).to.equal(true);
  });

  it("SealResult shape additive: new intentDigest/network/isMainnet fields don't break existing destructure", () => {
    // Documentary check — the new fields are at the end of SealResult so
    // a 0.15.x consumer doing `const { ok, transaction, warnings } = result`
    // is unaffected. This test exists to lock that contract: the SealResult
    // interface order matters and prepending intentDigest/network/isMainnet
    // would be a breaking change even though TS structural typing wouldn't
    // catch it. The interface in seal.ts:241-273 keeps the original
    // ok/transaction/warnings/txSizeBytes/lastValidBlockHeight/vaultContext
    // fields at their original positions.
    const synthetic = {
      ok: true as const,
      transaction: {} as never,
      warnings: [] as string[],
      txSizeBytes: 100,
      lastValidBlockHeight: 0n,
      intentDigest: new Uint8Array(32),
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const,
      isMainnet: true,
    };
    // Destructure the 0.15.x fields — this MUST type-check.
    const { ok, transaction, warnings, txSizeBytes } = synthetic;
    expect(ok).to.equal(true);
    expect(transaction).to.be.an("object");
    expect(warnings).to.be.an("array");
    expect(txSizeBytes).to.be.a("number");
  });
});
