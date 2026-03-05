use anchor_lang::prelude::*;

use crate::errors::PhalnxError;

/// Minimum instruction data size for Jupiter Lend operations.
/// Every valid instruction has at least an 8-byte discriminator.
const MIN_LEND_IX_DATA: usize = 8;

/// Verify Jupiter Lend instruction data is well-formed.
///
/// Jupiter Lend deposit/withdraw instructions are built by the Jupiter
/// Lend API and target the Earn/Lend program. The Lend program itself
/// enforces deposit/withdraw constraints. This guard validates that the
/// instruction data is at minimum structurally valid (has a discriminator).
///
/// Protocol allowlist + ActionType (Deposit/Withdraw) + spending cap
/// enforcement in validate_and_authorize provide the primary security layer.
pub fn verify_jupiter_lend_instruction(ix_data: &[u8]) -> Result<()> {
    require!(
        ix_data.len() >= MIN_LEND_IX_DATA,
        PhalnxError::InvalidJupiterLendInstruction
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_lend_instruction_with_discriminator() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8]; // 8 bytes (minimum)
        let result = verify_jupiter_lend_instruction(&data);
        assert!(result.is_ok());
    }

    #[test]
    fn valid_lend_instruction_with_extra_data() {
        let data = vec![0u8; 64]; // 64 bytes (plenty)
        let result = verify_jupiter_lend_instruction(&data);
        assert!(result.is_ok());
    }

    #[test]
    fn empty_instruction_rejected() {
        let data: Vec<u8> = vec![];
        let result = verify_jupiter_lend_instruction(&data);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(
            err,
            anchor_lang::error!(PhalnxError::InvalidJupiterLendInstruction)
        );
    }

    #[test]
    fn too_short_instruction_rejected() {
        let data = vec![1, 2, 3, 4, 5, 6, 7]; // 7 bytes (< 8 minimum)
        let result = verify_jupiter_lend_instruction(&data);
        assert!(result.is_err());
    }

    #[test]
    fn exactly_minimum_length_passes() {
        let data = vec![0u8; MIN_LEND_IX_DATA];
        let result = verify_jupiter_lend_instruction(&data);
        assert!(result.is_ok());
    }
}
