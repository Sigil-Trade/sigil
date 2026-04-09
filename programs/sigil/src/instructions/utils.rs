use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::state::*;

/// Reject CPI calls — only top-level transaction instructions allowed.
///
/// Fix for docs/SECURITY-FINDINGS-2026-04-07.md Finding 3 (A9). Use at
/// the top of every state-mutating instruction handler to prevent
/// re-entry via a compromised whitelisted program. Without this guard,
/// an attacker who gains control of a whitelisted DeFi program can CPI
/// into Sigil handlers (withdraw_funds, apply_pending_policy, etc.)
/// using a signer that the owner already authorized for a different
/// action in the outer transaction — the classic inverse-attack vector.
///
/// The CPI guard on `validate_and_authorize` alone does NOT close this
/// — it only prevents the sandwich entry instruction itself from being
/// nested. Re-entry into any other state-mutating handler bypasses it
/// unless that handler has its own guard.
///
/// Fully-qualified paths so handlers don't need to import
/// `get_stack_height`, `TRANSACTION_LEVEL_STACK_HEIGHT`, or
/// `SigilError` just to use the macro.
///
/// Usage:
/// ```ignore
/// pub fn handler(ctx: Context<...>, ...) -> Result<()> {
///     crate::reject_cpi!();
///     // ... rest of handler
/// }
/// ```
#[macro_export]
macro_rules! reject_cpi {
    () => {
        anchor_lang::prelude::require!(
            anchor_lang::solana_program::instruction::get_stack_height()
                == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
            $crate::errors::SigilError::CpiCallNotAllowed
        )
    };
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
            .ok_or(SigilError::Overflow)?;
        let multiplier = 10u64.checked_pow(diff as u32).ok_or(SigilError::Overflow)?;
        amount
            .checked_mul(multiplier)
            .ok_or(error!(SigilError::Overflow))
    } else {
        // More decimals than USD: divide down
        let diff = token_decimals
            .checked_sub(USD_DECIMALS)
            .ok_or(SigilError::Overflow)?;
        let divisor = 10u64.checked_pow(diff as u32).ok_or(SigilError::Overflow)?;
        amount
            .checked_div(divisor)
            .ok_or(error!(SigilError::Overflow))
    }
}
