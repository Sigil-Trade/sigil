/**
 * Canonical Borsh-style encoder primitives — shared utilities.
 *
 * APPEND-ONLY DISCIPLINE. The TA-19 policy preview digest
 * (`policy/compute-policy-preview-digest.ts`) and the AL3 SealInput intent
 * digest (`seal/intent-digest.ts`, Phase 9 Batch I) both depend on these
 * primitives being byte-stable across SDK versions. Adding a new primitive
 * is fine; CHANGING the byte layout of an existing one would break every
 * downstream cross-impl Rust↔TS hash and silently invalidate every
 * previously-signed policy preview digest.
 *
 * Mirrors the Rust-side conventions used by `solana_program::hash::hash`
 * over Borsh-encoded structs:
 *   - Little-endian for all multi-byte integers (u16/u32/u64).
 *   - Vec<T> = u32 LE length prefix ++ flat element bytes (no per-element
 *     framing).
 *   - bool encoded as u8 (0 or 1; the canonical Borsh wire format).
 *   - Pubkey = raw 32 bytes (base58 decoded).
 *   - SHA-256 over the canonical-encoded byte string.
 *
 * Primitives are deliberately small, stateless, and side-effect-free so
 * they can be unit-tested in isolation and reused without surprises.
 */

import { sha256 as nobleSha256 } from "@noble/hashes/sha2";

// ── Base58 decode (no external dep) ─────────────────────────────────────────
//
// Solana pubkeys are base58 strings; we need the raw 32 bytes. The SDK has
// many base58 helpers downstream but importing from `kit-adapter` here would
// create a cycle (kit-adapter imports from `core/` which is consumed by
// digest helpers). Inline a small standard-Bitcoin-alphabet decoder.

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX: Record<string, number> = (() => {
  const r: Record<string, number> = Object.create(null);
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    r[BASE58_ALPHABET[i]!] = i;
  }
  return r;
})();

/**
 * Decode a Solana base58 pubkey to its 32-byte raw form. Throws on any
 * input that doesn't decode to exactly 32 bytes (catches malformed
 * pubkeys before they corrupt the canonical encoding).
 *
 * @throws Error if `s` is empty, contains an invalid base58 character,
 *   or decodes to a byte length other than 32.
 */
export function base58Decode32(s: string): Uint8Array {
  if (s.length === 0) {
    throw new Error("base58Decode32: empty input");
  }
  let leadingZeros = 0;
  while (leadingZeros < s.length && s[leadingZeros] === "1") {
    leadingZeros++;
  }
  // Big integer mode: walk digits, base-256 carry.
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const v = BASE58_INDEX[c];
    if (v === undefined) {
      throw new Error(`base58Decode32: invalid char '${c}'`);
    }
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  // bytes is little-endian; reverse and prepend leading zeros.
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[leadingZeros + (bytes.length - 1 - i)] = bytes[i]!;
  }
  if (out.length !== 32) {
    throw new Error(
      `base58Decode32: expected 32-byte pubkey, got ${out.length} bytes`,
    );
  }
  return out;
}

// ── Cursor writers ──────────────────────────────────────────────────────────
//
// Each writer takes a DataView + offset and returns the new offset. The
// `DataView` interface is browser- and Node-portable. All multi-byte integers
// are little-endian (matching `solana_program` + Borsh canonical encoding).

/** Write u8 (single byte). Returns new offset. */
export function writeU8(view: DataView, offset: number, v: number): number {
  view.setUint8(offset, v & 0xff);
  return offset + 1;
}

/** Write u16 little-endian. Returns new offset. */
export function writeU16Le(view: DataView, offset: number, v: number): number {
  view.setUint16(offset, v, true);
  return offset + 2;
}

/** Write u32 little-endian. Returns new offset. */
export function writeU32Le(view: DataView, offset: number, v: number): number {
  view.setUint32(offset, v, true);
  return offset + 4;
}

/** Write u64 little-endian. Returns new offset. */
export function writeU64Le(view: DataView, offset: number, v: bigint): number {
  view.setBigUint64(offset, v, true);
  return offset + 8;
}

/** Write a bool as a single 0/1 byte. Returns new offset. */
export function writeBool(view: DataView, offset: number, v: boolean): number {
  view.setUint8(offset, v ? 1 : 0);
  return offset + 1;
}

// ── SHA-256 hasher ──────────────────────────────────────────────────────────

/**
 * SHA-256 over the input bytes. Backed by `@noble/hashes/sha256` — pure
 * JS, browser- and Bun-compatible, byte-identical to Node's `node:crypto`
 * for the same input (TA-19 cross-impl fixture suite verifies this).
 *
 * Phase 9 Batch I switched the backend from `node:crypto` to noble so AL3
 * intent-digest can ship the same primitive across Node, Bun, and the
 * browser without runtime-conditional imports.
 */
export function sha256(input: Uint8Array): Uint8Array {
  return nobleSha256(input);
}

/**
 * Constant-time digest comparison (true if `a` and `b` are byte-equal).
 * Uses XOR-accumulate with no early exit so timing leaks don't reveal
 * which prefix matched. Used by cosign + policy-digest verification.
 */
export function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= (a[i]! ^ b[i]!) & 0xff;
  }
  return acc === 0;
}
