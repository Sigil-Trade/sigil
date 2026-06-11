/**
 * @usesigil/kit — Phase 7 audit-log read helpers.
 *
 * Bootstrap of the on-chain audit-log surface added in Phase 7 of the V2
 * revamp (see HARDENED_V2_PROMPT_MAP.md §6 Phase 7). Phase 9 SDK redesign
 * will expand this into a full analytics layer; for V1 we expose only the
 * fetch + decode + ordering primitives needed by the dashboard and tests.
 *
 * Two on-chain PDAs are read:
 *   - AuditLogSuccess @ [b"audit_success", vault] — 128-entry circular log
 *     of mutating-instruction successes.
 *   - AuditLogRejected @ [b"audit_rejected", vault] — 64-entry circular log
 *     of finalize_session REJECT-path entries (Audit #2 F-19 split).
 *
 * Both buffers share the same `AuditEntry` shape; only the capacity and
 * the discriminator allocation differ.
 */

import type {
  Address,
  ReadonlyUint8Array,
  Rpc,
  SolanaRpcApi,
} from "./kit-adapter.js";
import {
  fetchAuditLogSuccess as fetchRawSuccess,
  fetchAuditLogRejected as fetchRawRejected,
  type AuditLogSuccess,
  type AuditLogRejected,
} from "./generated/accounts/index.js";
import type { AuditEntry } from "./generated/types/index.js";

// ─── Discriminator constants (mirror state/audit_log_success.rs) ─────────────

/** Reserved sentinel — never written; defense-in-depth zero default. */
export const AUDIT_DISC_RESERVED_ZERO = 0;
/** RESERVED slot. Phase 7 writes NO entries from `validate_and_authorize`;
 *  this slot is held for future per-validate audit rows. The REJECT path of
 *  `finalize_session` uses {@link AUDIT_DISC_FINALIZE_REJECT} (=16) instead. */
export const AUDIT_DISC_VALIDATE = 1;
/** finalize_session SUCCESS path. */
export const AUDIT_DISC_FINALIZE_SUCCESS = 2;
export const AUDIT_DISC_DEPOSIT = 3;
export const AUDIT_DISC_WITHDRAW = 4;
export const AUDIT_DISC_FREEZE = 5;
export const AUDIT_DISC_REACTIVATE = 6;
/** RESERVED for Phase 8 ownership_transfer_initiate. Phase 7 does NOT write. */
export const AUDIT_DISC_OWNERSHIP_INITIATE = 7;
/** RESERVED for Phase 8 ownership_transfer_accept. Phase 7 does NOT write. */
export const AUDIT_DISC_OWNERSHIP_ACCEPT = 8;
/** RESERVED for Phase 8 ownership_transfer_cancel. Phase 7 does NOT write. */
export const AUDIT_DISC_OWNERSHIP_CANCEL = 9;
export const AUDIT_DISC_PAUSE_AGENT = 10;
export const AUDIT_DISC_UNPAUSE_AGENT = 11;
export const AUDIT_DISC_REVOKE_AGENT = 12;
export const AUDIT_DISC_REGISTER_AGENT = 13;
export const AUDIT_DISC_POLICY_APPLY = 14;
export const AUDIT_DISC_CONSTRAINTS_APPLY = 15;
/** finalize_session REJECT path — written only to the rejected buffer when
 *  the session is expired at finalize-time (permissionless crank).
 *  §RP-1 HIGH-1 (2026-05-19): replaces the prior reuse of disc=1
 *  `AUDIT_DISC_VALIDATE` which was forensically ambiguous. */
export const AUDIT_DISC_FINALIZE_REJECT = 16;
// Phase 8 PEN-CROSS-1 (audit 2026-05-19) Batch 6 — queue/apply OPERATOR-class
// agent grant. See state/audit_log_success.rs lines 72-77.
export const AUDIT_DISC_AGENT_GRANT_QUEUE = 17;
export const AUDIT_DISC_AGENT_GRANT_APPLY = 18;
// Phase 8 §RP Fix-Up B (PEN-02b CRITICAL, audit 2026-05-19) — cancel of a
// queued OPERATOR-class agent grant.
export const AUDIT_DISC_AGENT_GRANT_CANCEL = 19;
// M-6 close (audit 2026-05-21) — apply_agent_permissions_update lands a
// per-agent permissions update.
export const AUDIT_DISC_AGENT_PERMS_APPLY = 20;
// M-7 close (audit 2026-05-21) — apply_close_constraints flips
// has_constraints=false and clears the constraints PDA.
export const AUDIT_DISC_CONSTRAINTS_CLOSE_APPLY = 21;
// M-8 close (audit 2026-05-21) — record_agent_violation tripped the
// auto-revoke threshold.
export const AUDIT_DISC_AGENT_AUTO_REVOKED = 22;

/** Capacity of the SUCCESS audit-log buffer (entries before wrap). */
export const AUDIT_LOG_SUCCESS_CAPACITY = 128;
/** Capacity of the REJECTED audit-log buffer (entries before wrap). */
export const AUDIT_LOG_REJECTED_CAPACITY = 64;

// ─── Result types ────────────────────────────────────────────────────────────

/**
 * Result of `fetchAuditLogSuccess` / `fetchAuditLogRejected`.
 * `entries` is ordered OLDEST → NEWEST (i.e. chronological), the buffer's
 * head-pointer is already applied. `head` and `count` are surfaced for
 * advanced callers that want to reconstruct the raw circular layout.
 */
export interface AuditLogView {
  vault: Address;
  head: number;
  count: number;
  /** Entries ordered oldest → newest. Length = min(count, CAPACITY). */
  entries: AuditEntry[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Reorder a raw circular buffer into a chronological entries list.
 *
 * Layout invariant from `state/audit_log_success.rs::append`:
 *   - Write position rolls forward modulo CAPACITY.
 *   - `count` saturates at CAPACITY.
 *   - When `count < CAPACITY`: oldest entry is at index 0, newest at
 *     `head - 1`. The valid range is `[0, count)`.
 *   - When `count == CAPACITY`: buffer is full; oldest entry is at `head`,
 *     newest at `head - 1` (mod CAPACITY).
 */
function orderCircularEntries<T>(
  raw: T[],
  head: number,
  count: number,
  capacity: number,
): T[] {
  if (count <= 0) return [];
  if (count < capacity) {
    return raw.slice(0, count);
  }
  // Wrapped buffer: oldest is at `head`, then forward modulo capacity.
  const out: T[] = [];
  for (let i = 0; i < capacity; i++) {
    out.push(raw[(head + i) % capacity]);
  }
  return out;
}

function toView<TLog extends AuditLogSuccess | AuditLogRejected>(
  raw: TLog,
  capacity: number,
): AuditLogView {
  return {
    vault: raw.vault,
    head: raw.head,
    count: raw.count,
    entries: orderCircularEntries(
      raw.entries as AuditEntry[],
      raw.head,
      raw.count,
      capacity,
    ),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch the on-chain SUCCESS audit log for `vault` and return its entries
 * ordered oldest → newest.
 *
 * Throws when the account does not exist (vault not initialised on this
 * cluster or program) — same semantics as the auto-generated
 * `fetchAuditLogSuccess`. Use `fetchAuditLogSuccessSafe` for a maybe-flavour
 * (added in Phase 9).
 */
export async function fetchAuditLogSuccess(
  rpc: Rpc<SolanaRpcApi>,
  pda: Address,
): Promise<AuditLogView> {
  const raw = await fetchRawSuccess(rpc, pda);
  return toView(raw.data, AUDIT_LOG_SUCCESS_CAPACITY);
}

/**
 * Fetch the on-chain REJECTED audit log for `vault` and return its entries
 * ordered oldest → newest. Phase 7 writes only the `finalize_session`
 * REJECT path here.
 */
export async function fetchAuditLogRejected(
  rpc: Rpc<SolanaRpcApi>,
  pda: Address,
): Promise<AuditLogView> {
  const raw = await fetchRawRejected(rpc, pda);
  return toView(raw.data, AUDIT_LOG_REJECTED_CAPACITY);
}

// ─── Encoding utilities (re-exports + helpers) ───────────────────────────────

/**
 * Return the raw 32-byte `subject` field of an `AuditEntry`.
 *
 * Per-discriminator semantic (mirrors `state/audit_log_success.rs`):
 *   - disc=2/16 (finalize_success/reject) → protocol pubkey
 *   - disc=3/4 (deposit/withdraw)         → SPL Token mint pubkey
 *   - disc=5/6/14/15 (vault-scoped ix)    → vault pubkey
 *   - disc=10..=13 (agent-scoped ix)      → agent pubkey
 *
 * The raw field is a `[u8; 32]` so callers without the SDK's Address
 * machinery can still operate on the underlying bytes.
 */
export function subjectBytes(entry: AuditEntry): ReadonlyUint8Array {
  return entry.subject;
}

// §RP-1 HIGH-2 (2026-05-19) — removed `targetProtocolBytes` alias in Phase
// 10 Bucket 1 (deferred from Phase 9 D-items). The `target_protocol` field
// was renamed to `subject` since it holds a mint / agent / vault pubkey
// depending on the discriminator. Use {@link subjectBytes} instead.
