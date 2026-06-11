/**
 * Unit tests for the shared canonical-encode primitives extracted from
 * `compute-policy-preview-digest.ts` (Phase 9 Batch C).
 *
 * Discipline: every primitive that TA-19 and AL3 will share MUST round-trip
 * byte-equal against a hand-encoded reference. A regression here would
 * silently invalidate every previously-signed policy preview digest AND
 * every future intent digest.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import {
  base58Decode32,
  digestsEqual,
  sha256,
  writeBool,
  writeU16Le,
  writeU32Le,
  writeU64Le,
  writeU8,
} from "../src/canonical-encode.js";

describe("canonical-encode — base58Decode32", () => {
  it("decodes the system program ID to 32 zero bytes", () => {
    const out = base58Decode32("11111111111111111111111111111111");
    expect(out).to.have.lengthOf(32);
    for (const byte of out) {
      expect(byte).to.equal(0);
    }
  });

  it("decodes a known 32-byte pubkey reversibly", () => {
    const pk = "So11111111111111111111111111111111111111112";
    const out = base58Decode32(pk);
    expect(out).to.have.lengthOf(32);
    expect(out[31]).to.equal(1);
  });

  it("rejects empty input", () => {
    expect(() => base58Decode32("")).to.throw("empty input");
  });

  it("rejects invalid base58 characters", () => {
    expect(() => base58Decode32("0OIl11111111111111111111111111111")).to.throw(
      "invalid char",
    );
  });

  it("rejects input that decodes to length != 32", () => {
    expect(() => base58Decode32("abc")).to.throw("expected 32-byte");
  });
});

describe("canonical-encode — cursor writers (little-endian)", () => {
  it("writeU8 stores a single byte and advances by 1", () => {
    const buf = new Uint8Array(2);
    const view = new DataView(buf.buffer);
    const next = writeU8(view, 0, 0xff);
    expect(next).to.equal(1);
    expect(buf[0]).to.equal(0xff);
    expect(buf[1]).to.equal(0);
  });

  it("writeU16Le stores 2 bytes little-endian", () => {
    const buf = new Uint8Array(2);
    const view = new DataView(buf.buffer);
    const next = writeU16Le(view, 0, 0x1234);
    expect(next).to.equal(2);
    expect(buf[0]).to.equal(0x34);
    expect(buf[1]).to.equal(0x12);
  });

  it("writeU32Le stores 4 bytes little-endian", () => {
    const buf = new Uint8Array(4);
    const view = new DataView(buf.buffer);
    const next = writeU32Le(view, 0, 0xdeadbeef);
    expect(next).to.equal(4);
    expect(buf[0]).to.equal(0xef);
    expect(buf[1]).to.equal(0xbe);
    expect(buf[2]).to.equal(0xad);
    expect(buf[3]).to.equal(0xde);
  });

  it("writeU64Le stores 8 bytes little-endian", () => {
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    const next = writeU64Le(view, 0, 0x0123456789abcdefn);
    expect(next).to.equal(8);
    expect(Array.from(buf)).to.deep.equal([
      0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01,
    ]);
  });

  it("writeBool encodes true as 1, false as 0 (Borsh convention)", () => {
    const buf = new Uint8Array(2);
    const view = new DataView(buf.buffer);
    let off = writeBool(view, 0, true);
    off = writeBool(view, off, false);
    expect(buf[0]).to.equal(1);
    expect(buf[1]).to.equal(0);
    expect(off).to.equal(2);
  });
});

describe("canonical-encode — sha256 + digestsEqual", () => {
  it("sha256 produces 32 bytes", () => {
    const out = sha256(new Uint8Array(0));
    expect(out).to.have.lengthOf(32);
  });

  it("sha256 of empty input matches the well-known NIST vector", () => {
    // SHA-256 of "" = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const out = sha256(new Uint8Array(0));
    const hex = Array.from(out)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).to.equal(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("sha256 is deterministic across calls", () => {
    const input = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const a = sha256(input);
    const b = sha256(input);
    expect(digestsEqual(a, b)).to.equal(true);
  });

  it("digestsEqual returns false for differing length", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(digestsEqual(a, b)).to.equal(false);
  });

  it("digestsEqual returns true for byte-identical inputs", () => {
    const a = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const b = new Uint8Array([0xaa, 0xbb, 0xcc]);
    expect(digestsEqual(a, b)).to.equal(true);
  });

  it("digestsEqual returns false for differing inputs (constant-time check)", () => {
    const a = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const b = new Uint8Array([0xaa, 0xbb, 0xcd]);
    expect(digestsEqual(a, b)).to.equal(false);
  });
});

describe("canonical-encode — TA-19 byte-equal regression guard", () => {
  it("EMPTY_AGENT_SET_HASH equivalent: sha256 of u32-LE 0 matches known value", () => {
    // The exported EMPTY_AGENT_SET_HASH in compute-policy-preview-digest.ts
    // is now computed via the shared sha256 helper. Verify the shared helper
    // produces the same byte sequence by re-deriving the empty-vec hash.
    const empty = new Uint8Array(4); // u32 LE length prefix = 0
    const out = sha256(empty);
    // Pinned fixture: sha256([0,0,0,0]) = df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119
    const hex = Array.from(out)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).to.equal(
      "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
    );
  });
});
