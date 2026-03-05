//! Oracle price parsing for Pyth and Switchboard.
//!
//! Supports two oracle types, detected at runtime by account owner:
//!   - **Pyth Receiver** (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`):
//!     PriceUpdateV2 manual byte parsing.
//!   - **Switchboard On-Demand** (`SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv`):
//!     PullFeed manual byte parsing (submissions array + median).
//!
//! Both parsers return an i128 mantissa with 18 implicit decimals so that
//! `oracle_price_to_usd()` in validate_and_authorize works unchanged.
//!
//! No external crate dependencies — all byte layouts are inlined.

use anchor_lang::prelude::*;

use crate::errors::AgentShieldError;
use crate::state::{
    ADAPTIVE_CONF_MULTIPLIER, MAX_CONF_CAP_BPS, MAX_ORACLE_STALE_SLOTS, MIN_ADAPTIVE_CONF_BPS,
    MIN_ORACLE_SAMPLES, ORACLE_SAFETY_VALVE_BPS, PYTH_RECEIVER_PROGRAM,
    SWITCHBOARD_ON_DEMAND_PROGRAM,
};

// ─── Oracle source enum ─────────────────────────────────────────────────────

/// Identifies which oracle provided the price.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OracleSource {
    Pyth = 0,
    Switchboard = 1,
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/// Parse an oracle price from the provided account, auto-detecting the
/// oracle type by checking the account owner program.
///
/// Returns `(adjusted_price, midpoint, OracleSource)` where:
/// - `adjusted_price`: conservative upper-bound price for USD conversion
///   (Pyth: price+conf, Switchboard: median — no spread adjustment)
/// - `midpoint`: raw midpoint price for cross-oracle divergence checks
///   (Pyth: price without conf, Switchboard: median)
///
/// Both values are i128 mantissas with 18 implicit decimals.
///
/// The separation prevents asymmetric confidence from corrupting
/// cross-oracle divergence checks. When Pyth (price+conf) is compared
/// against Switchboard (median), the confidence band creates false
/// divergence of ~1-5%. By comparing midpoint-to-midpoint, the
/// divergence check measures actual oracle disagreement.
pub fn parse_oracle_price(
    account_info: &AccountInfo,
    expected_feed: &Pubkey,
    current_slot: u64,
) -> Result<(i128, i128, OracleSource)> {
    if *account_info.owner == PYTH_RECEIVER_PROGRAM {
        let (adjusted, midpoint) = parse_pyth_price(account_info, expected_feed, current_slot)?;
        Ok((adjusted, midpoint, OracleSource::Pyth))
    } else if *account_info.owner == SWITCHBOARD_ON_DEMAND_PROGRAM {
        let price = parse_switchboard_price(
            account_info,
            expected_feed,
            MAX_ORACLE_STALE_SLOTS as u64,
            MIN_ORACLE_SAMPLES,
            current_slot,
        )?;
        // Switchboard: median IS the midpoint; no confidence adjustment
        Ok((price, price, OracleSource::Switchboard))
    } else {
        Err(error!(AgentShieldError::OracleUnsupportedType))
    }
}

// ─── Pyth PriceUpdateV2 parsing ──────────────────────────────────────────────
//
// Borsh-serialized layout (no alignment padding):
//
//   Offset   0: discriminator      [8 bytes]
//   Offset   8: write_authority     [32 bytes]  (Pubkey)
//   Offset  40: verification_level  [1 byte]    (0=Partial, 1=Full; Borsh enum, variable-width)
//   Offset  41: feed_id             [32 bytes]
//   Offset  73: price               [8 bytes]   (i64, LE)
//   Offset  81: conf                [8 bytes]   (u64, LE)
//   Offset  89: exponent            [4 bytes]   (i32, LE)
//   Offset  93: publish_time        [8 bytes]   (i64, LE — unix seconds)
//   Offset 101: prev_publish_time   [8 bytes]
//   Offset 109: ema_price           [8 bytes]
//   Offset 117: ema_conf            [8 bytes]
//   Offset 125: posted_slot         [8 bytes]
//   Total: 133 bytes minimum

const PYTH_MIN_SIZE: usize = 133;

/// Anchor discriminator for PriceUpdateV2: sha256("account:PriceUpdateV2")[..8]
/// Verified against mainnet Pyth accounts.
const PYTH_PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

const PYTH_VERIFICATION_OFFSET: usize = 40;
const PYTH_PRICE_OFFSET: usize = 73;
const PYTH_CONF_OFFSET: usize = 81;
const PYTH_EXPONENT_OFFSET: usize = 89;
const PYTH_EMA_PRICE_OFFSET: usize = 109;
const PYTH_EMA_CONF_OFFSET: usize = 117;
const PYTH_POSTED_SLOT_OFFSET: usize = 125;

/// Parse a Pyth PriceUpdateV2 account and return `(adjusted, midpoint)`
/// as i128 mantissas with 18 implicit decimals.
///
/// - `adjusted`: `(max(spot, ema) + capped_conf) * 10^(18+exp)` —
///   conservative upper bound for USD conversion. Uses hybrid base price
///   (max of spot and EMA) with confidence capped at 2% of base.
/// - `midpoint`: `spot_price * 10^(18+exp)` — raw midpoint for cross-oracle
///   divergence checks (comparing midpoint-to-midpoint avoids asymmetric
///   confidence artifacts between Pyth and Switchboard).
///
/// # Security
/// - Account key must match `expected_feed`
/// - Account owner must be PYTH_RECEIVER_PROGRAM (checked by dispatcher)
/// - Verification level must be Full (1) — Wormhole-verified
/// - Staleness: `posted_slot` must be within `MAX_ORACLE_STALE_SLOTS`
/// - Safety valve: spot conf/price > 20% rejects (broken feed)
/// - Confidence capped at 2% of base price (bounds overcount)
/// - EMA provides price floor during crashes (safe direction)
/// - Price and EMA must be positive
fn parse_pyth_price(
    account_info: &AccountInfo,
    expected_feed: &Pubkey,
    current_slot: u64,
) -> Result<(i128, i128)> {
    // 1. Key must match expected feed
    require!(
        account_info.key() == *expected_feed,
        AgentShieldError::OracleFeedInvalid
    );

    let data = account_info.try_borrow_data()?;

    // 2. Discriminator + size validation
    require!(
        data.len() >= PYTH_MIN_SIZE,
        AgentShieldError::OracleFeedInvalid
    );
    require!(
        data[..8] == PYTH_PRICE_UPDATE_V2_DISCRIMINATOR,
        AgentShieldError::OracleFeedInvalid
    );

    // 3. Verification level must be Full (1)
    let verification_level = data[PYTH_VERIFICATION_OFFSET];
    require!(verification_level == 1, AgentShieldError::OracleNotVerified);

    // 4. Read price fields
    let price = i64::from_le_bytes(
        data[PYTH_PRICE_OFFSET..PYTH_PRICE_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?,
    );
    let conf = u64::from_le_bytes(
        data[PYTH_CONF_OFFSET..PYTH_CONF_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?,
    );
    let exponent = i32::from_le_bytes(
        data[PYTH_EXPONENT_OFFSET..PYTH_EXPONENT_OFFSET + 4]
            .try_into()
            .map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?,
    );
    let posted_slot = u64::from_le_bytes(
        data[PYTH_POSTED_SLOT_OFFSET..PYTH_POSTED_SLOT_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?,
    );

    // 5. Staleness check (slot-based, same as Switchboard)
    let min_slot = current_slot.saturating_sub(MAX_ORACLE_STALE_SLOTS as u64);
    require!(posted_slot >= min_slot, AgentShieldError::OracleFeedStale);

    // 6. Price must be positive
    require!(price > 0, AgentShieldError::OracleFeedInvalid);

    // 7. Safety valve: reject if spot confidence is extremely wide (broken
    //    feed). 20% threshold catches genuinely broken feeds without
    //    blocking meme coins during normal volatility (BONK routinely
    //    spikes to 6%+ conf).
    let conf_ratio = (conf as u128)
        .checked_mul(10_000)
        .ok_or(AgentShieldError::Overflow)?
        .checked_div(price as u128)
        .ok_or(AgentShieldError::Overflow)?;
    require!(
        conf_ratio <= ORACLE_SAFETY_VALVE_BPS as u128,
        AgentShieldError::OracleConfidenceTooWide
    );

    // 8. Read EMA fields for hybrid pricing.
    //    EMA is a 1-hour inverse-confidence-weighted moving average
    //    computed by the Pyth oracle program. We use it as a conservative
    //    price floor, NOT as the primary price (EMA lags during pumps).
    let ema_price = i64::from_le_bytes(
        data[PYTH_EMA_PRICE_OFFSET..PYTH_EMA_PRICE_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?,
    );
    let ema_conf = u64::from_le_bytes(
        data[PYTH_EMA_CONF_OFFSET..PYTH_EMA_CONF_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?,
    );

    // EMA must be positive (zero on brand-new feeds before first cycle)
    require!(ema_price > 0, AgentShieldError::OracleFeedInvalid);

    // 8a. Adaptive confidence gate: spot_conf must be ≤ 5 × ema_conf.
    //     Auto-calibrates per-token: SOL (ema_conf ~0.1%) blocks at
    //     0.5%, BONK (ema_conf ~3%) blocks at 15%. The floor prevents
    //     ema_conf=0 (very stable or new feeds) from blocking all trades.
    let price_u64 =
        u64::try_from(price).map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?;

    let adaptive_from_ema = ema_conf
        .checked_mul(ADAPTIVE_CONF_MULTIPLIER)
        .ok_or(AgentShieldError::Overflow)?;
    let min_adaptive = price_u64
        .checked_mul(MIN_ADAPTIVE_CONF_BPS)
        .ok_or(AgentShieldError::Overflow)?
        .checked_div(10_000)
        .ok_or(AgentShieldError::Overflow)?;
    let adaptive_threshold = adaptive_from_ema.max(min_adaptive);
    require!(
        conf <= adaptive_threshold,
        AgentShieldError::OracleConfidenceSpike
    );

    // 9. Hybrid base price: max(spot, ema).
    //    Pump: spot > ema → uses spot (accurate, no EMA lag attack).
    //    Crash: ema > spot → uses ema (overcounts — safe for spending caps).
    //    max(spot, ema) ≥ spot ALWAYS — the spending cap is never breached
    //    in real USD terms in any market direction.
    let base_price = if price >= ema_price { price } else { ema_price };
    let base_price_u64 =
        u64::try_from(base_price).map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?;

    // 10. Cap spot confidence at MAX_CONF_CAP_BPS (2%) of base price.
    //     Uses spot_conf (real-time uncertainty), not ema_conf (lagged).
    //     Bounds overcount: BONK with 6% conf → capped to 2%, trade
    //     proceeds. SOL with 0.1% conf → actual 0.1%, no waste.
    let max_conf = base_price_u64
        .checked_mul(MAX_CONF_CAP_BPS)
        .ok_or(AgentShieldError::Overflow)?
        .checked_div(10_000)
        .ok_or(AgentShieldError::Overflow)?;
    let capped_conf = conf.min(max_conf);

    // 11. Adjusted price = base + capped confidence (conservative upper
    //     bound). Under Pyth's Laplace model, 1x conf ≈ 82% one-sided
    //     coverage — deliberate tradeoff for spending caps.
    let adjusted_price = (base_price as i128)
        .checked_add(capped_conf as i128)
        .ok_or(AgentShieldError::Overflow)?;

    // 12. Normalize to i128 with 18 implicit decimals.
    //     Pyth: price_value * 10^exponent = USD price.
    //     Normalized: price_value * 10^(18 + exponent).
    //     exponent is typically -8, so 10^(18 + (-8)) = 10^10.
    let norm_exp = 18i32
        .checked_add(exponent)
        .ok_or(AgentShieldError::Overflow)?;
    require!(norm_exp >= 0, AgentShieldError::OracleFeedInvalid);

    let multiplier = 10i128
        .checked_pow(norm_exp as u32)
        .ok_or(AgentShieldError::Overflow)?;

    let normalized_adjusted = adjusted_price
        .checked_mul(multiplier)
        .ok_or(AgentShieldError::Overflow)?;
    let normalized_midpoint = (price as i128)
        .checked_mul(multiplier)
        .ok_or(AgentShieldError::Overflow)?;

    require!(normalized_adjusted > 0, AgentShieldError::OracleFeedInvalid);
    require!(normalized_midpoint > 0, AgentShieldError::OracleFeedInvalid);

    Ok((normalized_adjusted, normalized_midpoint))
}

// ─── Switchboard PullFeed parsing ────────────────────────────────────────────
//
// Layout reference: switchboard-on-demand v0.11.3, `#[repr(C)]` on SBF
// (max alignment = 8 bytes):
//
//   OracleSubmission (64 bytes, stride 64):
//     offset  0: oracle    (Pubkey, 32 bytes)
//     offset 32: slot      (u64, 8 bytes)
//     offset 40: landed_at (u64, 8 bytes)
//     offset 48: value     (i128, 16 bytes — price with 18 implicit decimals)

/// Number of oracle submissions in a PullFeed account
const SUBMISSION_COUNT: usize = 32;

/// Byte size of one OracleSubmission (repr(C) on SBF)
const SUBMISSION_STRIDE: usize = 64;

/// Byte offset of `slot` (u64) within an OracleSubmission
const SUBMISSION_SLOT_OFFSET: usize = 32;

/// Byte offset of `value` (i128) within an OracleSubmission
const SUBMISSION_VALUE_OFFSET: usize = 48;

/// Byte offset of `oracle` (Pubkey) within an OracleSubmission
const SUBMISSION_ORACLE_OFFSET: usize = 0;

/// Size of the Anchor discriminator
const DISCRIMINATOR_SIZE: usize = 8;

/// Minimum account data size: discriminator + 32 submissions
const MIN_PULL_FEED_SIZE: usize = DISCRIMINATOR_SIZE + SUBMISSION_COUNT * SUBMISSION_STRIDE;

/// Parse a Switchboard PullFeed account and return the median price
/// as an i128 mantissa with 18 implicit decimals.
///
/// NOTE: Switchboard returns the bare median (no confidence adjustment).
/// This is intentional — Switchboard's security model relies on median
/// robustness, not confidence bands. For conservative spending cap
/// enforcement, pair Switchboard with a Pyth fallback; the max-price
/// selection in convert_to_usd() provides the upward adjustment.
///
/// # Security
/// - `expected_feed`: must match account key (set by vault owner in PolicyConfig)
/// - Staleness: submissions older than `max_stale_slots` are ignored
/// - Minimum samples: at least `min_samples` valid submissions required
/// - Positive price: median must be > 0
pub fn parse_switchboard_price(
    account_info: &AccountInfo,
    expected_feed: &Pubkey,
    max_stale_slots: u64,
    min_samples: u32,
    current_slot: u64,
) -> Result<i128> {
    // 1. Validate account key matches the oracle_feed stored in PolicyConfig
    require!(
        account_info.key() == *expected_feed,
        AgentShieldError::OracleFeedInvalid
    );

    let data = account_info.try_borrow_data()?;

    // 2. Validate minimum size
    require!(
        data.len() >= MIN_PULL_FEED_SIZE,
        AgentShieldError::OracleFeedInvalid
    );

    // 3. Read valid submissions into a fixed-size buffer
    let mut values = [0i128; SUBMISSION_COUNT];
    let mut count: usize = 0;
    let min_slot = current_slot.saturating_sub(max_stale_slots);

    for i in 0..SUBMISSION_COUNT {
        let base = DISCRIMINATOR_SIZE + i * SUBMISSION_STRIDE;

        // Skip empty submission slots (oracle pubkey is all zeros)
        let oracle_end = base + SUBMISSION_ORACLE_OFFSET + 32;
        if data[base..oracle_end].iter().all(|&b| b == 0) {
            continue;
        }

        // Read slot (u64, little-endian)
        let slot_start = base + SUBMISSION_SLOT_OFFSET;
        let slot = u64::from_le_bytes(
            data[slot_start..slot_start + 8]
                .try_into()
                .map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?,
        );

        // Read value (i128, little-endian)
        let value_start = base + SUBMISSION_VALUE_OFFSET;
        let value = i128::from_le_bytes(
            data[value_start..value_start + 16]
                .try_into()
                .map_err(|_| error!(AgentShieldError::OracleFeedInvalid))?,
        );

        // Filter: must be recent slot AND positive value
        if slot >= min_slot && value > 0 {
            values[count] = value;
            count += 1;
        }
    }

    // 4. Minimum samples check
    require!(
        count as u32 >= min_samples,
        AgentShieldError::OracleFeedStale
    );

    // 5. Sort valid values and compute median
    let valid = &mut values[..count];
    valid.sort_unstable();

    let mid = count / 2;
    let median = if count % 2 == 0 && count > 1 {
        // Even number of samples: average the two middle values
        valid[mid - 1]
            .checked_add(valid[mid])
            .ok_or(AgentShieldError::Overflow)?
            .checked_div(2)
            .ok_or(AgentShieldError::Overflow)?
    } else {
        valid[mid]
    };

    // 6. Final sanity: price must be positive
    require!(median > 0, AgentShieldError::OracleFeedInvalid);

    Ok(median)
}
