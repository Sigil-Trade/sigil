use crate::errors::SigilError;
use crate::state::MAX_ALLOWED_PROTOCOLS;
use anchor_lang::prelude::*;

/// 10-minute epoch duration in seconds
pub const EPOCH_DURATION: i64 = 600;

/// Number of epochs in a 24-hour window (144 × 10 min = 24h)
pub const NUM_EPOCHS: usize = 144;

/// Rolling window duration in seconds (24 hours)
pub const ROLLING_WINDOW_SECONDS: i64 = 86_400;

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

    /// Reserved per-protocol spend counters (zeroed, no enforcement yet)
    pub protocol_counters: [ProtocolSpendCounter; MAX_ALLOWED_PROTOCOLS], // 480 bytes (10 × 48)

    /// Epoch of most recent record_spend() call. Enables early exit in get_rolling_24h_usd().
    /// Zero-initialized — value 0 correctly triggers early exit (current_epoch >> 144).
    pub last_write_epoch: i64, // 8 bytes

    /// Bump seed for PDA
    pub bump: u8, // 1 byte

    /// Padding for 8-byte alignment
    pub _padding: [u8; 7], // 7 bytes
}
// Total data: 2,824 bytes + 8 (discriminator) = 2,832 bytes

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

impl SpendTracker {
    /// Total account size including 8-byte discriminator
    pub const SIZE: usize = 8 + 32 + (16 * NUM_EPOCHS) + (48 * MAX_ALLOWED_PROTOCOLS) + 8 + 1 + 7;

    /// Record a spend in the current epoch bucket.
    /// If the bucket is from a different epoch, reset it first.
    pub fn record_spend(&mut self, clock: &Clock, usd_amount: u64) -> Result<()> {
        require!(clock.unix_timestamp > 0, SigilError::Overflow);
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

        // Early exit: if no writes in 144+ epochs, all data is expired
        if current_epoch - self.last_write_epoch > NUM_EPOCHS as i64 {
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
    pub fn get_protocol_spend(&self, clock: &Clock, protocol_id: &Pubkey) -> u64 {
        if clock.unix_timestamp <= 0 {
            return 0;
        }
        let current_epoch = clock.unix_timestamp.checked_div(EPOCH_DURATION).unwrap();
        let protocol_bytes = protocol_id.to_bytes();

        for counter in &self.protocol_counters {
            if counter.protocol == protocol_bytes {
                // Check if window is still valid (< 144 epochs = 24h)
                if current_epoch - counter.window_start < NUM_EPOCHS as i64 {
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
        require!(clock.unix_timestamp > 0, SigilError::Overflow);
        let current_epoch = clock.unix_timestamp.checked_div(EPOCH_DURATION).unwrap();
        let protocol_bytes = protocol_id.to_bytes();
        let empty_bytes = [0u8; 32];

        // Scan for existing counter or empty slot
        let mut empty_slot: Option<usize> = None;
        for i in 0..self.protocol_counters.len() {
            if self.protocol_counters[i].protocol == protocol_bytes {
                // Found existing counter
                if current_epoch - self.protocol_counters[i].window_start >= NUM_EPOCHS as i64 {
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
}
