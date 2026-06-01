// Parity test for tests/helpers/intent-digest-fixture.ts.
//
// Asserts byte-equality between:
//   1. Pinned hex vectors in tests/fixtures/intent-digest.json (canonical
//      reference, generated from the same byte-layout the on-chain Rust
//      handler uses)
//   2. The LiteSVM-test-side helper buildExpectedIntentDigest
//
// The pinned vectors are the cross-impl source of truth. The SDK kit's own
// AL3 fixture suite validates the TS side under sdk/kit/tests/al-envelope/.
// Rust↔helper parity is asserted at runtime in every validate_and_authorize
// integration test — if the helper drifts, ErrIntentDigestMismatch (6102)
// fires on-chain. We do NOT import the SDK kit directly here because that
// package is ESM-only (`"type": "module"`) and the LiteSVM test runner is
// CJS via ts-mocha + tsconfig `module: commonjs`.
//
// If this test ever fails, ALL ~135 success-path validate_and_authorize
// callsites are at risk of silently mismatching the on-chain verifier.
// Treat any failure here as P0.

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  buildExpectedIntentDigest,
  digestAsArgs,
  INTENT_DIGEST_MAGIC,
  INTENT_VERSION_V2,
  NETWORK_ID_DEVNET,
  NETWORK_ID_MAINNET,
  INTENT_DIGEST_BUFFER_BYTES,
  INTENT_DIGEST_OUTPUT_BYTES,
  ZERO_INTENT_DIGEST,
} from "./helpers/intent-digest-fixture";

interface PinnedVector {
  label: string;
  vault: string;
  agent: string;
  tokenMint: string;
  amount: string;
  targetProtocol: string;
  network: "devnet" | "mainnet";
  digestHex: string;
}

const FIXTURE_PATH = resolve(__dirname, "fixtures/intent-digest.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  vectors: PinnedVector[];
};

describe("D-1 scalar intent-digest fixture parity", () => {
  it("magic prefix is the 4 ASCII bytes for SIG1", () => {
    expect(INTENT_DIGEST_MAGIC.toString("ascii")).to.equal("SIG1");
    expect(Array.from(INTENT_DIGEST_MAGIC)).to.deep.equal([
      0x53, 0x49, 0x47, 0x31,
    ]);
  });

  it("constants match canonical encoding spec", () => {
    expect(INTENT_VERSION_V2).to.equal(2);
    expect(NETWORK_ID_DEVNET).to.equal(0);
    expect(NETWORK_ID_MAINNET).to.equal(1);
    expect(INTENT_DIGEST_BUFFER_BYTES).to.equal(142);
    expect(INTENT_DIGEST_OUTPUT_BYTES).to.equal(32);
  });

  it("ZERO_INTENT_DIGEST is 32 zero bytes", () => {
    expect(ZERO_INTENT_DIGEST).to.have.length(32);
    expect(ZERO_INTENT_DIGEST.every((b) => b === 0)).to.equal(true);
  });

  fixture.vectors.forEach((v) => {
    it(`pinned vector parity — ${v.label}`, () => {
      const digest = buildExpectedIntentDigest({
        vault: new PublicKey(v.vault),
        agent: new PublicKey(v.agent),
        tokenMint: new PublicKey(v.tokenMint),
        amount: BigInt(v.amount),
        targetProtocol: new PublicKey(v.targetProtocol),
        network: v.network,
      });
      expect(digest.toString("hex")).to.equal(v.digestHex);
      expect(digest).to.have.length(32);
    });
  });

  it("amount tamper changes the digest", () => {
    const v = fixture.vectors[1];
    const baseline = buildExpectedIntentDigest({
      vault: new PublicKey(v.vault),
      agent: new PublicKey(v.agent),
      tokenMint: new PublicKey(v.tokenMint),
      amount: BigInt(v.amount),
      targetProtocol: new PublicKey(v.targetProtocol),
      network: v.network,
    });
    const tampered = buildExpectedIntentDigest({
      vault: new PublicKey(v.vault),
      agent: new PublicKey(v.agent),
      tokenMint: new PublicKey(v.tokenMint),
      amount: BigInt(v.amount) + 1n,
      targetProtocol: new PublicKey(v.targetProtocol),
      network: v.network,
    });
    expect(baseline.toString("hex")).to.not.equal(tampered.toString("hex"));
  });

  it("network flip changes the digest (devnet vs mainnet)", () => {
    const devnet = fixture.vectors[1];
    const mainnet = fixture.vectors[2];
    expect(devnet.digestHex).to.not.equal(mainnet.digestHex);
  });

  it("targetProtocol defaults to system program when omitted", () => {
    const explicit = buildExpectedIntentDigest({
      vault: new PublicKey("11111111111111111111111111111112"),
      agent: new PublicKey("11111111111111111111111111111113"),
      tokenMint: new PublicKey("So11111111111111111111111111111111111111112"),
      amount: 1n,
      targetProtocol: PublicKey.default,
      network: "devnet",
    });
    const omitted = buildExpectedIntentDigest({
      vault: new PublicKey("11111111111111111111111111111112"),
      agent: new PublicKey("11111111111111111111111111111113"),
      tokenMint: new PublicKey("So11111111111111111111111111111111111111112"),
      amount: 1n,
      network: "devnet",
    });
    expect(explicit.toString("hex")).to.equal(omitted.toString("hex"));
  });

  it("negative amount throws", () => {
    expect(() =>
      buildExpectedIntentDigest({
        vault: PublicKey.default,
        agent: PublicKey.default,
        tokenMint: PublicKey.default,
        amount: -1n,
      } as never),
    ).to.throw(/non-negative/);
  });

  it("digestAsArgs rejects non-32-byte inputs", () => {
    expect(() => digestAsArgs(Buffer.alloc(31))).to.throw(/expected 32/);
    expect(() => digestAsArgs(Buffer.alloc(33))).to.throw(/expected 32/);
  });

  it("digestAsArgs returns number[] of length 32", () => {
    const digest = buildExpectedIntentDigest({
      vault: PublicKey.default,
      agent: PublicKey.default,
      tokenMint: PublicKey.default,
      amount: 0n,
      targetProtocol: PublicKey.default,
      network: "devnet",
    });
    const args = digestAsArgs(digest);
    expect(args).to.have.length(32);
    args.forEach((b) => {
      expect(b).to.be.a("number");
      expect(b).to.be.at.least(0);
      expect(b).to.be.at.most(255);
    });
  });
});
