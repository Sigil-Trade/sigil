use crate::errors::SigilError;
use crate::state::MAX_ALLOWED_PROTOCOLS;
use anchor_lang::prelude::*;

/// 10-minute epoch duration in seconds
pub const EPOCH_DURATION: i64 = 600;

/// Number of epochs in a 24-hour window (144 × 10 min = 24h)
pub const NUM_EPOCHS: usize = 144;

/// Rolling window duration in seconds (24 hours)
pub const ROLLING_WINDOW_SECONDS: i64 = 86_400;

/// TA-14 (Phase 5 post-exec): maximum tracked recipients per vault.
/// Fixed-size array — Vec NOT permitted in zero-copy account per F-14.
/// 10 simultaneous unique recipients per rolling 24h window. When all
/// 10 slots are within their windows and an 11th unique recipient
/// appears, the call rejects (NEVER LRU/churn-eviction — per §RP
/// requirement, ONLY age-based eviction permitted).
pub const MAX_PER_RECIPIENT_ENTRIES: usize = 10;

/// Zero-copy 144-epoch circular buffer for rolling 24h USD spend tracking.
/// Each bucket covers a 10-minute epoch. Boundary correction ensures
/// functionally exact accuracy (~$0.000001 worst-case rounding).
/// Rounding direction: slightly permissive (under-counts by at most $0.000001).
///
/// Seeds: `[b"tracker", vault.key().as_ref()]`
#[account(zero_copy)]
pub struct SpendTracker {
    /// Associated vault pubkey
    pub vault: Pubkey, // 32 bytes

    /// 144 epoch buckets for rolling 24h spend tracking
    pub buckets: [EpochBucket; NUM_EPOCHS], // 2,304 bytes (144 × 16)

    /// Per-protocol rolling 24h counters. Enforcement wired in
    /// `finalize_session.rs` — search for "TA-13 (Phase 5 ratification)"
    /// (two sites: the stablecoin-input branch around line 314 and the
    /// non-stablecoin-input branch around line 408). See
    /// `policy.protocol_caps` for the cap values and
    /// `PolicyConfig::get_protocol_cap` for the lookup logic. Per-protocol
    /// entries are populated by `record_protocol_spend()` when
    /// `policy.has_protocol_caps == true`.
    ///
    /// TA-13 ratification (Phase 5): the prior doc-comment claimed
    /// "zeroed, no enforcement yet" — this was stale. The enforcement
    /// has lived in `finalize_session` since Phase 2; this comment was
    /// the only artifact suggesting otherwise. Phase 5 ratifies the
    /// existing require! with the dedicated `ErrDailyCapExceeded` (6086)
    /// error code so off-chain monitors can disambiguate the "rolling
    /// 24h cap hit" semantic from the legacy "slot allocation exhausted"
    /// path (which still returns `ProtocolCapExceeded` from inside
    /// `record_protocol_spend`).
    pub protocol_counters: [ProtocolSpendCounter; MAX_ALLOWED_PROTOCOLS], // 480 bytes (10 × 48)

    /// Epoch of most recent record_spend() call. Enables early exit in get_rolling_24h_usd().
    /// Zero-initialized — value 0 correctly triggers early exit (current_epoch >> 144).
    pub last_write_epoch: i64, // 8 bytes

    /// Bump seed for PDA
    pub bump: u8, // 1 byte

    /// Padding for 8-byte alignment
    pub _padding: [u8; 7], // 7 bytes

    /// TA-14 (Phase 5 post-exec invariant #2): per-recipient rolling 24h
    /// outflow counters. Bounded to `MAX_PER_RECIPIENT_ENTRIES` (10)
    /// entries — Vec NOT permitted in zero-copy account per F-14.
    /// 10 × 48 = 480 bytes. Each entry tracks one recipient pubkey
    /// (resolved from the SPL TokenAccount.owner field — NOT the ATA
    /// pubkey) and their rolling-24h outflow USD total.
    pub per_recipient: [PerRecipientCounter; MAX_PER_RECIPIENT_ENTRIES], // 480 bytes

    /// TA-14 (Phase 5): how many `per_recipient` slots are currently
    /// active. New entries occupy `per_recipient[per_recipient_count]`
    /// then this counter increments. Eviction is AGE-BASED only — slots
    /// whose 24h window has elapsed are eligible; LRU/churn-eviction is
    /// EXPLICITLY REJECTED per §RP requirement (prevents an attacker
    /// recycling slots by paying many distinct recipients to bypass
    /// the cap).
    pub per_recipient_count: u8, // 1 byte

    /// Padding for 8-byte alignment after the new u8 counter.
    pub _padding_recipient: [u8; 7], // 7 bytes
}
// Total data: 2,824 + 8 (bump + padding) + 480 + 1 + 7 = 3,320 bytes
//             + 8 (discriminator) = 3,328 bytes

/// A single epoch bucket tracking aggregate USD spend.
/// 16 bytes per bucket. USD-only — rate limiting stays client-side.
#[derive(Default)]
#[zero_copy]
pub struct EpochBucket {
    /// Epoch identifier: unix_timestamp / EPOCH_DURATION
    pub epoch_id: i64, // 8 bytes

    /// Aggregate USD spent in this epoch (6 decimals)
    pub usd_amount: u64, // 8 bytes
}

/// Per-protocol spend counter using simple 24h window.
/// When current_epoch - window_start >= 144, the window is expired and resets to 0.
/// 48 bytes per entry (32 + 8 + 8).
#[zero_copy]
pub struct ProtocolSpendCounter {
    /// Protocol program ID
    pub protocol: [u8; 32],
    /// Window start timestamp (for future rolling window)
    pub window_start: i64,
    /// Accumulated spend in window (for future cap enforcement)
    pub window_spend: u64,
}

/// TA-14 (Phase 5 post-exec): per-recipient rolling 24h outflow counter.
/// 48 bytes per entry (32 + 8 + 8).
///
/// `recipient` is resolved from the SPL TokenAccount.owner field — NOT
/// the ATA pubkey. The §RP brief explicitly flags ATA-vs-owner confusion
/// as the attack class to defend against.
///
/// `window_start` is the Unix timestamp at which the current 24h window
/// began. When `now - window_start >= 86400` the slot is eligible for
/// age-based eviction.
///
/// `window_spend_usd` is the accumulated 6-decimal USDC face value spent
/// to this recipient in the active window.
#[zero_copy]
#[repr(C)]
pub struct PerRecipientCounter {
    /// Recipient wallet pubkey (NOT the ATA pubkey — Pod-compatible
    /// `[u8; 32]` since zero-copy accounts can't hold Pubkey directly).
    pub recipient: [u8; 32],
    /// Unix timestamp at which the active rolling 24h window started.
    /// Zero indicates an empty slot.
    pub window_start: i64,
    /// Accumulated 6-decimal USDC face value spent to `recipient` in
    /// the active 24h window.
    pub window_spend_usd: u64,
}

impl PerRecipientCounter {
    /// Empty slot: `window_start == 0` AND `window_spend_usd == 0`.
    ///
    /// The invariant pairs the two fields so a zeroed slot is unambiguously
    /// "never used", separate from "used and now elapsed" (where
    /// `window_start > 0`). Allocation in `SpendTracker::record_recipient_spend`
    /// relies on the per_recipient_count cursor rather than slot scanning,
    /// but `is_empty()` is the canonical predicate for any future caller
    /// that needs to identify never-used slots without touching the cursor.
    pub fn is_empty(&self) -> bool {
        self.window_start == 0 && self.window_spend_usd == 0
    }

    /// Expired: `now - window_start >= ROLLING_WINDOW_SECONDS` (86,400 s = 24h).
    ///
    /// Uses `saturating_sub` to stay consistent with the surrounding code
    /// (a clock running backward yields 0, which is < the window and so
    /// reports "not expired" — fail-closed for the eviction path that
    /// relies on this check).
    pub fn is_expired(&self, now: i64) -> bool {
        now.saturating_sub(self.window_start) >= ROLLING_WINDOW_SECONDS
    }

    /// Same recipient pubkey as the passed slice. Byte-equality on the
    /// raw 32-byte representation (zero-copy accounts cannot hold
    /// `Pubkey` directly).
    pub fn matches(&self, recipient: &[u8; 32]) -> bool {
        &self.recipient == recipient
    }

    /// Accumulate `amount_usd` into the active rolling window. Caller
    /// MUST have verified `matches() == true` (same recipient) AND
    /// `is_expired() == false` (window still active) before invoking,
    /// otherwise the addition mixes spend from a stale window into the
    /// current one. Returns `Overflow` on `u64::MAX` saturation.
    ///
    /// Return type is the std `core::result::Result<(), SigilError>`
    /// (not Anchor's `anchor_lang::Result<T>` alias) so the caller
    /// receives the raw error variant and decides how to wrap it.
    pub fn accumulate(&mut self, amount_usd: u64) -> core::result::Result<(), SigilError> {
        self.window_spend_usd = self
            .window_spend_usd
            .checked_add(amount_usd)
            .ok_or(SigilError::Overflow)?;
        Ok(())
    }

    /// Reset this slot to a fresh window starting at `now` with the
    /// given `recipient` and `initial_spend`. Used by both the
    /// expired-window-on-same-recipient path and the empty-slot
    /// allocation path in `record_recipient_spend`.
    pub fn reset(&mut self, recipient: [u8; 32], now: i64, initial_spend: u64) {
        self.recipient = recipient;
        self.window_start = now;
        self.window_spend_usd = initial_spend;
    }
}

impl SpendTracker {
    /// Total account size including 8-byte discriminator.
    /// 8 disc + 32 vault + 144*16 buckets + 10*48 protocol_counters +
    /// 8 last_write_epoch + 1 bump + 7 pad +
    /// 10*48 per_recipient + 1 per_recipient_count + 7 pad
    /// = 8 + 32 + 2304 + 480 + 8 + 1 + 7 + 480 + 1 + 7 = 3328 bytes
    pub const SIZE: usize = 8
        + 32
        + (16 * NUM_EPOCHS)
        + (48 * MAX_ALLOWED_PROTOCOLS)
        + 8
        + 1
        + 7
        + (48 * MAX_PER_RECIPIENT_ENTRIES) // [TA-14] per_recipient
        + 1 // per_recipient_count
        + 7; // _padding_recipient

    // LM-1 (Bucket-3 audit 2026-05-23): compile-time pin against silent
    // drift of the documented byte baseline. Any field addition that does
    // not also update this assert breaks the build.
    const _SPEND_TRACKER_SIZE_PIN: () = assert!(
        SpendTracker::SIZE == 3_328,
        "SpendTracker::SIZE drifted from documented baseline"
    );

    /// Record a spend in the current epoch bucket.
    /// If the bucket is from a different epoch, reset it first.
    pub fn record_spend(&mut self, clock: &Clock, usd_amount: u64) -> Result<()> {
        // Clock-validity guard (pre-genesis broken clock).
        require!(clock.unix_timestamp > 0, SigilError::InvalidSession);
        // Safe: EPOCH_DURATION is a non-zero constant (600)
        let current_epoch = clock.unix_timestamp.checked_div(EPOCH_DURATION).unwrap();
        let idx = (current_epoch % NUM_EPOCHS as i64) as usize;

        if self.buckets[idx].epoch_id != current_epoch {
            self.buckets[idx] = EpochBucket {
                epoch_id: current_epoch,
                usd_amount: 0,
            };
        }

        self.buckets[idx].usd_amount = self.buckets[idx]
            .usd_amount
            .checked_add(usd_amount)
            .ok_or(error!(SigilError::Overflow))?;

        self.last_write_epoch = current_epoch;

        Ok(())
    }

    /// Get the rolling 24h USD spend total with boundary correction.
    ///
    /// Iterates all 144 buckets, summing those within the 24h window.
    /// The oldest bucket that straddles the window boundary is
    /// proportionally scaled for functionally exact accuracy.
    /// Worst-case rounding error: $0.000001 (1 unit at 6 decimals).
    pub fn get_rolling_24h_usd(&self, clock: &Clock) -> u64 {
        if clock.unix_timestamp <= 0 {
            return 0;
        }
        // Safe: EPOCH_DURATION is a non-zero constant (600)
        let current_epoch = clock.unix_timestamp.checked_div(EPOCH_DURATION).unwrap();

        // Early exit: if no writes in 144+ epochs, all data is expired.
        // saturating_sub fail-closes on clock skew (last_write_epoch > current_epoch
        // would otherwise panic under release-mode overflow-checks=true).
        if current_epoch.saturating_sub(self.last_write_epoch) > NUM_EPOCHS as i64 {
            return 0;
        }

        let window_start_ts = clock.unix_timestamp.saturating_sub(ROLLING_WINDOW_SECONDS);
        let mut total: u128 = 0;

        for bucket in &self.buckets {
            if bucket.usd_amount == 0 {
                continue;
            }

            let bucket_start = bucket.epoch_id.saturating_mul(EPOCH_DURATION);
            let bucket_end = bucket_start.saturating_add(EPOCH_DURATION);

            if bucket_end <= window_start_ts || bucket.epoch_id > current_epoch {
                continue; // entirely outside window
            }

            if bucket_start >= window_start_ts {
                // Fully inside window — count 100%
                total = total.saturating_add(bucket.usd_amount as u128);
            } else {
                // Boundary bucket — proportional scaling
                // Safe: bucket_end > window_start_ts (checked above), EPOCH_DURATION non-zero
                let overlap = bucket_end.checked_sub(window_start_ts).unwrap() as u128;
                let scaled = (bucket.usd_amount as u128)
                    .saturating_mul(overlap)
                    .checked_div(EPOCH_DURATION as u128)
                    .unwrap();
                total = total.saturating_add(scaled);
            }
        }

        // Cap at u64::MAX
        if total > u64::MAX as u128 {
            u64::MAX
        } else {
            total as u64
        }
    }

    /// Get per-protocol spend within the current simple 24h window.
    /// Returns 0 if no counter exists or window has expired (>= 144 epochs old).
    ///
    /// KNOWN LIMITATION: Uses a simple 24h window (resets entirely on expiry),
    /// not the proportional boundary correction used by the global rolling cap.
    /// At the window boundary, accumulated per-protocol spend resets to 0,
    /// allowing brief overspend relative to the per-protocol cap. The global
    /// rolling cap (get_rolling_24h_usd) provides the primary enforcement and
    /// is NOT subject to this reset behavior.
    ///
    /// AUDIT 2026-06-15 (M3 — ACCEPTED by owner): the ~2x per-protocol overspend
    /// possible across the 24h boundary is bounded by the global proportional
    /// rolling cap — total vault outflow can never exceed `daily_spending_cap_usd`
    /// regardless of per-protocol granularity — so this is a sub-limit precision
    /// nicety, NOT a fund-loss path. A full 144-bucket-per-protocol rewrite
    /// (~+20KB zero-copy account + a layout migration) was evaluated and rejected
    /// as disproportionate to a non-fund-loss issue. See SIGIL_ONCHAIN_AUDIT_2026-06-15.md.
    pub fn get_protocol_spend(&self, clock: &Clock, protocol_id: &Pubkey) -> u64 {
        if clock.unix_timestamp <= 0 {
            return 0;
        }
        let current_epoch = clock.unix_timestamp.checked_div(EPOCH_DURATION).unwrap();
        let protocol_bytes = protocol_id.to_bytes();

        for counter in &self.protocol_counters {
            if counter.protocol == protocol_bytes {
                // Check if window is still valid (< 144 epochs = 24h).
                // saturating_sub fail-closes on clock skew (would otherwise panic
                // under release-mode overflow-checks=true).
                if current_epoch.saturating_sub(counter.window_start) < NUM_EPOCHS as i64 {
                    return counter.window_spend;
                }
                return 0; // Window expired
            }
        }
        0 // No counter found
    }

    /// Record per-protocol spend. Finds or allocates a counter slot by protocol ID.
    /// Uses simple 24h window — resets entirely when window expires.
    ///
    /// KNOWN LIMITATION: Same simple-window behavior as get_protocol_spend().
    /// See that function's doc comment for details on the boundary reset behavior.
    pub fn record_protocol_spend(
        &mut self,
        clock: &Clock,
        protocol_id: &Pubkey,
        usd_amount: u64,
    ) -> Result<()> {
        // Clock-validity guard (pre-genesis broken clock).
        require!(clock.unix_timestamp > 0, SigilError::InvalidSession);
        let current_epoch = clock.unix_timestamp.checked_div(EPOCH_DURATION).unwrap();
        let protocol_bytes = protocol_id.to_bytes();
        let empty_bytes = [0u8; 32];

        // Scan for existing counter or empty slot
        let mut empty_slot: Option<usize> = None;
        for i in 0..self.protocol_counters.len() {
            if self.protocol_counters[i].protocol == protocol_bytes {
                // Found existing counter.
                // saturating_sub fail-closes on clock skew (would otherwise panic
                // under release-mode overflow-checks=true).
                if current_epoch.saturating_sub(self.protocol_counters[i].window_start)
                    >= NUM_EPOCHS as i64
                {
                    // Window expired — reset
                    self.protocol_counters[i].window_start = current_epoch;
                    self.protocol_counters[i].window_spend = usd_amount;
                } else {
                    // Window still valid — accumulate
                    self.protocol_counters[i].window_spend = self.protocol_counters[i]
                        .window_spend
                        .checked_add(usd_amount)
                        .ok_or(error!(SigilError::Overflow))?;
                }
                return Ok(());
            }
            if empty_slot.is_none() && self.protocol_counters[i].protocol == empty_bytes {
                empty_slot = Some(i);
            }
        }

        // Not found — allocate empty slot
        if let Some(idx) = empty_slot {
            self.protocol_counters[idx].protocol = protocol_bytes;
            self.protocol_counters[idx].window_start = current_epoch;
            self.protocol_counters[idx].window_spend = usd_amount;
            Ok(())
        } else {
            Err(error!(SigilError::ProtocolCapExceeded))
        }
    }

    /// TA-14 (Phase 5 post-exec invariant #2): get the rolling 24h
    /// outflow USD total to `recipient`. Returns 0 if the recipient has
    /// no active counter or the counter's window has elapsed.
    ///
    /// Window expiry: `now - counter.window_start >= 86400`. The counter
    /// is treated as inert when expired (returns 0 here); actual eviction
    /// happens in `record_recipient_spend()`.
    pub fn get_recipient_spend(&self, clock: &Clock, recipient: &Pubkey) -> u64 {
        if clock.unix_timestamp <= 0 {
            return 0;
        }
        let now = clock.unix_timestamp;
        let recipient_bytes = recipient.to_bytes();
        let active = (self.per_recipient_count as usize).min(self.per_recipient.len());
        for i in 0..active {
            let entry = &self.per_recipient[i];
            if entry.recipient == recipient_bytes {
                // Window expired → entry inert; report 0.
                if now.saturating_sub(entry.window_start) >= ROLLING_WINDOW_SECONDS {
                    return 0;
                }
                return entry.window_spend_usd;
            }
        }
        0
    }

    /// TA-14 (Phase 5): record `usd_amount` outflow to `recipient`.
    /// AGE-BASED eviction only — no LRU/churn-eviction permitted.
    ///
    /// Algorithm:
    ///   1. If the recipient already has a slot:
    ///      a. If the slot's window has elapsed (≥ 24h since window_start),
    ///      reset to a fresh window starting at `now` with
    ///      `window_spend_usd = usd_amount`.
    ///      b. Otherwise accumulate `usd_amount` into the active window
    ///      (checked add — `Overflow` on u64::MAX overflow).
    ///   2. If the recipient has no slot:
    ///      a. If `per_recipient_count < MAX_PER_RECIPIENT_ENTRIES`,
    ///      allocate the next free slot at index `per_recipient_count`
    ///      and increment.
    ///      b. Otherwise scan for an entry whose window has elapsed
    ///      (`now - window_start >= 86400`) — among eligible entries,
    ///      pick the one with the OLDEST `window_start`. Overwrite
    ///      it with the new recipient.
    ///      c. If NO entry has an elapsed window, REJECT with
    ///      `ErrRecipientCapExceeded`. Critical: this is the no-churn
    ///      guarantee — an attacker who has filled all 10 slots within
    ///      the last 24h cannot recycle them by paying new recipients.
    ///
    /// Caller is expected to perform the cap-vs-spend check BEFORE this
    /// record helper (so the cap rejection happens at the require! site
    /// in finalize_session, not inside this state mutator).
    pub fn record_recipient_spend(
        &mut self,
        clock: &Clock,
        recipient: &Pubkey,
        usd_amount: u64,
    ) -> Result<()> {
        // Clock-validity guard (pre-genesis broken clock).
        require!(clock.unix_timestamp > 0, SigilError::InvalidSession);
        let now = clock.unix_timestamp;
        let recipient_bytes = recipient.to_bytes();
        let active = (self.per_recipient_count as usize).min(self.per_recipient.len());
        // M-9 audit fix (2026-05-19): per-recipient cursor invariant.
        // `per_recipient_count` is the number of populated slots — it MUST
        // be ≤ `MAX_PER_RECIPIENT_ENTRIES`. The `.min()` clamp above is a
        // belt-and-suspenders saturating cast for the case where on-chain
        // state somehow grew past the bound (account data corruption); the
        // debug_assert documents the design invariant explicitly for any
        // future refactor. The clamp is what's load-bearing under release
        // builds; the assert fires in tests if the invariant breaks.
        debug_assert!(
            (self.per_recipient_count as usize) <= MAX_PER_RECIPIENT_ENTRIES,
            "TA-14 per-recipient cursor invariant violated: count={} > MAX={}",
            self.per_recipient_count,
            MAX_PER_RECIPIENT_ENTRIES,
        );

        // 1) Existing slot path
        for i in 0..active {
            if self.per_recipient[i].matches(&recipient_bytes) {
                if self.per_recipient[i].is_expired(now) {
                    // Window elapsed — reset to fresh window. NOT churn-
                    // eviction (same recipient is restarting their own
                    // window after natural expiry, which the no-churn
                    // rule explicitly permits).
                    self.per_recipient[i].reset(recipient_bytes, now, usd_amount);
                } else {
                    // Accumulate into active window.
                    // `accumulate` returns `Result<_, SigilError>`; wrap into
                    // an Anchor error so the surrounding `Result<()>`
                    // (anchor_lang::Result) propagates correctly. The only
                    // failure mode is `SigilError::Overflow` (u64 saturation
                    // on checked_add), which is what was previously raised
                    // inline.
                    self.per_recipient[i]
                        .accumulate(usd_amount)
                        .map_err(|_| error!(SigilError::Overflow))?;
                }
                return Ok(());
            }
        }

        // 2a) Allocate new slot if any are free
        if active < MAX_PER_RECIPIENT_ENTRIES {
            let idx = active;
            self.per_recipient[idx].reset(recipient_bytes, now, usd_amount);
            self.per_recipient_count = self
                .per_recipient_count
                .checked_add(1)
                .ok_or(error!(SigilError::Overflow))?;
            return Ok(());
        }

        // 2b) Array full — AGE-BASED eviction. Scan ALL slots looking
        // for entries with elapsed windows. Among eligible entries,
        // pick the one with the OLDEST window_start.
        let mut oldest_idx: Option<usize> = None;
        let mut oldest_ts: i64 = i64::MAX;
        for i in 0..MAX_PER_RECIPIENT_ENTRIES {
            if self.per_recipient[i].is_expired(now)
                && self.per_recipient[i].window_start < oldest_ts
            {
                oldest_idx = Some(i);
                oldest_ts = self.per_recipient[i].window_start;
            }
        }

        // 2c) No eligible slot — REJECT. Defends against churn-eviction.
        let Some(idx) = oldest_idx else {
            return Err(error!(SigilError::ErrRecipientCapExceeded));
        };

        // Evict and install the new recipient.
        self.per_recipient[idx].reset(recipient_bytes, now, usd_amount);
        Ok(())
    }
}

#[cfg(test)]
mod per_recipient_counter_tests {
    use super::*;

    fn counter(recipient: [u8; 32], window_start: i64, spend: u64) -> PerRecipientCounter {
        PerRecipientCounter {
            recipient,
            window_start,
            window_spend_usd: spend,
        }
    }

    /// `is_empty()` requires BOTH `window_start == 0` AND
    /// `window_spend_usd == 0`. A slot with a non-zero window_start is
    /// "used" even if spend is currently zero.
    #[test]
    fn is_empty_only_when_both_fields_zero() {
        assert!(counter([0u8; 32], 0, 0).is_empty(), "zeroed slot is empty");
        assert!(
            !counter([0u8; 32], 1, 0).is_empty(),
            "non-zero window_start means slot is in use"
        );
        assert!(
            !counter([0u8; 32], 0, 1).is_empty(),
            "non-zero spend means slot is in use"
        );
        assert!(
            !counter([1u8; 32], 100, 50).is_empty(),
            "fully populated slot is not empty"
        );
    }

    /// `is_expired()` uses the `>=` semantics: exactly 86,400 s after
    /// `window_start` is the first instant the slot is expired.
    #[test]
    fn is_expired_uses_inclusive_boundary() {
        let c = counter([1u8; 32], 1000, 50);
        assert!(
            !c.is_expired(1000 + ROLLING_WINDOW_SECONDS - 1),
            "one second before boundary is still active"
        );
        assert!(
            c.is_expired(1000 + ROLLING_WINDOW_SECONDS),
            "exactly at boundary is expired (>= semantics)"
        );
        assert!(
            c.is_expired(1000 + ROLLING_WINDOW_SECONDS + 1),
            "well past boundary is expired"
        );
        // Clock running backward: saturating_sub yields 0 < 86_400 → not expired.
        assert!(
            !c.is_expired(500),
            "clock skew (now < start) is not expired"
        );
    }

    /// `matches()` is byte-equality on the raw 32-byte key.
    #[test]
    fn matches_compares_raw_bytes() {
        let key_a = [0xAAu8; 32];
        let key_b = [0xBBu8; 32];
        let c = counter(key_a, 100, 0);
        assert!(c.matches(&key_a), "same bytes must match");
        assert!(!c.matches(&key_b), "different bytes must not match");
    }

    /// `accumulate()` performs a checked add and surfaces `Overflow` on
    /// saturation rather than wrapping.
    #[test]
    fn accumulate_checked_add_and_overflow() {
        let mut c = counter([1u8; 32], 100, 1_000);
        c.accumulate(2_500).expect("normal add succeeds");
        assert_eq!(c.window_spend_usd, 3_500);

        let mut overflow = counter([1u8; 32], 100, u64::MAX);
        let err = overflow
            .accumulate(1)
            .expect_err("u64::MAX + 1 must overflow");
        assert!(matches!(err, SigilError::Overflow), "expected Overflow");
        // State unchanged on overflow.
        assert_eq!(overflow.window_spend_usd, u64::MAX);
    }

    /// `reset()` overwrites all three fields atomically (from the
    /// caller's perspective — there's no other field to leak across).
    /// Critical: an expired slot reset to a new recipient must NOT
    /// retain stale spend from the prior window.
    #[test]
    fn reset_overwrites_all_fields() {
        let old_key = [0x11u8; 32];
        let new_key = [0x22u8; 32];
        let mut c = counter(old_key, 1_000, 999_999);
        c.reset(new_key, 5_000, 42);
        assert_eq!(c.recipient, new_key, "recipient overwritten");
        assert_eq!(c.window_start, 5_000, "window_start overwritten");
        assert_eq!(c.window_spend_usd, 42, "spend overwritten (no stale carry)");
    }
}
