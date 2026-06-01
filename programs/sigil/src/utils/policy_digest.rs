//! TA-19 — canonical policy preview digest.
//!
//! Both the SDK (`computePolicyPreviewDigest` in `sdk/kit/src/policy/`) and the
//! on-chain handlers compute the same SHA-256 over the same Borsh-encoded bytes.
//! The owner signs the digest at `queue_policy_update` (or `initialize_vault`),
//! and `apply_pending_policy` re-asserts it before any field is copied to the
//! live policy.
//!
//! CANONICAL ENCODING (FIXED — DO NOT REORDER, breaking this changes existing
//! pending digests). All fields use stock Borsh:
//!
//! 1. `daily_spending_cap_usd: u64`   (8 bytes, LE)
//! 2. `max_transaction_size_usd: u64` (8 bytes, LE)
//! 3. `max_slippage_bps: u16`         (2 bytes, LE)
//! 4. `developer_fee_rate: u16`       (2 bytes, LE) — PEN-CROSS-6 (Phase 2 close-up)
//! 5. `protocol_mode: u8`             (1 byte)
//! 6. `protocols: Vec<Pubkey>`        (4 byte LE len ++ each Pubkey 32 bytes)
//! 7. `destination_mode: u8`          (1 byte)
//! 8. `allowed_destinations: Vec<Pubkey>` (4 byte LE len ++ each Pubkey 32 bytes)
//! 9. `timelock_duration: u64`        (8 bytes, LE)
//! 10. `session_expiry_seconds: u64`  (8 bytes, LE)
//! 11. `observe_only: bool`           (1 byte, 0 or 1)
//! M1-04 (digest-version bump): field 12 `has_constraints` REMOVED with the
//! constraints engine; fields below renumbered (was 13..22, now 12..21).
//! 12. `has_post_assertions: u8`      (1 byte)
//! 13. `created_at_slot: u64`         (8 bytes, LE) — PEN-CROSS-2 (Phase 2 close-up)
//! 14. `operating_hours: u32`         (4 bytes, LE) — TA-05 (Phase 3 pre-exec)
//! 15. `auto_promote_grays: bool`     (1 byte, 0/1)  — TA-07 (Phase 3 pre-exec)
//! 16. `auto_revoke_threshold: u8`    (1 byte)       — TA-17 (Phase 3 pre-exec)
//! 17. `stable_balance_floor: u64`    (8 bytes, LE)  — TA-12 (Phase 5 post-exec)
//! 18. `per_recipient_daily_cap_usd: u64` (8 bytes, LE) — TA-14 (Phase 5 post-exec)
//! 19. `cosign_required: bool`        (1 byte, 0/1)  — G6 (audit 2026-05-18 cosign opt-in)
//! 20. `agent_set_hash: [u8; 32]`     (32 bytes)     — Phase 8 PEN-CROSS-1
//! 21. `cosign_session_pubkey: Pubkey` (32 bytes)    — D-5 (audit 2026-05-19, F-RP3-1)
//!
//! Phase 3 append-only additions (TA-05/07/17): the three new policy-owned
//! fields are appended at positions 15-17 to preserve the existing 14-field
//! prefix (F-14 APPEND-ONLY rule).
//!
//! Phase 5 append-only additions (TA-12/TA-14): `stable_balance_floor` at
//! position 18, `per_recipient_daily_cap_usd` at position 19. The owner's
//! chosen reserve and per-recipient cap are part of the signed policy —
//! a compromised SDK or pending-PDA tamperer cannot silently lower them.
//!
//! G6 append-only addition (2026-05-18 audit cosign opt-in): `cosign_required`
//! at position 20 (1 byte, 0/1). Owner's choice to opt into TA-09 cosign
//! enforcement is part of the signed policy — a compromised SDK cannot
//! silently disable cosign between owner approval and on-chain landing.
//! Disabling cosign on a live policy where `cosign_required == true` is
//! itself an elevated mutation per `queue_policy_update`, closing the
//! one-way ratchet: phishing-compromised owner key cannot disable cosign
//! and then drain via subsequent non-elevated mutations.
//!
//! Phase 8 PEN-CROSS-1 append-only addition (Council ISC-66/A8/A9): the
//! `agent_set_hash` at position 20 (was 21 pre-M1-04) binds the EXISTING agent set into the
//! signed digest. SHA-256 over Borsh of `Vec<(Pubkey, u8 capability)>`
//! sorted by pubkey ascending so the projection is deterministic regardless
//! of register order. Closes the silent-insertion vector: a phished owner
//! key calling `register_agent(capability=OPERATOR, FULL_CAPABILITY)` now
//! diverges the digest from the owner's last signed value, breaking the
//! next apply-time digest comparison. Empty Vec produces a deterministic
//! 32-byte hash (SHA-256 of the 4-byte LE-encoded zero length prefix).
//!
//! D-5 append-only addition (audit 2026-05-19, F-RP3-1): the
//! `cosign_session_pubkey` at position 21 (was 22 pre-M1-04) binds the owner's chosen
//! reactivate-time cosigner into the signed policy. The
//! `reactivate_vault` handler reads this pubkey at runtime and requires
//! a matching `is_signer == true` entry in `remaining_accounts` whenever
//! the operation grafts a new agent at `FULL_CAPABILITY`. A tampered SDK
//! cannot silently flip the pubkey between owner approval and on-chain
//! landing — the digest mismatch closes that gap. Default
//! `Pubkey::default()` at init means the gate is OFF; owners opt in via
//! `queue_policy_update`.
//!
//! The graylist itself (`destination_graylist: Vec<(Pubkey, i64)>`) is
//! intentionally NOT in the digest. Reasoning: graylist entries are
//! derived/ephemeral — they auto-populate when the owner adds a new
//! destination via `queue_policy_update`, and they only delay an already-
//! signed allowlist entry. The owner-signed digest already binds the
//! destination allowlist (position 8). Promoting via
//! `promote_graylist_destination` only accelerates the existing unlock — it
//! cannot widen the allowlist. So including the graylist would force the
//! owner to re-sign the digest on every unlock-time advancement, which is
//! ephemeral noise. The allowlist (position 8) carries the load-bearing
//! authorisation; the graylist is unsigned friction. By contrast,
//! `auto_promote_grays` IS in the digest: the owner's CHOICE to bypass
//! friction is configuration, not ephemeral state.

use crate::state::AgentEntry;
use anchor_lang::prelude::*;
// Note: `anchor_lang::solana_program::hash` is NOT re-exported in Anchor 0.32.1.
// Use the `solana-program` direct dep (declared in Cargo.toml).
use solana_program::hash::{hash, hashv};

/// Canonical preview fields. Owner re-creates this off-chain via the SDK; the
/// handler re-creates it on-chain from the resulting `PolicyConfig` (or the
/// merge of `PolicyConfig + PendingPolicyUpdate`). The two SHA-256 digests
/// must match.
pub struct PolicyPreviewFields<'a> {
    pub daily_spending_cap_usd: u64,
    pub max_transaction_size_usd: u64,
    pub max_slippage_bps: u16,
    /// PEN-CROSS-6 (Phase 2 close-up): `developer_fee_rate` lives on
    /// `PolicyConfig` but was previously NOT in the digest. A compromised SDK
    /// could insert a non-zero fee rate that bypasses the user's signed
    /// digest. Now bound at position 4 of the canonical encoding.
    pub developer_fee_rate: u16,
    pub protocol_mode: u8,
    pub protocols: &'a [Pubkey],
    pub destination_mode: u8,
    pub allowed_destinations: &'a [Pubkey],
    pub timelock_duration: u64,
    pub session_expiry_seconds: u64,
    pub observe_only: bool,
    // M1-04: has_constraints removed (digest-version bump).
    pub has_post_assertions: u8,
    /// PEN-CROSS-2 (Phase 2 close-up): the slot at which the vault was
    /// initialized. Closes the close+reinit replay window — replaying a
    /// signed `initialize_vault` against a fresh (owner, vault_id) PDA
    /// produces a slot mismatch and `PolicyPreviewMismatch` rejects it.
    pub created_at_slot: u64,
    /// TA-05 (Phase 3): 24-bit UTC operating-hours bitmask. Bit `n` set →
    /// the vault permits spending at UTC hour `n`. Bound at position 15 of
    /// the canonical digest so owner-blind-sign cannot land a permissive
    /// 0xFFFFFF when the owner thought they signed a narrow market-hours
    /// mask. Upper 8 bits (24..=31) MUST be zero — handler rejects with
    /// `ErrOutsideOperatingHours` if violated.
    pub operating_hours: u32,
    /// TA-07 (Phase 3): owner's "skip 24h graylist friction" toggle. The
    /// graylist Vec itself is NOT in the digest (derived/ephemeral, gated
    /// by the already-bound allowlist at position 8), but the owner's
    /// CHOICE to bypass it IS — silent flips can't change the friction
    /// model. Bound at position 16.
    pub auto_promote_grays: bool,
    /// TA-17 (Phase 3): consecutive-failure threshold for auto-revoke.
    /// Range 3..=20 enforced at policy-write time. Bound at position 17.
    pub auto_revoke_threshold: u8,
    /// TA-12 (Phase 5): owner-chosen hard floor on combined USDC + USDT
    /// vault balance, asserted at the end of every finalize_session
    /// spending path. 6-decimal USDC face value. Bound at position 18.
    pub stable_balance_floor: u64,
    /// TA-14 (Phase 5): per-recipient rolling 24h outflow cap in 6-decimal
    /// USDC face value. Default 0 = no per-recipient cap. Bound at
    /// position 19.
    pub per_recipient_daily_cap_usd: u64,
    /// G6 (audit 2026-05-18 cosign opt-in): owner's choice to require
    /// TA-09 cosign on elevated mutations. Default false (low-friction).
    /// When true, `queue_policy_update`'s elevation checks fire and
    /// require a non-default cosign session + signer. Bound at
    /// position 20 of the canonical encoding so a compromised SDK
    /// cannot silently disable cosign between owner approval and
    /// on-chain landing. Disabling (true → false) is itself elevated.
    pub cosign_required: bool,
    /// Phase 8 PEN-CROSS-1 (Council ISC-66/A8/A9): SHA-256 over Borsh of
    /// `Vec<(Pubkey, u8 capability)>` sorted by pubkey ascending. Binds
    /// the EXISTING agent set to the policy digest so any silent insertion
    /// of an agent (e.g., phished-owner `register_agent` of an
    /// OPERATOR-class grant) breaks the digest comparison. Empty Vec
    /// produces a deterministic 32-byte hash (SHA-256 of 4-byte LE-encoded
    /// zero length prefix). Bound at position 21 of the canonical encoding.
    pub agent_set_hash: [u8; 32],
    /// D-5 (audit 2026-05-19, F-RP3-1): the owner-chosen pubkey that must
    /// cosign `reactivate_vault` whenever a fresh agent is being grafted
    /// at `FULL_CAPABILITY`. Default `Pubkey::default()` = gate disabled;
    /// any other value enables the runtime gate at the reactivate site.
    /// Bound at position 22 of the canonical encoding so a tampered SDK
    /// cannot silently flip the pubkey between owner approval and
    /// on-chain landing.
    pub cosign_session_pubkey: Pubkey,
}

/// P0.2 PEN-7 defense-in-depth ratchet (audit 2026-05-19).
///
/// Number of fields bound into the TA-19 canonical policy preview digest.
/// `apply_pending_policy.rs` const-asserts equality against this value at
/// compile time. Adding a new field to `PolicyPreviewFields` WITHOUT
/// updating this constant + the digest encoding below breaks `cargo build`
/// — closing the silent-bypass class where a future refactor introduces a
/// policy-owned field that is mutable without owner attestation.
///
/// The const-assert lives at the apply-time site as a load-bearing reminder
/// (apply_pending_policy.rs::EXPECTED_DIGEST_FIELD_COUNT). Both this and
/// the apply-side constant must change in lockstep.
// M1-04: was 22; has_constraints removed (digest-version bump).
pub const POLICY_PREVIEW_FIELD_COUNT: usize = 21;

/// Phase 8 PEN-CROSS-1 (Council ISC-66/A8/A9 / ISC-141 empty-set determinism).
///
/// Compute the canonical `agent_set_hash` from a vault's agent set. Hash is
/// SHA-256 over the standard Borsh encoding of `Vec<(Pubkey, u8 capability)>`
/// sorted by pubkey ascending. Sorting makes the projection deterministic
/// regardless of register order, so two vaults with the same `(pubkey,
/// capability)` set produce byte-identical hashes.
///
/// Empty vault (e.g. immediately after `initialize_vault` — `vault.agents` is
/// empty) produces a deterministic 32-byte hash: SHA-256 of the 4-byte
/// LE-encoded zero length prefix (an empty Borsh `Vec`). Tests pin this
/// value cross-impl (Rust ↔ TypeScript byte equality).
pub fn compute_agent_set_hash(agents: &[AgentEntry]) -> [u8; 32] {
    let mut sorted: Vec<(Pubkey, u8)> = agents.iter().map(|a| (a.pubkey, a.capability)).collect();
    sorted.sort_by_key(|(pk, _)| *pk);
    // Borsh encode: u32 LE length prefix + each (Pubkey, u8). `try_to_vec`
    // produces the same byte layout as the canonical Borsh schema.
    //
    // Phase 8 §RP Fix-Up B (LBL-08 LOW, audit 2026-05-19): replaced
    // `.unwrap_or_default()` with `.expect()`. Borsh encoding of a
    // `Vec<(Pubkey, u8)>` is total — every constituent type implements
    // BorshSerialize without fallible paths. The prior silent fallback to
    // `Vec::default()` (empty Vec) would have produced the EMPTY_AGENT_SET_HASH
    // for an N-entry vault, silently defeating the digest invariant. The
    // panic is provably unreachable today, and it surfaces a programmer
    // error loudly if a future BPF runtime/Borsh upgrade ever introduced a
    // fallible path on this exact type.
    let encoded = sorted
        .try_to_vec()
        .expect("compute_agent_set_hash: Vec<(Pubkey, u8)> Borsh encode is total");
    hash(&encoded).to_bytes()
}

#[cfg(test)]
mod field_count_invariant {
    //! P0.2 PEN-7: destructuring pattern match that fails to compile if
    //! `PolicyPreviewFields` grows without an explicit update to the count
    //! and the digest encoding. The cargo build (which compiles tests
    //! under `cfg(test)`) catches it, AND `cargo test --lib` proves the
    //! count is the actual field count via destructuring.
    use super::*;

    /// If a 23rd field lands on `PolicyPreviewFields`, this match fails
    /// to compile with `missing structure fields` — forcing the developer
    /// to update the digest encoding + the count constant in the SAME
    /// commit. Closes PEN-7 silent-bypass.
    #[test]
    fn ta19_field_count_pinned() {
        // Build a sentinel value using ZERO/empty initialisers — the
        // destructuring below is what's load-bearing, not the field
        // values. The bool fields use `false`, scalars use `0`, slices
        // empty.
        let protocols: &[Pubkey] = &[];
        let allowed_destinations: &[Pubkey] = &[];
        let fields = PolicyPreviewFields {
            daily_spending_cap_usd: 0,
            max_transaction_size_usd: 0,
            max_slippage_bps: 0,
            developer_fee_rate: 0,
            protocol_mode: 0,
            protocols,
            destination_mode: 0,
            allowed_destinations,
            timelock_duration: 0,
            session_expiry_seconds: 0,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 0,
            operating_hours: 0,
            auto_promote_grays: false,
            auto_revoke_threshold: 0,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: agent_set_hash bound at canonical
            // position 21. Sentinel uses [0u8;32] — the empty-agent-set
            // hash test below pins the true deterministic value.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey bound at
            // canonical position 22. Default Pubkey::default() = gate
            // disabled.
            cosign_session_pubkey: Pubkey::default(),
        };
        // The destructuring pattern below is exhaustive. If a 23rd field
        // lands on PolicyPreviewFields, this match fails to compile with
        // E0027 — `missing structure fields`. Forces the digest encoding
        // + POLICY_PREVIEW_FIELD_COUNT to be updated in lockstep.
        let PolicyPreviewFields {
            daily_spending_cap_usd: _,
            max_transaction_size_usd: _,
            max_slippage_bps: _,
            developer_fee_rate: _,
            protocol_mode: _,
            protocols: _,
            destination_mode: _,
            allowed_destinations: _,
            timelock_duration: _,
            session_expiry_seconds: _,
            observe_only: _,
            has_post_assertions: _,
            created_at_slot: _,
            operating_hours: _,
            auto_promote_grays: _,
            auto_revoke_threshold: _,
            stable_balance_floor: _,
            per_recipient_daily_cap_usd: _,
            cosign_required: _,
            agent_set_hash: _,
            cosign_session_pubkey: _,
        } = fields;
        assert_eq!(POLICY_PREVIEW_FIELD_COUNT, 21);
    }
}

/// SHA-256 over the canonical Borsh encoding of the preview fields.
///
/// On-chain memory budget: bounded by `MAX_ALLOWED_PROTOCOLS` (10) +
/// `MAX_ALLOWED_DESTINATIONS` (10) at 32 bytes each + the fixed-width scalars.
/// Worst-case ~700 bytes, comfortably below the BPF stack limit. We use
/// `hashv` on a contiguous `Vec<u8>` rather than incremental hashing because
/// SHA-256 is single-pass and the bound is tight.
pub fn compute_policy_preview_digest(fields: &PolicyPreviewFields<'_>) -> [u8; 32] {
    // Pre-size: 8+8+2+2+1 + 4+32*10 + 1 + 4+32*10 + 8+8+1+1+1+8+4 = ~692 bytes worst case
    let mut buf: Vec<u8> = Vec::with_capacity(720);

    // 1. daily_spending_cap_usd: u64 LE
    buf.extend_from_slice(&fields.daily_spending_cap_usd.to_le_bytes());
    // 2. max_transaction_size_usd: u64 LE
    buf.extend_from_slice(&fields.max_transaction_size_usd.to_le_bytes());
    // 3. max_slippage_bps: u16 LE
    buf.extend_from_slice(&fields.max_slippage_bps.to_le_bytes());
    // 4. developer_fee_rate: u16 LE — PEN-CROSS-6 (Phase 2 close-up)
    buf.extend_from_slice(&fields.developer_fee_rate.to_le_bytes());
    // 5. protocol_mode: u8
    buf.push(fields.protocol_mode);
    // 6. protocols: Vec<Pubkey> — Borsh u32-LE length then concatenated pubkey bytes
    buf.extend_from_slice(&(fields.protocols.len() as u32).to_le_bytes());
    for pk in fields.protocols.iter() {
        buf.extend_from_slice(pk.as_ref());
    }
    // 7. destination_mode: u8
    buf.push(fields.destination_mode);
    // 8. allowed_destinations: Vec<Pubkey>
    buf.extend_from_slice(&(fields.allowed_destinations.len() as u32).to_le_bytes());
    for pk in fields.allowed_destinations.iter() {
        buf.extend_from_slice(pk.as_ref());
    }
    // 9. timelock_duration: u64 LE
    buf.extend_from_slice(&fields.timelock_duration.to_le_bytes());
    // 10. session_expiry_seconds: u64 LE
    buf.extend_from_slice(&fields.session_expiry_seconds.to_le_bytes());
    // 11. observe_only: bool as 1 byte (0/1)
    buf.push(u8::from(fields.observe_only));
    // M1-04 (digest-version bump): field 12 `has_constraints` REMOVED. All
    // fields below shift up by one position (was 13..22, now 12..21).
    // 12. has_post_assertions: u8
    buf.push(fields.has_post_assertions);
    // 13. created_at_slot: u64 LE — PEN-CROSS-2 (Phase 2 close-up)
    buf.extend_from_slice(&fields.created_at_slot.to_le_bytes());
    // 14. operating_hours: u32 LE — TA-05 (Phase 3 pre-exec)
    buf.extend_from_slice(&fields.operating_hours.to_le_bytes());
    // 15. auto_promote_grays: bool as 1 byte (0/1) — TA-07 (Phase 3 pre-exec)
    buf.push(u8::from(fields.auto_promote_grays));
    // 16. auto_revoke_threshold: u8 — TA-17 (Phase 3 pre-exec)
    buf.push(fields.auto_revoke_threshold);
    // 17. stable_balance_floor: u64 LE — TA-12 (Phase 5 post-exec invariant)
    buf.extend_from_slice(&fields.stable_balance_floor.to_le_bytes());
    // 18. per_recipient_daily_cap_usd: u64 LE — TA-14 (Phase 5 post-exec)
    buf.extend_from_slice(&fields.per_recipient_daily_cap_usd.to_le_bytes());
    // 19. cosign_required: bool as 1 byte (0/1) — G6 (audit 2026-05-18 cosign opt-in)
    buf.push(u8::from(fields.cosign_required));
    // 20. agent_set_hash: [u8; 32] — Phase 8 PEN-CROSS-1. Pre-computed
    // SHA-256 of Borsh-encoded `Vec<(Pubkey, u8)>` sorted by pubkey
    // ascending (see `compute_agent_set_hash`). Bound here so any silent
    // mutation of `vault.agents` (e.g. phished-owner `register_agent` of
    // an OPERATOR-capability grant) diverges the policy digest from the
    // owner's last signed value.
    buf.extend_from_slice(&fields.agent_set_hash);
    // 22. cosign_session_pubkey: Pubkey (32 bytes) — D-5 (audit 2026-05-19,
    // F-RP3-1). Owner-chosen reactivate-time cosigner pubkey, default
    // `Pubkey::default()` when the gate is disabled. Bound here so a
    // tampered SDK cannot silently flip the pubkey between owner approval
    // and on-chain landing (the digest mismatch closes that gap).
    buf.extend_from_slice(fields.cosign_session_pubkey.as_ref());

    hashv(&[&buf]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    #[test]
    fn digest_is_deterministic() {
        let protocols = [pk(1), pk(2)];
        let dests = [pk(10)];
        let f = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 0,
            operating_hours: 0,
            auto_promote_grays: false,
            auto_revoke_threshold: 0,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let d1 = compute_policy_preview_digest(&f);
        let d2 = compute_policy_preview_digest(&f);
        assert_eq!(d1, d2, "same fields must produce same digest");
    }

    #[test]
    fn digest_changes_on_observe_only_flip() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 1,
            max_transaction_size_usd: 1,
            max_slippage_bps: 0,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 0,
            operating_hours: 0,
            auto_promote_grays: false,
            auto_revoke_threshold: 0,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let mut flipped = base.daily_spending_cap_usd;
        let _ = &mut flipped; // suppress unused
        let d_base = compute_policy_preview_digest(&base);
        let f_observe = PolicyPreviewFields {
            observe_only: true,
            ..base
        };
        let d_flip = compute_policy_preview_digest(&f_observe);
        assert_ne!(d_base, d_flip, "observe_only flip MUST change digest");
    }

    #[test]
    fn digest_changes_on_protocols_reorder() {
        // Same set, different order — encoding is ordered, so digest differs.
        // (SDK and on-chain both encode in slice order, so the two sides agree.)
        let a = [pk(1), pk(2)];
        let b = [pk(2), pk(1)];
        let dests = [pk(10)];
        let f1 = PolicyPreviewFields {
            daily_spending_cap_usd: 1,
            max_transaction_size_usd: 1,
            max_slippage_bps: 0,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &a,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 0,
            operating_hours: 0,
            auto_promote_grays: false,
            auto_revoke_threshold: 0,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let f2 = PolicyPreviewFields {
            protocols: &b,
            ..f1
        };
        let d1 = compute_policy_preview_digest(&f1);
        let d2 = compute_policy_preview_digest(&f2);
        assert_ne!(d1, d2, "ordered slice → reorder must change digest");
    }

    /// TA-05 (Phase 3 pre-exec): flipping operating_hours from 0x00FFFFFF
    /// (all 24 hours) to a narrower mask MUST change the canonical digest.
    /// Without this, an owner who signed a narrow market-hours mask could
    /// be tricked into landing a permissive 0xFFFFFF on-chain.
    #[test]
    fn digest_changes_on_operating_hours_flip() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 12345,
            operating_hours: 0x00FFFFFF,
            auto_promote_grays: false,
            auto_revoke_threshold: 0,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let narrow = PolicyPreviewFields {
            // 13:00-17:00 UTC = bits 13..17 = 0x1E000
            operating_hours: 0x0001E000,
            ..base
        };
        let d_base = compute_policy_preview_digest(&base);
        let d_narrow = compute_policy_preview_digest(&narrow);
        assert_ne!(d_base, d_narrow, "operating_hours flip MUST change digest");
    }

    /// TA-07 (Phase 3): flipping auto_promote_grays MUST change the digest.
    /// The owner's CHOICE to bypass graylist friction is bound by TA-19 —
    /// silent flips can't change the friction model.
    #[test]
    fn digest_changes_on_auto_promote_grays_flip() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 12345,
            operating_hours: 0x00FFFFFF,
            auto_promote_grays: false,
            auto_revoke_threshold: 5,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let flipped = PolicyPreviewFields {
            auto_promote_grays: true,
            ..base
        };
        let d_base = compute_policy_preview_digest(&base);
        let d_flip = compute_policy_preview_digest(&flipped);
        assert_ne!(d_base, d_flip, "auto_promote_grays flip MUST change digest");
    }

    /// TA-17 (Phase 3): auto_revoke_threshold is bound by the digest. A
    /// threshold of 3 vs 20 produces distinct digests.
    #[test]
    fn digest_changes_on_auto_revoke_threshold_flip() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 12345,
            operating_hours: 0x00FFFFFF,
            auto_promote_grays: false,
            auto_revoke_threshold: 5,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let lower = PolicyPreviewFields {
            auto_revoke_threshold: 3,
            ..base
        };
        let d_base = compute_policy_preview_digest(&base);
        let d_lower = compute_policy_preview_digest(&lower);
        assert_ne!(
            d_base, d_lower,
            "auto_revoke_threshold flip MUST change digest"
        );
    }

    /// TA-14 (Phase 5 post-exec): flipping per_recipient_daily_cap_usd MUST
    /// change the canonical digest. The owner's chosen per-recipient cap is
    /// part of the signed policy — silent flips can't raise (or remove) the
    /// cap to let an attacker drain a single recipient.
    #[test]
    fn digest_changes_on_per_recipient_daily_cap_flip() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 12345,
            operating_hours: 0x00FFFFFF,
            auto_promote_grays: false,
            auto_revoke_threshold: 5,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let raised = PolicyPreviewFields {
            per_recipient_daily_cap_usd: 50_000_000, // $50 cap
            ..base
        };
        let d_base = compute_policy_preview_digest(&base);
        let d_raised = compute_policy_preview_digest(&raised);
        assert_ne!(
            d_base, d_raised,
            "per_recipient_daily_cap_usd flip MUST change digest"
        );
    }

    /// TA-12 (Phase 5 post-exec): flipping stable_balance_floor MUST change
    /// the canonical digest. The owner's chosen reserve is part of the
    /// signed policy — silent flips can't drop the floor and let an attacker
    /// drain past it.
    #[test]
    fn digest_changes_on_stable_balance_floor_flip() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 12345,
            operating_hours: 0x00FFFFFF,
            auto_promote_grays: false,
            auto_revoke_threshold: 5,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let raised = PolicyPreviewFields {
            // $100 floor in 6-decimal USDC face value
            stable_balance_floor: 100_000_000,
            ..base
        };
        let d_base = compute_policy_preview_digest(&base);
        let d_raised = compute_policy_preview_digest(&raised);
        assert_ne!(
            d_base, d_raised,
            "stable_balance_floor flip MUST change digest"
        );
    }

    /// G6 (audit 2026-05-18 cosign opt-in): flipping `cosign_required` MUST
    /// change the canonical digest. The owner's CHOICE to opt into TA-09
    /// cosign is bound by TA-19 — silent flips can't enable or disable
    /// cosign without invalidating the owner's signed digest.
    #[test]
    fn digest_changes_on_cosign_required_flip() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 12345,
            operating_hours: 0x00FFFFFF,
            auto_promote_grays: false,
            auto_revoke_threshold: 5,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: empty-vault agent_set_hash. Tests below
            // pin a known empty-Vec SHA-256; per-test fixtures override.
            agent_set_hash: [0u8; 32],
            // D-5 (audit 2026-05-19): cosign_session_pubkey at position 22.
            // Default Pubkey::default() = gate disabled — preserves prior
            // byte layout for fixtures that don't exercise the field.
            cosign_session_pubkey: Pubkey::default(),
        };
        let flipped = PolicyPreviewFields {
            cosign_required: true,
            ..base
        };
        let d_base = compute_policy_preview_digest(&base);
        let d_flip = compute_policy_preview_digest(&flipped);
        assert_ne!(d_base, d_flip, "cosign_required flip MUST change digest");
    }

    /// D-5 (audit 2026-05-19, F-RP3-1): flipping `cosign_session_pubkey` MUST
    /// change the canonical digest. The owner's chosen reactivate-time
    /// cosigner pubkey is bound by TA-19 at canonical position 22 — silent
    /// flips can't enable or disable the reactivate-cosign gate without
    /// invalidating the owner's signed digest.
    #[test]
    fn digest_changes_on_cosign_session_pubkey_flip() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 12345,
            operating_hours: 0x00FFFFFF,
            auto_promote_grays: false,
            auto_revoke_threshold: 5,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            cosign_required: false,
            agent_set_hash: [0u8; 32],
            cosign_session_pubkey: Pubkey::default(),
        };
        let with_cosigner = PolicyPreviewFields {
            cosign_session_pubkey: pk(99),
            ..base
        };
        let d_base = compute_policy_preview_digest(&base);
        let d_with = compute_policy_preview_digest(&with_cosigner);
        assert_ne!(
            d_base, d_with,
            "cosign_session_pubkey flip MUST change digest"
        );
    }

    /// Phase 8 PEN-CROSS-1 (Council ISC-141): the empty-agent-set hash is
    /// deterministic across two `compute_agent_set_hash(&[])` invocations,
    /// AND matches the `EMPTY_AGENT_SET_HASH` cross-impl pin. If the Borsh
    /// encoding of an empty `Vec<(Pubkey, u8)>` ever changes (impossible
    /// under stock Borsh, but future-proof), this test catches it.
    #[test]
    fn empty_agent_set_hash_is_deterministic() {
        let h1 = compute_agent_set_hash(&[]);
        let h2 = compute_agent_set_hash(&[]);
        assert_eq!(h1, h2, "empty-agent-set hash MUST be deterministic");
        assert_eq!(
            h1, EMPTY_AGENT_SET_HASH,
            "empty-agent-set hash diverged from cross-impl pin",
        );
    }

    /// Phase 8 PEN-CROSS-1: sorting invariant. Two agent sets with the same
    /// `(pubkey, capability)` pairs in different orders MUST produce the
    /// same hash — `compute_agent_set_hash` sorts by pubkey ascending.
    #[test]
    fn agent_set_hash_is_order_independent() {
        let a = AgentEntry {
            pubkey: pk(1),
            capability: 2,
            consecutive_failures: 0,
            _reserved: [0u8; 6],
            spending_limit_usd: 0,
            paused: false,
        };
        let b = AgentEntry {
            pubkey: pk(2),
            capability: 1,
            consecutive_failures: 0,
            _reserved: [0u8; 6],
            spending_limit_usd: 0,
            paused: false,
        };
        let h_ab = compute_agent_set_hash(&[a.clone(), b.clone()]);
        let h_ba = compute_agent_set_hash(&[b, a]);
        assert_eq!(
            h_ab, h_ba,
            "agent_set_hash MUST be order-independent (sorted by pubkey asc)"
        );
    }

    /// Phase 8 PEN-CROSS-1 (Council ISC-66): inserting an agent into a
    /// vault MUST diverge the agent_set_hash AND therefore the policy
    /// preview digest. Closes the silent-insertion vector.
    #[test]
    fn digest_changes_on_agent_set_mutation() {
        let protocols = [pk(1)];
        let dests = [pk(10)];
        let base = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 12345,
            operating_hours: 0x00FFFFFF,
            auto_promote_grays: false,
            auto_revoke_threshold: 5,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            cosign_required: false,
            agent_set_hash: EMPTY_AGENT_SET_HASH,
            // D-5: cosign_session_pubkey at position 22 — default off.
            cosign_session_pubkey: Pubkey::default(),
        };
        // Build a mutated agent set: one OPERATOR agent inserted.
        let new_agent = AgentEntry {
            pubkey: pk(42),
            capability: 2, // CAPABILITY_OPERATOR
            consecutive_failures: 0,
            _reserved: [0u8; 6],
            spending_limit_usd: 0,
            paused: false,
        };
        let mutated_hash = compute_agent_set_hash(&[new_agent]);
        assert_ne!(
            mutated_hash, EMPTY_AGENT_SET_HASH,
            "non-empty agent set hash MUST diverge from EMPTY pin"
        );
        let with_agent = PolicyPreviewFields {
            agent_set_hash: mutated_hash,
            ..base
        };
        let d_base = compute_policy_preview_digest(&base);
        let d_with = compute_policy_preview_digest(&with_agent);
        assert_ne!(
            d_base, d_with,
            "agent_set_hash mutation MUST diverge the policy digest"
        );
    }

    #[test]
    fn digest_known_value_for_minimal_policy() {
        // Pin a known-good byte sequence so SDK + on-chain regressions surface
        // immediately. Empty vectors, all-zero scalars, baseline RESTRICTED.
        let f = PolicyPreviewFields {
            daily_spending_cap_usd: 0,
            max_transaction_size_usd: 0,
            max_slippage_bps: 0,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &[],
            destination_mode: 0,
            allowed_destinations: &[],
            timelock_duration: 0,
            session_expiry_seconds: 0,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: 0,
            // Minimal fixture uses operating_hours=0 (no hours enabled — an
            // inert configuration, but the bytes are deterministic).
            operating_hours: 0,
            // TA-07/17 minimal pins: both zero.
            auto_promote_grays: false,
            auto_revoke_threshold: 0,
            // TA-12 minimal pin: zero floor (default — no reserve).
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            // G6 (audit 2026-05-18): default cosign opt-in = false. Existing
            // fixtures must keep this off so the byte layout below remains
            // pinned; new tests below exercise the flipped case explicitly.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: minimal fixture uses the empty-vault
            // agent_set_hash deterministic pin (Council ISC-141).
            agent_set_hash: EMPTY_AGENT_SET_HASH,
            // D-5 (audit 2026-05-19): minimal fixture pins
            // cosign_session_pubkey = Pubkey::default() — gate disabled.
            // Preserves byte layout symmetry with the prior fixture; the
            // dedicated flip-changes-digest test below exercises the
            // enabled path.
            cosign_session_pubkey: Pubkey::default(),
        };
        // Encoding: 8 zero + 8 zero + 2 zero + 2 zero (developer_fee_rate)
        //   + 0x01 + 4 zero + 0x00 + 4 zero + 8 zero + 8 zero + 0 + 0 + 0
        //   + 8 zero (created_at_slot) + 4 zero (operating_hours TA-05)
        //   + 0 (auto_promote_grays TA-07) + 0 (auto_revoke_threshold TA-17)
        //   + 8 zero (stable_balance_floor TA-12)
        //   + 8 zero (per_recipient_daily_cap_usd TA-14)
        //   + 0 (cosign_required G6 audit 2026-05-18)
        //   + 32 bytes (EMPTY_AGENT_SET_HASH at position 21 PEN-CROSS-1)
        //   + 32 zero bytes (cosign_session_pubkey at position 22 D-5)
        // = 142 bytes deterministic input.
        let digest = compute_policy_preview_digest(&f);
        // Cross-impl pin — same fixture is asserted byte-for-byte in
        // sdk/kit/tests/policy/preview-digest.test.ts. If either side
        // changes the canonical encoding, BOTH digests change and the
        // two tests fail in lock-step. Prior digests:
        //   Pre-PEN-CROSS-6:
        //     29f9a0caa6851902abe7de24ac30380ef50c220d25d541f8fe1762793152b623
        //   Post-PEN-CROSS-6 (pre-PEN-CROSS-2):
        //     0ad67bf0d81b972c60abe82ebea425d4b30d0ef910bcc7b76584fae36a0f1252
        //   Post-PEN-CROSS-2 (pre-TA-05):
        //     63974a2661afc539fc8f1e55245adcef9e3b91f82a191c757ed3c795e8e59148
        //   Post-TA-05 (pre-TA-07/17):
        //     f48fb07695e4b5da504654ad5281f0d39e9fcff6fa9cde64a463f1d8a8471322
        //   Post-TA-07/17 (pre-TA-12):
        //     eec4230cd52f7f567e06e9b197a0dacdc3955808d1a5a256d5975a4ac1177beb
        //   Post-TA-12 (pre-TA-14):
        //     d3e731941e95cb1c426ccc6f2b5c53525c033f498bdb79a593bc86c98508c67a
        //   Post-TA-14 (pre-G6):
        //     45c51e8d77b5a1775ea95c760a4a554288fc246f91e10bac620cfda902936a46
        //   Post-G6 (pre-PEN-CROSS-1):
        //     19c70cb767358d1ce2a4c736b067172e0f87ddad8ae6f98292a62bd5f9bae355
        //   Post-PEN-CROSS-1 (pre-D-5):
        //     a9d8654da866751cbec1c45dcae0b7c3b6e45ee98c2b284b8cd9f8f09d894f83
        // D-5 (audit 2026-05-19, F-RP3-1) appends 32 more bytes
        // (cosign_session_pubkey = Pubkey::default() → 32 zero bytes) at
        // position 22. New digest pinned in REGENERATED_HEX_MINIMAL below.
        let expected: [u8; 32] = REGENERATED_HEX_MINIMAL;
        assert_eq!(
            digest, expected,
            "minimal-policy digest must match SDK fixture (sdk/kit/tests/policy/preview-digest.test.ts)"
        );
    }

    #[test]
    fn digest_known_value_for_realistic_policy() {
        // Realistic policy: 2 protocols, 1 destination, common scalars. Same
        // fixture asserted in sdk/kit/tests/policy/preview-digest.test.ts.
        // Pubkey fill bytes used: [1u8;32], [2u8;32], [10u8;32].
        let protocols = [pk(1), pk(2)];
        let dests = [pk(10)];
        let f = PolicyPreviewFields {
            daily_spending_cap_usd: 500_000_000,
            max_transaction_size_usd: 100_000_000,
            max_slippage_bps: 100,
            developer_fee_rate: 0,
            protocol_mode: 1,
            protocols: &protocols,
            destination_mode: 0,
            allowed_destinations: &dests,
            timelock_duration: 1800,
            session_expiry_seconds: 30,
            observe_only: false,
            has_post_assertions: 0,
            // PEN-CROSS-2: realistic fixture exercises a non-zero
            // created_at_slot to lock the byte layout of an active vault.
            created_at_slot: 12345,
            // TA-05: realistic fixture pins operating_hours = 0x00FFFFFF
            // (all 24h) so the test exercises a representative production
            // value rather than the inert 0.
            operating_hours: 0x00FFFFFF,
            // TA-07: realistic fixture pins auto_promote_grays=false
            // (default — owner did not opt out of friction).
            auto_promote_grays: false,
            // TA-17: realistic fixture pins the default threshold of 5.
            auto_revoke_threshold: 5,
            // TA-12 realistic pin: $100 floor in 6-decimal USDC face value.
            // Exercises a non-zero floor on the canonical byte layout.
            stable_balance_floor: 100_000_000,
            // TA-14 realistic pin: $50 per-recipient daily cap in 6-decimal
            // USDC face value. Exercises a non-zero cap on the canonical
            // byte layout.
            per_recipient_daily_cap_usd: 50_000_000,
            // G6 realistic pin: cosign opt-in default = false (low-friction).
            // The flip-changes-digest test below exercises the true path.
            cosign_required: false,
            // Phase 8 PEN-CROSS-1: realistic fixture uses the empty-vault
            // agent_set_hash (Council ISC-141). Realistic vault has policy
            // configured but no agents yet — matches the typical post-init
            // call site of `apply_pending_policy` re-derive paths.
            agent_set_hash: EMPTY_AGENT_SET_HASH,
            // D-5 (audit 2026-05-19): realistic fixture pins
            // cosign_session_pubkey = Pubkey::default() — gate disabled.
            cosign_session_pubkey: Pubkey::default(),
        };
        let digest = compute_policy_preview_digest(&f);
        // Prior digests:
        //   Pre-PEN-CROSS-6:
        //     33d743a9643fcc6d39c30ac5f8c159d6e94d31ce354d6dd3843367773b3a8502
        //   Post-PEN-CROSS-6 (pre-PEN-CROSS-2, created_at_slot=0 not yet encoded):
        //     ed9ac12d21e0f03933bbf789eae99944c311f2ff6f1baff992058307174de316
        //   Post-PEN-CROSS-2 (pre-TA-05):
        //     ac54284579f4b8afd714b290ec22df745bddbede9a5b366f17c8db776fab53c7
        //   Post-TA-05 (pre-TA-07/17):
        //     af3990ea433e3de25baa05627f9a38ab497dffcba1e202aac99343b1de9cfc8c
        //   Post-TA-07/17 (pre-TA-12):
        //     35ed9a9f97b0fa21ca581bd45f11b28c2932525101e9be063cc0d2f6bebc3c48
        //   Post-TA-12 (pre-TA-14):
        //     6523cb9b64baef661d919c802a8762332d1091cb53e8245d1624f52839fc9c8c
        //   Post-TA-14 (pre-G6):
        //     67c7cde90c0d8140fceb370bf94dcc15488ffd1407a84d4c248b590a8b9d810f
        //   Post-G6 (pre-PEN-CROSS-1):
        //     15ab9e4290b8bc9229adc64e46cf785edb1adc78596eb339e7bdd4df2a2cab62
        //   Post-PEN-CROSS-1 (pre-D-5):
        //     503ff364c055085089576e5af684383e10b7dd65ed796bd57c53927e879cdb0e
        // D-5 (audit 2026-05-19, F-RP3-1) appends 32 more bytes
        // (cosign_session_pubkey = Pubkey::default() → 32 zero bytes) at
        // position 22. New digest pinned in REGENERATED_HEX_REALISTIC below.
        let expected: [u8; 32] = REGENERATED_HEX_REALISTIC;
        assert_eq!(
            digest, expected,
            "realistic-policy digest must match SDK fixture"
        );
    }
}

/// D-5 (audit 2026-05-19, F-RP3-1) minimal-policy expected digest.
///
/// Computed over the canonical 144-byte encoding (110 prior bytes +
/// 32 bytes of `cosign_session_pubkey` at position 22 = 142 bytes…
/// actually 110+32 = 142, but the EMPTY_AGENT_SET_HASH is now also
/// included so total = 110 + 32 = 142 = wait, see below). The
/// `cosign_session_pubkey` here is `Pubkey::default()` since the
/// minimal fixture's vault has the reactivate-cosign gate disabled.
///
/// Cross-impl byte-equality pin (Rust ↔ TS).
///
/// Prior digests:
///   Post-PEN-CROSS-1 (pre-D-5):
///     a9d8654da866751cbec1c45dcae0b7c3b6e45ee98c2b284b8cd9f8f09d894f83
/// Post-D-5:
///   = `f36f0bce45b2ccd681891f2b4922b733563ad21485e6801e4f5f43f475ca0949`
#[cfg(test)]
// M1-04: regenerated for the 21-field digest (has_constraints removed).
const REGENERATED_HEX_MINIMAL: [u8; 32] = [
    0x8d, 0x80, 0xe1, 0x31, 0xf0, 0xfc, 0xa0, 0x7e, 0x71, 0xd1, 0x73, 0xcd, 0x5c, 0x55, 0x9f, 0x00,
    0x41, 0xa6, 0xef, 0x93, 0x91, 0xe3, 0xa8, 0x7e, 0xca, 0xc5, 0xf2, 0x49, 0xc5, 0xbd, 0xa3, 0x6d,
];

/// D-5 (audit 2026-05-19, F-RP3-1) realistic-policy expected digest.
///
/// Realistic fixture with 2 protocols, 1 destination, common scalars,
/// `stable_balance_floor = 100_000_000` ($100 reserve),
/// `per_recipient_daily_cap_usd = 50_000_000` ($50 per-recipient cap),
/// `cosign_required = false`, `agent_set_hash = EMPTY_AGENT_SET_HASH`,
/// and `cosign_session_pubkey = Pubkey::default()`.
///
/// Prior digests:
///   Post-PEN-CROSS-1 (pre-D-5):
///     503ff364c055085089576e5af684383e10b7dd65ed796bd57c53927e879cdb0e
/// Post-D-5:
///   = `68778cdd2c3fc158756997c3f851d6b67235cbac7f5217a9c4614afd39a344c4`
#[cfg(test)]
// M1-04: regenerated for the 21-field digest (has_constraints removed).
const REGENERATED_HEX_REALISTIC: [u8; 32] = [
    0x21, 0x15, 0x5d, 0x71, 0xa1, 0xd0, 0xa4, 0x66, 0xcf, 0x57, 0x67, 0x66, 0x58, 0xdc, 0xae, 0x57,
    0x7b, 0x3c, 0xab, 0x8d, 0x1c, 0xc5, 0x12, 0xc4, 0x58, 0x9f, 0x9e, 0xbb, 0xa1, 0x0b, 0xae, 0x03,
];

/// Phase 8 PEN-CROSS-1 (Council ISC-141): empty-agent-set hash. SHA-256 of
/// the Borsh-encoded empty `Vec<(Pubkey, u8)>` — i.e. SHA-256 of the
/// 4-byte LE-encoded zero length prefix [0x00,0x00,0x00,0x00]. Deterministic
/// — pinned across Rust (this constant) and TypeScript (sdk/kit/src/policy/
/// compute-policy-preview-digest.ts::EMPTY_AGENT_SET_HASH).
///
/// = `df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119`
#[cfg(test)]
pub(crate) const EMPTY_AGENT_SET_HASH: [u8; 32] = [
    0xdf, 0x3f, 0x61, 0x98, 0x04, 0xa9, 0x2f, 0xdb, 0x40, 0x57, 0x19, 0x2d, 0xc4, 0x3d, 0xd7, 0x48,
    0xea, 0x77, 0x8a, 0xdc, 0x52, 0xbc, 0x49, 0x8c, 0xe8, 0x05, 0x24, 0xc0, 0x14, 0xb8, 0x11, 0x19,
];
