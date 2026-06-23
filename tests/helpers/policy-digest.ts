/**
 * Phase 2 TA-19: canonical policy preview digest helper for LiteSVM tests.
 *
 * Mirrors `programs/sigil/src/utils/policy_digest.rs` byte-for-byte. The SDK
 * has its own copy at `sdk/kit/src/policy/compute-policy-preview-digest.ts`;
 * LiteSVM tests can't easily import the SDK ESM build, so this is a local
 * Node-style implementation.
 *
 * CANONICAL ENCODING (DO NOT REORDER):
 *   1. daily_spending_cap_usd: u64 LE
 *   2. max_transaction_size_usd: u64 LE
 *   3. max_slippage_bps: u16 LE
 *   4. developer_fee_rate: u16 LE — PEN-CROSS-6 (Phase 2 close-up)
 *   5. protocol_mode: u8
 *   6. protocols: Vec<Pubkey>  (u32 LE len + 32 bytes each)
 *   7. destination_mode: u8
 *   8. allowed_destinations: Vec<Pubkey>
 *   9. timelock_duration: u64 LE
 *   10. session_expiry_seconds: u64 LE
 *   11. observe_only: bool (1 byte 0/1)
 *   12. has_constraints: bool (1 byte 0/1)
 *   13. has_post_assertions: u8
 *   14. created_at_slot: u64 LE — PEN-CROSS-2 (Phase 2 close-up)
 *   15. operating_hours: u32 LE — TA-05 (Phase 3 pre-exec)
 *   16. auto_promote_grays: bool (1 byte 0/1) — TA-07 (Phase 3 pre-exec)
 *   17. auto_revoke_threshold: u8 — TA-17 (Phase 3 pre-exec)
 *   18. stable_balance_floor: u64 LE — TA-12 (Phase 5 post-exec)
 *   19. per_recipient_daily_cap_usd: u64 LE — TA-14 (Phase 5 post-exec)
 *   20. cosign_required: bool (1 byte 0/1) — G6 (audit 2026-05-18 cosign opt-in)
 *   21. agent_set_hash: [u8; 32] — Phase 8 PEN-CROSS-1 (audit 2026-05-19)
 *   22. cosign_session_pubkey: Pubkey (32 bytes) — D-5 (audit 2026-05-19, F-RP3-1)
 *   23. operator_grant_delay_seconds: u64 LE — F-Q6 (2026-06-02)
 *   24. has_protocol_caps: bool (1 byte 0/1) — M-1 (audit 2026-06-11)
 *   25. protocol_caps: Vec<u64> (u32 LE len + each u64 LE) — M-1 (audit 2026-06-11)
 *   26. protocol_hashes: u32 LE len = protocols.length (4 bytes) ++ for each i
 *       the 32 bytes protocol_hashes[i] — Item 3 verified-build gate (2026-06-22).
 *       INDEX-ALIGNED to protocols: the length prefix + iteration are keyed on
 *       protocols.length, NOT the hash array length (mirrors the Rust encoder
 *       in policy_digest.rs, which keys position 25 on `protocols.len()`).
 */

import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/**
 * Phase 8 PEN-CROSS-1 (Council ISC-141): SHA-256 of the Borsh-encoded
 * empty `Vec<(Pubkey, u8)>` — i.e. SHA-256 of [0x00,0x00,0x00,0x00].
 * Mirrors Rust `policy_digest.rs::EMPTY_AGENT_SET_HASH` and SDK
 * `compute-policy-preview-digest.ts::EMPTY_AGENT_SET_HASH`.
 */
export const EMPTY_AGENT_SET_HASH: Buffer = createHash("sha256")
  .update(Buffer.alloc(4))
  .digest();

/**
 * Compute the canonical `agent_set_hash` from a list of (pubkey, capability)
 * agent entries. Sort by pubkey ascending byte-wise; Borsh-encode
 * `Vec<(Pubkey, u8)>`; SHA-256. Mirrors `compute_agent_set_hash` byte-for-byte.
 */
export function computeAgentSetHash(
  agents: ReadonlyArray<{ pubkey: PublicKey; capability: number }>,
): Buffer {
  const sorted = [...agents].sort((a, b) => {
    const ab = a.pubkey.toBuffer();
    const bb = b.pubkey.toBuffer();
    for (let i = 0; i < 32; i++) {
      if (ab[i] < bb[i]) return -1;
      if (ab[i] > bb[i]) return 1;
    }
    return 0;
  });
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(sorted.length);
  const parts: Buffer[] = [lenBuf];
  for (const e of sorted) {
    parts.push(e.pubkey.toBuffer());
    parts.push(Buffer.from([e.capability & 0xff]));
  }
  return createHash("sha256").update(Buffer.concat(parts)).digest();
}

export interface PolicyDigestFields {
  dailySpendingCapUsd: BN | bigint | number;
  maxTransactionSizeUsd: BN | bigint | number;
  maxSlippageBps: number;
  /**
   * PEN-CROSS-6 (Phase 2 close-up): now part of the canonical digest encoding.
   * Optional with default 0 so legacy callers continue to pin a 0-fee policy.
   */
  developerFeeRate?: number;
  protocolMode: number;
  protocols: PublicKey[];
  destinationMode: number;
  allowedDestinations: PublicKey[];
  timelockDuration: BN | bigint | number;
  sessionExpirySeconds?: BN | bigint | number;
  observeOnly: boolean;
  hasPostAssertions?: number;
  /**
   * PEN-CROSS-2 (Phase 2 close-up): now part of the canonical digest encoding.
   * Optional with default 0 so legacy callers continue to compute the digest
   * for vaults whose `policy.created_at_slot` is still 0 (handler captures the
   * actual slot at init).
   */
  createdAtSlot?: BN | bigint | number;
  /**
   * TA-05 (Phase 3 pre-exec): 24-bit UTC operating-hours bitmask. Optional
   * with default 0 so legacy fixtures that don't pass it produce the same
   * inert-hours digest the on-chain init handler now requires. New tests
   * should pass `0x00FFFFFF` (all 24h) explicitly.
   */
  operatingHours?: number;
  /**
   * TA-07 (Phase 3): owner-side toggle to bypass the 24h graylist friction.
   * Default false. Bound by TA-19 at digest position 16.
   */
  autoPromoteGrays?: boolean;
  /**
   * TA-17 (Phase 3): consecutive-failure threshold for agent auto-revoke.
   * Default 0 (legacy callers). Bound at digest position 17. On-chain
   * handler requires this to be in [3, 20] at policy-write time.
   */
  autoRevokeThreshold?: number;
  /**
   * TA-12 (Phase 5 post-exec): owner-chosen hard reserve on combined
   * USDC+USDT vault balance. 6-decimal USDC face value. Default 0
   * (no reserve). Bound at digest position 18.
   */
  stableBalanceFloor?: BN | bigint | number;
  /**
   * TA-14 (Phase 5 post-exec): owner-chosen rolling 24h per-recipient
   * outflow cap. 6-decimal USDC face value. Default 0 (no per-recipient
   * cap). Bound at digest position 19.
   */
  perRecipientDailyCapUsd?: BN | bigint | number;
  /**
   * G6 (audit 2026-05-18 cosign opt-in): owner's opt-in to TA-09 cosign
   * enforcement on elevated mutations. Default false (low-friction).
   * Bound at digest position 20. Disabling cosign on a live policy where
   * this is true is itself an elevated mutation per `queue_policy_update`.
   */
  cosignRequired?: boolean;
  /**
   * Phase 8 PEN-CROSS-1: SHA-256 over Borsh of the vault's agent set
   * (sorted by pubkey ascending). Default `EMPTY_AGENT_SET_HASH` so legacy
   * fixtures (no agents) continue to produce the canonical digest.
   */
  agentSetHash?: Buffer;
  /**
   * D-5 (audit 2026-05-19, F-RP3-1): owner-chosen reactivate-time
   * cosigner pubkey. Default `PublicKey.default` (32 zero bytes) when
   * omitted, matching the on-chain init state. Bound at digest
   * position 22.
   */
  cosignSessionPubkey?: PublicKey;
  /**
   * F-Q6 (2026-06-02): owner-configured OPERATOR-grant delay (in seconds).
   * Default 0 so legacy fixtures produce the on-chain default-0 digest.
   * Bound by TA-19, appended last in the canonical encoding.
   */
  operatorGrantDelaySeconds?: BN | bigint | number;
  /**
   * M-1 (2026-06-11): per-protocol-caps master switch. Bound at canonical
   * position 23 (default false). Mirrors the on-chain init derivation
   * `!protocol_caps.is_empty()` when caps are supplied.
   */
  hasProtocolCaps?: boolean;
  /**
   * M-1 (2026-06-11): per-protocol caps, aligned 1:1 with `protocols` (≤10).
   * Bound at canonical position 24: u32 LE length ++ each u64 LE. Default []
   * so legacy fixtures match an on-chain policy with no per-protocol caps.
   */
  protocolCaps?: (BN | bigint | number)[];
  /**
   * Item 3 (verified-build gate, 2026-06-22): per-protocol pinned ELF SHA-256
   * hashes, INDEX-ALIGNED to `protocols`. Each entry is a 32-byte Buffer (an
   * all-zero entry = gate disabled for that protocol). Bound at canonical
   * position 25 (Rust numbering), encoded index-aligned to `protocols`:
   * u32-LE(protocols.length) ++ for each i the 32 bytes protocolHashes[i]
   * (missing/short entries encode 32 zero bytes). Default [] when omitted (⇒
   * all protocols encode 32 zero bytes = gate off everywhere), matching the
   * on-chain init/legacy all-zero `protocol_hashes`. Mirrors the Rust encoder
   * in `policy_digest.rs` byte-for-byte (keyed on protocols.length).
   */
  protocolHashes?: Buffer[];
}

function u64le(v: BN | bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  if (typeof v === "number") {
    buf.writeBigUInt64LE(BigInt(v));
  } else if (typeof v === "bigint") {
    buf.writeBigUInt64LE(v);
  } else {
    buf.writeBigUInt64LE(BigInt(v.toString()));
  }
  return buf;
}

function u32le(v: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(v);
  return buf;
}

function u16le(v: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(v);
  return buf;
}

function u8(v: number): Buffer {
  return Buffer.from([v & 0xff]);
}

/**
 * Returns the SHA-256 digest as a `number[]` of length 32. Anchor 0.32.1's
 * TypeScript codec represents Rust's `[u8; 32]` arg as `number[]`, so callers
 * pass this directly into `.initializeVault(... , digest)` or
 * `.queuePolicyUpdate(... , digest)` without further conversion.
 */
export function computePolicyPreviewDigest(
  fields: PolicyDigestFields,
): number[] {
  const parts: Buffer[] = [];
  parts.push(u64le(fields.dailySpendingCapUsd));
  parts.push(u64le(fields.maxTransactionSizeUsd));
  parts.push(u16le(fields.maxSlippageBps));
  // PEN-CROSS-6: developer_fee_rate at position 4 of canonical encoding.
  parts.push(u16le(fields.developerFeeRate ?? 0));
  parts.push(u8(fields.protocolMode));
  parts.push(u32le(fields.protocols.length));
  for (const p of fields.protocols) parts.push(p.toBuffer());
  parts.push(u8(fields.destinationMode));
  parts.push(u32le(fields.allowedDestinations.length));
  for (const p of fields.allowedDestinations) parts.push(p.toBuffer());
  parts.push(u64le(fields.timelockDuration));
  parts.push(u64le(fields.sessionExpirySeconds ?? 0));
  parts.push(u8(fields.observeOnly ? 1 : 0));
  parts.push(u8(fields.hasPostAssertions ?? 0));
  // PEN-CROSS-2: created_at_slot at position 14 of canonical encoding.
  parts.push(u64le(fields.createdAtSlot ?? 0));
  // TA-05: operating_hours at position 15 of canonical encoding.
  parts.push(u32le(fields.operatingHours ?? 0));
  // TA-07: auto_promote_grays at position 16.
  parts.push(u8(fields.autoPromoteGrays ? 1 : 0));
  // TA-17: auto_revoke_threshold at position 17.
  parts.push(u8(fields.autoRevokeThreshold ?? 0));
  // TA-12: stable_balance_floor at position 18.
  parts.push(u64le(fields.stableBalanceFloor ?? 0));
  // TA-14: per_recipient_daily_cap_usd at position 19.
  parts.push(u64le(fields.perRecipientDailyCapUsd ?? 0));
  // G6 (audit 2026-05-18 cosign opt-in): cosign_required at position 20.
  parts.push(u8(fields.cosignRequired ? 1 : 0));
  // Phase 8 PEN-CROSS-1: agent_set_hash at position 21. Defaults to
  // the empty-vault deterministic value when the caller doesn't supply it.
  const agentSetHash = fields.agentSetHash ?? EMPTY_AGENT_SET_HASH;
  if (agentSetHash.length !== 32) {
    throw new Error(
      `agentSetHash must be exactly 32 bytes, got ${agentSetHash.length}`,
    );
  }
  parts.push(agentSetHash);
  // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey at position
  // 22. Defaults to PublicKey.default (32 zero bytes) so legacy fixtures
  // that don't opt into the reactivate-cosign gate produce the canonical
  // digest. Bound by TA-19.
  const cosignSessionBuf = (
    fields.cosignSessionPubkey ?? PublicKey.default
  ).toBuffer();
  if (cosignSessionBuf.length !== 32) {
    throw new Error(
      `cosignSessionPubkey must serialise to exactly 32 bytes, got ${cosignSessionBuf.length}`,
    );
  }
  parts.push(cosignSessionBuf);
  // F-Q6 (2026-06-02): operator_grant_delay_seconds (u64 LE), appended last.
  // Default 0 so legacy fixtures match the on-chain default-0 value.
  parts.push(u64le(fields.operatorGrantDelaySeconds ?? 0));
  // M-1 (2026-06-11): has_protocol_caps (pos 23, bool as u8) + protocol_caps
  // (pos 24, u32 LE length prefix ++ each u64 LE). Defaults false/[] so legacy
  // fixtures match an on-chain policy with no per-protocol caps.
  parts.push(u8(fields.hasProtocolCaps ? 1 : 0));
  const protocolCaps = fields.protocolCaps ?? [];
  parts.push(u32le(protocolCaps.length));
  for (const c of protocolCaps) parts.push(u64le(c));
  // Item 3 (2026-06-22): protocol_hashes at canonical position 25 (Rust
  // numbering). INDEX-ALIGNED to protocols: length prefix + iteration are keyed
  // on protocols.length (NOT protocolHashes.length), mirroring the Rust encoder
  // (policy_digest.rs uses `n_protocols = fields.protocols.len()`). A missing /
  // short entry encodes 32 zero bytes (gate disabled for that protocol).
  const protocolHashes = fields.protocolHashes ?? [];
  const nProtocols = fields.protocols.length;
  parts.push(u32le(nProtocols));
  for (let i = 0; i < nProtocols; i++) {
    const h = protocolHashes[i];
    if (h === undefined) {
      parts.push(Buffer.alloc(32));
    } else {
      if (h.length !== 32) {
        throw new Error(
          `protocolHashes[${i}] must be exactly 32 bytes, got ${h.length}`,
        );
      }
      parts.push(h);
    }
  }

  const buf = Buffer.concat(parts);
  return Array.from(createHash("sha256").update(buf).digest());
}

/**
 * Convenience: compute a digest from the args that `initialize_vault` will
 * use. Equivalent to:
 *
 *   computePolicyPreviewDigest({
 *     ...args,
 *     destinationMode: 0,
 *     sessionExpirySeconds: 0,
 *     hasConstraints: false,
 *     hasPostAssertions: 0,
 *   })
 *
 * The on-chain handler is hard-coded to RESTRICTED + no constraints at init.
 */
export function initVaultPreviewDigest(args: {
  dailySpendingCapUsd: BN | bigint | number;
  maxTransactionSizeUsd: BN | bigint | number;
  maxSlippageBps: number;
  /**
   * Optional — defaults to 0 so existing fixtures need no update. The on-chain
   * `initialize_vault` handler will recompute against the caller's
   * `developer_fee_rate` ix arg; the two MUST match.
   */
  developerFeeRate?: number;
  protocolMode: number;
  protocols: PublicKey[];
  allowedDestinations: PublicKey[];
  timelockDuration: BN | bigint | number;
  observeOnly?: boolean;
  /**
   * PEN-CROSS-2 (Phase 2 close-up): the slot at which `initialize_vault`
   * will mint the live policy. The on-chain handler captures
   * `Clock::get()?.slot` at handler entry; the digest the caller signs MUST
   * encode that exact slot. Pass the LiteSVM clock slot here (e.g.
   * `Number(svm.getClock().slot)`). Default is 0, matching LiteSVM's
   * initial clock when `withTransactionHistory(0n)` was used and no time
   * has advanced.
   */
  createdAtSlot?: BN | bigint | number;
  /**
   * TA-05 (Phase 3 pre-exec): operating_hours UTC bitmask. Default 0 — legacy
   * fixtures need no update, but new tests SHOULD pass `0x00FFFFFF` (all 24h)
   * so validate_and_authorize doesn't reject. Upper 8 bits must be zero.
   */
  operatingHours?: number;
  /** TA-07 (Phase 3): owner's graylist-bypass choice. Default false. */
  autoPromoteGrays?: boolean;
  /**
   * TA-17 (Phase 3): consecutive-failure auto-revoke threshold. Default 5
   * for new tests; on-chain handler requires range [3, 20].
   */
  autoRevokeThreshold?: number;
  /**
   * TA-12 (Phase 5): stable_balance_floor in 6-decimal USDC face value.
   * Default 0 (no reserve). Bound at digest position 18.
   */
  stableBalanceFloor?: BN | bigint | number;
  /**
   * TA-14 (Phase 5): per_recipient_daily_cap_usd in 6-decimal USDC face
   * value. Default 0 (no cap). Bound at digest position 19.
   */
  perRecipientDailyCapUsd?: BN | bigint | number;
  /**
   * G6 (audit 2026-05-18 cosign opt-in): owner's opt-in to TA-09 cosign
   * enforcement on elevated mutations. Default false (low-friction).
   * Bound at digest position 20.
   */
  cosignRequired?: boolean;
  /**
   * Phase 8 PEN-CROSS-1: agent_set_hash for the vault at init time. Default
   * `EMPTY_AGENT_SET_HASH` — vault starts with zero agents.
   */
  agentSetHash?: Buffer;
  /**
   * D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey at init time.
   * Default `PublicKey.default` — the reactivate-cosign gate is OFF
   * for fresh vaults. The on-chain `initialize_vault` handler hard-codes
   * `Pubkey::default()`, so any non-default value here will diverge the
   * digest from the handler-recomputed value and the
   * `PolicyPreviewMismatch` check rejects. Tests should leave this
   * unset at init and opt in later via `queue_policy_update`.
   */
  cosignSessionPubkey?: PublicKey;
  /**
   * M-1 (audit 2026-06-11): per-protocol daily caps, bound into the canonical
   * preview digest at positions 23-24. Default empty. `has_protocol_caps` is
   * DERIVED as `protocolCaps.length > 0`, mirroring the on-chain initialize_vault
   * (`has_protocol_caps = !protocol_caps.is_empty()`). Pass the SAME slice given
   * to the `initializeVault` ix arg, else the handler-recomputed digest diverges
   * and `PolicyPreviewMismatch` (6071) rejects.
   */
  protocolCaps?: (BN | bigint | number)[];
}): number[] {
  return computePolicyPreviewDigest({
    dailySpendingCapUsd: args.dailySpendingCapUsd,
    maxTransactionSizeUsd: args.maxTransactionSizeUsd,
    maxSlippageBps: args.maxSlippageBps,
    developerFeeRate: args.developerFeeRate ?? 0,
    protocolMode: args.protocolMode,
    protocols: args.protocols,
    destinationMode: 0,
    allowedDestinations: args.allowedDestinations,
    timelockDuration: args.timelockDuration,
    sessionExpirySeconds: 0,
    observeOnly: args.observeOnly ?? false,
    hasPostAssertions: 0,
    createdAtSlot: args.createdAtSlot ?? 0,
    operatingHours: args.operatingHours ?? 0,
    autoPromoteGrays: args.autoPromoteGrays ?? false,
    autoRevokeThreshold: args.autoRevokeThreshold ?? 0,
    stableBalanceFloor: args.stableBalanceFloor ?? 0,
    perRecipientDailyCapUsd: args.perRecipientDailyCapUsd ?? 0,
    // G6 (audit 2026-05-18 cosign opt-in): default false at init so
    // existing fixtures continue to produce the same digest layout
    // they signed against. New tests opt in explicitly.
    cosignRequired: args.cosignRequired ?? false,
    // Phase 8 PEN-CROSS-1: at init the vault has no agents, so default
    // to the empty-Vec hash. Tests that exercise non-empty agent sets
    // override explicitly.
    agentSetHash: args.agentSetHash ?? EMPTY_AGENT_SET_HASH,
    // D-5 (audit 2026-05-19, F-RP3-1): at init the on-chain handler
    // hard-codes `Pubkey::default()` for the reactivate-cosign gate.
    // Default here mirrors that — owners opt in later via
    // `queue_policy_update`.
    cosignSessionPubkey: args.cosignSessionPubkey ?? PublicKey.default,
    // M-1 (audit 2026-06-11): derive has_protocol_caps from the slice length,
    // matching initialize_vault's `!protocol_caps.is_empty()`.
    hasProtocolCaps: (args.protocolCaps?.length ?? 0) > 0,
    protocolCaps: args.protocolCaps ?? [],
  });
}

/**
 * Compute the digest of the merged-effective policy that WILL result from
 * applying a `queue_policy_update` over the live policy. Used by LiteSVM
 * tests to bind `newPolicyPreviewDigest` to the queue instruction.
 *
 * Pass the live policy (fetched via `program.account.policyConfig.fetch`)
 * plus a partial-override of the fields the queue is changing. Anything
 * NOT in the override inherits from `live`.
 *
 * `observeOnly` and `hasConstraints` are not mutable via queue_policy_update —
 * supply the current vault's observe_only flag explicitly.
 */
export interface LiveLikePolicy {
  dailySpendingCapUsd: BN | bigint;
  maxTransactionSizeUsd: BN | bigint;
  maxSlippageBps: number;
  /** PEN-CROSS-6: bound by the canonical digest. */
  developerFeeRate?: number;
  protocolMode: number;
  protocols: PublicKey[];
  destinationMode: number;
  allowedDestinations: PublicKey[];
  timelockDuration: BN | bigint;
  sessionExpirySeconds: BN | bigint;
  hasPostAssertions: number;
  /**
   * PEN-CROSS-2: bound by the canonical digest. Read from
   * `PolicyConfig.createdAtSlot` (typed as BN by Anchor).
   */
  createdAtSlot?: BN | bigint | number;
  /** TA-05 (Phase 3): bound by the canonical digest at position 15. */
  operatingHours?: number;
  /** TA-07 (Phase 3): bound by the canonical digest at position 16. */
  autoPromoteGrays?: boolean;
  /** TA-17 (Phase 3): bound by the canonical digest at position 17. */
  autoRevokeThreshold?: number;
  /** TA-12 (Phase 5): bound by the canonical digest at position 18. */
  stableBalanceFloor?: BN | bigint | number;
  /** TA-14 (Phase 5): bound by the canonical digest at position 19. */
  perRecipientDailyCapUsd?: BN | bigint | number;
  /** G6 (audit 2026-05-18 cosign opt-in): bound at digest position 20. */
  cosignRequired?: boolean;
  /** Phase 8 PEN-CROSS-1: bound at canonical digest position 21. */
  agentSetHash?: Buffer;
  /** D-5 (audit 2026-05-19, F-RP3-1): bound at canonical digest position 22. */
  cosignSessionPubkey?: PublicKey;
  /** F-Q6 (2026-06-02): operator_grant_delay_seconds, the final canonical digest field (after cosign_session_pubkey). */
  operatorGrantDelaySeconds?: BN | bigint | number;
  /**
   * M-1 (audit 2026-06-11): live per-protocol caps master switch + slice, bound
   * at canonical digest positions 23-24. Read from `PolicyConfig`.
   */
  hasProtocolCaps?: boolean;
  protocolCaps?: (BN | bigint | number)[];
  /**
   * Item 3 (2026-06-22): live per-protocol pinned ELF SHA-256 hashes, bound at
   * canonical digest position 25. Read from `PolicyConfig.protocolHashes` (the
   * full 10-entry fixed array as decoded by Anchor). Default [] (all-zero / gate
   * off) when absent (pre-Item-3 IDL deserialization).
   */
  protocolHashes?: Buffer[];
}

export interface QueueOverride {
  dailySpendingCapUsd?: BN | bigint | number | null;
  maxTransactionSizeUsd?: BN | bigint | number | null;
  maxSlippageBps?: number | null;
  developerFeeRate?: number | null;
  protocolMode?: number | null;
  protocols?: PublicKey[] | null;
  destinationMode?: number | null;
  allowedDestinations?: PublicKey[] | null;
  timelockDuration?: BN | bigint | number | null;
  sessionExpirySeconds?: BN | bigint | number | null;
  /** TA-05 (Phase 3): operating_hours override. */
  operatingHours?: number | null;
  /**
   * TA-07/17 (Phase 3): not mutable via queue_policy_update in V1, but the
   * helper signature accepts them for explicit symmetry — null means
   * pass-through from live policy.
   */
  autoPromoteGrays?: boolean | null;
  autoRevokeThreshold?: number | null;
  /** TA-12 (Phase 5): stable_balance_floor override. null = pass-through. */
  stableBalanceFloor?: BN | bigint | number | null;
  /**
   * TA-14 (Phase 5): per_recipient_daily_cap_usd override. null =
   * pass-through from live policy.
   */
  perRecipientDailyCapUsd?: BN | bigint | number | null;
  /**
   * G6 (audit 2026-05-18 cosign opt-in): cosign_required override. null =
   * pass-through. Setting from true→false on a live policy where the live
   * value is true is itself an ELEVATED mutation (one-way ratchet); the
   * helper doesn't enforce that here — the on-chain handler rejects with
   * `ErrCosignRequired` if cosign isn't provided.
   */
  cosignRequired?: boolean | null;
  /**
   * D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey override.
   * null = pass-through from live policy. Setting to `PublicKey.default`
   * explicitly disables the gate; any other pubkey enables it.
   */
  cosignSessionPubkey?: PublicKey | null;
  /**
   * F-Q6 (2026-06-02): operator_grant_delay_seconds override. null =
   * pass-through from live policy; any value sets the configured delay
   * (the on-chain queue merges via `unwrap_or(live)`). The final
   * canonical digest field (after cosign_session_pubkey).
   */
  operatorGrantDelaySeconds?: BN | bigint | number | null;
  /**
   * M-1 (audit 2026-06-11): per-protocol caps overrides. null = pass-through
   * from live. On-chain, has_protocol_caps and protocol_caps are independent
   * queue args (each merged via `unwrap_or(live)`), so both are exposed
   * separately rather than derived from one another.
   */
  hasProtocolCaps?: boolean | null;
  protocolCaps?: (BN | bigint | number)[] | null;
  /**
   * Item 3 (2026-06-22): protocol_hashes override. null = pass-through from live
   * policy (the on-chain queue merges via `unwrap_or(live)`); a Buffer[] sets the
   * full index-aligned hash array (arm/disarm/re-pin). Bound at canonical digest
   * position 25.
   */
  protocolHashes?: Buffer[] | null;
}

function pick<T>(override: T | null | undefined, fallback: T): T {
  return override == null ? fallback : override;
}

export function queuePolicyMergedDigest(
  live: LiveLikePolicy,
  override: QueueOverride,
  observeOnly: boolean,
): number[] {
  return computePolicyPreviewDigest({
    dailySpendingCapUsd: pick(
      override.dailySpendingCapUsd,
      live.dailySpendingCapUsd,
    ),
    maxTransactionSizeUsd: pick(
      override.maxTransactionSizeUsd,
      live.maxTransactionSizeUsd,
    ),
    maxSlippageBps: pick(override.maxSlippageBps, live.maxSlippageBps),
    // PEN-CROSS-6: developer_fee_rate flows through the merge identically.
    developerFeeRate: pick(
      override.developerFeeRate,
      live.developerFeeRate ?? 0,
    ),
    protocolMode: pick(override.protocolMode, live.protocolMode),
    protocols: pick(override.protocols, live.protocols),
    destinationMode: pick(override.destinationMode, live.destinationMode),
    allowedDestinations: pick(
      override.allowedDestinations,
      live.allowedDestinations,
    ),
    timelockDuration: pick(override.timelockDuration, live.timelockDuration),
    sessionExpirySeconds: pick(
      override.sessionExpirySeconds,
      live.sessionExpirySeconds,
    ),
    observeOnly,
    hasPostAssertions: live.hasPostAssertions,
    // PEN-CROSS-2: created_at_slot is immutable post-init — always sourced
    // from live policy. Queue does NOT mutate it; no override is exposed.
    createdAtSlot: live.createdAtSlot ?? 0,
    // TA-05 (Phase 3): operating_hours is mutable via queue (override) or
    // pass-through from live.
    operatingHours: pick(override.operatingHours, live.operatingHours ?? 0),
    // TA-07/17 (Phase 3): pass-through from live policy (queue does not
    // mutate these in V1, but override is exposed for future flexibility).
    autoPromoteGrays: pick(
      override.autoPromoteGrays,
      live.autoPromoteGrays ?? false,
    ),
    autoRevokeThreshold: pick(
      override.autoRevokeThreshold,
      live.autoRevokeThreshold ?? 0,
    ),
    // TA-12 (Phase 5): merged-effective stable_balance_floor.
    stableBalanceFloor: pick(
      override.stableBalanceFloor,
      live.stableBalanceFloor ?? 0,
    ),
    // TA-14 (Phase 5): merged-effective per-recipient daily cap.
    perRecipientDailyCapUsd: pick(
      override.perRecipientDailyCapUsd,
      live.perRecipientDailyCapUsd ?? 0,
    ),
    // G6 (audit 2026-05-18 cosign opt-in): merged-effective cosign_required.
    cosignRequired: pick(override.cosignRequired, live.cosignRequired ?? false),
    // Phase 8 PEN-CROSS-1: queue_policy_update does NOT mutate the agent
    // set — pass through from live policy snapshot.
    agentSetHash: live.agentSetHash ?? EMPTY_AGENT_SET_HASH,
    // D-5 (audit 2026-05-19, F-RP3-1): merged-effective cosign_session_pubkey.
    // null override = pass-through from live policy. Defaults to
    // PublicKey.default (gate disabled) when live is unset.
    cosignSessionPubkey: pick(
      override.cosignSessionPubkey,
      live.cosignSessionPubkey ?? PublicKey.default,
    ),
    // F-Q6 (2026-06-02): merged-effective operator_grant_delay_seconds.
    // Mirrors the on-chain queue merge `unwrap_or(live)` — null override =
    // pass-through from live policy (default 0 when live is unset).
    operatorGrantDelaySeconds: pick(
      override.operatorGrantDelaySeconds,
      live.operatorGrantDelaySeconds ?? 0,
    ),
    // M-1 (audit 2026-06-11): merged-effective per-protocol caps. Mirrors the
    // on-chain queue merge (`has_protocol_caps`/`protocol_caps` each
    // `unwrap_or(live)`) — null override = pass-through from live policy.
    hasProtocolCaps: pick(
      override.hasProtocolCaps,
      live.hasProtocolCaps ?? false,
    ),
    protocolCaps: pick(override.protocolCaps, live.protocolCaps ?? []),
    // Item 3 (2026-06-22): merged-effective protocol_hashes. Mirrors the on-chain
    // queue merge `unwrap_or(live)` — null override = pass-through from live
    // policy (default [] / gate-off when live is unset).
    protocolHashes: pick(override.protocolHashes, live.protocolHashes ?? []),
  });
}

/**
 * PEN-CROSS-3 (Phase 2 close-up): compute the expected post-mutation digest
 * for one of the 4 sibling handlers. Mirrors the SDK helper
 * `siblingHandlerExpectedDigest`.
 *
 * Pass `hasConstraints`/`hasPostAssertions` to override the flag the handler
 * is about to flip. The rest of the digest fields are read off the live
 * PolicyConfig + AgentVault.
 */
export async function siblingHandlerDigest(
  program: any,
  policyPda: PublicKey,
  vaultPda: PublicKey,
  override: { hasPostAssertions?: number },
): Promise<number[]> {
  const policy = await program.account.policyConfig.fetch(policyPda);
  const vault = await program.account.agentVault.fetch(vaultPda);
  return computePolicyPreviewDigest({
    dailySpendingCapUsd: policy.dailySpendingCapUsd,
    maxTransactionSizeUsd: policy.maxTransactionSizeUsd,
    maxSlippageBps: policy.maxSlippageBps,
    developerFeeRate: policy.developerFeeRate ?? 0,
    protocolMode: policy.protocolMode,
    protocols: policy.protocols,
    destinationMode: policy.destinationMode,
    allowedDestinations: policy.allowedDestinations,
    timelockDuration: policy.timelockDuration,
    sessionExpirySeconds: policy.sessionExpirySeconds,
    observeOnly: !!vault.observeOnly,
    hasPostAssertions:
      override.hasPostAssertions !== undefined
        ? override.hasPostAssertions
        : (policy.hasPostAssertions as number),
    createdAtSlot: policy.createdAtSlot ?? 0,
    // TA-05 (Phase 3): sibling handlers never mutate operating_hours.
    operatingHours: policy.operatingHours ?? 0,
    // TA-07/17 (Phase 3): pass through.
    autoPromoteGrays: !!policy.autoPromoteGrays,
    autoRevokeThreshold: policy.autoRevokeThreshold ?? 0,
    // TA-12 (Phase 5): pass-through. Sibling handlers never mutate this.
    stableBalanceFloor: policy.stableBalanceFloor ?? 0,
    // TA-14 (Phase 5): pass-through. Sibling handlers never mutate this.
    perRecipientDailyCapUsd: policy.perRecipientDailyCapUsd ?? 0,
    // G6 (audit 2026-05-18 cosign opt-in): pass-through from live policy.
    // Sibling handlers (constraints / post-assertions flips) never mutate
    // cosign_required.
    cosignRequired: !!policy.cosignRequired,
    // Phase 8 PEN-CROSS-1: sibling handlers never mutate the agent set.
    // Compute from `vault.agents` (which Anchor decodes into the AgentEntry
    // shape with `pubkey`/`capability` fields).
    agentSetHash: computeAgentSetHash(
      (vault.agents as ReadonlyArray<{
        pubkey: PublicKey;
        capability: number;
      }>) ?? [],
    ),
    // D-5 (audit 2026-05-19, F-RP3-1): pass-through from live policy.
    // Sibling handlers never mutate cosign_session_pubkey. Default
    // PublicKey.default when the live field is absent (legacy account
    // decoded against pre-D-5 IDL).
    cosignSessionPubkey:
      (policy.cosignSessionPubkey as PublicKey | undefined) ??
      PublicKey.default,
    // F-Q6 (2026-06-02): pass-through from live policy. Sibling handlers
    // (register/revoke/pause/unpause + post-assertions flips) never mutate
    // operator_grant_delay_seconds; mirrors the register_agent.rs recompute.
    operatorGrantDelaySeconds:
      (policy.operatorGrantDelaySeconds as BN | undefined) ?? 0,
  });
}

/**
 * Async helper that fetches the live policy + vault from a Program client,
 * then computes the merged digest for a queue. Tests pass the program client,
 * policyPda, vaultPda, and the override object — the helper handles the rest.
 *
 * Typed loosely (`any`) for Program/PolicyConfig/AgentVault because the test
 * helper module sits outside the Anchor-generated types graph.
 */
export async function fetchAndComputeQueueDigest(
  program: any,
  policyPda: PublicKey,
  vaultPda: PublicKey,
  override: QueueOverride,
): Promise<number[]> {
  const policy = await program.account.policyConfig.fetch(policyPda);
  const vault = await program.account.agentVault.fetch(vaultPda);
  const live: LiveLikePolicy = {
    dailySpendingCapUsd: policy.dailySpendingCapUsd,
    maxTransactionSizeUsd: policy.maxTransactionSizeUsd,
    maxSlippageBps: policy.maxSlippageBps,
    developerFeeRate: policy.developerFeeRate ?? 0,
    protocolMode: policy.protocolMode,
    protocols: policy.protocols,
    destinationMode: policy.destinationMode,
    allowedDestinations: policy.allowedDestinations,
    timelockDuration: policy.timelockDuration,
    sessionExpirySeconds: policy.sessionExpirySeconds,
    hasPostAssertions: policy.hasPostAssertions,
    createdAtSlot: policy.createdAtSlot ?? 0,
    operatingHours: policy.operatingHours ?? 0,
    autoPromoteGrays: !!policy.autoPromoteGrays,
    autoRevokeThreshold: policy.autoRevokeThreshold ?? 0,
    stableBalanceFloor: policy.stableBalanceFloor ?? 0,
    perRecipientDailyCapUsd: policy.perRecipientDailyCapUsd ?? 0,
    cosignRequired: !!policy.cosignRequired,
    // Phase 8 PEN-CROSS-1: snapshot agent_set_hash from live vault.
    agentSetHash: computeAgentSetHash(
      (vault.agents as ReadonlyArray<{
        pubkey: PublicKey;
        capability: number;
      }>) ?? [],
    ),
    // D-5 (audit 2026-05-19, F-RP3-1): snapshot cosign_session_pubkey
    // from live policy. Falls back to PublicKey.default when the field
    // is absent (legacy account / pre-D-5 IDL deserialization).
    cosignSessionPubkey:
      (policy.cosignSessionPubkey as PublicKey | undefined) ??
      PublicKey.default,
    // F-Q6 (2026-06-02): snapshot operator_grant_delay_seconds from live
    // policy (BN from Anchor). Falls back to 0 when absent (pre-F-Q6 IDL).
    operatorGrantDelaySeconds:
      (policy.operatorGrantDelaySeconds as BN | undefined) ?? 0,
    // M-1 (audit 2026-06-11): snapshot per-protocol caps from the live policy so
    // the merged-effective digest matches the on-chain recompute (which always
    // reflects live caps when the queue does not override them). Falls back to
    // false/[] when absent (pre-M-1 IDL deserialization). Callers changing caps
    // pass the new values via the `override` arg (hasProtocolCaps/protocolCaps).
    hasProtocolCaps: !!policy.hasProtocolCaps,
    protocolCaps:
      (policy.protocolCaps as Array<BN | bigint | number> | undefined) ?? [],
    // Item 3 (2026-06-22): snapshot the live protocol_hashes from the policy so
    // the merged-effective digest matches the on-chain recompute (which always
    // reflects live hashes when the queue does not override them). Anchor decodes
    // the on-chain `[[u8;32];10]` as an array of byte arrays; normalize each to a
    // 32-byte Buffer. Falls back to [] when absent (pre-Item-3 IDL).
    protocolHashes: (
      (policy.protocolHashes as Array<number[] | Uint8Array | Buffer>) ?? []
    ).map((h) => Buffer.from(h as Uint8Array)),
  };
  return queuePolicyMergedDigest(live, override, !!vault.observeOnly);
}
