use super::{MAX_ALLOWED_DESTINATIONS, MAX_ALLOWED_PROTOCOLS, SESSION_DURATION_SECONDS};
use anchor_lang::prelude::*;

/// Protocol access control mode: only protocols in list allowed.
///
/// Phase 2 (Option A default-tightening): this is the ONLY permitted value.
/// The prior `PROTOCOL_MODE_ALL` (0) and `PROTOCOL_MODE_DENYLIST` (2) constants
/// were deleted because:
///   - ALL mode bypassed the protocol allowlist entirely (Audit #2 F-4 vector).
///   - DENYLIST mode required Sigil to enumerate every hostile program — an
///     unbounded set — defeating the security primitive.
///
/// Vaults MUST use ALLOWLIST. Handlers (`initialize_vault`, `queue_policy_update`,
/// `apply_pending_policy`) reject any other value with `InvalidProtocolMode`.
pub const PROTOCOL_MODE_ALLOWLIST: u8 = 1;

/// Destination access control mode: destination MUST be in `allowed_destinations`.
///
/// Phase 2 (Option A default-tightening): this is the ONLY permitted value.
/// The prior `DESTINATION_MODE_OPEN_WITH_CAP` (1) constant was deleted because
/// it allowed a compromised agent to drain `daily_spending_cap_usd` to any
/// destination (closes F-4 default-allow drain vector definitively, rather
/// than depending on owner opt-in correctness).
/// Vaults MUST use RESTRICTED. Handlers reject any other value with
/// `InvalidDestinationMode`.
pub const DESTINATION_MODE_RESTRICTED: u8 = 0;

#[account]
pub struct PolicyConfig {
    /// Associated vault pubkey
    pub vault: Pubkey,

    /// Maximum aggregate spend per rolling 24h period in USD (6 decimals).
    /// $500 = 500_000_000. This is the primary spending cap.
    pub daily_spending_cap_usd: u64,

    /// Maximum single transaction size in USD (6 decimals).
    pub max_transaction_size_usd: u64,

    /// Protocol allowlist mode. Phase 2 Option A: ONLY value 1 (ALLOWLIST)
    /// permitted. Modes 0 (ALL) and 2 (DENYLIST) deleted under L-1. Handler
    /// rejects any other value with `ErrInvalidProtocolMode`.
    pub protocol_mode: u8,

    /// Protocol pubkeys for allowlist/denylist.
    /// Bounded to MAX_ALLOWED_PROTOCOLS entries.
    pub protocols: Vec<Pubkey>,

    /// Developer fee rate (rate / 1,000,000). Applied to every finalized
    /// transaction. Max MAX_DEVELOPER_FEE_RATE (500 = 5 BPS).
    pub developer_fee_rate: u16,

    /// Maximum slippage tolerance (basis points) — generic config primitive
    /// preserved per D-5 across Phase 1 Option A demolition. Per L-1 there is
    /// no on-chain Jupiter slippage verifier in V1; this field is consumed by
    /// off-chain SDK simulators and (Phase 6) generic post-execution assertions
    /// (R-1 mint-delta cap). Validated at config time via
    /// `max_slippage_bps <= MAX_SLIPPAGE_BPS` (= 5000 BPS = 50% ceiling).
    /// 0 = no slippage protection configured.
    pub max_slippage_bps: u16,

    /// Timelock duration in seconds for policy changes. 0 = no timelock.
    pub timelock_duration: u64,

    /// Allowed destination addresses for agent transfers.
    /// Empty = any destination allowed. Bounded to MAX_ALLOWED_DESTINATIONS.
    pub allowed_destinations: Vec<Pubkey>,

    // M1-04 (constraints-engine teardown): `has_constraints: bool` REMOVED.
    // The constraints engine is gone, so the flag is always-false and carries
    // no information. Removing it (rather than reserving it) is the deliberate
    // pre-launch digest-version bump — it shifts canonical-digest fields 13..22
    // down by one byte; the SDK encoder + IDL + Codama decoder are updated in
    // lockstep (M1-04 step 5b).

    /// Whether a pending policy update PDA exists for this vault.
    /// Set true by queue_policy_update, false by apply/cancel_pending_policy.
    pub has_pending_policy: bool,

    /// Whether per-protocol spend caps are configured.
    /// Requires protocol_mode == ALLOWLIST and protocol_caps.len() == protocols.len().
    pub has_protocol_caps: bool,

    /// Per-protocol daily spending caps in USD (6 decimals).
    /// Index-aligned with `protocols`. Only enforced when `has_protocol_caps = true`.
    /// A value of 0 means no per-protocol limit (global cap still applies).
    pub protocol_caps: Vec<u64>,

    /// Configurable session duration in seconds. 0 = use default
    /// (`SESSION_DURATION_SECONDS` = 30s). Valid range when non-zero:
    /// `MIN_SESSION_DURATION_SECONDS..=MAX_OWNER_SESSION_DURATION_SECONDS`
    /// (currently 5..=90s). Wall-clock based — see audit F5-H1.
    pub session_expiry_seconds: u64,

    /// Bump seed for PDA
    pub bump: u8,

    /// Policy version counter for OCC (optimistic concurrency control).
    /// Incremented on every apply_pending_policy and apply_constraints_update.
    /// Agents include expected_policy_version in validate_and_authorize;
    /// program rejects if version changed since the agent's RPC read.
    pub policy_version: u64,

    /// Whether native PostExecutionAssertions are configured for this vault.
    /// When true, finalize_session requires the assertions PDA in remaining_accounts.
    /// 0 = no assertions, non-zero = assertions required.
    pub has_post_assertions: u8,

    /// Destination access control mode for `agent_transfer` and spending paths.
    ///
    /// Phase 2 Option A: only value 0 (RESTRICTED) is accepted. Permissive
    /// OPEN_WITH_CAP (1) was deleted. Closes F-4 (third-pass audit) and the
    /// subsequent owner-opt-in window definitively.
    pub destination_mode: u8,

    /// TA-19 (Phase 2): SHA-256 digest of the canonical Borsh encoding of the
    /// policy fields the owner approved at queue/init time. Bound at the same
    /// instruction where the owner signs the change, re-asserted at apply, so
    /// a compromised owner-signer or pending-PDA tampering cannot mutate the
    /// applied policy without producing a digest mismatch.
    ///
    /// CANONICAL ENCODING (FIXED — DO NOT REORDER):
    ///   1. `daily_spending_cap_usd: u64`
    ///   2. `max_transaction_size_usd: u64`
    ///   3. `max_slippage_bps: u16`
    ///   4. `developer_fee_rate: u16` — PEN-CROSS-6 (Phase 2 close-up)
    ///   5. `protocol_mode: u8`
    ///   6. `protocols: Vec<Pubkey>`
    ///   7. `destination_mode: u8`
    ///   8. `allowed_destinations: Vec<Pubkey>`
    ///   9. `timelock_duration: u64`
    ///   10. `session_expiry_seconds: u64`
    ///   11. `observe_only: bool`
    ///   12. `has_constraints: bool`
    ///   13. `has_post_assertions: u8`
    ///   14. `created_at_slot: u64` — PEN-CROSS-2 (Phase 2 close-up)
    ///
    /// All fields encoded as Borsh: u8/u16/u64 little-endian, `bool` as `[u8; 1]`
    /// (0 or 1), `Vec<Pubkey>` as `u32_le_len ++ pubkey_bytes_concatenated`.
    /// The SDK helper `computePolicyPreviewDigest` mirrors this encoding exactly.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub policy_preview_digest: [u8; 32],

    /// PEN-CROSS-2 (Phase 2 close-up): the slot at which `initialize_vault`
    /// minted this PolicyConfig. Bound by TA-19 at position 14 of the
    /// canonical digest encoding.
    ///
    /// Closes the close+reinit replay window: an owner who closes a vault
    /// (via `close_vault`) and later re-inits a fresh PDA at the same
    /// (owner, vault_id) gets a new `created_at_slot`. The signed
    /// `initialize_vault` ix from the old vault encodes the OLD slot in its
    /// preview digest, so replaying that signed tx against the fresh PDA
    /// produces a digest mismatch and `PolicyPreviewMismatch` rejects it.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule.
    pub created_at_slot: u64,

    /// TA-05 (Phase 3 pre-execution guard #2): 24-bit UTC operating-hours
    /// bitmask. Bit `n` (0 ≤ n ≤ 23) set → spending allowed when
    /// `clock.unix_timestamp / 3600 % 24 == n`. Upper 8 bits (24..=31)
    /// MUST be zero; rejected at write-time.
    ///
    /// Default for owners who don't narrow: 0xFFFFFF (all 24 hours enabled
    /// — equivalent to "no operating-hours constraint"). New vaults set
    /// this explicitly via the digest the owner signs; back-compat
    /// consideration removed per L-3 (Phase 2 TA-19 bound the field anyway).
    ///
    /// Bound by TA-19 at position 15 of the canonical digest encoding.
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub operating_hours: u32,

    /// TA-07 (Phase 3 pre-execution guard #4): first-time-destination
    /// 24-hour graylist friction. When a NEW destination is added to
    /// `allowed_destinations` (via queue_policy_update), it enters this
    /// graylist with `unlock_unix = now + 86400` (24h). Until either
    /// (a) the unlock time elapses OR (b) the owner calls
    /// `promote_graylist_destination` to fast-track, spending paths
    /// reject any tx routing value to that destination with
    /// `ErrGraylistFriction` (6077).
    ///
    /// Tuple is `(destination_pubkey, unlock_unix)`. Bounded ≤10 entries
    /// (max_destinations). When full, additional allowlist adds reject
    /// with `ErrGraylistFull` (6087) until an existing entry unlocks or
    /// is promoted.
    ///
    /// DESIGN: graylist entries are derived/ephemeral state — the owner's
    /// signed digest already binds the allowlist (canonical position 8),
    /// and graylist friction only delays an already-authorised destination.
    /// Therefore the graylist itself is NOT in the canonical digest
    /// encoding. Promoting accelerates the unlock but cannot widen the
    /// allowlist beyond what the owner signed.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub destination_graylist: Vec<DestinationGraylistEntry>,

    /// TA-07 (Phase 3): if true, new destinations added to the allowlist
    /// skip the 24h graylist entirely (audit trail still recorded via
    /// emitted events). Bound by TA-19 at canonical digest position 16
    /// so the owner's choice to bypass friction is part of the signed
    /// configuration — not silently flipped.
    ///
    /// Default false. APPENDED at end per F-14 APPEND-ONLY rule.
    pub auto_promote_grays: bool,

    /// TA-17 (Phase 3 pre-execution guard #7): consecutive-failure
    /// threshold after which an agent's capability is auto-revoked.
    /// Owner-configurable in range 3..=20; out-of-range values rejected
    /// at policy-write time with `InvalidPermissions`. Default 5.
    ///
    /// Only on-chain policy-violation codes (6074-6091) count — see
    /// `POLICY_VIOLATION_RANGE` in finalize_session. External codes
    /// (CU exhaustion, nonce desync, auth) do NOT increment.
    ///
    /// Bound by TA-19 at canonical digest position 17. APPENDED per
    /// F-14 APPEND-ONLY rule.
    pub auto_revoke_threshold: u8,

    /// TA-12 (Phase 5 post-execution invariant #1): hard floor on the
    /// combined USDC + USDT balance held by the vault. After every
    /// `finalize_session` spending path completes (CPI balance audit +
    /// rolling-cap + per-agent + per-protocol bookkeeping), the handler
    /// re-reads the vault's USDC + USDT token-account balances and
    /// asserts their sum is ≥ this value. If not, it rejects with
    /// `ErrStableFloorViolation` (6085).
    ///
    /// This is the LAST defensive line — no combination of attacks (CPI
    /// drain, per-protocol cap bypass via async fulfillment, fee
    /// inflation, slippage manipulation) may drain the vault below this
    /// line. Default 0 (no reserve — preserves all existing vault
    /// behavior). Owner-configurable via `initialize_vault` and
    /// `queue_policy_update`.
    ///
    /// Bound by TA-19 at canonical digest position 18. APPENDED per
    /// F-14 APPEND-ONLY rule for Borsh stability.
    pub stable_balance_floor: u64,

    /// TA-14 (Phase 5 post-execution invariant #2): rolling 24h
    /// per-recipient outflow cap, in 6-decimal USDC face value. When
    /// non-zero, every `finalize_session` spending path validates that
    /// the recipient's rolling 24h spend (tracked on
    /// `SpendTracker.per_recipient`) PLUS this transaction's outflow
    /// to that recipient stays ≤ this value. Otherwise rejects with
    /// `ErrRecipientCapExceeded` (6096).
    ///
    /// Default 0 (no per-recipient cap) preserves existing vault
    /// behavior. Owner-configurable via `initialize_vault` and
    /// `queue_policy_update`.
    ///
    /// Bound by TA-19 at canonical digest position 19. APPENDED per
    /// F-14 APPEND-ONLY rule for Borsh stability.
    pub per_recipient_daily_cap_usd: u64,

    /// G6 (audit 2026-05-18): owner-controlled opt-in flag for TA-09
    /// cosign enforcement on elevated policy mutations.
    ///
    /// When `false` (default): elevated mutations (raising caps,
    /// expanding allowlists, weakening floors / per-recipient caps /
    /// protocol caps) require only the owner's signature — no cosign
    /// session is required. Low-friction default, suitable for solo
    /// founders, AI-agent automation, dev/test vaults, and any vault
    /// whose owner is a Squads V4 multisig PDA (multisig at the Solana
    /// layer already enforces multi-signer authorization).
    ///
    /// When `true`: TA-09 elevation checks fire. The seven elevation
    /// triggers in `queue_policy_update` (raises_daily_cap,
    /// raises_max_tx, expands_destinations, expands_protocols,
    /// lowers_floor, weakens_per_recipient_cap, weakens_protocol_caps)
    /// require a non-default `cosign_session` pubkey + a corresponding
    /// signer in `remaining_accounts` with `is_signer == true`.
    ///
    /// Toggle semantics:
    /// - **Enabling (false → true)** is NON-ELEVATED. It is a safety
    ///   improvement — owner is voluntarily tightening the policy.
    ///   Cosign is not required to enable cosign.
    /// - **Disabling (true → false)** IS ELEVATED. One-way-ratchet
    ///   semantics: if cosign is currently ON, the owner cannot turn
    ///   it OFF without producing a valid cosign signature — exactly
    ///   the protection cosign was meant to provide. A phishing-
    ///   compromised owner key cannot silently disable cosign and
    ///   then drain via subsequent non-elevated mutations.
    ///
    /// Bound by TA-19 at canonical digest position 20. APPENDED at end
    /// of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub cosign_required: bool,

    /// D-5 close (audit 2026-05-19, F-RP3-1): the cosign-session pubkey
    /// gating elevated capability grants on the `reactivate_vault` path.
    ///
    /// THREAT: a phished/leaked owner key can chain
    ///   `freeze_vault → reactivate_vault(new_agent=ATTACKER, FULL_CAPABILITY)`
    /// in a single transaction. The vault's `cosign_required` flag gates
    /// elevated MUTATIONS via `queue_policy_update`, but the reactivate
    /// path grafts a new agent at FULL_CAPABILITY directly — no timelock,
    /// no cosign — yielding an instant operator-class grant.
    ///
    /// DEFENSE: when `cosign_session_pubkey != Pubkey::default()` AND the
    /// reactivate ix passes `capability == FULL_CAPABILITY` for the new
    /// agent, the handler REQUIRES a matching signer in
    /// `ctx.remaining_accounts` whose key equals this pubkey AND
    /// `is_signer == true`. Otherwise rejects with
    /// `ErrReactivateCosignRequiredForFullCapability` (6114).
    ///
    /// Default `Pubkey::default()` at `initialize_vault` time means
    /// existing vaults retain today's behavior (no cosign gate on
    /// reactivate). Owners opt in by setting a non-default value via
    /// `queue_policy_update`. Setting a non-default value here is
    /// orthogonal to `cosign_required` — the two gate different ix paths
    /// (queue/apply vs reactivate) and use different pubkey sources
    /// (`pending.cosign_session` vs this field).
    ///
    /// Bound by TA-19 at canonical digest position 22. APPENDED at end
    /// of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub cosign_session_pubkey: Pubkey,

    /// F-Q6 (2026-06-02): owner-configured delay (in seconds) before an
    /// OPERATOR capability grant takes effect. Default 0. An owner-set
    /// security control gating OPERATOR seating — bound by TA-19 at canonical
    /// digest position 22 so a tampered SDK or pending-PDA mutation cannot
    /// silently lower it between owner approval and on-chain landing.
    /// Changeable only via the timelocked `queue_policy_update` path (so
    /// lowering it is itself delayed). The single-key forced floor
    /// (`max(field, 600)`) and per-tier grant logic live in `register_agent`
    /// / `queue_agent_grant`.
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub operator_grant_delay_seconds: u64,
}

/// TA-07 (Phase 3): one entry in `PolicyConfig.destination_graylist`.
///
/// `destination` is the wallet/PDA pubkey whose ATAs are being graylisted
/// (matches the entry in `allowed_destinations`). `unlock_unix` is the
/// Unix timestamp at which the destination becomes spendable without
/// the owner having to promote it.
///
/// Layout: 32 + 8 = 40 bytes per entry. Bounded ≤MAX_ALLOWED_DESTINATIONS
/// (10) so the worst-case Vec contribution to PolicyConfig SIZE is
/// `4 + 40*10 = 404` bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct DestinationGraylistEntry {
    pub destination: Pubkey,
    pub unlock_unix: i64,
}

impl DestinationGraylistEntry {
    /// Borsh-encoded size: 32 (Pubkey) + 8 (i64) = 40 bytes.
    pub const SIZE: usize = 32 + 8;
}

impl PolicyConfig {
    /// Account discriminator (8) + vault (32) + daily_cap_usd (8) +
    /// max_tx_usd (8) + protocol_mode (1) +
    /// protocols vec (4 + 32 * MAX) +
    /// developer_fee_rate (2) + max_slippage_bps (2) + timelock_duration (8) +
    /// allowed_destinations vec (4 + 32 * MAX) + has_constraints (1) +
    /// has_pending_policy (1) + has_protocol_caps (1) +
    /// protocol_caps vec (4 + 8 * MAX) + session_expiry_seconds (8) + bump (1) +
    /// policy_version (8) + has_post_assertions (1) + destination_mode (1) +
    /// policy_preview_digest (32) + created_at_slot (8) + operating_hours (4) +
    /// destination_graylist vec (4 + 40 * MAX_ALLOWED_DESTINATIONS) +
    /// auto_promote_grays (1) + auto_revoke_threshold (1) +
    /// stable_balance_floor (8) [TA-12 Phase 5] +
    /// per_recipient_daily_cap_usd (8) [TA-14 Phase 5] +
    /// cosign_required (1) [G6 audit 2026-05-18] +
    /// cosign_session_pubkey (32) [D-5 close audit 2026-05-19, F-RP3-1] +
    /// operator_grant_delay_seconds (8) [F-Q6 2026-06-02]
    /// [TA-19, Phase 2; PEN-CROSS-2 Phase 2 close-up;
    ///  TA-05/07/17 Phase 3 pre-exec; TA-12/TA-14 Phase 5;
    ///  G6 cosign opt-in 2026-05-18 audit;
    ///  D-5 reactivate cosign-when-FULL 2026-05-19 audit]
    pub const SIZE: usize = 8
        + 32
        + 8
        + 8
        + 1
        + (4 + 32 * MAX_ALLOWED_PROTOCOLS)
        + 2
        + 2 // max_slippage_bps
        + 8
        + (4 + 32 * MAX_ALLOWED_DESTINATIONS)
        // M1-04: has_constraints (1 byte) removed
        + 1 // has_pending_policy
        + 1 // has_protocol_caps
        + (4 + 8 * MAX_ALLOWED_PROTOCOLS) // protocol_caps
        + 8 // session_expiry_seconds
        + 1 // bump
        + 8 // policy_version
        + 1 // has_post_assertions
        + 1 // destination_mode
        + 32 // policy_preview_digest [TA-19]
        + 8 // created_at_slot [PEN-CROSS-2]
        + 4 // operating_hours [TA-05 Phase 3]
        + (4 + DestinationGraylistEntry::SIZE * MAX_ALLOWED_DESTINATIONS) // graylist [TA-07]
        + 1 // auto_promote_grays [TA-07]
        + 1 // auto_revoke_threshold [TA-17]
        + 8 // stable_balance_floor [TA-12 Phase 5]
        + 8 // per_recipient_daily_cap_usd [TA-14 Phase 5]
        + 1 // cosign_required [G6 audit 2026-05-18]
        + 32 // cosign_session_pubkey [D-5 audit 2026-05-19, F-RP3-1]
        + 8; // operator_grant_delay_seconds [F-Q6 2026-06-02]

    /// Check if a protocol is allowed.
    ///
    /// Phase 2 Option A: ALLOWLIST-only. Permissive ALL/DENYLIST modes deleted.
    /// Returns true iff `program_id` appears in `self.protocols`.
    /// Handlers reject `protocol_mode != PROTOCOL_MODE_ALLOWLIST` at create/queue/apply,
    /// so a runtime `protocol_mode` mismatch here indicates state corruption — fail closed.
    pub fn is_protocol_allowed(&self, program_id: &Pubkey) -> bool {
        if self.protocol_mode != PROTOCOL_MODE_ALLOWLIST {
            return false; // defensive: state corruption / migration glitch
        }
        self.protocols.contains(program_id)
    }

    /// Check if a destination is allowed for agent transfers.
    ///
    /// Phase 2 Option A: RESTRICTED-only. Permissive OPEN_WITH_CAP mode deleted
    /// (closes F-4 default-allow drain vector definitively rather than relying on
    /// owner opt-in correctness). Returns true iff `destination_owner` appears
    /// in `self.allowed_destinations`. An empty list rejects every destination.
    /// Handlers reject `destination_mode != DESTINATION_MODE_RESTRICTED` at
    /// create/queue/apply, so a runtime mismatch here indicates state corruption —
    /// fail closed.
    pub fn is_destination_allowed(&self, destination_owner: &Pubkey) -> bool {
        if self.destination_mode != DESTINATION_MODE_RESTRICTED {
            return false; // defensive: state corruption / migration glitch
        }
        self.allowed_destinations.contains(destination_owner)
    }

    /// Get the per-protocol daily cap for a given protocol.
    /// Returns None if caps disabled, or Some(cap) where 0 means unlimited.
    pub fn get_protocol_cap(&self, protocol: &Pubkey) -> Option<u64> {
        if !self.has_protocol_caps {
            return None;
        }
        self.protocols
            .iter()
            .position(|p| p == protocol)
            .map(|i| self.protocol_caps.get(i).copied().unwrap_or(0))
    }

    /// Returns the effective session duration in seconds.
    /// 0 = use default (`SESSION_DURATION_SECONDS` = 30s).
    pub fn effective_session_expiry_seconds(&self) -> u64 {
        if self.session_expiry_seconds == 0 {
            SESSION_DURATION_SECONDS as u64
        } else {
            self.session_expiry_seconds
        }
    }

    /// TA-07 (Phase 3): is the destination currently in the graylist AND
    /// still locked? Returns `(true, unlock_unix)` if so, else `(false, _)`.
    ///
    /// A destination that's NOT in the graylist returns `(false, 0)`. A
    /// destination that's in the graylist but past unlock returns
    /// `(false, unlock_unix)` — entries left in the graylist past unlock
    /// are harmless (they auto-pass) and are cleaned up by the
    /// `promote_graylist_destination` ix or by overwrite when the
    /// destination is re-added.
    pub fn is_destination_graylisted(&self, destination: &Pubkey, now: i64) -> (bool, i64) {
        for entry in self.destination_graylist.iter() {
            if entry.destination == *destination {
                return (now < entry.unlock_unix, entry.unlock_unix);
            }
        }
        (false, 0)
    }

    /// TA-05 (Phase 3): is the given Unix timestamp's UTC hour permitted
    /// by `operating_hours`?
    ///
    /// `operating_hours` is a 24-bit bitmask. Bit `n` (0..=23) set → spending
    /// allowed when the UTC hour is `n`. UTC hour is derived as
    /// `(unix_timestamp / 3600).rem_euclid(24)` — `rem_euclid` ensures
    /// pre-epoch timestamps (negative i64) still map into 0..=23.
    ///
    /// Bits 24..=31 MUST be zero (validated at write time). Defaults to
    /// 0xFFFFFF when an owner doesn't narrow — equivalent to "no
    /// operating-hours constraint".
    ///
    /// `unix_timestamp <= 0` is treated as "outside" — a positive Clock
    /// timestamp is the only safe input. (Solana mainnet always provides one;
    /// LiteSVM under devnet-testing may not — those vaults should configure
    /// `operating_hours = 0xFFFFFF` so the bitmask check is a no-op.)
    pub fn is_within_operating_hours(&self, unix_timestamp: i64) -> bool {
        if unix_timestamp <= 0 {
            return false;
        }
        let hour: u32 = ((unix_timestamp / 3600).rem_euclid(24)) as u32;
        // Defense-in-depth: even if upper bits leaked through validation,
        // mask to the lower 24 bits before testing.
        let mask = self.operating_hours & 0x00FFFFFF;
        (mask & (1u32 << hour)) != 0
    }
}

// F-Q6 (2026-06-02) compile-time SIZE pin (mirrors the AgentVault pattern).
// Verifies the PolicyConfig::SIZE arithmetic after appending
// operator_grant_delay_seconds (+8): 1321 (pre-F-Q6, post-M1-04 has_constraints
// removal) + 8 = 1329. Any future field addition that forgets to update SIZE
// fails the build here — the same PEN-7-class ratchet AgentVault already has.
const _POLICY_CONFIG_SIZE_PIN: () = assert!(
    PolicyConfig::SIZE == 1329,
    "PolicyConfig::SIZE drifted from documented F-Q6 layout (1321 + 8 operator_grant_delay_seconds = 1329)"
);

/// TA-05 (Phase 3): mask covering bits 0..=23 only. Any `operating_hours`
/// value whose bits 24..=31 are non-zero is invalid and MUST be rejected at
/// policy-write time. The all-hours-enabled value is `OPERATING_HOURS_VALID_MASK`
/// itself (`0x00FFFFFF`); callers that want "all hours" use this same constant.
pub const OPERATING_HOURS_VALID_MASK: u32 = 0x00FFFFFF;
