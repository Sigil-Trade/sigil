use anchor_lang::prelude::*;

use crate::errors::PhalnxError;

/// Flash Trade `openPosition` discriminator (from flash-sdk IDL v15.1.4).
/// sha256("global:open_position")[:8]
const OPEN_POSITION_DISC: [u8; 8] = [135, 128, 47, 77, 15, 152, 240, 49];

/// Flash Trade `closePosition` discriminator.
/// sha256("global:close_position")[:8]
const CLOSE_POSITION_DISC: [u8; 8] = [123, 134, 81, 0, 49, 68, 98, 98];

/// Flash Trade `increaseSize` discriminator.
/// sha256("global:increase_size")[:8]
const INCREASE_SIZE_DISC: [u8; 8] = [107, 13, 141, 238, 152, 165, 96, 87];

/// Flash Trade `decreaseSize` discriminator.
/// sha256("global:decrease_size")[:8]
const DECREASE_SIZE_DISC: [u8; 8] = [171, 28, 203, 29, 118, 16, 214, 169];

/// Flash Trade `addCollateral` discriminator.
/// sha256("global:add_collateral")[:8]
const ADD_COLLATERAL_DISC: [u8; 8] = [127, 82, 121, 42, 161, 176, 249, 206];

/// Flash Trade `removeCollateral` discriminator.
/// sha256("global:remove_collateral")[:8]
const REMOVE_COLLATERAL_DISC: [u8; 8] = [86, 222, 130, 86, 92, 20, 72, 65];

/// Verify a Flash Trade instruction is recognized and, for price-bearing
/// instructions, that priceWithSlippage.price > 0.
///
/// Price-bearing instructions (openPosition, closePosition, increaseSize,
/// decreaseSize) have layout:
///   discriminator (8) | priceWithSlippage.price (u64) | exponent (i32) | ...
///
/// Non-price instructions (addCollateral, removeCollateral) only need
/// discriminator validation — they don't carry a priceWithSlippage field.
pub fn verify_flash_trade_instruction(ix_data: &[u8]) -> Result<()> {
    require!(
        ix_data.len() >= 8,
        PhalnxError::InvalidFlashTradeInstruction
    );

    let disc = &ix_data[..8];

    // Non-price instructions: addCollateral, removeCollateral
    if disc == ADD_COLLATERAL_DISC || disc == REMOVE_COLLATERAL_DISC {
        return Ok(());
    }

    // Price-bearing instructions need minimum 20 bytes: 8 (disc) + 8 (price) + 4 (exponent)
    require!(
        ix_data.len() >= 20,
        PhalnxError::InvalidFlashTradeInstruction
    );

    let is_known = disc == OPEN_POSITION_DISC
        || disc == CLOSE_POSITION_DISC
        || disc == INCREASE_SIZE_DISC
        || disc == DECREASE_SIZE_DISC;
    require!(is_known, PhalnxError::InvalidFlashTradeInstruction);

    // Read priceWithSlippage.price (u64 at offset 8, after discriminator)
    let price_bytes: [u8; 8] = ix_data[8..16]
        .try_into()
        .map_err(|_| error!(PhalnxError::InvalidFlashTradeInstruction))?;
    let price = u64::from_le_bytes(price_bytes);

    require!(price > 0, PhalnxError::FlashTradePriceZero);

    Ok(())
}
