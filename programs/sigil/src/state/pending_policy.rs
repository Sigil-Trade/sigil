use super::{MAX_ALLOWED_DESTINATIONS, MAX_ALLOWED_PROTOCOLS};
use anchor_lang::prelude::*;

/// Queued policy update that becomes executable after a timelock period.
/// Created by `queue_policy_update`, applied by `apply_pending_policy`,
/// or cancelled by `cancel_pending_policy`.
///
/// PDA seeds: `[b"pending_policy", vault.key().as_ref()]`
#[account]
pub struct PendingPolicyUpdate {
    /// Associated vault pubkey
    pub vault: Pubkey,

    /// Unix timestamp when this update was queued
    pub queued_at: i64,

    /// Unix timestamp when this update becomes executable
    pub executes_at: i64,

    /// Slot number when this update was queued. Paired with `MAX_APPLY_AGE_SLOTS`
    /// to enforce a freshness ceiling — defends against durable-nonce pre-signing
    /// attacks (F-10 audit fix, Drift Protocol April 2026 $285M analog).
    pub queued_at_slot: u64,

    // All policy fields as Option<T> — only non-None fields are applied
    pub daily_spending_cap_usd: Option<u64>,
    pub max_transaction_amount_usd: Option<u64>,
    pub protocol_mode: Option<u8>,
    pub protocols: Option<Vec<Pubkey>>,
    pub developer_fee_rate: Option<u16>,
    pub max_slippage_bps: Option<u16>,
    pub timelock_duration: Option<u64>,
    pub allowed_destinations: Option<Vec<Pubkey>>,
    pub session_expiry_seconds: Option<u64>,
    pub has_protocol_caps: Option<bool>,
    pub protocol_caps: Option<Vec<u64>>,

    /// Destination access control mode update.
    /// Phase 2 Option A: only Some(0) (RESTRICTED) is accepted. Some(1) was deleted.
    pub destination_mode: Option<u8>,

    /// Bump seed for PDA
    pub bump: u8,

    /// TA-05 (Phase 3): optional update to `PolicyConfig.operating_hours`.
    /// 24-bit UTC bitmask; upper 8 bits MUST be zero. Bound by TA-19 at
    /// canonical position 15.
    /// APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability.
    pub operating_hours: Option<u32>,

    /// TA-09 (Phase 3 pre-execution guard #6): cosign requirement marker.
    /// When `queue_policy_update` detects an elevated mutation (raising
    /// daily cap, raising max-tx, expanding destinations/protocols, etc),
    /// the owner MUST supply a co-signing session in the accounts. The
    /// queue handler computes a sha256 over the canonical pending args
    /// and stores it here; `apply_pending_policy` re-asserts the digest.
    ///
    /// `[0u8; 32]` = no cosign required (non-elevated mutation). Any
    /// non-zero digest indicates this pending was bound to a specific
    /// cosign. At apply, the handler MUST re-compute and equal-check.
    ///
    /// APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability.
    pub cosign_digest: [u8; 32],

    /// TA-09 (Phase 3): pubkey of the session that co-signed this queue.
    /// Recorded for audit. `Pubkey::default()` = no cosign (non-elevated).
    pub cosign_session: Pubkey,

    /// TA-19 (Phase 2): SHA-256 digest of the canonical Borsh encoding of the
    /// policy fields THAT WOULD RESULT FROM APPLYING this pending update over
    /// the live policy. Owner computes off-chain over the merged result and
    /// includes the digest in `queue_policy_update`; `apply_pending_policy`
    /// re-asserts the digest against a re-computed merged digest before any
    /// field is copied to the live policy. Defends against pending-PDA
    /// tampering between queue and apply (e.g., partial overwrite via a
    /// rogue program with the same account discriminator).
    ///
    /// Encoding identical to `PolicyConfig.policy_preview_digest` — see that
    /// field's doc-comment for the canonical encoding ordering.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub new_policy_preview_digest: [u8; 32],

    /// TA-12 (Phase 5): optional update to `PolicyConfig.stable_balance_floor`.
    /// None = preserve live value; Some(n) = set to n. Bound by TA-19 at
    /// canonical digest position 18.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub stable_balance_floor: Option<u64>,

    /// TA-14 (Phase 5): optional update to
    /// `PolicyConfig.per_recipient_daily_cap_usd`. None = preserve live value;
    /// Some(n) = set to n. Bound by TA-19 at canonical digest position 19.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub per_recipient_daily_cap_usd: Option<u64>,

    /// G6 (audit 2026-05-18 cosign opt-in): optional update to
    /// `PolicyConfig.cosign_required`. None = preserve live value;
    /// Some(true) = enable cosign on elevated mutations (safety
    /// improvement — NOT elevated); Some(false) when live is true
    /// IS elevated (one-way ratchet — disabling cosign requires cosign).
    /// Bound by TA-19 at canonical digest position 20.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub cosign_required: Option<bool>,

    /// D-5 close (audit 2026-05-19, F-RP3-1): optional update to
    /// `PolicyConfig.cosign_session_pubkey`. None = preserve live value;
    /// Some(pubkey) = set the reactivate-cosign pubkey for elevated
    /// capability grants. `Pubkey::default()` is permitted as a value
    /// (disables the gate); any other pubkey enables it.
    ///
    /// Setting this field is NOT classified as elevated by the existing
    /// 7-trigger gate in `queue_policy_update` — owners opt INTO friction
    /// (the gate fires LATER on `reactivate_vault`). Disabling it
    /// (`Some(Pubkey::default())`) on a live policy where the field is
    /// currently non-default IS, however, a one-way-ratchet violation if
    /// the vault is otherwise cosign-opted-in; deferred to Phase 9
    /// alongside the broader ratchet polish — the present batch closes
    /// only the reactivate-time gate.
    ///
    /// Bound by TA-19 at canonical digest position 22.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub cosign_session_pubkey: Option<Pubkey>,

    /// F-Q6 (2026-06-02): optional update to
    /// `PolicyConfig.operator_grant_delay_seconds`. None = preserve live value;
    /// Some(n) = update. Bound by TA-19 at canonical digest position 22.
    /// APPENDED per F-14 APPEND-ONLY rule for Borsh stability.
    pub operator_grant_delay_seconds: Option<u64>,
}

impl PendingPolicyUpdate {
    /// Worst-case size with all Option fields populated at max capacity.
    pub const SIZE: usize = 8
        + 32
        + 8 // queued_at
        + 8 // executes_at
        + 8 // queued_at_slot (F-10 audit fix)
        + (1 + 8) // daily_spending_cap_usd
        + (1 + 8) // max_transaction_amount_usd
        + (1 + 1) // protocol_mode
        + (1 + 4 + 32 * MAX_ALLOWED_PROTOCOLS) // protocols
        + (1 + 2) // developer_fee_rate
        + (1 + 2) // max_slippage_bps
        + (1 + 8) // timelock_duration
        + (1 + 4 + 32 * MAX_ALLOWED_DESTINATIONS) // allowed_destinations
        + (1 + 8) // session_expiry_seconds
        + (1 + 1) // has_protocol_caps
        + (1 + 4 + 8 * MAX_ALLOWED_PROTOCOLS) // protocol_caps
        + (1 + 1) // destination_mode (Option<u8>)
        + 1 // bump
        + 32 // new_policy_preview_digest [TA-19, Phase 2]
        + (1 + 4) // operating_hours [TA-05, Phase 3]
        + 32 // cosign_digest [TA-09, Phase 3]
        + 32 // cosign_session [TA-09, Phase 3]
        + (1 + 8) // stable_balance_floor [TA-12, Phase 5]
        + (1 + 8) // per_recipient_daily_cap_usd [TA-14, Phase 5]
        + (1 + 1) // cosign_required Option<bool> [G6, 2026-05-18 audit]
        + (1 + 32) // cosign_session_pubkey Option<Pubkey> [D-5, 2026-05-19 audit, F-RP3-1]
        + (1 + 8); // operator_grant_delay_seconds Option<u64> [F-Q6 2026-06-02]

    /// Returns true if the timelock period has expired and the update
    /// can be applied.
    pub fn is_ready(&self, current_timestamp: i64) -> bool {
        current_timestamp >= self.executes_at
    }
}
