/**
 * TA-09 (agent-perms) — Canonical agent-permissions cosign digest (SDK side).
 *
 * Mirrors `programs/sigil/src/utils/cosign_digest.rs::compute_agent_perms_cosign_digest`
 * byte-for-byte. Separate from the policy `computeCosignDigest` by design: the
 * policy digest binds policy fields; this one binds per-agent permission fields.
 *
 * Flow: on a `cosign_required` vault, raising an agent's capability or spending
 * limit (or setting a non-zero cooldown) is an ELEVATED mutation. The owner +
 * cosigner co-sign `queue_agent_permissions_update`; the handler recomputes this
 * digest from the pending args + cosign-session pubkey and stores it, then
 * `apply_agent_permissions_update` recomputes and asserts byte-equality
 * (`ErrCosignRequired` on mismatch). This SDK helper produces the value an
 * elevated transaction builder must reproduce.
 *
 * CANONICAL ENCODING (APPEND-ONLY — 81 bytes, NO Option tags / length prefixes /
 * domain separator; mirrors cosign_digest.rs:110-117):
 *   1. cosign_session : Pubkey (32 bytes raw)
 *   2. agent          : Pubkey (32 bytes raw) — binds the digest to a specific
 *      agent (prevents queue-on-A / apply-on-B replay)
 *   3. new_capability : u8 (1 byte)
 *   4. spending_limit_usd : u64 LE (8 bytes)
 *   5. cooldown_seconds   : u64 LE (8 bytes)
 */

import type { Address } from "../kit-adapter.js";
import { base58Decode32, sha256, writeU64Le } from "../canonical-encode.js";

/** 32 (session) + 32 (agent) + 1 (capability) + 8 (limit) + 8 (cooldown). */
const AGENT_PERMS_COSIGN_DIGEST_SIZE = 81;

/**
 * Canonical agent-perms cosign-digest input shape. Matches the on-chain
 * `AgentPermsCosignDigestFields` struct exactly. Unlike the policy cosign
 * digest, every field is unconditional fixed-width — there are NO `Option`
 * discriminator bytes here (do not copy the policy-digest pattern).
 */
export interface AgentPermsCosignDigestFields {
  /** The cosigning session pubkey (matches pending_agent_perms.cosign_session). */
  cosignSession: Address | string;
  /** The target agent's pubkey. */
  agent: Address | string;
  /** Proposed new capability: 0=Disabled, 1=Observer, 2=Operator. */
  newCapability: number;
  /** Proposed per-agent spending limit ($ × 1e6). */
  spendingLimitUsd: bigint;
  /** Proposed cooldown in seconds (0 = none). */
  cooldownSeconds: bigint;
}

/**
 * Compute the canonical SHA-256 agent-perms cosign digest. Returns a 32-byte
 * Uint8Array, byte-identical to the on-chain helper for the same input.
 *
 * @throws if either pubkey doesn't base58-decode to exactly 32 bytes
 */
export function computeAgentPermsCosignDigest(
  fields: AgentPermsCosignDigestFields,
): Uint8Array {
  const buf = new Uint8Array(AGENT_PERMS_COSIGN_DIGEST_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let off = 0;
  // 1. cosign_session (32 bytes raw)
  buf.set(base58Decode32(fields.cosignSession as string), off);
  off += 32;
  // 2. agent (32 bytes raw)
  buf.set(base58Decode32(fields.agent as string), off);
  off += 32;
  // 3. new_capability (u8)
  buf[off++] = fields.newCapability & 0xff;
  // 4. spending_limit_usd (u64 LE)
  off = writeU64Le(view, off, fields.spendingLimitUsd);
  // 5. cooldown_seconds (u64 LE)
  off = writeU64Le(view, off, fields.cooldownSeconds);

  if (off !== buf.length) {
    throw new Error(
      `computeAgentPermsCosignDigest: encoded ${off} bytes, expected ${buf.length}`,
    );
  }
  return sha256(buf);
}
