use anchor_lang::prelude::*;
// Note: `anchor_lang::solana_program::hash` is NOT re-exported in Anchor 0.32.1.
// Use the `solana-program` direct dep (declared in Cargo.toml) — same
// pattern as `utils/policy_digest.rs` and `state/pending_constraints.rs`.
use solana_program::hash::hash as sha256_hash;

/// Phase 8 PEN-CROSS-1 (Council ISC-58..65) — queued OPERATOR-class agent grant.
///
/// `register_agent` (Batch 6) now hard-rejects `capability == CAPABILITY_OPERATOR`
/// (closes the phished-owner instant-operator-grant vector). To grant an
/// OPERATOR-class agent the owner now MUST route through the two-step queue
/// + apply timelock-gated path:
///
///   1. `queue_agent_grant(agent, capability=OPERATOR, spending_limit_usd)` →
///      writes this PDA, captures `queued_at`, requires cosign when
///      `policy.cosign_required == true`.
///   2. `apply_agent_grant()` after `now - queued_at >= min_delay_seconds` →
///      pushes the agent into `vault.agents`, re-derives the policy preview
///      digest with the new `agent_set_hash`, bumps `policy.policy_version`,
///      and closes the pending PDA.
///
/// PDA seeds: `[b"pending_agent_grant", vault.key().as_ref()]`. There is at
/// most ONE pending OPERATOR grant per vault — `init` against a duplicate
/// pubkey rejects via the standard Anchor "account already in use" path,
/// mirroring `PendingOwnershipTransfer` and `PendingPolicyUpdate`.
#[account]
#[derive(Default)]
pub struct PendingAgentGrant {
    /// PDA-bound vault. Defense-in-depth duplicate of the seeds vault prefix.
    pub vault: Pubkey, // 32
    /// Agent pubkey being granted. Validated against the existing
    /// `vault.is_agent` set at apply time (the Anchor `init` of the PDA
    /// itself prevents double-queue per agent because the seed includes the
    /// vault only — apply also re-checks for double-registration).
    pub agent: Pubkey, // 32
    /// Target capability. Hard-rejected at queue time unless `>= CAPABILITY_OPERATOR`
    /// — this is the WHOLE POINT of the queued path. Stored as u8 for wire
    /// compatibility with `vault.agents[i].capability`.
    pub capability: u8, // 1
    /// Per-agent rolling-24h spend limit (USDC face value, 6 decimals).
    /// Mirrors `register_agent`'s arg.
    pub spending_limit_usd: u64, // 8
    /// `Clock::unix_timestamp` at queue time. Timelock enforced as
    /// `clock.unix_timestamp - queued_at >= min_delay_seconds`.
    pub queued_at: i64, // 8
    /// Owner-configurable timelock window (seconds). Defaults to
    /// `Self::DEFAULT_MIN_DELAY = 172_800s = 48h` — matches the
    /// `PendingOwnershipTransfer` 48h window so an OPERATOR-class grant
    /// (which is at least as elevated as ownership transfer in capability
    /// terms) gets the full observation window for the owner to detect a
    /// phished-key queue and cancel via `cancel_agent_grant`.
    ///
    /// Phase 8 §RP Fix-Up B (PEN-02a CRITICAL, audit 2026-05-19): raised
    /// from 30min → 48h. The previous default gave a phished owner only
    /// 30 minutes to react. 48h matches the ownership-transfer floor; a
    /// future SDK call may permit owner-configurable shortening if
    /// `policy.timelock_duration` permits, but the V1 default is the
    /// 48h floor for safety.
    pub min_delay_seconds: u64, // 8
    /// PDA bump.
    pub bump: u8, // 1
    /// 6-byte alignment cushion + additive headroom for future v1.1
    /// extensions (e.g. cooldown_seconds binding). Zero-init on `init`.
    pub _padding: [u8; 6], // 6
    /// M-5 close (Bucket 2, Phase 10 PEN-CROSS-3): SHA-256 over the
    /// canonical byte encoding of the pending content (vault + agent +
    /// capability + spending_limit_usd + queued_at + min_delay_seconds +
    /// queued_at_slot — CH-1 close Bucket-3 audit 2026-05-23 folded
    /// queued_at_slot into the canonical encoder at position 7).
    /// Written once at `queue_agent_grant` and re-asserted at
    /// `apply_agent_grant` before any mutation of `vault.agents`.
    ///
    /// Defense-in-depth against discriminator-collision overwrite of
    /// this pending PDA's body between queue and apply: even if a future
    /// bug allowed a same-seed CPI to rewrite the grant fields, the
    /// digest recorded at queue time pins the owner-attested content,
    /// and the apply-time recompute would diverge and reject with
    /// `ErrPendingAgentGrantDigestMismatch`.
    ///
    /// Alignment: Anchor's `#[account]` uses Borsh on-the-wire layout, so
    /// the byte arithmetic is purely additive: 104 + 32 + 8 = 144 bytes
    /// total (CH-1 Bucket-3 added 8 bytes for queued_at_slot).
    /// `[u8; 32]` has alignment 1, so no padding is required regardless of
    /// the preceding `u8` + `[u8; 6]` shape.
    pub pending_content_digest: [u8; 32], // 32

    /// CH-1 close (Bucket-3 audit 2026-05-23): slot at queue time for
    /// F-10 freshness check. Paired with `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN`
    /// to defend against the Drift-April-2026 durable-nonce pre-signing
    /// attack class: a compromised owner key can pre-sign queue+apply ix
    /// in the same slot, queue NOW, then replay the pre-signed apply
    /// weeks later. Slot-based F-10 catches the "weeks later" case.
    ///
    /// Note: `queued_at: i64` above is the existing unix-timestamp used
    /// by the 48h timelock countdown — that semantic is unchanged. This
    /// slot field is additive and load-bearing only for the F-10 fresh-
    /// ness check.
    pub queued_at_slot: u64, // 8
}

impl PendingAgentGrant {
    /// Account discriminator (8) + Pubkey×2 (64) + u8 (1) + u64 (8) +
    /// i64 (8) + u64 (8) + u8 (1) + padding[6] (6) + digest[32] (32) +
    /// queued_at_slot (8) = 144 bytes.
    /// M-5 close (Bucket 2, PEN-CROSS-3): +32 bytes for `pending_content_digest`.
    /// CH-1 close (Bucket-3 audit 2026-05-23): +8 bytes for `queued_at_slot`.
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 8 + 8 + 8 + 1 + 6 + 32 + 8;

    /// Default timelock: 48 hours (matches
    /// `PendingOwnershipTransfer::DEFAULT_MIN_DELAY`). OPERATOR-class agent
    /// grants are at least as elevated as ownership transfer in capability
    /// terms — the owner gets the full 48h observation window to detect a
    /// phished-key queue and call `cancel_agent_grant` before
    /// `apply_agent_grant` can land.
    ///
    /// Phase 8 §RP Fix-Up B (PEN-02a CRITICAL, audit 2026-05-19): raised
    /// from `MIN_TIMELOCK_DURATION = 1800s` (30 min) to 172_800s (48h).
    pub const DEFAULT_MIN_DELAY: u64 = 172_800;
}

// Compile-time pin — drift in the documented byte layout breaks the build.
// Mirrors the §RP-1 pattern used for `PendingOwnershipTransfer`.
//
// M-5 close (Bucket 2, PEN-CROSS-3): bumped from 104 → 136 bytes (+32 for
// `pending_content_digest`). This is the load-bearing reminder that any new
// field on `PendingAgentGrant` MUST also be folded into the
// `canonical_bytes_of_pending_agent_grant` encoding below, else the
// queue/apply digest invariant silently regresses.
// CH-1 close (Bucket-3 audit 2026-05-23): bumped 136 → 144 bytes (+8 for
// `queued_at_slot`). The new slot field IS folded into the canonical bytes
// (position 7) so a tampered slot fails the apply-time digest recompute.
const _PENDING_AGENT_GRANT_SIZE_PIN: () = assert!(
    PendingAgentGrant::SIZE == 144,
    "PendingAgentGrant::SIZE drifted from documented 144 bytes (CH-1 Bucket-3 baseline)",
);

/// M-5 close (Bucket 2, Phase 10 PEN-CROSS-3) — canonical byte encoding of the
/// content fields of a `PendingAgentGrant` PDA.
///
/// COVERS:
///   1. `vault: Pubkey`              (32 bytes)
///   2. `agent: Pubkey`              (32 bytes)
///   3. `capability: u8`             (1 byte)
///   4. `spending_limit_usd: u64`    (8 bytes, LE)
///   5. `queued_at: i64`             (8 bytes, LE)
///   6. `min_delay_seconds: u64`     (8 bytes, LE)
///   7. `queued_at_slot: u64`        (8 bytes, LE)  [CH-1 close, Bucket-3 2026-05-23]
///
/// EXCLUDES (intentional — these are re-applied at apply time or are
/// alignment-only and would defeat the apply-time recompute):
///   - `bump`                            (re-derived by Anchor at apply time)
///   - `_padding[6]`                     (alignment-only)
///   - `pending_content_digest` itself   (the field being asserted)
///
/// INCLUDES (intentional — these ARE content and tampering them must fail
/// the apply-time digest recompute):
///   - `queued_at_slot` [CH-1 close]: an attacker who rewrites the slot
///     between queue and apply to evade the F-10 staleness check would
///     also have to forge a matching digest. By folding the slot into
///     the canonical encoding, we make that forgery infeasible without
///     also defeating SHA-256.
///
/// Total fixed-size canonical encoding: 97 bytes.
///
/// CALL SITES:
///   - `queue_agent_grant.rs`   — writes the digest after populating the
///     pending PDA. Recorded as the owner-attested grant snapshot.
///   - `apply_agent_grant.rs`   — recomputes the digest from the live
///     pending PDA bytes and rejects with
///     `ErrPendingAgentGrantDigestMismatch` if the recomputed value
///     diverges from the stored one. Constant-time compare via
///     `ct_eq_32` (shared from `state::pending_constraints`) to deny
///     timing side-channels.
pub fn canonical_bytes_of_pending_agent_grant(pending: &PendingAgentGrant) -> Vec<u8> {
    // 97-byte fixed-size buffer. No bounded-list inputs → exact size.
    let mut buf: Vec<u8> = Vec::with_capacity(32 + 32 + 1 + 8 + 8 + 8 + 8);

    // 1. vault: Pubkey (32 bytes, raw)
    buf.extend_from_slice(pending.vault.as_ref());
    // 2. agent: Pubkey (32 bytes, raw)
    buf.extend_from_slice(pending.agent.as_ref());
    // 3. capability: u8
    buf.push(pending.capability);
    // 4. spending_limit_usd: u64 LE
    buf.extend_from_slice(&pending.spending_limit_usd.to_le_bytes());
    // 5. queued_at: i64 LE
    buf.extend_from_slice(&pending.queued_at.to_le_bytes());
    // 6. min_delay_seconds: u64 LE
    buf.extend_from_slice(&pending.min_delay_seconds.to_le_bytes());
    // 7. queued_at_slot: u64 LE  [CH-1 close, Bucket-3 2026-05-23]
    buf.extend_from_slice(&pending.queued_at_slot.to_le_bytes());

    buf
}

/// M-5 close (Bucket 2, PEN-CROSS-3) — SHA-256 over the canonical encoding.
///
/// Wraps `canonical_bytes_of_pending_agent_grant` + solana_program::hash::hash.
/// Used by BOTH `queue_agent_grant` (record) and `apply_agent_grant` (verify)
/// to guarantee a deterministic queue↔apply digest comparison.
pub fn compute_pending_agent_grant_digest(pending: &PendingAgentGrant) -> [u8; 32] {
    let bytes = canonical_bytes_of_pending_agent_grant(pending);
    sha256_hash(&bytes).to_bytes()
}
