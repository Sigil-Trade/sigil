/**
 * TA-19 — Canonical policy preview digest (SDK side).
 *
 * Mirrors `programs/sigil/src/utils/policy_digest.rs` exactly. The SDK computes
 * this off-chain, the owner signs `queue_policy_update` / `initialize_vault`
 * with the digest as an arg, and the on-chain handler recomputes it from the
 * resulting policy state. If the two digests do not match the handler rejects
 * with `PolicyPreviewMismatch` (6080).
 *
 * Defense rationale:
 *   - Sequence: SDK builds policy fields → SDK computes digest → owner signs
 *     the transaction (digest is in the instruction data, signed alongside).
 *   - On-chain handler reads the policy fields from the args, re-computes the
 *     same digest, and asserts equality.
 *   - The only ways the two digests can diverge are: (a) an owner blind-signed
 *     mutated fields that the SDK never told them about; (b) a rogue program
 *     tampered with the pending PDA between queue and apply (a future
 *     discriminator-collision attack). Both cases reject — the owner sees a
 *     mismatch error rather than silently committing.
 *
 * CANONICAL ENCODING (FIXED — DO NOT REORDER). Positions are the live byte
 * order — see PER_FIELD_FIXED_SIZES below, the single source of truth that a
 * module-load assertion pins against POLICY_PREVIEW_FIELD_COUNT:
 *   1. daily_spending_cap_usd: u64 LE (8 bytes)
 *   2. max_transaction_size_usd: u64 LE (8 bytes)
 *   3. max_slippage_bps: u16 LE (2 bytes)
 *   4. developer_fee_rate: u16 LE (2 bytes) — PEN-CROSS-6 (Phase 2 close-up)
 *   5. protocol_mode: u8 (1 byte)
 *   6. protocols: Vec<Pubkey> = u32 LE length (4 bytes) ++ each Pubkey 32 bytes
 *   7. destination_mode: u8 (1 byte)
 *   8. allowed_destinations: Vec<Pubkey> = u32 LE length (4 bytes) ++ each Pubkey 32 bytes
 *   9. timelock_duration: u64 LE (8 bytes)
 *   10. session_expiry_seconds: u64 LE (8 bytes)
 *   11. observe_only: bool as 1 byte (0 or 1)
 *   12. has_post_assertions: u8 (1 byte) — M1-04 removed the former
 *       has_constraints byte (digest-version bump); positions renumbered down.
 *   13. created_at_slot: u64 LE (8 bytes) — PEN-CROSS-2 (Phase 2 close-up)
 *   14. operating_hours: u32 LE (4 bytes) — TA-05 (Phase 3 pre-exec)
 *   15. auto_promote_grays: bool as 1 byte (0/1) — TA-07 (Phase 3 pre-exec)
 *   16. auto_revoke_threshold: u8 (1 byte) — TA-17 (Phase 3 pre-exec)
 *   17. stable_balance_floor: u64 LE (8 bytes) — TA-12 (Phase 5 post-exec)
 *   18. per_recipient_daily_cap_usd: u64 LE (8 bytes) — TA-14 (Phase 5 post-exec)
 *   19. cosign_required: bool (1 byte 0/1) — G6 (audit 2026-05-18 cosign opt-in)
 *   20. agent_set_hash: [u8; 32] — Phase 8 PEN-CROSS-1 (audit 2026-05-19)
 *   21. cosign_session_pubkey: Pubkey (32 bytes) — D-5 (audit 2026-05-19, F-RP3-1)
 *   22. operator_grant_delay_seconds: u64 LE (8 bytes) — F-Q6 (2026-06-02)
 *   23. has_protocol_caps: bool as 1 byte (0/1) — M-1 (audit 2026-06-11)
 *   24. protocol_caps: u32 LE length (4 bytes) ++ each cap u64 LE (8 bytes) — M-1
 *   25. protocol_hashes: u32 LE length = protocols.length (4 bytes) ++ for each
 *       protocol the 32-byte pinned ELF SHA-256 (all-zero = gate off) — Item 3
 *       (verified-build gate, 2026-06-22). INDEX-ALIGNED to protocols.
 *
 * Phase 3 append-only additions (TA-05/07/17): operating_hours,
 * auto_promote_grays, auto_revoke_threshold are appended at positions 15-17
 * to preserve the 14-field prefix (F-14 APPEND-ONLY rule).
 *
 * Phase 5 append-only additions (TA-12/TA-14): stable_balance_floor at
 * position 17, per_recipient_daily_cap_usd at position 18. Both bound by
 * TA-19 so silent SDK / pending-PDA mutations can't bypass the owner's
 * signed digest.
 *
 * G6 append-only addition (audit 2026-05-18 cosign opt-in): cosign_required
 * at position 19 (1 byte, 0/1). Owner's choice to opt into TA-09 cosign
 * enforcement is part of the signed policy — a compromised SDK cannot
 * silently disable cosign between owner approval and on-chain landing.
 * Disabling cosign on a live policy where this is true is itself an
 * elevated mutation per `queue_policy_update` (one-way ratchet).
 *
 * Phase 8 PEN-CROSS-1 append-only addition (Council ISC-66/A8/A9): the
 * `agent_set_hash` at position 20 binds the EXISTING agent set into the
 * signed digest. SHA-256 over Borsh of `Vec<(Pubkey, u8 capability)>`
 * sorted by pubkey ascending. Closes the silent-insertion vector where
 * a phished-owner `register_agent(capability=OPERATOR)` would otherwise
 * grant operator-class without diverging the digest from the last value
 * the owner signed. Empty Vec produces a deterministic 32-byte hash
 * (`EMPTY_AGENT_SET_HASH` — SHA-256 of [0x00,0x00,0x00,0x00]).
 *
 * D-5 append-only addition (audit 2026-05-19, F-RP3-1): the
 * `cosign_session_pubkey` at position 21 binds the owner's chosen
 * reactivate-time cosigner pubkey into the signed digest. The
 * `reactivate_vault` handler reads this pubkey at runtime and requires
 * a matching `is_signer == true` entry in `remaining_accounts` whenever
 * the operation grafts a new agent at `FULL_CAPABILITY`. A tampered SDK
 * cannot silently flip the gate between owner approval and on-chain
 * landing — the digest mismatch closes that gap. Default
 * `Pubkey::default()` (32 zero bytes) means the gate is OFF; owners
 * opt in via `queue_policy_update`.
 *
 * The `destination_graylist: Vec<(Pubkey, i64)>` is intentionally NOT in
 * the digest. Graylist entries are derived/ephemeral — they auto-populate
 * when the owner adds a destination via queue_policy_update, and they
 * only delay an already-signed allowlist entry. Promoting via
 * promote_graylist_destination only accelerates the existing unlock — it
 * cannot widen the allowlist. The owner-signed digest already binds the
 * destination allowlist (position 8).
 *
 * Total bounded by MAX_ALLOWED_PROTOCOLS=10 + MAX_ALLOWED_DESTINATIONS=10 at
 * 32 bytes each + fixed scalars ≈ 700 bytes worst case.
 */

import type { Address } from "../kit-adapter.js";
import {
  base58Decode32 as base58Decode,
  sha256,
  writeU16Le,
  writeU32Le,
  writeU64Le,
  digestsEqual as canonicalDigestsEqual,
} from "../canonical-encode.js";

/**
 * Canonical preview-fields shape. Matches the on-chain `PolicyPreviewFields`
 * struct in `programs/sigil/src/utils/policy_digest.rs` exactly.
 */
export interface PolicyPreviewFields {
  /** $ × 1e6 (USDC/USDT decimals). e.g. $500 = 500_000_000n. */
  dailySpendingCapUsd: bigint;
  /** $ × 1e6. */
  maxTransactionSizeUsd: bigint;
  /** Basis points (0-5000). */
  maxSlippageBps: number;
  /**
   * Developer fee rate (rate / 1,000,000). Bound by the owner-signed digest
   * since PEN-CROSS-6 (Phase 2 close-up). 0..=MAX_DEVELOPER_FEE_RATE (500).
   */
  developerFeeRate: number;
  /** 1 = ALLOWLIST (Phase 2 Option A). Other values rejected on-chain. */
  protocolMode: number;
  /** Up to MAX_ALLOWED_PROTOCOLS (10) base58-encoded program IDs. */
  protocols: readonly (Address | string)[];
  /** 0 = RESTRICTED (Phase 2 Option A). Other values rejected on-chain. */
  destinationMode: number;
  /** Up to MAX_ALLOWED_DESTINATIONS (10) base58-encoded wallet pubkeys. */
  allowedDestinations: readonly (Address | string)[];
  /** Timelock duration in seconds (>= MIN_TIMELOCK_DURATION=1800). */
  timelockDuration: bigint;
  /** Owner-configurable session expiry (0 = use default 30s). */
  sessionExpirySeconds: bigint;
  /** TA-19: observe-only kill switch (rejects all validate_and_authorize). */
  observeOnly: boolean;
  // M1-04: hasConstraints removed (digest-version bump; constraints engine gone).
  /** Whether post-execution assertions are configured (0 = no, non-zero = yes). */
  hasPostAssertions: number;
  /**
   * PEN-CROSS-2 (Phase 2 close-up): the slot at which `initialize_vault`
   * minted the live policy. Bound by TA-19 at position 13. Closes the
   * close+reinit replay window.
   */
  createdAtSlot: bigint;
  /**
   * TA-05 (Phase 3): 24-bit UTC operating-hours bitmask. Bit `n` (0..=23)
   * set → the vault permits spending at UTC hour `n`. Default 0 when
   * omitted by legacy callers (preserves existing test fixtures). Production
   * SDK consumers should pass 0xFFFFFF (all 24h enabled) explicitly.
   * Upper 8 bits MUST be zero — on-chain handler rejects with
   * `ErrOutsideOperatingHours` (6084) if violated. Bound at position 14
   * of the canonical encoding.
   */
  operatingHours?: number;
  /**
   * TA-07 (Phase 3): owner-side toggle to bypass the 24h graylist friction
   * for newly-added destinations. Default false (friction enforced).
   * Bound by TA-19 at canonical position 15 so silent flips can't change
   * the friction model.
   */
  autoPromoteGrays?: boolean;
  /**
   * TA-17 (Phase 3): consecutive-failure threshold for agent auto-revoke.
   * Range 3..=20. Default 0 (legacy callers — but on-chain handler now
   * requires this to be in [3, 20] at policy-write time). Bound at
   * canonical position 16.
   */
  autoRevokeThreshold?: number;
  /**
   * TA-12 (Phase 5 post-exec): owner-chosen hard reserve on combined
   * USDC+USDT vault balance, asserted at every `finalize_session`
   * spending path completion. 6-decimal USDC face value (e.g.
   * `$100 = 100_000_000n`). Default 0 (no reserve — preserves existing
   * vault behavior). Bound at canonical position 17.
   */
  stableBalanceFloor?: bigint;
  /**
   * TA-14 (Phase 5 post-exec): owner-chosen rolling 24h per-recipient
   * outflow cap. 6-decimal USDC face value. Default 0 (no per-recipient
   * cap — preserves existing vault behavior). Bound at canonical
   * position 18.
   */
  perRecipientDailyCapUsd?: bigint;
  /**
   * G6 (audit 2026-05-18 cosign opt-in): owner-chosen opt-in to TA-09
   * cosign enforcement on elevated mutations. Default false (low-friction
   * — preserves existing vault behavior; owner-signature-only flow on
   * elevated mutations). When true, the `queue_policy_update` handler's
   * 7-trigger elevation gate (raises caps, expands allowlists, weakens
   * floor / per-recipient / protocol caps) requires a cosign session.
   * Disabling cosign on a live policy where this is true is itself an
   * elevated mutation (one-way ratchet). Bound at canonical position 19.
   */
  cosignRequired?: boolean;
  /**
   * Phase 8 PEN-CROSS-1 (Council ISC-66/A8/A9): SHA-256 over Borsh of
   * `Vec<(pubkey, u8 capability)>` sorted by pubkey ascending. Pass the
   * result of `computeAgentSetHash(...)` over the live vault's agent set
   * (use empty array for a freshly-initialized vault). Empty vault produces
   * the deterministic `EMPTY_AGENT_SET_HASH` value. Bound at canonical
   * position 20. Optional with default `EMPTY_AGENT_SET_HASH` so legacy
   * fixtures (no agents) continue to compute the canonical digest.
   */
  agentSetHash?: Uint8Array;
  /**
   * D-5 (audit 2026-05-19, F-RP3-1): the owner-chosen reactivate-time
   * cosigner pubkey. Default `Pubkey::default()` (zero pubkey, encoded
   * as 32 zero bytes) when omitted, matching the on-chain init state
   * where the gate is disabled. Owners opt in by passing a non-default
   * pubkey via `queue_policy_update` (the SDK helper here mirrors that
   * value into the digest). Bound at canonical position 21.
   *
   * Type: base58 string (e.g. an Address) OR a 32-byte raw Uint8Array.
   * The encoder accepts both shapes for parity with the protocols /
   * allowedDestinations fields.
   */
  cosignSessionPubkey?: Address | string | Uint8Array;
  /**
   * F-Q6 (2026-06-02): owner-configured delay (in seconds) before an OPERATOR
   * capability grant takes effect. Default 0n when omitted (matching the
   * on-chain init default). An owner-set security control gating OPERATOR
   * seating — bound by TA-19 at canonical position 22 so a tampered SDK or
   * pending-PDA mutation cannot silently lower it between owner approval and
   * on-chain landing. Owners change it only via the timelocked
   * `queue_policy_update` path.
   */
  operatorGrantDelaySeconds?: bigint;
  /**
   * M-1 (audit 2026-06-11): owner's per-protocol-caps master switch. Bound at
   * canonical position 23 (default false when omitted, matching the on-chain
   * init/legacy state). Mirrors the cosign digest's order (hasProtocolCaps
   * before protocolCaps). Closes the gap where a tampered SDK could flip the
   * caps switch without the owner's signed preview detecting it.
   */
  hasProtocolCaps?: boolean;
  /**
   * M-1 (audit 2026-06-11): owner's per-protocol rolling-24h spend caps,
   * aligned 1:1 with `protocols` (≤ 10). Bound at canonical position 24 as a
   * u32 LE length prefix ++ each cap as u64 LE (mirrors the `protocols` Vec
   * pattern). Default [] when omitted.
   */
  protocolCaps?: readonly bigint[];
  /**
   * Item 3 (verified-build gate, 2026-06-22): owner's per-protocol pinned ELF
   * SHA-256 hashes, INDEX-ALIGNED to `protocols`. Each entry is a 32-byte
   * `Uint8Array` (an all-zero array = gate disabled for that protocol). Bound at
   * canonical position 25, encoded index-aligned to `protocols`:
   * `u32-LE(protocols.length)` ++ for each i the 32 bytes `protocolHashes[i]`
   * (missing/short entries encode 32 zero bytes). Default [] when omitted (⇒
   * all protocols encode 32 zero bytes = gate off everywhere), matching the
   * on-chain init/legacy state where `protocol_hashes` is all-zero. Mirrors the
   * Rust `protocol_hashes` digest encoding byte-for-byte.
   */
  protocolHashes?: readonly Uint8Array[];
}

// Base58 decode + sha256 + cursor writers now live in `../canonical-encode.ts`
// so the AL3 SealInput intent digest (`seal/intent-digest.ts`, Phase 9
// Batch I) can reuse them. The shared module guarantees byte-identical
// output for both TA-19 and AL3 — silent encoder drift between the two
// would defeat the cross-impl Rust↔TS hash invariant.

// ── §RP-2 L-NEW-1 forward-looking ratchet (audit 2026-05-19) ────────────────
//
// Mirrors the Rust-side `POLICY_PREVIEW_FIELD_COUNT` const-assert at
// `programs/sigil/src/utils/policy_digest.rs:143` and the destructuring
// test in `field_count_invariant`. The Rust defenses are exhaustive
// (compile-time struct destructuring catches "field added but encoder
// not updated"), but the TS encoder is a plain procedural write loop —
// adding a 21st field to `PolicyPreviewFields` here AND bumping
// `POLICY_PREVIEW_FIELD_COUNT` to 21 still passes the build if the
// developer forgets to write the encoding line.
//
// `PER_FIELD_FIXED_SIZES` is a 1:1 array of the FIXED-WIDTH byte cost
// of each canonical field (excluding the variable per-element 32-byte
// pubkey appendages for protocols + allowed_destinations). The
// `EXPECTED_FIXED_SIZE` derived sum + the runtime assertion against
// the encoded buffer's length forces the developer to update this
// table AND the encoder in lockstep. Silent bypass is closed.
//
// To add a field: (1) extend `PolicyPreviewFields` (2) extend
// `PER_FIELD_FIXED_SIZES` with the new field's fixed byte cost (3)
// bump `POLICY_PREVIEW_FIELD_COUNT` (4) write the encoder line. The
// `assert_field_count_in_lockstep` IIFE catches step-skips at module
// load.

/** Mirrors `policy_digest.rs::POLICY_PREVIEW_FIELD_COUNT`.
 *  M1-04: was 22; has_constraints removed (digest-version bump).
 *  F-Q6 (2026-06-02): 21 → 22, binds operator_grant_delay_seconds.
 *  M-1 (2026-06-11): 22 → 24, binds has_protocol_caps (23) + protocol_caps (24).
 *  Item 3 (2026-06-22): 24 → 25, binds protocol_hashes (25, index-aligned to protocols). */
export const POLICY_PREVIEW_FIELD_COUNT = 25;

/**
 * Phase 8 PEN-CROSS-1 (Council ISC-141): SHA-256 of the Borsh-encoded
 * empty `Vec<(Pubkey, u8)>` — i.e. SHA-256 of [0x00, 0x00, 0x00, 0x00].
 * Deterministic; pinned across Rust (`policy_digest.rs::EMPTY_AGENT_SET_HASH`)
 * and TypeScript (this constant). Used by `computePolicyPreviewDigest`
 * when the caller omits `agentSetHash` (legacy fixture path).
 */
export const EMPTY_AGENT_SET_HASH: Uint8Array = (() => {
  const empty = new Uint8Array(4); // u32 LE length prefix = 0
  return sha256(empty);
})();

/**
 * Compute the canonical `agent_set_hash` from a list of agents. SHA-256
 * over Borsh of `Vec<(Pubkey, u8 capability)>` sorted by pubkey ascending.
 * Mirrors `policy_digest.rs::compute_agent_set_hash` byte-for-byte.
 *
 * Pass the result into `computePolicyPreviewDigest({ ...fields, agentSetHash })`.
 *
 * @throws if any pubkey doesn't base58-decode to 32 bytes
 */
export function computeAgentSetHash(
  agents: ReadonlyArray<{ pubkey: Address | string; capability: number }>,
): Uint8Array {
  // Decode + project to (rawBytes, capability) tuples.
  const decoded = agents.map((a) => ({
    raw: base58Decode(a.pubkey as string),
    capability: a.capability & 0xff,
  }));
  // Sort by pubkey ascending — byte-wise lex order matches Solana's
  // `Pubkey::cmp` (just a [u8;32] comparison).
  decoded.sort((a, b) => {
    for (let i = 0; i < 32; i++) {
      if (a.raw[i]! < b.raw[i]!) return -1;
      if (a.raw[i]! > b.raw[i]!) return 1;
    }
    return 0;
  });
  // Borsh encode: u32 LE length prefix + each (Pubkey: 32 bytes, capability: 1 byte).
  // Per-entry size = 33 bytes; total = 4 + decoded.length * 33.
  const buf = new Uint8Array(4 + decoded.length * 33);
  new DataView(buf.buffer, buf.byteOffset, 4).setUint32(
    0,
    decoded.length,
    true,
  );
  let off = 4;
  for (const e of decoded) {
    buf.set(e.raw, off);
    off += 32;
    buf[off++] = e.capability;
  }
  return sha256(buf);
}

/**
 * Fixed-width byte cost per canonical field. Variable parts (the
 * per-element 32-byte pubkey appendages of protocols and
 * allowed_destinations) are NOT included — those are accounted for
 * separately at encode time. Indices map 1:1 to the canonical fields
 * listed in the module header.
 */
const PER_FIELD_FIXED_SIZES = [
  8, // 1.  daily_spending_cap_usd       (u64 LE)
  8, // 2.  max_transaction_size_usd     (u64 LE)
  2, // 3.  max_slippage_bps             (u16 LE)
  2, // 4.  developer_fee_rate           (u16 LE)  PEN-CROSS-6
  1, // 5.  protocol_mode                (u8)
  4, // 6.  protocols                    (u32 LE length prefix; pubkeys variable)
  1, // 7.  destination_mode             (u8)
  4, // 8.  allowed_destinations         (u32 LE length prefix; pubkeys variable)
  8, // 9.  timelock_duration            (u64 LE)
  8, // 10. session_expiry_seconds       (u64 LE)
  1, // 11. observe_only                 (bool as u8)
  // M1-04: field 12 has_constraints REMOVED (digest-version bump); renumbered below.
  1, // 12. has_post_assertions          (u8)
  8, // 13. created_at_slot              (u64 LE) PEN-CROSS-2
  4, // 14. operating_hours              (u32 LE) TA-05
  1, // 15. auto_promote_grays           (bool as u8) TA-07
  1, // 16. auto_revoke_threshold        (u8) TA-17
  8, // 17. stable_balance_floor         (u64 LE) TA-12
  8, // 18. per_recipient_daily_cap_usd  (u64 LE) TA-14
  1, // 19. cosign_required              (bool as u8) G6
  32, // 20. agent_set_hash              ([u8;32]) Phase 8 PEN-CROSS-1
  32, // 21. cosign_session_pubkey       (Pubkey)  D-5 (audit 2026-05-19, F-RP3-1)
  8, // 22. operator_grant_delay_seconds (u64 LE)  F-Q6 (2026-06-02)
  1, // 23. has_protocol_caps            (bool as u8)  M-1 (2026-06-11)
  4, // 24. protocol_caps                (u32 LE length prefix; u64 caps variable)  M-1
  4, // 25. protocol_hashes             (u32 LE length prefix; 32-byte hashes variable)  Item 3 (2026-06-22)
] as const;

/** Derived sum — must match the encoder's `fixedSize` exactly. */
const EXPECTED_FIXED_SIZE = PER_FIELD_FIXED_SIZES.reduce((a, b) => a + b, 0);

// Module-load assertion: enforce that PER_FIELD_FIXED_SIZES.length and
// POLICY_PREVIEW_FIELD_COUNT diverge → throw at import time. Catches a
// developer who bumps the count without updating the table (or vice
// versa). Cheap one-time cost, runs once per process.
(function assert_field_count_in_lockstep(): void {
  if (PER_FIELD_FIXED_SIZES.length !== POLICY_PREVIEW_FIELD_COUNT) {
    throw new Error(
      `§RP-2 L-NEW-1 (TA-19 ratchet): PER_FIELD_FIXED_SIZES.length=${PER_FIELD_FIXED_SIZES.length} ` +
        `diverges from POLICY_PREVIEW_FIELD_COUNT=${POLICY_PREVIEW_FIELD_COUNT}. ` +
        "Either add the missing field's byte cost to PER_FIELD_FIXED_SIZES, " +
        "or update POLICY_PREVIEW_FIELD_COUNT, in the SAME commit. " +
        "Silent diverge would bypass TA-19 (PEN-7 class).",
    );
  }
})();

// ── Encoders ─────────────────────────────────────────────────────────────────
//
// Cursor writers (writeU8 / writeU16Le / writeU32Le / writeU64Le / writeBool)
// now live in `../canonical-encode.ts` and are imported at the top of this
// file. The hand-rolled versions previously here were byte-identical.

/**
 * Compute the canonical SHA-256 of the policy preview fields.
 *
 * Returns a 32-byte Uint8Array. Identical to the on-chain helper
 * `compute_policy_preview_digest` for the same input.
 *
 * @throws if any pubkey doesn't base58-decode to exactly 32 bytes
 * @throws if a u64 is negative or out of range
 */
export function computePolicyPreviewDigest(
  fields: PolicyPreviewFields,
): Uint8Array {
  // Pre-size: 8+8+2+1 + 4+32*10 + 1 + 4+32*10 + 8+8+1+1+1 = ~684 bytes worst case
  const protocols = fields.protocols;
  const dests = fields.allowedDestinations;
  // Decode pubkeys first so any error surfaces with a useful message before
  // we start the hash walk.
  const protoBytes = protocols.map((p) => base58Decode(p as string));
  const destBytes = dests.map((p) => base58Decode(p as string));

  // §RP-2 L-NEW-1: fixedSize is now derived from the PER_FIELD_FIXED_SIZES
  // table above (must equal POLICY_PREVIEW_FIELD_COUNT entries). The inline
  // "8 + 8 + ..." literal was the original hand-summed form — a 21st-field
  // bug would silently bypass it. The table-driven form forces the
  // developer to update both the table AND the encoder body when adding
  // a field (the offset assertion at the bottom catches the inconsistency).
  const fixedSize = EXPECTED_FIXED_SIZE;
  // M-1 (2026-06-11): + each protocol_cap (u64 = 8 bytes); the u32 length
  // prefix is already counted in PER_FIELD_FIXED_SIZES (field 24 = 4).
  // Item 3 (2026-06-22): protocol_hashes is index-aligned to protocols, so its
  // variable size is keyed on protocols.length (32 bytes each), NOT on the
  // protocolHashes array length — matching the Rust encoder which iterates
  // 0..protocols.len(). The u32 length prefix is already counted in
  // PER_FIELD_FIXED_SIZES (field 25 = 4).
  const variableSize =
    protoBytes.length * 32 +
    destBytes.length * 32 +
    (fields.protocolCaps?.length ?? 0) * 8 +
    protoBytes.length * 32;
  const buf = new Uint8Array(fixedSize + variableSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let off = 0;
  off = writeU64Le(view, off, fields.dailySpendingCapUsd);
  off = writeU64Le(view, off, fields.maxTransactionSizeUsd);
  off = writeU16Le(view, off, fields.maxSlippageBps);
  // PEN-CROSS-6: developer_fee_rate at position 4 of canonical encoding.
  off = writeU16Le(view, off, fields.developerFeeRate);
  buf[off++] = fields.protocolMode;
  off = writeU32Le(view, off, protoBytes.length);
  for (const pk of protoBytes) {
    buf.set(pk, off);
    off += 32;
  }
  buf[off++] = fields.destinationMode;
  off = writeU32Le(view, off, destBytes.length);
  for (const pk of destBytes) {
    buf.set(pk, off);
    off += 32;
  }
  off = writeU64Le(view, off, fields.timelockDuration);
  off = writeU64Le(view, off, fields.sessionExpirySeconds);
  buf[off++] = fields.observeOnly ? 1 : 0;
  // M1-04: has_constraints byte removed (digest-version bump).
  buf[off++] = fields.hasPostAssertions;
  // PEN-CROSS-2: created_at_slot at position 13 of canonical encoding.
  off = writeU64Le(view, off, fields.createdAtSlot);
  // TA-05 (Phase 3): operating_hours at position 14 of canonical encoding.
  // Default 0 when omitted by legacy callers; production SDK consumers
  // should pass 0xFFFFFF explicitly via `initializeVault`/`queuePolicyUpdate`.
  off = writeU32Le(view, off, fields.operatingHours ?? 0);
  // TA-07 (Phase 3): auto_promote_grays at position 15.
  buf[off++] = fields.autoPromoteGrays ? 1 : 0;
  // TA-17 (Phase 3): auto_revoke_threshold at position 16.
  buf[off++] = fields.autoRevokeThreshold ?? 0;
  // TA-12 (Phase 5): stable_balance_floor at position 17.
  off = writeU64Le(view, off, fields.stableBalanceFloor ?? 0n);
  // TA-14 (Phase 5): per_recipient_daily_cap_usd at position 18.
  off = writeU64Le(view, off, fields.perRecipientDailyCapUsd ?? 0n);
  // G6 (audit 2026-05-18 cosign opt-in): cosign_required at position 19.
  buf[off++] = fields.cosignRequired ? 1 : 0;
  // Phase 8 PEN-CROSS-1: agent_set_hash at position 20. Default
  // EMPTY_AGENT_SET_HASH so legacy callers (no agents) continue to
  // produce a canonical digest without explicit setup.
  const agentSetHash = fields.agentSetHash ?? EMPTY_AGENT_SET_HASH;
  if (agentSetHash.length !== 32) {
    throw new Error(
      `agentSetHash must be exactly 32 bytes, got ${agentSetHash.length}`,
    );
  }
  buf.set(agentSetHash, off);
  off += 32;
  // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey at position
  // 22. Default `Pubkey::default()` (32 zero bytes) so legacy callers
  // that don't opt into the reactivate-cosign gate continue to produce
  // the canonical digest. Owner opt-in passes a base58 string OR a
  // 32-byte Uint8Array; the encoder normalises both into the canonical
  // 32-byte buffer.
  const cosignSessionRaw = fields.cosignSessionPubkey;
  let cosignSessionBytes: Uint8Array;
  if (cosignSessionRaw === undefined) {
    cosignSessionBytes = new Uint8Array(32); // Pubkey::default()
  } else if (cosignSessionRaw instanceof Uint8Array) {
    cosignSessionBytes = cosignSessionRaw;
  } else {
    cosignSessionBytes = base58Decode(cosignSessionRaw as string);
  }
  if (cosignSessionBytes.length !== 32) {
    throw new Error(
      `cosignSessionPubkey must decode to exactly 32 bytes, got ${cosignSessionBytes.length}`,
    );
  }
  buf.set(cosignSessionBytes, off);
  off += 32;
  // F-Q6 (2026-06-02): operator_grant_delay_seconds at position 22 (u64 LE).
  // Default 0n so legacy callers that don't configure a delay continue to
  // produce the canonical digest. Owner opts in via queue_policy_update.
  off = writeU64Le(view, off, fields.operatorGrantDelaySeconds ?? 0n);
  // 23. has_protocol_caps: bool as u8 — M-1 (2026-06-11). Parity with the Rust
  // encoder + the cosign digest (position 8).
  buf[off++] = fields.hasProtocolCaps ? 1 : 0;
  // 24. protocol_caps: u32 LE length prefix ++ each cap u64 LE — M-1, parity with
  // the `protocols` Vec pattern above + the cosign digest (position 9).
  const protocolCaps = fields.protocolCaps ?? [];
  off = writeU32Le(view, off, protocolCaps.length);
  for (const cap of protocolCaps) {
    off = writeU64Le(view, off, cap);
  }
  // 25. protocol_hashes: index-aligned to protocols — Item 3 (2026-06-22).
  // u32-LE(protocols.length) ++ for each i in 0..protocols.length the 32 bytes
  // protocolHashes[i] (a missing/short entry encodes 32 zero bytes = gate
  // disabled for that protocol). Keyed on protocols.length, NOT on
  // protocolHashes.length, to match the Rust encoder's 0..protocols.len() walk.
  const protocolHashes = fields.protocolHashes ?? [];
  off = writeU32Le(view, off, protoBytes.length);
  for (let i = 0; i < protoBytes.length; i++) {
    const h = protocolHashes[i];
    if (h === undefined) {
      // No hash supplied for this protocol → 32 zero bytes (gate disabled).
      off += 32;
    } else {
      if (h.length !== 32) {
        throw new Error(
          `protocolHashes[${i}] must be exactly 32 bytes, got ${h.length}`,
        );
      }
      buf.set(h, off);
      off += 32;
    }
  }

  // §RP-2 L-NEW-1 forward-looking ratchet: the encoder MUST write
  // exactly `fixedSize + variableSize` bytes. `fixedSize` is now
  // derived from the PER_FIELD_FIXED_SIZES table (which is asserted
  // at module load to be 1:1 with POLICY_PREVIEW_FIELD_COUNT). A
  // future engineer who adds a 21st field MUST update both the table
  // AND the encoder body — if they update only the table (bumping
  // EXPECTED_FIXED_SIZE) but forget to write the encoder line, this
  // assertion fires with a clear mismatch. If they update only the
  // encoder line, the SAME assertion fires (the buffer was too small
  // and the OOB write at line `buf[off++] = ...` already threw).
  if (off !== buf.length) {
    throw new Error(
      `computePolicyPreviewDigest: encoded ${off} bytes, expected ${buf.length}. ` +
        `If you added a field to PolicyPreviewFields, update PER_FIELD_FIXED_SIZES + ` +
        `POLICY_PREVIEW_FIELD_COUNT AND write the encoder line in the SAME commit.`,
    );
  }

  return sha256(buf);
}

/**
 * Equivalent of `Buffer.equals` for two `Uint8Array` digests. Re-exported
 * from `../canonical-encode.ts` (constant-time XOR-accumulate; no early
 * exit) so callers that previously imported it from this module continue
 * to work after Batch C.
 */
export const digestsEqual = canonicalDigestsEqual;
