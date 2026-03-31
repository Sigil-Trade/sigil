use anchor_lang::prelude::*;

use crate::errors::SigilError;

/// Overlay epoch duration: 1 hour (3600 seconds).
/// Chosen over the global tracker's 10-minute epoch because per-agent spend
/// windows need less granularity — 24 × 1h buckets cover 24h with 75% less storage.
pub const OVERLAY_EPOCH_DURATION: i64 = 3600;

/// Number of overlay epochs: 24 × 1h = 24h rolling window.
pub const OVERLAY_NUM_EPOCHS: usize = 24;

/// Rolling window duration in seconds (24 hours) — same as global tracker.
pub const OVERLAY_ROLLING_WINDOW_SECONDS: i64 = 86_400;

/// Maximum number of agent entries per overlay.
/// 10 matches MAX_AGENTS_PER_VAULT so every registered agent can have per-agent tracking.
/// Account size: 2,528 bytes (well within Solana's 10,240-byte CPI limit).
pub const MAX_OVERLAY_ENTRIES: usize = 10;

/// Per-agent contribution entry within an overlay.
/// Tracks each agent's individual spend contributions using a 24-bucket
/// hourly epoch scheme with per-entry `last_write_epoch` for correct gap-zeroing.
///
/// Layout: 32 (agent) + 8 (last_write_epoch) + 8 × 24 (contributions) = 232 bytes
#[zero_copy]
pub struct AgentContributionEntry {
    /// Agent pubkey stored as raw bytes (zero_copy requires fixed-size)
    pub agent: [u8; 32],

    /// The epoch number of the most recent write to this entry.
    /// Used to derive which buckets are stale via modular arithmetic.
    /// epoch = unix_timestamp / OVERLAY_EPOCH_DURATION (3600)
    pub last_write_epoch: i64,

    /// Per-epoch USD contributions from this agent.
    /// Indexed by `epoch % OVERLAY_NUM_EPOCHS`.
    pub contributions: [u64; OVERLAY_NUM_EPOCHS],
}

/// Per-vault overlay PDA tracking per-agent spend contributions.
///
/// Seeds: `[b"agent_spend", vault.key().as_ref(), &[0u8]]`
///
/// Supports up to 10 agents (matches MAX_AGENTS_PER_VAULT).
///
/// Size calculation:
///   8 (discriminator) + 32 (vault) + 232 × 10 (entries) + 1 (bump) + 7 (padding) + 80 (lifetime_spend) + 80 (lifetime_tx_count) = 2,528 bytes
#[account(zero_copy)]
pub struct AgentSpendOverlay {
    /// Associated vault pubkey
    pub vault: Pubkey, // 32 bytes

    /// Agent contribution entries (up to MAX_OVERLAY_ENTRIES agents)
    pub entries: [AgentContributionEntry; MAX_OVERLAY_ENTRIES], // 2,320 bytes

    /// Bump seed for PDA
    pub bump: u8, // 1 byte

    /// Padding for 8-byte alignment
    pub _padding: [u8; 7], // 7 bytes

    /// Per-agent cumulative spend in USD base units. Index matches entries[i].
    /// DESIGN DECISION: Tracks spend only, NOT profit/loss.
    /// Per-agent P&L requires oracles (removed by design) and protocol-specific
    /// position reading (violates protocol-agnostic principle). Realized P&L
    /// can be derived in the SDK by correlating agent spend events with vault
    /// balance changes. See agent-analytics.ts for the SDK implementation.
    /// Found by: Persona test (Treasury Manager "David")
    /// Appended AFTER existing layout to preserve zero-copy byte offsets.
    pub lifetime_spend: [u64; MAX_OVERLAY_ENTRIES], // 80 bytes

    /// Per-agent cumulative transaction count. Index matches entries[i].
    /// Incremented in finalize_session for EVERY successful spending session.
    /// Used for: avg TX size (lifetime_spend / lifetime_tx_count), agent activity ranking.
    pub lifetime_tx_count: [u64; MAX_OVERLAY_ENTRIES], // 80 bytes
}
// Total data: 2,360 + 80 + 80 bytes + 8 (discriminator) = 2,528 bytes

impl AgentSpendOverlay {
    /// Total account size including 8-byte discriminator
    pub const SIZE: usize = 8
        + 32
        + (232 * MAX_OVERLAY_ENTRIES)
        + 1
        + 7
        + (8 * MAX_OVERLAY_ENTRIES)
        + (8 * MAX_OVERLAY_ENTRIES);
    // = 8 + 32 + 2320 + 1 + 7 + 80 + 80 = 2,528

    /// Find the slot index for a given agent, or None if not present.
    pub fn find_agent_slot(&self, agent: &Pubkey) -> Option<usize> {
        let agent_bytes = agent.to_bytes();
        self.entries.iter().position(|e| e.agent == agent_bytes)
    }

    /// Claim an empty slot for a new agent. Returns the slot index, or None if full.
    /// An empty slot has agent == [0u8; 32].
    pub fn claim_slot(&mut self, agent: &Pubkey) -> Option<usize> {
        let zero = [0u8; 32];
        if let Some(idx) = self.entries.iter().position(|e| e.agent == zero) {
            self.entries[idx].agent = agent.to_bytes();
            // contributions and last_write_epoch are already zero-initialized
            Some(idx)
        } else {
            None
        }
    }

    /// Release a slot by zeroing the agent key, last_write_epoch, and all contribution buckets.
    /// Called when an agent is revoked to prevent slot leaks.
    pub fn release_slot(&mut self, slot_idx: usize) {
        if slot_idx >= MAX_OVERLAY_ENTRIES {
            return;
        }
        self.entries[slot_idx].agent = [0u8; 32];
        self.entries[slot_idx].last_write_epoch = 0;
        for i in 0..OVERLAY_NUM_EPOCHS {
            self.entries[slot_idx].contributions[i] = 0;
        }
        self.lifetime_spend[slot_idx] = 0;
        self.lifetime_tx_count[slot_idx] = 0;
    }

    /// Zero contribution buckets in the gap between last_write_epoch and current_epoch.
    /// Only zeroes buckets that have become stale — not the entire array.
    ///
    /// If the gap is >= OVERLAY_NUM_EPOCHS (24), all buckets are zeroed.
    /// Otherwise, only buckets from (last_write_epoch+1)..=current_epoch are zeroed (wrapping).
    fn zero_gap_buckets(&mut self, slot_idx: usize, current_epoch: i64) {
        let entry = &mut self.entries[slot_idx];
        let gap = current_epoch - entry.last_write_epoch;

        if gap <= 0 {
            // Same epoch or clock went backward — no zeroing needed
            return;
        }

        if gap >= OVERLAY_NUM_EPOCHS as i64 {
            // Entire window has expired — zero all buckets
            for i in 0..OVERLAY_NUM_EPOCHS {
                entry.contributions[i] = 0;
            }
        } else {
            // Zero only the gap buckets: (last_write_epoch+1)..=current_epoch
            for offset in 1..=gap {
                let epoch = entry.last_write_epoch + offset;
                let idx = (epoch % OVERLAY_NUM_EPOCHS as i64) as usize;
                entry.contributions[idx] = 0;
            }
        }
    }

    /// Get the rolling 24h USD spend for a specific agent, with boundary correction.
    ///
    /// Iterates backward from last_write_epoch, summing contributions within the
    /// 24h window. Uses proportional scaling for the boundary bucket (same math
    /// as the global SpendTracker).
    pub fn get_agent_rolling_24h_usd(&self, clock: &Clock, slot_idx: usize) -> u64 {
        if clock.unix_timestamp <= 0 || slot_idx >= MAX_OVERLAY_ENTRIES {
            return 0;
        }

        let current_epoch = clock.unix_timestamp / OVERLAY_EPOCH_DURATION;
        let entry = &self.entries[slot_idx];

        // If last write was more than 24 epochs ago, all data is expired
        if current_epoch - entry.last_write_epoch > OVERLAY_NUM_EPOCHS as i64 {
            return 0;
        }

        let window_start_ts = clock
            .unix_timestamp
            .saturating_sub(OVERLAY_ROLLING_WINDOW_SECONDS);
        let mut total: u128 = 0;

        // Iterate backward from last_write_epoch (most recent data)
        for k in 0..(OVERLAY_NUM_EPOCHS as i64) {
            let epoch_for_k = entry.last_write_epoch - k;
            if epoch_for_k < 0 {
                break;
            }

            let bucket_start = epoch_for_k * OVERLAY_EPOCH_DURATION;
            let bucket_end = bucket_start + OVERLAY_EPOCH_DURATION;

            // If this bucket ends before the window start, we're done (going backward)
            if bucket_end <= window_start_ts {
                break;
            }

            // If this bucket is in the future relative to current_epoch, skip it
            if epoch_for_k > current_epoch {
                continue;
            }

            let bucket_idx = (epoch_for_k % OVERLAY_NUM_EPOCHS as i64) as usize;
            let contribution = entry.contributions[bucket_idx];
            if contribution == 0 {
                continue;
            }

            if bucket_start >= window_start_ts {
                // Fully within window
                total = total.saturating_add(contribution as u128);
            } else {
                // Boundary bucket — proportional scaling
                let overlap = (bucket_end - window_start_ts) as u128;
                let scaled = (contribution as u128)
                    .saturating_mul(overlap)
                    .checked_div(OVERLAY_EPOCH_DURATION as u128)
                    .unwrap_or(0);
                total = total.saturating_add(scaled);
            }
        }

        if total > u64::MAX as u128 {
            u64::MAX
        } else {
            total as u64
        }
    }

    /// Record an agent's spend contribution in the current epoch.
    pub fn record_agent_contribution(
        &mut self,
        clock: &Clock,
        slot_idx: usize,
        usd_amount: u64,
    ) -> Result<()> {
        if slot_idx >= MAX_OVERLAY_ENTRIES {
            return Err(error!(SigilError::Overflow));
        }

        let current_epoch = clock.unix_timestamp / OVERLAY_EPOCH_DURATION;

        // Zero any gap buckets between last write and now
        self.zero_gap_buckets(slot_idx, current_epoch);

        let idx = (current_epoch % OVERLAY_NUM_EPOCHS as i64) as usize;

        // Add contribution
        self.entries[slot_idx].contributions[idx] = self.entries[slot_idx].contributions[idx]
            .checked_add(usd_amount)
            .ok_or(error!(SigilError::Overflow))?;

        // Update last_write_epoch
        self.entries[slot_idx].last_write_epoch = current_epoch;

        Ok(())
    }
}
