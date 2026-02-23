use anchor_lang::prelude::*;

use crate::errors::AgentShieldError;
use crate::oracle;
use crate::state::*;

/// Convert a token amount to USD value (6 decimals).
///
/// - Stablecoin: 1:1 USD conversion using token decimals
/// - Oracle-priced: reads Pyth or Switchboard feed from remaining_accounts
///
/// Fallback logic (when `fallback_feed != Pubkey::default()`):
/// 1. Try primary → if ok AND fallback available → cross-check divergence,
///    use higher price (conservative).
/// 2. If primary fails AND fallback available → use fallback.
/// 3. If both fail → `OracleBothFeedsFailed`.
///
/// Returns (usd_amount, oracle_price_option, oracle_source_option)
pub(crate) fn convert_to_usd(
    is_stablecoin: bool,
    oracle_feed: &Pubkey,
    fallback_feed: &Pubkey,
    token_decimals: u8,
    amount: u64,
    remaining_accounts: &[AccountInfo],
    clock: &Clock,
) -> Result<(u64, Option<i128>, Option<u8>)> {
    if is_stablecoin {
        // Stablecoin: 1:1 USD. Convert base units to USD (6 decimals).
        let usd = stablecoin_to_usd(amount, token_decimals)?;
        Ok((usd, None, None))
    } else {
        // Oracle-priced: read feed from remaining_accounts
        require!(
            !remaining_accounts.is_empty(),
            AgentShieldError::OracleAccountMissing
        );

        let has_fallback = *fallback_feed != Pubkey::default();

        // Try primary oracle
        let primary_result =
            oracle::parse_oracle_price(&remaining_accounts[0], oracle_feed, clock.slot);

        match primary_result {
            Ok((primary_adjusted, primary_midpoint, primary_source)) => {
                // Primary succeeded — check fallback for cross-validation
                if has_fallback && remaining_accounts.len() > 1 {
                    let fallback_result = oracle::parse_oracle_price(
                        &remaining_accounts[1],
                        fallback_feed,
                        clock.slot,
                    );
                    if let Ok((fb_adjusted, fb_midpoint, _)) = fallback_result {
                        // Both available: check divergence using MIDPOINTS.
                        // Midpoint-to-midpoint comparison avoids asymmetric
                        // confidence artifacts when mixing Pyth (price+conf)
                        // with Switchboard (bare median).
                        check_oracle_divergence(primary_midpoint, fb_midpoint)?;
                        // Use the HIGHER adjusted price (conservative for spending caps)
                        let mantissa = if primary_adjusted >= fb_adjusted {
                            primary_adjusted
                        } else {
                            fb_adjusted
                        };
                        let usd = oracle_price_to_usd(amount, mantissa, token_decimals)?;
                        return Ok((usd, Some(mantissa), Some(primary_source as u8)));
                    }
                    // Fallback failed: use primary only (ignore fallback failure)
                }
                let usd = oracle_price_to_usd(amount, primary_adjusted, token_decimals)?;
                Ok((usd, Some(primary_adjusted), Some(primary_source as u8)))
            }
            Err(primary_err) => {
                // Primary failed — try fallback
                if has_fallback && remaining_accounts.len() > 1 {
                    let fallback_result = oracle::parse_oracle_price(
                        &remaining_accounts[1],
                        fallback_feed,
                        clock.slot,
                    );
                    match fallback_result {
                        Ok((fb_adjusted, _, fb_source)) => {
                            let usd = oracle_price_to_usd(amount, fb_adjusted, token_decimals)?;
                            return Ok((usd, Some(fb_adjusted), Some(fb_source as u8)));
                        }
                        Err(_) => {
                            return Err(error!(AgentShieldError::OracleBothFeedsFailed));
                        }
                    }
                }
                // No fallback: propagate original error
                Err(primary_err)
            }
        }
    }
}

/// Check that two oracle midpoint prices do not diverge more than
/// MAX_ORACLE_DIVERGENCE_BPS.
/// Formula: |a - b| * 10000 / min(a, b) <= MAX_ORACLE_DIVERGENCE_BPS
///
/// Callers MUST pass midpoint prices (Pyth: raw price without conf,
/// Switchboard: median), NOT confidence-adjusted prices. This ensures
/// the divergence check measures actual oracle disagreement without
/// asymmetric confidence artifacts between oracle providers.
pub(crate) fn check_oracle_divergence(price_a: i128, price_b: i128) -> Result<()> {
    let diff = if price_a >= price_b {
        price_a
            .checked_sub(price_b)
            .ok_or(AgentShieldError::Overflow)?
    } else {
        price_b
            .checked_sub(price_a)
            .ok_or(AgentShieldError::Overflow)?
    };

    let min_price = if price_a <= price_b { price_a } else { price_b };

    require!(min_price > 0, AgentShieldError::OracleFeedInvalid);

    let divergence_bps = diff
        .checked_mul(10_000)
        .ok_or(AgentShieldError::Overflow)?
        .checked_div(min_price)
        .ok_or(AgentShieldError::Overflow)?;

    require!(
        divergence_bps <= MAX_ORACLE_DIVERGENCE_BPS as i128,
        AgentShieldError::OraclePriceDivergence
    );

    Ok(())
}

/// Convert stablecoin amount to USD (6 decimals).
/// usd = amount * 10^USD_DECIMALS / 10^token_decimals
pub(crate) fn stablecoin_to_usd(amount: u64, token_decimals: u8) -> Result<u64> {
    if token_decimals == USD_DECIMALS {
        // USDC/USDT (6 decimals) → direct 1:1
        Ok(amount)
    } else if token_decimals < USD_DECIMALS {
        // Fewer decimals than USD: multiply up
        let diff = USD_DECIMALS
            .checked_sub(token_decimals)
            .ok_or(AgentShieldError::Overflow)?;
        let multiplier = 10u64
            .checked_pow(diff as u32)
            .ok_or(AgentShieldError::Overflow)?;
        amount
            .checked_mul(multiplier)
            .ok_or(error!(AgentShieldError::Overflow))
    } else {
        // More decimals than USD: divide down
        let diff = token_decimals
            .checked_sub(USD_DECIMALS)
            .ok_or(AgentShieldError::Overflow)?;
        let divisor = 10u64
            .checked_pow(diff as u32)
            .ok_or(AgentShieldError::Overflow)?;
        amount
            .checked_div(divisor)
            .ok_or(error!(AgentShieldError::Overflow))
    }
}

/// Convert oracle-priced token amount to USD (6 decimals).
/// Both Pyth and Switchboard prices are normalized to 18 implicit
/// decimals. usd = amount * mantissa / 10^(token_decimals + 12)
///
/// The 12 comes from: 18 (oracle decimals) - 6 (USD decimals) = 12
pub(crate) fn oracle_price_to_usd(amount: u64, mantissa: i128, token_decimals: u8) -> Result<u64> {
    // Ensure positive price
    require!(mantissa > 0, AgentShieldError::OracleFeedInvalid);

    // Compute: amount * mantissa (in i128 to avoid overflow)
    let numerator = (amount as i128)
        .checked_mul(mantissa)
        .ok_or(AgentShieldError::Overflow)?;

    // Divisor = 10^(token_decimals + 12)
    let exponent = (token_decimals as u32)
        .checked_add(12)
        .ok_or(AgentShieldError::Overflow)?;
    let divisor = 10i128
        .checked_pow(exponent)
        .ok_or(AgentShieldError::Overflow)?;

    let usd_i128 = numerator
        .checked_div(divisor)
        .ok_or(AgentShieldError::Overflow)?;

    // Ensure result fits in u64
    require!(usd_i128 >= 0, AgentShieldError::OracleFeedInvalid);
    require!(usd_i128 <= u64::MAX as i128, AgentShieldError::Overflow);

    Ok(usd_i128 as u64)
}
