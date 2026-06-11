//! TA-09 (Phase 3 pre-execution guard #6): cosign-digest binding.
//!
//! `queue_policy_update` binds an "elevated mutation" pending PDA to a
//! specific cosign by hashing the canonical instruction-data of the
//! pending args + the cosign session pubkey. The cosigning session must
//! sign the SAME transaction (Solana's `is_signer`). The handler stores
//! the digest on `PendingPolicyUpdate`; `apply_pending_policy` re-computes
//! it from the persisted pending args + recorded session pubkey and
//! re-asserts equality.
//!
//! Why a digest, not just "presence of a signer"?
//!
//! The HARDENED prompt is explicit: "The session signature must cover the
//! SAME instruction-data hash (sha256 of pending args) that the owner
//! signed." A bare signer-presence check would let an attacker swap
//! pending args between queue and apply (e.g. discriminator-collision on
//! the pending PDA) while keeping the same cosign Pubkey — the apply
//! handler would see a valid signer history and a pending PDA with new
//! args. By binding the digest of the pending-args bytes + the session
//! pubkey, any mutation between queue and apply produces a digest
//! mismatch and a hard reject.
//!
//! Forward-compat note: the canonical encoding here is APPEND-ONLY — new
//! fields land at the END to preserve replayable digests for in-flight
//! pending PDAs across upgrades.
//!
//! Same `solana-program` direct-dep hash path as `policy_digest.rs`
//! (Anchor 0.32.1 doesn't re-export `solana_program::hash`).

use anchor_lang::prelude::*;
use solana_program::hash::hashv;

/// Canonical inputs to the cosign digest. All Option<…> fields are
/// encoded as `[u8; 1] discriminator (0 = None, 1 = Some) ++ payload`.
///
/// Round 2 B4 F-1 fix (audit 2026-05-19): extended to bind the elevation
/// triggers that landed in G3 + G6 (stable_balance_floor,
/// per_recipient_daily_cap_usd, has_protocol_caps, protocol_caps,
/// cosign_required) but were previously NOT in the digest scope. Without
/// this binding, a tampered SDK or discriminator-collision attack could
/// mutate the pending PDA between queue and apply on those triggers
/// without producing a cosign-digest mismatch (TA-19's
/// policy_preview_digest binds them at the *policy* level but the
/// cosign-binding promise is "the session signature covers the SAME
/// pending args the owner signed").
///
/// APPEND-ONLY rule: new fields land at positions 6, 7, 8, 9, 10. Pre-G3
/// fixtures DO change because the canonical encoding now includes 5 new
/// trailing `None` tag bytes for missing values; both Rust + SDK HEX pins
/// are updated below.
pub struct CosignDigestFields<'a> {
    /// The same `cosign_session` pubkey the queue accepted.
    pub cosign_session: &'a Pubkey,
    /// daily_spending_cap_usd Option<u64>
    pub daily_spending_cap_usd: Option<u64>,
    /// max_transaction_amount_usd Option<u64>
    pub max_transaction_amount_usd: Option<u64>,
    /// allowed_destinations Option<&[Pubkey]>
    pub allowed_destinations: Option<&'a [Pubkey]>,
    /// protocols Option<&[Pubkey]>
    pub protocols: Option<&'a [Pubkey]>,
    /// Round 2 B4 F-1 (2026-05-19): stable_balance_floor Option<u64>.
    /// G3 elevation trigger — LOWERING the floor weakens custody safety.
    pub stable_balance_floor: Option<u64>,
    /// Round 2 B4 F-1: per_recipient_daily_cap_usd Option<u64>. G3
    /// elevation trigger — RAISING / DISABLING widens spend per recipient.
    pub per_recipient_daily_cap_usd: Option<u64>,
    /// Round 2 B4 F-1: has_protocol_caps Option<bool>. G3 elevation
    /// trigger — disabling protocol caps entirely.
    pub has_protocol_caps: Option<bool>,
    /// Round 2 B4 F-1: protocol_caps Option<&[u64]>. G3 elevation
    /// trigger — shrinking individual caps to zero or raising them.
    pub protocol_caps: Option<&'a [u64]>,
    /// Round 2 B4 F-1: cosign_required Option<bool>. G6 elevation
    /// trigger — disabling cosign on a cosign-opted-in vault (one-way
    /// ratchet — disabling cosign requires cosign).
    pub cosign_required: Option<bool>,
}

/// Round 2 F-RP3-2 fix (audit 2026-05-19): canonical inputs to the
/// agent-perms cosign digest. Bound by `queue_agent_permissions_update`
/// when `policy.cosign_required && is_elevated` (raising capability,
/// raising spending_limit, OR shortening cooldown). Re-asserted at
/// `apply_agent_permissions_update`.
///
/// Why a SEPARATE digest helper (not `CosignDigestFields`)?
/// The policy-update digest binds policy fields; this digest binds
/// per-agent permission fields. Sharing the same struct would force
/// every agent-perms call to embed policy fields (mostly None) and
/// vice-versa — clutters the canonical encoding and creates two
/// independent forward-compat surfaces colliding into one.
pub struct AgentPermsCosignDigestFields<'a> {
    /// The cosigning session pubkey (matches the recorded
    /// `pending_agent_perms.cosign_session`).
    pub cosign_session: &'a Pubkey,
    /// The target agent's pubkey (binds the digest to a specific agent —
    /// prevents queue-on-agent-A / apply-on-agent-B replay).
    pub agent: &'a Pubkey,
    /// Pending `new_capability` arg.
    pub new_capability: u8,
    /// Pending `spending_limit_usd` arg.
    pub spending_limit_usd: u64,
    /// Pending `cooldown_seconds` arg.
    pub cooldown_seconds: u64,
}

/// Round 2 F-RP3-2 fix: SHA-256 over the canonical encoding of the
/// agent-perms cosign inputs.
///
/// CANONICAL ENCODING (APPEND-ONLY):
///   1. cosign_session pubkey (32 bytes raw)
///   2. agent pubkey         (32 bytes raw)
///   3. new_capability       (1 byte)
///   4. spending_limit_usd   (8 bytes u64 LE)
///   5. cooldown_seconds     (8 bytes u64 LE)
///
/// = 81 bytes deterministic input.
pub fn compute_agent_perms_cosign_digest(fields: &AgentPermsCosignDigestFields<'_>) -> [u8; 32] {
    let mut buf: Vec<u8> = Vec::with_capacity(81);
    // 1. cosign_session (32 bytes raw)
    buf.extend_from_slice(fields.cosign_session.as_ref());
    // 2. agent (32 bytes raw)
    buf.extend_from_slice(fields.agent.as_ref());
    // 3. new_capability (1 byte)
    buf.push(fields.new_capability);
    // 4. spending_limit_usd (u64 LE)
    buf.extend_from_slice(&fields.spending_limit_usd.to_le_bytes());
    // 5. cooldown_seconds (u64 LE)
    buf.extend_from_slice(&fields.cooldown_seconds.to_le_bytes());
    hashv(&[&buf]).to_bytes()
}

/// SHA-256 over the canonical encoding of the cosign-relevant inputs.
///
/// Only the FIELDS that participate in "elevated mutation" detection are
/// in scope. Non-elevated fields (developer_fee_rate, max_slippage_bps,
/// session_expiry_seconds, timelock_duration narrowing, protocol_mode,
/// destination_mode, has_protocol_caps, protocol_caps shrinking) do NOT
/// require cosign and are NOT bound by this digest — they are still
/// bound by the existing TA-19 policy_preview_digest at queue time.
pub fn compute_cosign_digest(fields: &CosignDigestFields<'_>) -> [u8; 32] {
    // Pre-size: 32 (session) + 9 + 9 + 4+32*10 + 4+32*10 + 4 markers
    let mut buf: Vec<u8> = Vec::with_capacity(720);

    // 1. cosign_session pubkey (32 bytes raw)
    buf.extend_from_slice(fields.cosign_session.as_ref());

    // 2. daily_spending_cap_usd Option<u64>
    match fields.daily_spending_cap_usd {
        Some(v) => {
            buf.push(1);
            buf.extend_from_slice(&v.to_le_bytes());
        }
        None => buf.push(0),
    }

    // 3. max_transaction_amount_usd Option<u64>
    match fields.max_transaction_amount_usd {
        Some(v) => {
            buf.push(1);
            buf.extend_from_slice(&v.to_le_bytes());
        }
        None => buf.push(0),
    }

    // 4. allowed_destinations Option<&[Pubkey]>
    match fields.allowed_destinations {
        Some(dests) => {
            buf.push(1);
            buf.extend_from_slice(&(dests.len() as u32).to_le_bytes());
            for pk in dests.iter() {
                buf.extend_from_slice(pk.as_ref());
            }
        }
        None => buf.push(0),
    }

    // 5. protocols Option<&[Pubkey]>
    match fields.protocols {
        Some(protos) => {
            buf.push(1);
            buf.extend_from_slice(&(protos.len() as u32).to_le_bytes());
            for pk in protos.iter() {
                buf.extend_from_slice(pk.as_ref());
            }
        }
        None => buf.push(0),
    }

    // Round 2 B4 F-1 (2026-05-19): APPEND-ONLY extension binding 5 new
    // elevation triggers. All encoded as `Option<…>` with the load-bearing
    // tag byte (None vs Some(0) MUST produce distinct digests).

    // 6. stable_balance_floor Option<u64>
    match fields.stable_balance_floor {
        Some(v) => {
            buf.push(1);
            buf.extend_from_slice(&v.to_le_bytes());
        }
        None => buf.push(0),
    }

    // 7. per_recipient_daily_cap_usd Option<u64>
    match fields.per_recipient_daily_cap_usd {
        Some(v) => {
            buf.push(1);
            buf.extend_from_slice(&v.to_le_bytes());
        }
        None => buf.push(0),
    }

    // 8. has_protocol_caps Option<bool>. Bool encoded as 1 byte.
    match fields.has_protocol_caps {
        Some(b) => {
            buf.push(1);
            buf.push(u8::from(b));
        }
        None => buf.push(0),
    }

    // 9. protocol_caps Option<&[u64]>. Each cap is 8 bytes LE.
    match fields.protocol_caps {
        Some(caps) => {
            buf.push(1);
            buf.extend_from_slice(&(caps.len() as u32).to_le_bytes());
            for c in caps.iter() {
                buf.extend_from_slice(&c.to_le_bytes());
            }
        }
        None => buf.push(0),
    }

    // 10. cosign_required Option<bool>. Bool encoded as 1 byte.
    match fields.cosign_required {
        Some(b) => {
            buf.push(1);
            buf.push(u8::from(b));
        }
        None => buf.push(0),
    }

    hashv(&[&buf]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    /// Deterministic: same inputs → same digest.
    #[test]
    fn cosign_digest_is_deterministic() {
        let cosigner = pk(1);
        let dests = [pk(10), pk(11)];
        let f = CosignDigestFields {
            cosign_session: &cosigner,
            daily_spending_cap_usd: Some(500_000_000),
            max_transaction_amount_usd: None,
            allowed_destinations: Some(&dests),
            protocols: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        let d1 = compute_cosign_digest(&f);
        let d2 = compute_cosign_digest(&f);
        assert_eq!(d1, d2);
    }

    /// Cosign-session flip MUST change the digest. Defends against
    /// session-swap between queue and apply.
    #[test]
    fn cosign_digest_changes_on_session_flip() {
        let cosigner_a = pk(1);
        let cosigner_b = pk(2);
        let f_a = CosignDigestFields {
            cosign_session: &cosigner_a,
            daily_spending_cap_usd: Some(500_000_000),
            max_transaction_amount_usd: None,
            allowed_destinations: None,
            protocols: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        let f_b = CosignDigestFields {
            cosign_session: &cosigner_b,
            ..f_a
        };
        assert_ne!(compute_cosign_digest(&f_a), compute_cosign_digest(&f_b));
    }

    /// Cap-flip MUST change the digest. Defends against args-swap
    /// between queue and apply.
    #[test]
    fn cosign_digest_changes_on_cap_raise() {
        let cosigner = pk(1);
        let f_a = CosignDigestFields {
            cosign_session: &cosigner,
            daily_spending_cap_usd: Some(500_000_000),
            max_transaction_amount_usd: None,
            allowed_destinations: None,
            protocols: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        let f_b = CosignDigestFields {
            cosign_session: &cosigner,
            daily_spending_cap_usd: Some(1_000_000_000), // doubled
            max_transaction_amount_usd: None,
            allowed_destinations: None,
            protocols: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        assert_ne!(compute_cosign_digest(&f_a), compute_cosign_digest(&f_b));
    }

    /// None vs Some(0) MUST produce distinct digests (the discriminator
    /// is the load-bearing byte). Defends against the "swap None to
    /// Some(0)" attack which would also be elevated-detection-bypass.
    #[test]
    fn cosign_digest_distinguishes_none_from_some_zero() {
        let cosigner = pk(1);
        let f_none = CosignDigestFields {
            cosign_session: &cosigner,
            daily_spending_cap_usd: None,
            max_transaction_amount_usd: None,
            allowed_destinations: None,
            protocols: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        let f_some_zero = CosignDigestFields {
            cosign_session: &cosigner,
            daily_spending_cap_usd: Some(0),
            max_transaction_amount_usd: None,
            allowed_destinations: None,
            protocols: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        assert_ne!(
            compute_cosign_digest(&f_none),
            compute_cosign_digest(&f_some_zero)
        );
    }

    /// Destinations reorder MUST change the digest (ordered encoding).
    #[test]
    fn cosign_digest_changes_on_destinations_reorder() {
        let cosigner = pk(1);
        let a = [pk(10), pk(11)];
        let b = [pk(11), pk(10)];
        let f_a = CosignDigestFields {
            cosign_session: &cosigner,
            daily_spending_cap_usd: None,
            max_transaction_amount_usd: None,
            allowed_destinations: Some(&a),
            protocols: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        let f_b = CosignDigestFields {
            cosign_session: &cosigner,
            allowed_destinations: Some(&b),
            ..f_a
        };
        assert_ne!(compute_cosign_digest(&f_a), compute_cosign_digest(&f_b));
    }

    /// G4 (audit close) — cross-impl byte-equality pin (minimal fixture).
    ///
    /// Pins a deterministic SHA-256 over the 41-byte canonical encoding for the
    /// minimal-cosign case:
    ///   - cosign_session = pk(1) → 32 bytes
    ///   - all nine Option<…> fields = None → 9 zero discriminator bytes
    ///   - (no payload bytes for any Option since all are None)
    /// = 41 bytes deterministic input.
    ///
    /// Round 2 B4 F-1 rebind (2026-05-19): grew from 36 → 41 bytes after the
    /// APPEND-ONLY extension added 5 new Option<…> tails
    /// (stable_balance_floor, per_recipient_daily_cap_usd, has_protocol_caps,
    /// protocol_caps, cosign_required), each contributing one None byte.
    ///
    /// Same fixture is asserted byte-for-byte in
    /// `sdk/kit/tests/policy/cosign-digest.test.ts` (HEX_MINIMAL). If either
    /// side mutates the canonical encoding, BOTH digests change and the two
    /// tests fail in lock-step — the goal, not silent acceptance of a
    /// divergent format.
    #[test]
    fn cosign_digest_known_value_for_minimal() {
        let cosigner = pk(1);
        let f = CosignDigestFields {
            cosign_session: &cosigner,
            daily_spending_cap_usd: None,
            max_transaction_amount_usd: None,
            allowed_destinations: None,
            protocols: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        let digest = compute_cosign_digest(&f);
        let expected: [u8; 32] = COSIGN_HEX_MINIMAL;
        assert_eq!(
            digest, expected,
            "minimal-cosign digest must match SDK fixture (sdk/kit/tests/policy/cosign-digest.test.ts)"
        );
    }

    /// G4 (audit close) — cross-impl byte-equality pin (realistic fixture).
    ///
    /// Realistic cosign args mirroring an "elevated mutation that raises the
    /// daily cap, raises the max-tx, adds a destination, and adds a protocol".
    ///   - cosign_session = pk(1)
    ///   - daily_spending_cap_usd = Some(500_000_000)
    ///   - max_transaction_amount_usd = Some(100_000_000)
    ///   - allowed_destinations = Some(&[pk(10)])
    ///   - protocols = Some(&[pk(1), pk(2)])
    ///   - stable_balance_floor = None        (B4 F-1)
    ///   - per_recipient_daily_cap_usd = None (B4 F-1)
    ///   - has_protocol_caps = None           (B4 F-1)
    ///   - protocol_caps = None               (B4 F-1)
    ///   - cosign_required = None             (B4 F-1)
    /// Encoding length:
    ///   32 (session)
    ///   + 1 + 8 (daily Some(u64))
    ///   + 1 + 8 (max_tx Some(u64))
    ///   + 1 + 4 + 32 (destinations Some(Vec<Pubkey> len=1))
    ///   + 1 + 4 + 32*2 (protocols Some(Vec<Pubkey> len=2))
    ///   + 5 (five trailing B4 F-1 None discriminator bytes)
    /// = 161 bytes deterministic input.
    ///
    /// Round 2 B4 F-1 rebind (2026-05-19): grew from 156 → 161 bytes after
    /// the APPEND-ONLY extension added 5 new Option<…> tails, each None for
    /// the realistic fixture.
    #[test]
    fn cosign_digest_known_value_for_realistic() {
        let cosigner = pk(1);
        let dests = [pk(10)];
        let protos = [pk(1), pk(2)];
        let f = CosignDigestFields {
            cosign_session: &cosigner,
            daily_spending_cap_usd: Some(500_000_000),
            max_transaction_amount_usd: Some(100_000_000),
            allowed_destinations: Some(&dests),
            protocols: Some(&protos),
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            has_protocol_caps: None,
            protocol_caps: None,
            cosign_required: None,
        };
        let digest = compute_cosign_digest(&f);
        let expected: [u8; 32] = COSIGN_HEX_REALISTIC;
        assert_eq!(
            digest, expected,
            "realistic-cosign digest must match SDK fixture"
        );
    }
}

/// G4 (audit close) — pinned cosign digest for the minimal fixture.
///
/// Round 2 B4 F-1 rebind (2026-05-19): the canonical encoding grew from
/// 36 bytes to 41 bytes — five new `Option<…>` fields landed at the end
/// of the encoding (stable_balance_floor, per_recipient_daily_cap_usd,
/// has_protocol_caps, protocol_caps, cosign_required), each contributing
/// one trailing None discriminator byte. The pin is rebound accordingly.
///
/// Computed over the canonical 41-byte encoding:
///   - cosign_session = pk(1) ([1u8; 32])              → 32 bytes
///   - daily_spending_cap_usd = None                   →  1 zero byte
///   - max_transaction_amount_usd = None               →  1 zero byte
///   - allowed_destinations = None                     →  1 zero byte
///   - protocols = None                                →  1 zero byte
///   - stable_balance_floor = None        (B4 F-1)     →  1 zero byte
///   - per_recipient_daily_cap_usd = None (B4 F-1)     →  1 zero byte
///   - has_protocol_caps = None           (B4 F-1)     →  1 zero byte
///   - protocol_caps = None               (B4 F-1)     →  1 zero byte
///   - cosign_required = None             (B4 F-1)     →  1 zero byte
///
/// = `36744bc16c6c142eab59716b80de14e1ec548b29dff1bb699773b91791197df1`
///
/// Same value pinned at `sdk/kit/tests/policy/cosign-digest.test.ts` as
/// `HEX_MINIMAL`.
#[cfg(test)]
const COSIGN_HEX_MINIMAL: [u8; 32] = [
    0x36, 0x74, 0x4b, 0xc1, 0x6c, 0x6c, 0x14, 0x2e, 0xab, 0x59, 0x71, 0x6b, 0x80, 0xde, 0x14, 0xe1,
    0xec, 0x54, 0x8b, 0x29, 0xdf, 0xf1, 0xbb, 0x69, 0x97, 0x73, 0xb9, 0x17, 0x91, 0x19, 0x7d, 0xf1,
];

/// G4 (audit close) — pinned cosign digest for the realistic fixture.
///
/// Round 2 B4 F-1 rebind (2026-05-19): the canonical encoding grew from
/// 156 bytes to 161 bytes — five new trailing None discriminator bytes
/// from the B4 F-1 fields (stable_balance_floor,
/// per_recipient_daily_cap_usd, has_protocol_caps, protocol_caps,
/// cosign_required), each unset for the realistic fixture.
///
/// Computed over the canonical 161-byte encoding (see test for full layout).
///
/// = `d2cb150b71e205fc076159adc6bf3b5aef9c04f059743f74b1c0c5fb376f4b8c`
///
/// Same value pinned at `sdk/kit/tests/policy/cosign-digest.test.ts` as
/// `HEX_REALISTIC`.
#[cfg(test)]
const COSIGN_HEX_REALISTIC: [u8; 32] = [
    0xd2, 0xcb, 0x15, 0x0b, 0x71, 0xe2, 0x05, 0xfc, 0x07, 0x61, 0x59, 0xad, 0xc6, 0xbf, 0x3b, 0x5a,
    0xef, 0x9c, 0x04, 0xf0, 0x59, 0x74, 0x3f, 0x74, 0xb1, 0xc0, 0xc5, 0xfb, 0x37, 0x6f, 0x4b, 0x8c,
];
