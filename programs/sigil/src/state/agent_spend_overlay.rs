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
/// Size calculation (PRE-TA-06):
///   8 (discriminator) + 32 (vault) + 232 × 10 (entries) + 1 (bump) + 7 (padding) + 80 (lifetime_spend) + 80 (lifetime_tx_count) = 2,528 bytes
/// Size calculation (POST-TA-06): +80 cooldown_seconds + 80 last_action_unix = 2,688 bytes
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

    /// TA-06 (Phase 3 pre-execution guard #3): per-agent cooldown in seconds.
    /// Index matches entries[i].
    ///
    /// Per-AGENT, not per-vault — a per-vault cooldown was rejected per F-16
    /// because one agent's traffic would DoS all other agents on the same
    /// vault. With per-agent cooldown, each agent has its own pacing limit
    /// configured by the owner.
    ///
    /// 0 = no cooldown (default). Owner configures via
    /// `queue_agent_permissions_update` (P3).
    ///
    /// Appended AFTER lifetime_spend/lifetime_tx_count to preserve existing
    /// zero-copy byte offsets per the established APPEND-ONLY pattern.
    pub cooldown_seconds: [u64; MAX_OVERLAY_ENTRIES], // 80 bytes

    /// TA-06 (Phase 3): per-agent last successful validate_and_authorize
    /// Unix timestamp. Index matches entries[i]. Written at the end of
    /// validate_and_authorize on a successful authorization. The cooldown
    /// gate compares `(now - last_action_unix) >= cooldown_seconds[i]`.
    ///
    /// 0 = no prior action recorded (first authorization for this agent
    /// after registration / overlay reset). The cooldown check uses
    /// `i64::checked_sub` and treats a 0 baseline as "no previous action"
    /// → cooldown auto-passes.
    ///
    /// Appended AFTER cooldown_seconds to preserve zero-copy byte offsets.
    pub last_action_unix: [i64; MAX_OVERLAY_ENTRIES], // 80 bytes
}
// Total data (post-TA-06): 2,360 + 80 + 80 + 80 + 80 = 2,680 bytes
// Total account size: 2,680 + 8 (discriminator) = 2,688 bytes

impl AgentSpendOverlay {
    /// Total account size including 8-byte discriminator.
    /// TA-06 grew the overlay by 160 bytes (+80 cooldown_seconds, +80
    /// last_action_unix); new SIZE = 2,688 (was 2,528 pre-Phase-3).
    pub const SIZE: usize = 8
        + 32
        + (232 * MAX_OVERLAY_ENTRIES)
        + 1
        + 7
        + (8 * MAX_OVERLAY_ENTRIES) // lifetime_spend
        + (8 * MAX_OVERLAY_ENTRIES) // lifetime_tx_count
        + (8 * MAX_OVERLAY_ENTRIES) // cooldown_seconds [TA-06]
        + (8 * MAX_OVERLAY_ENTRIES); // last_action_unix [TA-06]
                                     // = 8 + 32 + 2320 + 1 + 7 + 80 + 80 + 80 + 80 = 2,688

    // LM-1 (Bucket-3 audit 2026-05-23): compile-time pin against silent
    // drift of the documented byte baseline. Any field addition that does
    // not also update this assert breaks the build. Mirrors the §RP-1
    // pattern used by PendingOwnershipTransfer + PendingAgentGrant.
    const _AGENT_SPEND_OVERLAY_SIZE_PIN: () = assert!(
        AgentSpendOverlay::SIZE == 2_688,
        "AgentSpendOverlay::SIZE drifted from documented baseline"
    );

    /// Find the slot index for a given agent, or None if not present.
    pub fn find_agent_slot(&self, agent: &Pubkey) -> Option<usize> {
        let agent_bytes = agent.to_bytes();
        self.entries.iter().position(|e| e.agent == agent_bytes)
    }

    /// Return the `AgentContributionEntry` for the given agent, or None
    /// if not present. Convenience wrapper around `find_agent_slot()` for
    /// read paths that want the entry struct rather than the slot index.
    ///
    /// Bounded by `MAX_OVERLAY_ENTRIES` (10) via `find_agent_slot`.
    /// Mutation paths must NOT go through this helper — `&self` here
    /// would silently re-borrow at the call site. Use `find_agent_slot`
    /// + direct `self.entries[idx]` indexing for any write path.
    pub fn get_agent_entry(&self, agent: &Pubkey) -> Option<&AgentContributionEntry> {
        self.find_agent_slot(agent).map(|i| &self.entries[i])
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
        // TA-06 (Phase 3): clear cooldown state on revoke so a re-registered
        // agent starts with a clean baseline. Owner must reconfigure cooldown
        // via queue_agent_permissions_update on re-registration.
        self.cooldown_seconds[slot_idx] = 0;
        self.last_action_unix[slot_idx] = 0;
    }

    /// Zero contribution buckets in the gap between last_write_epoch and current_epoch.
    /// Only zeroes buckets that have become stale — not the entire array.
    ///
    /// If the gap is >= OVERLAY_NUM_EPOCHS (24), all buckets are zeroed.
    /// Otherwise, only buckets from (last_write_epoch+1)..=current_epoch are zeroed (wrapping).
    fn zero_gap_buckets(&mut self, slot_idx: usize, current_epoch: i64) {
        let entry = &mut self.entries[slot_idx];
        // saturating_sub fail-closes on clock skew (would otherwise panic
        // under release-mode overflow-checks=true). On skew the saturated
        // result is 0 → `gap <= 0` short-circuit below preserves the
        // existing "no zeroing" behaviour.
        let gap = current_epoch.saturating_sub(entry.last_write_epoch);

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

        // If last write was more than 24 epochs ago, all data is expired.
        // saturating_sub fail-closes on clock skew (would otherwise panic
        // under release-mode overflow-checks=true).
        if current_epoch.saturating_sub(entry.last_write_epoch) > OVERLAY_NUM_EPOCHS as i64 {
            return 0;
        }

        let window_start_ts = clock
            .unix_timestamp
            .saturating_sub(OVERLAY_ROLLING_WINDOW_SECONDS);
        let mut total: u128 = 0;

        // Iterate backward from last_write_epoch (most recent data).
        // saturating_sub fail-closes on overflow (would otherwise panic
        // under release-mode overflow-checks=true). When k > last_write_epoch
        // the result saturates to 0; the bucket_end<=window_start_ts break
        // below catches the next iteration. The `epoch_for_k < 0` guard
        // remains as defense-in-depth.
        for k in 0..(OVERLAY_NUM_EPOCHS as i64) {
            let epoch_for_k = entry.last_write_epoch.saturating_sub(k);
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
                // Boundary bucket — proportional scaling.
                // saturating_sub fail-closes on clock skew (would otherwise
                // panic under release-mode overflow-checks=true). The
                // `bucket_end <= window_start_ts` guard above ensures
                // bucket_end > window_start_ts in legitimate flows.
                let overlap = bucket_end.saturating_sub(window_start_ts) as u128;
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

    /// TA-06 (Phase 3 pre-execution guard #3): is the agent's cooldown
    /// elapsed at `now`?
    ///
    /// Returns `true` if the agent at `slot_idx` may proceed (cooldown
    /// elapsed OR no cooldown configured OR no prior action). Returns
    /// `false` if the agent is still within its cooldown window.
    ///
    /// `cooldown_seconds[slot_idx] == 0` means "no cooldown" — auto-pass.
    /// `last_action_unix[slot_idx] == 0` means "no prior action recorded" —
    /// also auto-pass (fresh agent or post-revoke re-register).
    ///
    /// Defense-in-depth: uses `checked_sub` so a clock that runs backward
    /// produces a `None` (treated as "not elapsed", fail closed).
    pub fn is_cooldown_elapsed(&self, slot_idx: usize, now: i64) -> bool {
        if slot_idx >= MAX_OVERLAY_ENTRIES {
            return false; // defensive: out-of-bounds slot, fail closed
        }
        let cooldown = self.cooldown_seconds[slot_idx];
        if cooldown == 0 {
            return true; // no cooldown configured → auto-pass
        }
        let last = self.last_action_unix[slot_idx];
        if last == 0 {
            return true; // no prior action → auto-pass
        }
        // checked_sub guards against clock skew producing a negative delta.
        match now.checked_sub(last) {
            Some(delta) if delta >= 0 => (delta as u64) >= cooldown,
            _ => false, // fail closed on clock skew / overflow
        }
    }

    /// TA-06: record a successful action timestamp for the agent at
    /// `slot_idx`. Called from validate_and_authorize on a successful
    /// authorization after all other guards pass.
    pub fn record_action_unix(&mut self, slot_idx: usize, now: i64) -> Result<()> {
        if slot_idx >= MAX_OVERLAY_ENTRIES {
            return Err(error!(SigilError::Overflow));
        }
        self.last_action_unix[slot_idx] = now;
        Ok(())
    }

    /// TA-06: set the per-agent cooldown in seconds. 0 disables. Called
    /// from `queue_agent_permissions_update`/`apply_*` (P3).
    pub fn set_cooldown_seconds(&mut self, slot_idx: usize, cooldown: u64) -> Result<()> {
        if slot_idx >= MAX_OVERLAY_ENTRIES {
            return Err(error!(SigilError::Overflow));
        }
        self.cooldown_seconds[slot_idx] = cooldown;
        Ok(())
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

#[cfg(test)]
mod ta06_cooldown_tests {
    use super::*;

    fn zeroed_overlay() -> AgentSpendOverlay {
        // SAFETY: AgentSpendOverlay is #[account(zero_copy)] = #[repr(C)] +
        // Pod. All fields are integer arrays / fixed-size byte arrays.
        // The standard `bytemuck::Zeroable` pattern via unsafe std::mem::zeroed
        // produces a valid all-zero instance — same path the loader uses on
        // a freshly-allocated PDA.
        unsafe { core::mem::zeroed() }
    }

    /// TA-06: cooldown_seconds = 0 means "no cooldown" — auto-pass.
    #[test]
    fn cooldown_zero_means_no_gate() {
        let mut o = zeroed_overlay();
        o.cooldown_seconds[0] = 0;
        o.last_action_unix[0] = 100;
        assert!(
            o.is_cooldown_elapsed(0, 101),
            "cooldown=0 must auto-pass even 1s after last action"
        );
    }

    /// TA-06: no prior action (last_action_unix = 0) auto-passes even with
    /// configured cooldown. First action after registration is always allowed.
    #[test]
    fn cooldown_no_prior_action_passes() {
        let mut o = zeroed_overlay();
        o.cooldown_seconds[0] = 3600;
        o.last_action_unix[0] = 0;
        assert!(
            o.is_cooldown_elapsed(0, 100),
            "no prior action (last=0) must auto-pass"
        );
    }

    /// TA-06: action within cooldown window — REJECT.
    #[test]
    fn cooldown_within_window_rejects() {
        let mut o = zeroed_overlay();
        o.cooldown_seconds[0] = 3600;
        o.last_action_unix[0] = 1000;
        // 1000 + 59m = 4540 < 1000 + 3600 = 4600 → REJECT
        assert!(
            !o.is_cooldown_elapsed(0, 4540),
            "59 minutes after action with 60-min cooldown must reject"
        );
    }

    /// TA-06: action exactly at cooldown boundary — ACCEPT (>= semantics).
    #[test]
    fn cooldown_at_boundary_accepts() {
        let mut o = zeroed_overlay();
        o.cooldown_seconds[0] = 3600;
        o.last_action_unix[0] = 1000;
        // Exactly 3600 seconds elapsed — >=, so ACCEPT
        assert!(
            o.is_cooldown_elapsed(0, 4600),
            "exactly at cooldown boundary must accept (>=)"
        );
    }

    /// TA-06: action well after cooldown — ACCEPT.
    #[test]
    fn cooldown_well_past_accepts() {
        let mut o = zeroed_overlay();
        o.cooldown_seconds[0] = 60;
        o.last_action_unix[0] = 1000;
        assert!(
            o.is_cooldown_elapsed(0, 5000),
            "well past cooldown must accept"
        );
    }

    /// TA-06: clock running backward must fail closed.
    #[test]
    fn cooldown_clock_backward_fails_closed() {
        let mut o = zeroed_overlay();
        o.cooldown_seconds[0] = 60;
        o.last_action_unix[0] = 1000;
        assert!(
            !o.is_cooldown_elapsed(0, 500),
            "clock backward (now < last) must fail closed"
        );
    }

    /// TA-06 (F-16): cooldown is per-AGENT. One agent's last_action does
    /// not gate another agent on the same vault.
    #[test]
    fn cooldown_is_per_agent_not_per_vault() {
        let mut o = zeroed_overlay();
        // Agent 0: just used, in cooldown
        o.cooldown_seconds[0] = 3600;
        o.last_action_unix[0] = 1000;
        // Agent 1: never used, cooldown configured
        o.cooldown_seconds[1] = 3600;
        o.last_action_unix[1] = 0;
        // Agent 2: well past cooldown
        o.cooldown_seconds[2] = 60;
        o.last_action_unix[2] = 100;

        let now = 1500;
        assert!(!o.is_cooldown_elapsed(0, now), "agent 0 should be gated");
        assert!(
            o.is_cooldown_elapsed(1, now),
            "agent 1 must NOT be gated by agent 0's last action"
        );
        assert!(o.is_cooldown_elapsed(2, now), "agent 2 must pass");
    }

    /// TA-06: out-of-bounds slot returns false (fail closed).
    #[test]
    fn cooldown_out_of_bounds_fails_closed() {
        let o = zeroed_overlay();
        assert!(
            !o.is_cooldown_elapsed(MAX_OVERLAY_ENTRIES, 100),
            "OOB slot must fail closed"
        );
    }

    /// TA-06: release_slot clears cooldown fields so re-registration
    /// starts with a clean baseline.
    #[test]
    fn cooldown_release_slot_clears_fields() {
        let mut o = zeroed_overlay();
        o.cooldown_seconds[3] = 3600;
        o.last_action_unix[3] = 12345;
        o.release_slot(3);
        assert_eq!(o.cooldown_seconds[3], 0, "release must zero cooldown");
        assert_eq!(o.last_action_unix[3], 0, "release must zero last_action");
    }

    /// `find_agent_slot` returns the position of the agent if registered,
    /// None otherwise. Equivalent to manual `.entries.iter().position()`
    /// but bounded by MAX_OVERLAY_ENTRIES and the canonical lookup.
    #[test]
    fn find_agent_slot_returns_correct_index() {
        let mut o = zeroed_overlay();
        let agent_a = Pubkey::new_unique();
        let agent_b = Pubkey::new_unique();
        let unknown = Pubkey::new_unique();

        o.entries[2].agent = agent_a.to_bytes();
        o.entries[5].agent = agent_b.to_bytes();

        assert_eq!(o.find_agent_slot(&agent_a), Some(2));
        assert_eq!(o.find_agent_slot(&agent_b), Some(5));
        assert_eq!(o.find_agent_slot(&unknown), None);
    }

    /// `get_agent_entry` returns the entry struct for a registered agent,
    /// preserving the fields the inner iteration would have exposed.
    #[test]
    fn get_agent_entry_returns_struct_for_registered_agent() {
        let mut o = zeroed_overlay();
        let agent = Pubkey::new_unique();
        o.entries[4].agent = agent.to_bytes();
        o.entries[4].last_write_epoch = 12345;
        o.entries[4].contributions[7] = 999;

        let entry = o.get_agent_entry(&agent).expect("entry must be present");
        assert_eq!(entry.agent, agent.to_bytes(), "agent key matches");
        assert_eq!(entry.last_write_epoch, 12345, "last_write_epoch matches");
        assert_eq!(entry.contributions[7], 999, "contribution preserved");
    }

    /// `get_agent_entry` returns None for an unregistered agent — does
    /// not fall back to an arbitrary zeroed slot.
    #[test]
    fn get_agent_entry_returns_none_for_unknown_agent() {
        let o = zeroed_overlay();
        let unknown = Pubkey::new_unique();
        assert!(
            o.get_agent_entry(&unknown).is_none(),
            "unknown agent must return None, not slot 0"
        );
    }
}
