use anchor_lang::prelude::*;

#[account]
pub struct SessionAuthority {
    /// Associated vault
    pub vault: Pubkey,

    /// The agent who initiated this session
    pub agent: Pubkey,

    /// Whether this session has been authorized by the permission check
    pub authorized: bool,

    /// Authorized action details (for verification in finalize)
    pub authorized_amount: u64,
    pub authorized_token: Pubkey,
    pub authorized_protocol: Pubkey,

    /// Wall-clock expiry: session is valid until this `Clock::unix_timestamp`.
    ///
    /// **Why timestamp, not slot:** Solana slot times vary 400ms-1.5s under
    /// congestion. Slot-based expiry produced a 3.75x variance window between
    /// the documented and worst-case session lifetime — see audit F5-H1.
    /// Wall-clock enforcement is congestion-immune.
    pub expires_at_timestamp: i64,

    /// Whether token delegation was set up (approve CPI)
    pub delegated: bool,

    /// The vault's token account that was delegated to the agent
    /// (only meaningful when delegated == true)
    pub delegation_token_account: Pubkey,

    /// Protocol fee collected during validate (for event logging in finalize)
    pub protocol_fee: u64,

    /// Developer fee collected during validate (for event logging in finalize)
    pub developer_fee: u64,

    /// Stablecoin mint for outcome-based spending detection.
    /// For stablecoin input: set to authorized_token (the stablecoin being spent).
    /// For non-stablecoin input: set to the expected stablecoin output mint.
    /// Pubkey::default() for non-spending actions (no outcome check needed).
    pub output_mint: Pubkey,

    /// Snapshot of the relevant stablecoin account balance before the swap.
    /// For stablecoin input: vault_token_account.amount (taken before fee collection).
    /// For non-stablecoin input: output_stablecoin_account.amount.
    /// 0 for non-spending actions.
    pub stablecoin_balance_before: u64,

    /// Bump seed for PDA
    pub bump: u8,

    /// Phase B2: Snapshots of target account bytes captured in validate_and_authorize
    /// before DeFi instruction executes. Index i corresponds to PostAssertionEntry i.
    /// Used by delta assertion modes (1=MaxDecrease, 2=MaxIncrease, 3=NoChange).
    ///
    /// Phase 6 grow: array length 4 → 8 to match MAX_POST_ASSERTION_ENTRIES.
    /// Adds 128 bytes (4 × 32) to SessionAuthority.
    ///
    /// **Phase 6 R-1 MintDeltaCap reuse:** for mode-4 entries, the snapshot
    /// stores `pre_sum: u64 LE` in bytes [0..8] of the 32-byte slot. Remaining
    /// 24 bytes are zero-padded. `snapshot_lens[i]` is set to 8 (the u64
    /// width) so finalize can distinguish a captured R-1 snapshot from an
    /// uncaptured slot.
    pub assertion_snapshots: [[u8; 32]; 8],

    /// Phase B2: Actual value_len captured for each snapshot.
    /// 0 = no snapshot captured (mode 0 entries). Non-zero = snapshot was captured.
    /// finalize_session cross-checks snapshot_lens[i] == entry.value_len for
    /// modes 1..3. For mode 4 (R-1 MintDeltaCap) the field is set to 8 and
    /// finalize asserts snapshot_lens[i] == 8 before re-summing.
    ///
    /// Phase 6 grow: array length 4 → 8. Adds 4 bytes.
    pub snapshot_lens: [u8; 8],

    /// AC-10 (Phase 4) — monotonic session nonce closing durable-nonce replay
    /// (per Audit #1 C-1).
    ///
    /// **Semantics**
    /// - New session: `init` zero-initializes the account, so the field starts
    ///   at 0. `validate_and_authorize` accepts `expected_nonce` and requires
    ///   it to equal `self.nonce` at entry — a fresh session therefore demands
    ///   `expected_nonce = 0` from the caller.
    /// - `finalize_session` increments `self.nonce` by 1 on every successful
    ///   finalize (including the expired-cleanup path — see finalize_session.rs
    ///   for the atomicity argument). The increment is atomic with the
    ///   account-close: if finalize errors, the close is rolled back by the
    ///   runtime and the persisted nonce stays at the pre-increment value, so
    ///   a partial-fail does NOT permanent-increment the nonce.
    /// - Because `validate_and_authorize` uses `init` (not `init_if_needed`),
    ///   the (vault, agent, mint) session PDA is closed at finalize and the
    ///   next validate creates a fresh account starting at nonce=0. The nonce
    ///   field therefore functions as an in-session counter and is checked
    ///   against `expected_nonce` ONLY when the SessionAuthority account is
    ///   not closed between validates — currently a no-op in the steady-state
    ///   flow, present so Phase 8 ownership-transfer replay protection (M-5)
    ///   can extend the same field without a state-shape migration.
    ///
    /// **Phase 8 extension contract:** the ownership-transfer flow (M-5) will
    /// reuse this field as a per-vault monotonic counter scoped to the
    /// session PDA, preserving the existing finalize-time increment semantics.
    /// Adding seeds / scope is additive; the on-chain field stays a `u64`.
    ///
    /// **Why NOT in TA-19 canonical digest:** SessionAuthority is per-session
    /// ephemeral state, not policy-owned. Including the nonce in the policy
    /// digest would require digest recomputation on every successful seal,
    /// which collapses the queue/apply timelock semantics. The nonce is
    /// orthogonal to the policy_preview_digest binding.
    ///
    /// **APPEND-ONLY**: new field at the END of SessionAuthority. SIZE grows
    /// by 8 bytes (375 → 383). Pre-existing accounts at the prior layout are
    /// not migrated (the program close+init cycle naturally retires them at
    /// the next finalize), so this is safe under a V2 program ID redeploy.
    pub nonce: u64,

    /// F-Q8 — the vault stablecoin ATA pinned at validate for the
    /// non-stablecoin-input outcome check. finalize_session asserts the
    /// account it measures has THIS exact pubkey, so a compromised agent
    /// cannot substitute a different vault-owned stablecoin ATA (whose
    /// owner+mint also pass) to spoof the `current > before` return check.
    /// Set to output_stablecoin_account.key() on the non-stablecoin-input
    /// spending path; Pubkey::default() otherwise (stablecoin-input uses
    /// vault_token_account, already pinned via delegation_token_account).
    ///
    /// **APPEND-ONLY**: new field at the END of SessionAuthority. SIZE grows
    /// by 32 bytes (515 → 547). Sessions are init/close per cycle, so no
    /// migration is required.
    pub output_stablecoin_account: Pubkey,

    /// M1 output-ownership closure (2026-06-17) — the vault-owned token account
    /// that an acquiring spend on the **stablecoin-input** path MUST credit,
    /// pinned at validate. finalize asserts this exact account is vault-owned,
    /// holds `output_swap_mint`, and its balance strictly INCREASED, so a
    /// compromised agent cannot redirect the swap output to its own ATA
    /// (output-ownership / M1). GENERIC: the program never learns which protocol
    /// produced the swap — it checks only vault-ownership + increase.
    /// `Pubkey::default()` for non-swap / non-stablecoin-input sessions.
    ///
    /// **APPEND-ONLY**: new fields at the END of SessionAuthority. SIZE grows by
    /// 72 bytes (547 → 619). Ephemeral session ⇒ no migration.
    pub output_swap_account: Pubkey,

    /// The declared acquired mint backing `output_swap_account`. Must differ from
    /// the stablecoin input mint (a genuine acquisition, not a self-transfer).
    /// `Pubkey::default()` when no swap output is declared.
    pub output_swap_mint: Pubkey,

    /// Pre-DeFi snapshot of `output_swap_account.amount`, taken at validate.
    /// finalize requires the post-DeFi balance to be strictly greater
    /// (value-blind: the vault must have acquired *something* into the pinned
    /// account; no price/oracle). 0 when no swap output is declared.
    pub output_swap_balance_before: u64,
}

impl SessionAuthority {
    /// discriminator (8) + vault (32) + agent (32) + authorized (1) +
    /// amount (8) + token (32) + protocol (32) +
    /// expires_at_timestamp i64 (8) + delegated (1) + delegation_token_account (32) +
    /// protocol_fee (8) + developer_fee (8) +
    /// output_mint (32) + stablecoin_balance_before (8) + bump (1) +
    /// assertion_snapshots (256) + snapshot_lens (8) +
    /// nonce u64 (8)  ← AC-10 (Phase 4)
    ///
    /// is_spending byte removed in V2 Option A — always derived from
    /// `authorized_amount > 0`. Account is no longer rent-resized; SIZE shrinks
    /// by 1 byte under the V2 program ID.
    ///
    /// AC-10 (Phase 4) appends `nonce: u64` for durable-nonce replay defense.
    /// SIZE grows by 8 bytes (375 → 383). Phase 8 reuses the same field for
    /// ownership-transfer replay protection (M-5) without a layout migration.
    ///
    /// Phase 6 (Maestro borrows): assertion_snapshots grew from
    /// [[u8;32]; 4] → [[u8;32]; 8] (+128 bytes) and snapshot_lens from
    /// [u8;4] → [u8;8] (+4 bytes). Total SIZE grows 383 → 515 (+132). The
    /// extension is purely append-shape (existing fields kept in place at
    /// the same offsets), so on-chain decoders that already read the prior
    /// fields by name continue to work; only the per-account rent grows.
    /// Sessions are init/close per validate-finalize cycle, so no migration
    /// is required.
    ///
    /// F-Q8 (2026-06-02): appends `output_stablecoin_account: Pubkey` (+32),
    /// SIZE 515 → 547. Append-shape (existing offsets preserved); ephemeral
    /// session ⇒ no migration.
    ///
    /// M1 closure (2026-06-17): appends `output_swap_account: Pubkey` (+32),
    /// `output_swap_mint: Pubkey` (+32), `output_swap_balance_before: u64` (+8).
    /// SIZE 547 → 619. Append-shape; ephemeral session ⇒ no migration.
    pub const SIZE: usize =
        8 + 32 + 32 + 1 + 8 + 32 + 32 + 8 + 1 + 32 + 8 + 8 + 32 + 8 + 1 + 256 + 8 + 8 + 32
            + 32 + 32 + 8;

    /// Returns true when wall-clock has passed the session's expiry timestamp.
    pub fn is_expired(&self, current_unix_ts: i64) -> bool {
        current_unix_ts > self.expires_at_timestamp
    }

    pub fn is_valid(&self, current_unix_ts: i64) -> bool {
        self.authorized && !self.is_expired(current_unix_ts)
    }

    /// Compute the wall-clock expiry timestamp from `now_ts` and an
    /// owner-configured duration in seconds.
    ///
    /// `owner_max_seconds` is silently capped to
    /// `MAX_OWNER_SESSION_DURATION_SECONDS` as defense-in-depth — the
    /// `queue_policy_update` validator already rejects out-of-range values,
    /// but enforcing the cap here means a future bug elsewhere cannot create
    /// an over-long session.
    pub fn calculate_expiry(now_ts: i64, owner_max_seconds: u64) -> i64 {
        let capped = owner_max_seconds.min(super::MAX_OWNER_SESSION_DURATION_SECONDS) as i64;
        // saturating_add prevents wrap on pathological i64 inputs.
        now_ts.saturating_add(capped)
    }
}

#[cfg(test)]
mod f5h1_tests {
    //! F5-H1 audit fix: session expiry uses wall-clock `unix_timestamp`,
    //! not slot. These tests pin the variance-immunity property: regardless
    //! of how fast or slow slots advance, a session's lifetime is governed
    //! purely by the seconds between `now_ts` (validate) and the equality of
    //! that timestamp to `expires_at_timestamp` (finalize check).

    use super::*;
    use crate::state::{
        MAX_OWNER_SESSION_DURATION_SECONDS, MIN_SESSION_DURATION_SECONDS, SESSION_DURATION_SECONDS,
    };

    /// Helper — build a SessionAuthority with only `expires_at_timestamp` set.
    fn session_with_expiry(expires_at: i64) -> SessionAuthority {
        SessionAuthority {
            vault: Pubkey::default(),
            agent: Pubkey::default(),
            authorized: true,
            authorized_amount: 0,
            authorized_token: Pubkey::default(),
            authorized_protocol: Pubkey::default(),
            expires_at_timestamp: expires_at,
            delegated: false,
            delegation_token_account: Pubkey::default(),
            protocol_fee: 0,
            developer_fee: 0,
            output_mint: Pubkey::default(),
            stablecoin_balance_before: 0,
            bump: 0,
            assertion_snapshots: [[0u8; 32]; 8],
            snapshot_lens: [0u8; 8],
            nonce: 0,
            output_stablecoin_account: Pubkey::default(),
            output_swap_account: Pubkey::default(),
            output_swap_mint: Pubkey::default(),
            output_swap_balance_before: 0,
        }
    }

    /// `calculate_expiry(now_ts, default)` produces an expiry exactly
    /// `SESSION_DURATION_SECONDS` past `now_ts`, and `is_expired` uses a
    /// strict `>` boundary at that timestamp.
    ///
    /// **Why this proves congestion-immunity:** the function takes only
    /// `unix_timestamp` as its time input. Slot is not a parameter — there
    /// is no slot-time variance term in the result. Compare with the prior
    /// F5-H1 vulnerable form `now_slot + N` which scaled with slot duration.
    #[test]
    fn f5h1_calculate_expiry_uses_only_wall_clock() {
        let now_ts: i64 = 1_700_000_000; // arbitrary realistic mainnet timestamp
        let expires = SessionAuthority::calculate_expiry(now_ts, SESSION_DURATION_SECONDS as u64);
        assert_eq!(expires, now_ts + SESSION_DURATION_SECONDS);

        let session = session_with_expiry(expires);

        assert!(!session.is_expired(expires - 1)); // 1s before expiry
        assert!(!session.is_expired(expires)); // exactly at expiry: boundary is strict `>`
        assert!(session.is_expired(expires + 1)); // 1s after expiry
    }

    /// Defense-in-depth: even if a caller bypassed `queue_policy_update`
    /// validation, `calculate_expiry` itself caps the duration at
    /// `MAX_OWNER_SESSION_DURATION_SECONDS`. The previous slot-based 450
    /// would, at 1.5s/slot, have permitted 11+ minutes of live delegation.
    #[test]
    fn f5h1_owner_max_silently_capped_at_max_owner_duration() {
        let now_ts: i64 = 1_700_000_000;

        // Try to set 600s (10 minutes) — well above the 90s cap.
        let expires = SessionAuthority::calculate_expiry(now_ts, 600);
        assert_eq!(
            expires,
            now_ts + MAX_OWNER_SESSION_DURATION_SECONDS as i64,
            "calculate_expiry must cap at MAX_OWNER_SESSION_DURATION_SECONDS \
             regardless of caller-supplied owner_max_seconds"
        );

        // u64::MAX gets capped to MAX_OWNER_SESSION_DURATION_SECONDS, not saturating.
        let max_attempt = SessionAuthority::calculate_expiry(now_ts, u64::MAX);
        assert_eq!(
            max_attempt,
            now_ts + MAX_OWNER_SESSION_DURATION_SECONDS as i64
        );
    }

    /// Lower-bound sanity: 5s is the floor enforced by queue_policy_update,
    /// but `calculate_expiry` accepts any value >= 0. The floor is policy,
    /// not arithmetic.
    #[test]
    fn f5h1_min_session_duration_arithmetically_valid() {
        let now_ts: i64 = 1_700_000_000;
        let expires = SessionAuthority::calculate_expiry(now_ts, MIN_SESSION_DURATION_SECONDS);
        assert_eq!(expires, now_ts + MIN_SESSION_DURATION_SECONDS as i64);
        assert_eq!(expires - now_ts, 5);
    }

    /// Boundary: at i64::MAX - small, calculate_expiry must saturate
    /// rather than wrap. Solana unix_timestamp is ~year 2262 at the
    /// saturation boundary, so this is purely defensive.
    #[test]
    fn f5h1_calculate_expiry_saturates_near_i64_max() {
        let near_max = i64::MAX - 10;
        let expires = SessionAuthority::calculate_expiry(near_max, SESSION_DURATION_SECONDS as u64);
        assert_eq!(expires, i64::MAX, "must saturate, not wrap");
    }

    /// is_expired uses strict `>` so a session is valid AT the expiry timestamp.
    /// This matches the slot-based predecessor (`current_slot > expires_at_slot`).
    #[test]
    fn f5h1_is_expired_strict_inequality() {
        let session = session_with_expiry(1_700_000_030);
        assert!(!session.is_expired(1_700_000_030)); // exactly at: not expired
        assert!(session.is_expired(1_700_000_031)); // 1s after: expired
        assert!(!session.is_expired(1_700_000_029)); // 1s before: not expired
    }

    /// is_valid combines `authorized` + `!is_expired` — both must hold.
    #[test]
    fn f5h1_is_valid_requires_authorized_and_not_expired() {
        let mut session = session_with_expiry(1_700_000_030);
        session.authorized = true;
        assert!(session.is_valid(1_700_000_000)); // authorized + not expired
        assert!(!session.is_valid(1_700_000_031)); // authorized but expired

        session.authorized = false;
        assert!(!session.is_valid(1_700_000_000)); // not authorized
    }
}
