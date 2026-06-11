// D-1 / D-6 scalar intent-digest helper for LiteSVM + Surfpool tests.
//
// Mirrors `sdk/kit/src/seal/intent-digest.ts::computeScalarIntentDigest`
// and `programs/sigil/src/utils/intent_digest.rs::compute_scalar_intent_digest`
// byte-for-byte. Verified by intent-digest-fixture.test.ts at every commit.
//
// Use `buildExpectedIntentDigest(input)` then pass `Array.from(digest)` as
// the 6th argument to `program.methods.validateAndAuthorize(...)`. Anchor
// 0.32.1 serializes `[u8; 32]` IDL types from `number[]` of length 32.

import { PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import type BN from "bn.js";

export const INTENT_DIGEST_MAGIC: Buffer = Buffer.from("SIG1", "ascii");
export const INTENT_VERSION_V2 = 2;
export const NETWORK_ID_DEVNET = 0;
export const NETWORK_ID_MAINNET = 1;
export const INTENT_DIGEST_BUFFER_BYTES = 142;
export const INTENT_DIGEST_OUTPUT_BYTES = 32;

export interface ScalarIntentInput {
  vault: PublicKey;
  agent: PublicKey;
  tokenMint: PublicKey;
  amount: BN | bigint | number;
  targetProtocol?: PublicKey;
  network?: "devnet" | "mainnet";
}

export function buildExpectedIntentDigest(input: ScalarIntentInput): Buffer {
  const amount = BigInt(input.amount.toString());
  if (amount < 0n) {
    throw new Error(
      `buildExpectedIntentDigest: amount must be non-negative, got ${amount}`,
    );
  }
  const networkId =
    input.network === "mainnet" ? NETWORK_ID_MAINNET : NETWORK_ID_DEVNET;
  const targetProtocol = input.targetProtocol ?? PublicKey.default;

  const buf = Buffer.alloc(INTENT_DIGEST_BUFFER_BYTES);
  let off = 0;
  INTENT_DIGEST_MAGIC.copy(buf, off);
  off += 4;
  buf.writeUInt8(INTENT_VERSION_V2, off);
  off += 1;
  buf.writeUInt8(networkId, off);
  off += 1;
  input.vault.toBuffer().copy(buf, off);
  off += 32;
  input.agent.toBuffer().copy(buf, off);
  off += 32;
  input.tokenMint.toBuffer().copy(buf, off);
  off += 32;
  buf.writeBigUInt64LE(amount, off);
  off += 8;
  targetProtocol.toBuffer().copy(buf, off);
  off += 32;
  if (off !== INTENT_DIGEST_BUFFER_BYTES) {
    throw new Error(
      `buildExpectedIntentDigest: encoded ${off} bytes, expected ${INTENT_DIGEST_BUFFER_BYTES}`,
    );
  }
  return crypto.createHash("sha256").update(buf).digest();
}

export function digestAsArgs(digest: Buffer | Uint8Array): number[] {
  if (digest.length !== INTENT_DIGEST_OUTPUT_BYTES) {
    throw new Error(
      `digestAsArgs: expected ${INTENT_DIGEST_OUTPUT_BYTES} bytes, got ${digest.length}`,
    );
  }
  return Array.from(digest);
}

export function buildExpectedIntentDigestArgs(
  input: ScalarIntentInput,
): number[] {
  return digestAsArgs(buildExpectedIntentDigest(input));
}

// Use ONLY in tests asserting error 6102 (ErrIntentDigestMismatch) or
// CPI depth (CpiCallNotAllowed — the only earlier gate). The on-chain
// digest check at validate_and_authorize.rs:159-191 runs FIRST, before
// any other state check — so a zero-buffer digest on a non-6102 test
// will fail with 6102 instead of the intended error. ALWAYS compute a
// real digest unless the test literally targets the digest gate itself.
export const ZERO_INTENT_DIGEST: number[] = Array.from(
  new Uint8Array(INTENT_DIGEST_OUTPUT_BYTES),
);
