/**
 * TA-09 — Canonical cosign digest (SDK side).
 *
 * Mirrors `programs/sigil/src/utils/cosign_digest.rs` exactly. The SDK
 * computes this off-chain, the owner+cosigner sign `queue_policy_update` with
 * the cosign session pubkey as an arg. The on-chain handler:
 *   1. At queue time, recomputes the digest from the resulting pending args +
 *      the cosign session pubkey and stores it on `PendingPolicyUpdate`.
 *   2. At apply time, recomputes it AGAIN from the persisted pending args and
 *      asserts byte-equality. Any tamper of pending args between queue and
 *      apply (e.g. a future discriminator-collision attack on the pending PDA)
 *      produces a digest mismatch and a hard reject (`ErrCosignRequired`,
 *      6089).
 *
 * The cosign digest is INTENTIONALLY narrower than TA-19 `policy_preview_digest`:
 * only the FIELDS that participate in "elevated mutation" detection are in
 * scope. Non-elevated fields (developer_fee_rate, max_slippage_bps,
 * session_expiry_seconds, timelock_duration narrowing, protocol_mode,
 * destination_mode, operating_hours, etc.) do NOT require cosign and are NOT
 * bound by THIS digest — they are still bound by TA-19
 * `policy_preview_digest` at queue time.
 *
 * Round 2 B4 F-1 fix (audit 2026-05-19): the cosign-digest binding now
 * extends to all G3 + G6 elevation triggers that were previously NOT bound:
 *   - `stable_balance_floor` (G3)            — LOWERING weakens custody
 *   - `per_recipient_daily_cap_usd` (G3)     — RAISING widens spend
 *   - `has_protocol_caps` (G3)               — disabling protocol caps
 *   - `protocol_caps` (G3)                   — shrinking individual caps
 *   - `cosign_required` (G6)                 — disabling cosign one-way
 * Without this binding, a tampered SDK or discriminator-collision attack
 * could mutate the pending PDA between queue and apply on those triggers
 * without producing a cosign-digest mismatch (TA-19's policy_preview_digest
 * binds them at the *policy* level but the cosign-binding promise is "the
 * session signature covers the SAME pending args the owner signed").
 *
 * CANONICAL ENCODING (FIXED — DO NOT REORDER, APPEND-ONLY):
 *   1. cosign_session: Pubkey (32 bytes raw)
 *   2. daily_spending_cap_usd: Option<u64>
 *        - tag: 1 byte (0=None, 1=Some)
 *        - payload (if Some): u64 LE (8 bytes)
 *   3. max_transaction_amount_usd: Option<u64>
 *        - same shape as #2
 *   4. allowed_destinations: Option<Vec<Pubkey>>
 *        - tag: 1 byte (0=None, 1=Some)
 *        - payload (if Some): u32 LE length (4 bytes) ++ each Pubkey 32 bytes
 *   5. protocols: Option<Vec<Pubkey>>
 *        - same shape as #4
 *   6. stable_balance_floor: Option<u64>        (B4 F-1)
 *        - same shape as #2
 *   7. per_recipient_daily_cap_usd: Option<u64> (B4 F-1)
 *        - same shape as #2
 *   8. has_protocol_caps: Option<bool>          (B4 F-1)
 *        - tag: 1 byte (0=None, 1=Some)
 *        - payload (if Some): 1 byte (0/1)
 *   9. protocol_caps: Option<Vec<u64>>          (B4 F-1)
 *        - tag: 1 byte (0=None, 1=Some)
 *        - payload (if Some): u32 LE length (4 bytes) ++ each u64 8 bytes LE
 *  10. cosign_required: Option<bool>            (B4 F-1)
 *        - same shape as #8
 *
 * Total bounded by MAX_ALLOWED_PROTOCOLS=10 + MAX_ALLOWED_DESTINATIONS=10 at
 * 32 bytes each + MAX_PROTOCOL_CAPS=10 * 8 + fixed scalars ≈ 805 bytes worst
 * case.
 *
 * Forward-compat note: per the on-chain comment, the canonical encoding here
 * is APPEND-ONLY — new fields land at the END to preserve replayable digests
 * for in-flight pending PDAs across upgrades.
 */

import { createHash } from "node:crypto";
import type { Address } from "../kit-adapter.js";

/**
 * Canonical cosign-digest input shape. Matches the on-chain
 * `CosignDigestFields` struct in `programs/sigil/src/utils/cosign_digest.rs`
 * exactly.
 *
 * Optional fields:
 *   - `null` or `undefined` → Option::None on-chain (tag byte = 0, no payload).
 *   - non-null value         → Option::Some on-chain (tag byte = 1 + payload).
 *
 * Note that the discriminator is load-bearing: `None` vs `Some(0)` produce
 * DIFFERENT digests. The on-chain handler's "is_elevated" detection relies on
 * `Option::is_some_and(|new| new > live)` — a None pass-through never
 * elevates, but a Some(0) lower DOES elevate (and the digest reflects that
 * choice).
 */
export interface CosignDigestFields {
  /**
   * The cosigning session pubkey. 32 bytes raw at position 1.
   *
   * NON-Codama-generated SDK consumers passing the digest-encoded
   * `cosign_session` arg to a queue handler MUST observe the canonical
   * arg contract (Round 2 §RP-2 B4 F-3, 2026-05-19):
   *   - Non-elevated queue: pass `Pubkey::default()`
   *     (`11111111111111111111111111111111`) — and OMIT the cosigner from
   *     `remaining_accounts`.
   *   - Elevated queue (raising daily_cap, expanding destinations,
   *     lowering stable_balance_floor, raising per_recipient_daily_cap,
   *     disabling protocol_caps, mutating protocol_caps, or disabling
   *     cosign): pass a REAL session pubkey AND include it in
   *     `remaining_accounts` with `is_signer == true`. Use
   *     `buildCosignBundle()` in `sdk/kit/src/cosign-helper.ts` to mirror
   *     the on-chain digest the handler will store on
   *     `PendingPolicyUpdate`.
   *   - Reject path: passing a non-default `cosign_session` on a
   *     non-elevated queue surfaces `InvalidPermissions` (6088).
   *     INTENTIONAL — the on-chain handler refuses to silently downgrade
   *     a caller's declared intent.
   *
   * @see sdk/kit/src/cosign-helper.ts — full contract in the "CANONICAL
   * `cosign_session` ARG CONTRACT" block.
   */
  cosignSession: Address | string;
  /**
   * Pending `daily_spending_cap_usd` arg. `null`/`undefined` = pass-through
   * (Option::None). Bound at position 2.
   */
  dailySpendingCapUsd?: bigint | null;
  /**
   * Pending `max_transaction_amount_usd` arg. Bound at position 3.
   */
  maxTransactionAmountUsd?: bigint | null;
  /**
   * Pending `allowed_destinations` arg. `null`/`undefined` = pass-through
   * (Option::None); empty array = Some([]) (NOT the same as None — load-bearing
   * discriminator). Bound at position 4.
   */
  allowedDestinations?: readonly (Address | string)[] | null;
  /**
   * Pending `protocols` arg. Same shape as #4. Bound at position 5.
   */
  protocols?: readonly (Address | string)[] | null;
  /**
   * Round 2 B4 F-1 (2026-05-19): pending `stable_balance_floor` arg
   * (6-decimal USDC face value). G3 elevation trigger — LOWERING the
   * floor weakens custody safety. Bound at position 6. Same Option<u64>
   * shape as #2.
   */
  stableBalanceFloor?: bigint | null;
  /**
   * Round 2 B4 F-1: pending `per_recipient_daily_cap_usd` arg (6-decimal
   * USDC face value). G3 elevation trigger — RAISING / DISABLING widens
   * spend per recipient. Bound at position 7. Same Option<u64> shape as
   * #2.
   */
  perRecipientDailyCapUsd?: bigint | null;
  /**
   * Round 2 B4 F-1: pending `has_protocol_caps` flag. G3 elevation
   * trigger — disabling protocol caps entirely. Bound at position 8.
   * Option<bool>: `null`/`undefined` = Option::None (tag 0), boolean =
   * Option::Some (tag 1 + 1 byte payload, 0/1).
   */
  hasProtocolCaps?: boolean | null;
  /**
   * Round 2 B4 F-1: pending `protocol_caps` Vec<u64> arg (6-decimal USDC
   * face values, parallel to `protocols`). G3 elevation trigger —
   * shrinking individual caps to zero or raising them. Bound at position
   * 9. Option<Vec<u64>>: `null`/`undefined` = Option::None (tag 0); empty
   * array = Some([]) (NOT the same as None — load-bearing discriminator).
   * Order matters (parallel-array semantics).
   */
  protocolCaps?: readonly bigint[] | null;
  /**
   * Round 2 B4 F-1: pending `cosign_required` flag. G6 elevation trigger
   * — disabling cosign on a cosign-opted-in vault is a one-way ratchet
   * (disabling cosign requires cosign). Bound at position 10. Same
   * Option<bool> shape as #8.
   */
  cosignRequired?: boolean | null;
}

// ── Base58 decode (inlined to avoid circular SDK imports) ────────────────────
//
// Solana pubkeys are base58 strings; we need the raw 32 bytes. The SDK has
// other base58 helpers downstream, but to avoid circular imports we inline a
// small decoder. Same alphabet/logic as `compute-policy-preview-digest.ts`.

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX: Record<string, number> = (() => {
  const r: Record<string, number> = Object.create(null);
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    r[BASE58_ALPHABET[i]!] = i;
  }
  return r;
})();

function base58Decode(s: string): Uint8Array {
  if (s.length === 0) {
    throw new Error("base58Decode: empty input");
  }
  let leadingZeros = 0;
  while (leadingZeros < s.length && s[leadingZeros] === "1") {
    leadingZeros++;
  }
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const v = BASE58_INDEX[c];
    if (v === undefined) {
      throw new Error(`base58Decode: invalid char '${c}'`);
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
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[leadingZeros + (bytes.length - 1 - i)] = bytes[i]!;
  }
  if (out.length !== 32) {
    throw new Error(
      `base58Decode: expected 32-byte pubkey, got ${out.length} bytes`,
    );
  }
  return out;
}

// ── Encoders ─────────────────────────────────────────────────────────────────

function writeU64Le(view: DataView, offset: number, v: bigint): number {
  view.setBigUint64(offset, v, true);
  return offset + 8;
}

function writeU32Le(view: DataView, offset: number, v: number): number {
  view.setUint32(offset, v, true);
  return offset + 4;
}

/**
 * Compute the canonical SHA-256 of the cosign digest fields.
 *
 * Returns a 32-byte `Uint8Array`. Identical to the on-chain helper
 * `compute_cosign_digest` for the same input.
 *
 * Used by `cosign-helper.buildCosignBundle()` to produce the digest the
 * on-chain handler will re-validate at queue + apply time.
 *
 * @throws if any pubkey doesn't base58-decode to exactly 32 bytes
 * @throws if a u64 is negative or out of range
 */
export function computeCosignDigest(fields: CosignDigestFields): Uint8Array {
  const sessionBytes = base58Decode(fields.cosignSession as string);

  // Normalise Option semantics: undefined → null (Option::None).
  const dailyCap =
    fields.dailySpendingCapUsd === undefined
      ? null
      : fields.dailySpendingCapUsd;
  const maxTx =
    fields.maxTransactionAmountUsd === undefined
      ? null
      : fields.maxTransactionAmountUsd;
  const dests =
    fields.allowedDestinations === undefined
      ? null
      : fields.allowedDestinations;
  const protos = fields.protocols === undefined ? null : fields.protocols;
  // Round 2 B4 F-1: same undefined-vs-null normalisation for the 5 new
  // fields. The discriminator byte is load-bearing — `undefined` /
  // `null` BOTH map to Option::None (tag 0). `false`, `true`, or `0n`
  // map to Option::Some.
  const stableFloor =
    fields.stableBalanceFloor === undefined ? null : fields.stableBalanceFloor;
  const perRecipCap =
    fields.perRecipientDailyCapUsd === undefined
      ? null
      : fields.perRecipientDailyCapUsd;
  const hasProtoCaps =
    fields.hasProtocolCaps === undefined ? null : fields.hasProtocolCaps;
  const protoCaps =
    fields.protocolCaps === undefined ? null : fields.protocolCaps;
  const cosignReq =
    fields.cosignRequired === undefined ? null : fields.cosignRequired;

  // Pre-decode pubkeys so any error surfaces with a useful message BEFORE we
  // start the hash walk.
  const destBytes =
    dests === null ? null : dests.map((p) => base58Decode(p as string));
  const protoBytes =
    protos === null ? null : protos.map((p) => base58Decode(p as string));

  // Pre-size: 32 (session) + (1+8) for each Option<u64> (positions 2, 3, 6, 7)
  // + (1 + 4 + 32*N) for each Option<Vec<Pubkey>> (positions 4, 5)
  // + (1 + 1) for each Option<bool> (positions 8, 10)
  // + (1 + 4 + 8*N) for Option<Vec<u64>> (position 9)
  // Worst case ~805 bytes.
  const fixedSize =
    32 + // cosign_session
    1 + // daily tag
    (dailyCap !== null ? 8 : 0) +
    1 + // max_tx tag
    (maxTx !== null ? 8 : 0) +
    1 + // destinations tag
    (destBytes !== null ? 4 + destBytes.length * 32 : 0) +
    1 + // protocols tag
    (protoBytes !== null ? 4 + protoBytes.length * 32 : 0) +
    1 + // stable_balance_floor tag (B4 F-1)
    (stableFloor !== null ? 8 : 0) +
    1 + // per_recipient_daily_cap_usd tag (B4 F-1)
    (perRecipCap !== null ? 8 : 0) +
    1 + // has_protocol_caps tag (B4 F-1)
    (hasProtoCaps !== null ? 1 : 0) +
    1 + // protocol_caps tag (B4 F-1)
    (protoCaps !== null ? 4 + protoCaps.length * 8 : 0) +
    1 + // cosign_required tag (B4 F-1)
    (cosignReq !== null ? 1 : 0);
  const buf = new Uint8Array(fixedSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let off = 0;

  // 1. cosign_session pubkey (32 bytes raw)
  buf.set(sessionBytes, off);
  off += 32;

  // 2. daily_spending_cap_usd Option<u64>
  if (dailyCap === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    off = writeU64Le(view, off, dailyCap);
  }

  // 3. max_transaction_amount_usd Option<u64>
  if (maxTx === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    off = writeU64Le(view, off, maxTx);
  }

  // 4. allowed_destinations Option<Vec<Pubkey>>
  if (destBytes === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    off = writeU32Le(view, off, destBytes.length);
    for (const pk of destBytes) {
      buf.set(pk, off);
      off += 32;
    }
  }

  // 5. protocols Option<Vec<Pubkey>>
  if (protoBytes === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    off = writeU32Le(view, off, protoBytes.length);
    for (const pk of protoBytes) {
      buf.set(pk, off);
      off += 32;
    }
  }

  // Round 2 B4 F-1 (2026-05-19): APPEND-ONLY extension binding 5 new
  // elevation triggers. Mirrors `compute_cosign_digest` in
  // `programs/sigil/src/utils/cosign_digest.rs` lines 195-241. All
  // encoded as Option<…> with the load-bearing tag byte (None vs
  // Some(0) MUST produce distinct digests).

  // 6. stable_balance_floor Option<u64>
  if (stableFloor === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    off = writeU64Le(view, off, stableFloor);
  }

  // 7. per_recipient_daily_cap_usd Option<u64>
  if (perRecipCap === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    off = writeU64Le(view, off, perRecipCap);
  }

  // 8. has_protocol_caps Option<bool>. Bool encoded as 1 byte (0/1).
  if (hasProtoCaps === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    buf[off++] = hasProtoCaps ? 1 : 0;
  }

  // 9. protocol_caps Option<Vec<u64>>. Each cap is 8 bytes LE.
  if (protoCaps === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    off = writeU32Le(view, off, protoCaps.length);
    for (const c of protoCaps) {
      off = writeU64Le(view, off, c);
    }
  }

  // 10. cosign_required Option<bool>. Bool encoded as 1 byte (0/1).
  if (cosignReq === null) {
    buf[off++] = 0;
  } else {
    buf[off++] = 1;
    buf[off++] = cosignReq ? 1 : 0;
  }

  // Defensive: assert we wrote exactly what we sized.
  if (off !== buf.length) {
    throw new Error(
      `computeCosignDigest: encoded ${off} bytes, expected ${buf.length}`,
    );
  }

  return new Uint8Array(createHash("sha256").update(buf).digest());
}

/** Equivalent of `Buffer.equals` for two `Uint8Array` digests.
 *
 * M-8 audit fix (2026-05-19): constant-time comparison. Previously this
 * helper early-returned on the first mismatched byte, which leaks
 * length-prefix information about the matching prefix via timing
 * channels. Cosign digests are not classically time-attack-sensitive
 * (they're produced and consumed locally), but constant-time is the
 * defensive default. Both equal-length and unequal-length paths now run
 * to completion before returning.
 */
export function cosignDigestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Length comparison is deliberately the FIRST check and the only
  // early-return: comparing a length mismatch in constant time is
  // mathematically impossible (the longer array's tail bytes never
  // exist), and leaking the length prefix is harmless — the caller
  // controls both digest sources.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // XOR-accumulate. `diff` ends at 0 iff every byte pair matched;
    // any single mismatch sets some bit in `diff` permanently. No
    // early exit on mismatch → constant time per length.
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
