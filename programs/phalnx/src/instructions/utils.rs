use anchor_lang::prelude::*;

use crate::errors::PhalnxError;
use crate::state::*;

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
            .ok_or(PhalnxError::Overflow)?;
        let multiplier = 10u64
            .checked_pow(diff as u32)
            .ok_or(PhalnxError::Overflow)?;
        amount
            .checked_mul(multiplier)
            .ok_or(error!(PhalnxError::Overflow))
    } else {
        // More decimals than USD: divide down
        let diff = token_decimals
            .checked_sub(USD_DECIMALS)
            .ok_or(PhalnxError::Overflow)?;
        let divisor = 10u64
            .checked_pow(diff as u32)
            .ok_or(PhalnxError::Overflow)?;
        amount
            .checked_div(divisor)
            .ok_or(error!(PhalnxError::Overflow))
    }
}
