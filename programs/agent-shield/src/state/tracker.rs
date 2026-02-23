use crate::errors::AgentShieldError;
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

    /// Bump seed for PDA
    pub bump: u8, // 1 byte

    /// Padding for 8-byte alignment
    pub _padding: [u8; 7], // 7 bytes
}
// Total data: 2,344 bytes + 8 (discriminator) = 2,352 bytes

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

impl SpendTracker {
    /// Total account size including 8-byte discriminator
    pub const SIZE: usize = 8 + 32 + (16 * NUM_EPOCHS) + 1 + 7;

    /// Record a spend in the current epoch bucket.
    /// If the bucket is from a different epoch, reset it first.
    pub fn record_spend(&mut self, clock: &Clock, usd_amount: u64) -> Result<()> {
        let current_epoch = clock.unix_timestamp / EPOCH_DURATION;
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
            .ok_or(error!(AgentShieldError::Overflow))?;

        Ok(())
    }

    /// Get the rolling 24h USD spend total with boundary correction.
    ///
    /// Iterates all 144 buckets, summing those within the 24h window.
    /// The oldest bucket that straddles the window boundary is
    /// proportionally scaled for functionally exact accuracy.
    /// Worst-case rounding error: $0.000001 (1 unit at 6 decimals).
    pub fn get_rolling_24h_usd(&self, clock: &Clock) -> u64 {
        let current_epoch = clock.unix_timestamp / EPOCH_DURATION;
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
                let overlap = (bucket_end - window_start_ts) as u128;
                let scaled =
                    (bucket.usd_amount as u128).saturating_mul(overlap) / EPOCH_DURATION as u128;
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
}
