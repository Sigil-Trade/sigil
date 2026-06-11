/**
 * G4 (audit close) — TA-09 cross-impl test for cosign_digest.
 *
 * Pins the SAME fixtures used in the on-chain Rust unit tests at
 * `programs/sigil/src/utils/cosign_digest.rs`:
 *
 *   - `cosign_digest_known_value_for_minimal`
 *   - `cosign_digest_known_value_for_realistic`
 *
 * Both sides assert byte-for-byte equality against the same hex constants. If
 * the canonical encoding diverges in either direction, the two tests fail in
 * lock-step (the goal — not silent acceptance of a divergent format).
 *
 * The test also exercises a few invariants of the SDK helper: determinism,
 * session-pubkey sensitivity, None vs Some(0) discriminator, ordered
 * encoding for destinations / protocols, and the same buildCosignBundle
 * wrapper invariants the on-chain handler enforces (non-default + non-owner).
 *
 * Forward-compat note: per the on-chain comment in cosign_digest.rs, the
 * canonical encoding is APPEND-ONLY. If a future phase appends a new field,
 * BOTH HEX_MINIMAL and HEX_REALISTIC change — update both the Rust pin
 * (`COSIGN_HEX_MINIMAL` / `COSIGN_HEX_REALISTIC`) and the SDK pin (below).
 */

import { expect } from "chai";
import * as fc from "fast-check";
import { createHash } from "node:crypto";
import { buildCosignBundle } from "../../src/cosign-helper.js";
import { computeCosignDigest } from "../../src/policy/compute-cosign-digest.js";
import type { Address, TransactionSigner } from "../../src/kit-adapter.js";

// G4 fixtures, rebound by Round 2 B4 F-1 (2026-05-19): the canonical
// encoding extended from 5 to 10 Option<…> fields. Passing `undefined` for
// the 5 new optionals → Option::None branch (1 None byte each) → both
// fixtures grew by 5 trailing zero bytes vs the pre-B4-F-1 values.
//
// MINIMAL: cosign_session = pk(1), all 9 Options = None.
//   Encoding length:
//     32 (session)
//     + 1 (daily None tag)
//     + 1 (max_tx None tag)
//     + 1 (destinations None tag)
//     + 1 (protocols None tag)
//     + 1 (stable_balance_floor None tag)         (B4 F-1)
//     + 1 (per_recipient_daily_cap_usd None tag)  (B4 F-1)
//     + 1 (has_protocol_caps None tag)            (B4 F-1)
//     + 1 (protocol_caps None tag)                (B4 F-1)
//     + 1 (cosign_required None tag)              (B4 F-1)
//   = 41 bytes deterministic input.
// Pre-B4-F-1 value was 3f6c2724a21a3b29ef886a52aa414bec96c46f7af137c636065209ff892cee6c.
const HEX_MINIMAL =
  "36744bc16c6c142eab59716b80de14e1ec548b29dff1bb699773b91791197df1";

// REALISTIC: cosign_session = pk(1), daily = Some(500_000_000),
//   max_tx = Some(100_000_000), destinations = Some([pk(10)]),
//   protocols = Some([pk(1), pk(2)]), the 5 new B4 F-1 fields = None.
//   Encoding length:
//     32 (session)
//     + 1 + 8 (daily Some(u64))
//     + 1 + 8 (max_tx Some(u64))
//     + 1 + 4 + 32 (destinations Some(Vec len=1))
//     + 1 + 4 + 32*2 (protocols Some(Vec len=2))
//     + 5 (five trailing B4 F-1 None discriminator bytes)
//   = 161 bytes deterministic input.
// Pre-B4-F-1 value was 5a881caee096c1c8d60348f3cca70bc966d5ca92b32ddaf014ebc0dbc8edf1af.
const HEX_REALISTIC =
  "d2cb150b71e205fc076159adc6bf3b5aef9c04f059743f74b1c0c5fb376f4b8c";

// Base58 encodings of fixed test pubkeys [1u8;32], [2u8;32], [10u8;32].
// Same constants as preview-digest.test.ts.
const PK_1 = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const PK_2 = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const PK_10 = "gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5";

// pk(3) base58 for a distinct cosigner in same-key tests.
const PK_3 = "CwBgFNXrJ4hxnHnVUgreCQiHc1fcuuTtKMzZBC3DwYTo";

const DEFAULT_PUBKEY = "11111111111111111111111111111111";

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

describe("TA-09 — computeCosignDigest cross-impl pin (G4)", () => {
  it("minimal fixture matches on-chain Rust digest byte-for-byte", () => {
    const digest = computeCosignDigest({
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: null,
      maxTransactionAmountUsd: null,
      allowedDestinations: null,
      protocols: null,
    });
    expect(toHex(digest)).to.equal(HEX_MINIMAL);
  });

  it("realistic fixture matches on-chain Rust digest byte-for-byte", () => {
    const digest = computeCosignDigest({
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionAmountUsd: 100_000_000n,
      allowedDestinations: [PK_10 as unknown as Address],
      protocols: [PK_1 as unknown as Address, PK_2 as unknown as Address],
    });
    expect(toHex(digest)).to.equal(HEX_REALISTIC);
  });

  it("same fields produce the same digest (determinism)", () => {
    const fields = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionAmountUsd: null,
      allowedDestinations: [PK_10 as unknown as Address],
      protocols: null,
    };
    const d1 = computeCosignDigest(fields);
    const d2 = computeCosignDigest(fields);
    expect(toHex(d1)).to.equal(toHex(d2));
  });

  it("session-pubkey flip changes the digest (session-swap defense)", () => {
    const base = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionAmountUsd: null,
      allowedDestinations: null,
      protocols: null,
    };
    const d1 = computeCosignDigest(base);
    const d2 = computeCosignDigest({
      ...base,
      cosignSession: PK_2 as unknown as Address,
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  it("cap-raise flip changes the digest (args-swap defense)", () => {
    const base = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionAmountUsd: null,
      allowedDestinations: null,
      protocols: null,
    };
    const d1 = computeCosignDigest(base);
    const d2 = computeCosignDigest({
      ...base,
      dailySpendingCapUsd: 1_000_000_000n, // doubled
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  it("None vs Some(0) produce distinct digests (discriminator is load-bearing)", () => {
    const fNone = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: null,
      maxTransactionAmountUsd: null,
      allowedDestinations: null,
      protocols: null,
    };
    const fSomeZero = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: 0n,
      maxTransactionAmountUsd: null,
      allowedDestinations: null,
      protocols: null,
    };
    expect(toHex(computeCosignDigest(fNone))).to.not.equal(
      toHex(computeCosignDigest(fSomeZero)),
    );
  });

  it("destinations reorder changes the digest (ordered encoding)", () => {
    const base = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: null,
      maxTransactionAmountUsd: null,
      allowedDestinations: [
        PK_10 as unknown as Address,
        PK_2 as unknown as Address,
      ],
      protocols: null,
    };
    const d1 = computeCosignDigest(base);
    const d2 = computeCosignDigest({
      ...base,
      allowedDestinations: [
        PK_2 as unknown as Address,
        PK_10 as unknown as Address,
      ],
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  it("protocols reorder changes the digest (ordered encoding)", () => {
    const base = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: null,
      maxTransactionAmountUsd: null,
      allowedDestinations: null,
      protocols: [PK_1 as unknown as Address, PK_2 as unknown as Address],
    };
    const d1 = computeCosignDigest(base);
    const d2 = computeCosignDigest({
      ...base,
      protocols: [PK_2 as unknown as Address, PK_1 as unknown as Address],
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  it("empty Vec Some([]) differs from None (discriminator byte)", () => {
    // The on-chain handler treats `Some(vec![])` and `None` as distinct
    // — the Option tag byte differs (1 vs 0). The SDK MUST mirror this.
    const fSomeEmpty = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: null,
      maxTransactionAmountUsd: null,
      allowedDestinations: [] as readonly Address[],
      protocols: null,
    };
    const fNone = {
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: null,
      maxTransactionAmountUsd: null,
      allowedDestinations: null,
      protocols: null,
    };
    expect(toHex(computeCosignDigest(fSomeEmpty))).to.not.equal(
      toHex(computeCosignDigest(fNone)),
    );
  });

  it("rejects malformed pubkey base58", () => {
    expect(() =>
      computeCosignDigest({
        cosignSession: "not-a-pubkey" as unknown as Address,
        dailySpendingCapUsd: null,
        maxTransactionAmountUsd: null,
        allowedDestinations: null,
        protocols: null,
      }),
    ).to.throw(/base58/);
  });

  it("rejects malformed pubkey in destinations array", () => {
    expect(() =>
      computeCosignDigest({
        cosignSession: PK_1 as unknown as Address,
        dailySpendingCapUsd: null,
        maxTransactionAmountUsd: null,
        allowedDestinations: ["not-a-pubkey" as unknown as Address],
        protocols: null,
      }),
    ).to.throw(/base58/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCosignBundle — surface wrapper invariants
//
// The wrapper enforces non-default + non-owner-same at the SDK level,
// mirroring the on-chain `require_keys_neq!` checks at queue_policy_update.rs
// lines 288-302. Better DX than a failed simulation.
// ─────────────────────────────────────────────────────────────────────────────

function fakeOwnerSigner(addr: string): TransactionSigner {
  // Minimum-viable signer stub — buildCosignBundle only reads `.address`. The
  // tx builder uses the full signer surface; for digest derivation we don't.
  return {
    address: addr as unknown as Address,
    signTransactions: async () => {
      throw new Error("fakeOwnerSigner: signing not used in digest tests");
    },
  } as unknown as TransactionSigner;
}

describe("TA-09 — buildCosignBundle (G4) surface invariants", () => {
  it("rejects the default-pubkey cosign session up-front", () => {
    expect(() =>
      buildCosignBundle({
        cosignSessionPubkey: DEFAULT_PUBKEY as unknown as Address,
        ownerSigner: fakeOwnerSigner(PK_2),
        dailySpendingCapUsd: 500_000_000n,
      }),
    ).to.throw(/default pubkey|ErrCosignRequired/);
  });

  it("rejects same-key cosign (owner == cosigner)", () => {
    expect(() =>
      buildCosignBundle({
        cosignSessionPubkey: PK_2 as unknown as Address,
        ownerSigner: fakeOwnerSigner(PK_2),
        dailySpendingCapUsd: 500_000_000n,
      }),
    ).to.throw(/same-key|ErrCosignRequired/);
  });

  it("produces a digest equal to computeCosignDigest for the same inputs", () => {
    const bundle = buildCosignBundle({
      cosignSessionPubkey: PK_1 as unknown as Address,
      ownerSigner: fakeOwnerSigner(PK_3),
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionAmountUsd: 100_000_000n,
      allowedDestinations: [PK_10 as unknown as Address],
      protocols: [PK_1 as unknown as Address, PK_2 as unknown as Address],
    });
    const direct = computeCosignDigest({
      cosignSession: PK_1 as unknown as Address,
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionAmountUsd: 100_000_000n,
      allowedDestinations: [PK_10 as unknown as Address],
      protocols: [PK_1 as unknown as Address, PK_2 as unknown as Address],
    });
    expect(toHex(bundle.cosignDigest)).to.equal(toHex(direct));
    expect(bundle.cosignSession).to.equal(PK_1);
  });

  it("binds stableBalanceFloor + perRecipientDailyCapUsd into the digest (B4 F-1)", () => {
    // Round 2 B4 F-1 (2026-05-19): these two G3 elevation triggers are now
    // BOUND by the cosign digest at canonical positions 6 + 7. Two bundles
    // that differ ONLY in these fields MUST produce DIFFERENT cosign
    // digests — closing the gap where the digest previously only bound
    // positions 1-5. Inverted from the pre-B4-F-1 test expectation.
    const baseArgs = {
      cosignSessionPubkey: PK_1 as unknown as Address,
      ownerSigner: fakeOwnerSigner(PK_3),
      dailySpendingCapUsd: 500_000_000n,
    };
    const bundleA = buildCosignBundle({
      ...baseArgs,
      stableBalanceFloor: 100_000_000n,
      perRecipientDailyCapUsd: 50_000_000n,
    });
    const bundleB = buildCosignBundle({
      ...baseArgs,
      stableBalanceFloor: 0n,
      perRecipientDailyCapUsd: 999_999_999n,
    });
    expect(toHex(bundleA.cosignDigest)).to.not.equal(
      toHex(bundleB.cosignDigest),
    );
  });

  it("binds hasProtocolCaps + protocolCaps + cosignRequired into the digest (B4 F-1)", () => {
    // Round 2 B4 F-1 (2026-05-19): the remaining G3 + G6 elevation triggers
    // bound at canonical positions 8, 9, 10. Two bundles that differ ONLY
    // in these flags MUST produce DIFFERENT cosign digests.
    const baseArgs = {
      cosignSessionPubkey: PK_1 as unknown as Address,
      ownerSigner: fakeOwnerSigner(PK_3),
      dailySpendingCapUsd: 500_000_000n,
    };
    const bundleA = buildCosignBundle({
      ...baseArgs,
      hasProtocolCaps: true,
      protocolCaps: [100_000_000n, 200_000_000n],
      cosignRequired: true,
    });
    const bundleB = buildCosignBundle({
      ...baseArgs,
      hasProtocolCaps: false,
      protocolCaps: [100_000_000n, 200_000_000n],
      cosignRequired: true,
    });
    expect(toHex(bundleA.cosignDigest)).to.not.equal(
      toHex(bundleB.cosignDigest),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property test — SDK encoder == reference encoder
//
// Same pattern as PEN-CROSS-7 in preview-digest.test.ts: hand-encode a
// reference digest directly in this test from the spec, then assert SDK ==
// reference across random fixtures. Catches silent SDK encoder drift.
// ─────────────────────────────────────────────────────────────────────────────

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++;
  }
  const digits: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < leadingZeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET[digits[i]!];
  }
  return out;
}

/**
 * Reference encoder — hand-written from the spec in
 * `programs/sigil/src/utils/cosign_digest.rs` and the
 * `compute-cosign-digest.ts` docblock. Intentionally re-derived (not
 * imported) so it catches silent encoder drift in the SDK.
 *
 * Round 2 B4 F-1 (2026-05-19): extended to cover the 5 new APPEND-ONLY
 * fields at canonical positions 6-10 (stable_balance_floor,
 * per_recipient_daily_cap_usd, has_protocol_caps, protocol_caps,
 * cosign_required).
 */
function referenceCosignDigest(fields: {
  sessionBytes: Uint8Array;
  dailySpendingCapUsd: bigint | null;
  maxTransactionAmountUsd: bigint | null;
  allowedDestinationsBytes: readonly Uint8Array[] | null;
  protocolsBytes: readonly Uint8Array[] | null;
  stableBalanceFloor: bigint | null;
  perRecipientDailyCapUsd: bigint | null;
  hasProtocolCaps: boolean | null;
  protocolCaps: readonly bigint[] | null;
  cosignRequired: boolean | null;
}): string {
  const parts: number[] = [];
  const pushU64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    for (const x of b) parts.push(x);
  };
  const pushU32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    for (const x of b) parts.push(x);
  };
  const pushU8 = (v: number) => parts.push(v & 0xff);

  for (const x of fields.sessionBytes) parts.push(x);
  if (fields.dailySpendingCapUsd === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU64(fields.dailySpendingCapUsd);
  }
  if (fields.maxTransactionAmountUsd === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU64(fields.maxTransactionAmountUsd);
  }
  if (fields.allowedDestinationsBytes === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU32(fields.allowedDestinationsBytes.length);
    for (const b of fields.allowedDestinationsBytes) {
      for (const x of b) parts.push(x);
    }
  }
  if (fields.protocolsBytes === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU32(fields.protocolsBytes.length);
    for (const b of fields.protocolsBytes) {
      for (const x of b) parts.push(x);
    }
  }
  // Round 2 B4 F-1 — APPEND-ONLY extension (positions 6-10).
  if (fields.stableBalanceFloor === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU64(fields.stableBalanceFloor);
  }
  if (fields.perRecipientDailyCapUsd === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU64(fields.perRecipientDailyCapUsd);
  }
  if (fields.hasProtocolCaps === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU8(fields.hasProtocolCaps ? 1 : 0);
  }
  if (fields.protocolCaps === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU32(fields.protocolCaps.length);
    for (const c of fields.protocolCaps) {
      pushU64(c);
    }
  }
  if (fields.cosignRequired === null) {
    pushU8(0);
  } else {
    pushU8(1);
    pushU8(fields.cosignRequired ? 1 : 0);
  }

  const buf = Buffer.from(parts);
  return createHash("sha256").update(buf).digest("hex");
}

describe("TA-09 — property test: SDK encoder == reference encoder (G4)", () => {
  it("100 random fixtures match between SDK and hand-encoded reference", () => {
    const pubkeyArb = fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((u8: Uint8Array) => u8 as Uint8Array);
    const u64Arb = fc.bigUint({ max: (1n << 64n) - 1n });

    fc.assert(
      fc.property(
        pubkeyArb, // session
        fc.option(u64Arb, { nil: null }), // daily Option
        fc.option(u64Arb, { nil: null }), // max_tx Option
        fc.option(fc.array(pubkeyArb, { minLength: 0, maxLength: 10 }), {
          nil: null,
        }), // destinations Option<Vec>
        fc.option(fc.array(pubkeyArb, { minLength: 0, maxLength: 10 }), {
          nil: null,
        }), // protocols Option<Vec>
        // Round 2 B4 F-1 — new arbitraries for positions 6-10.
        fc.option(u64Arb, { nil: null }), // stable_balance_floor Option
        fc.option(u64Arb, { nil: null }), // per_recipient_daily_cap_usd Option
        fc.option(fc.boolean(), { nil: null }), // has_protocol_caps Option<bool>
        fc.option(fc.array(u64Arb, { minLength: 0, maxLength: 10 }), {
          nil: null,
        }), // protocol_caps Option<Vec<u64>>
        fc.option(fc.boolean(), { nil: null }), // cosign_required Option<bool>
        (
          sessionBytes,
          dailyOpt,
          maxTxOpt,
          destOpt,
          protoOpt,
          stableFloorOpt,
          perRecipCapOpt,
          hasProtoCapsOpt,
          protoCapsOpt,
          cosignReqOpt,
        ) => {
          const sdkDigest = computeCosignDigest({
            cosignSession: base58Encode(sessionBytes) as unknown as Address,
            dailySpendingCapUsd: dailyOpt,
            maxTransactionAmountUsd: maxTxOpt,
            allowedDestinations:
              destOpt === null
                ? null
                : destOpt.map(
                    (b: Uint8Array) => base58Encode(b) as unknown as Address,
                  ),
            protocols:
              protoOpt === null
                ? null
                : protoOpt.map(
                    (b: Uint8Array) => base58Encode(b) as unknown as Address,
                  ),
            stableBalanceFloor: stableFloorOpt,
            perRecipientDailyCapUsd: perRecipCapOpt,
            hasProtocolCaps: hasProtoCapsOpt,
            protocolCaps: protoCapsOpt,
            cosignRequired: cosignReqOpt,
          });
          const refDigest = referenceCosignDigest({
            sessionBytes,
            dailySpendingCapUsd: dailyOpt,
            maxTransactionAmountUsd: maxTxOpt,
            allowedDestinationsBytes: destOpt,
            protocolsBytes: protoOpt,
            stableBalanceFloor: stableFloorOpt,
            perRecipientDailyCapUsd: perRecipCapOpt,
            hasProtocolCaps: hasProtoCapsOpt,
            protocolCaps: protoCapsOpt,
            cosignRequired: cosignReqOpt,
          });
          const sdkHex = Array.from(sdkDigest)
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("");
          return sdkHex === refDigest;
        },
      ),
      { numRuns: 100 },
    );
  });
});
