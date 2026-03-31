use anchor_lang::prelude::*;

use crate::errors::SigilError;

// ---------------------------------------------------------------------------
// Discriminators — Anchor sha256("global:<method>")[:8]
// ---------------------------------------------------------------------------

/// Jupiter V6 `shared_accounts_route` discriminator.
const SHARED_ACCOUNTS_ROUTE_DISC: [u8; 8] = [193, 32, 155, 51, 65, 214, 156, 129];

/// Jupiter V6 `route` discriminator.
const ROUTE_DISC: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];

/// Jupiter V6 `exact_out_route` discriminator.
const EXACT_OUT_ROUTE_DISC: [u8; 8] = [208, 51, 239, 151, 123, 43, 237, 92];

/// Jupiter V6 `shared_accounts_exact_out_route` discriminator.
const SHARED_ACCOUNTS_EXACT_OUT_ROUTE_DISC: [u8; 8] = [176, 209, 105, 168, 154, 125, 69, 62];

// ---------------------------------------------------------------------------
// Swap variant lookup table — from on-chain IDL (2026-02-27)
// ---------------------------------------------------------------------------

/// Number of Swap variants in the Jupiter V6 on-chain IDL.
const SWAP_VARIANT_COUNT: usize = 127;

/// Maximum number of RoutePlanStep entries (sanity bound).
const MAX_ROUTE_STEPS: u32 = 10;

/// V1 suffix size: in_amount(8) + quoted_out_amount(8) + slippage_bps(2) + platform_fee_bps(1).
const V1_SUFFIX_SIZE: usize = 19;

/// Borsh field sizes for each Swap variant (excluding 1-byte discriminator).
///
/// - `>= 0` : fixed byte count
/// - `-1`   : variable length, parseable (RemainingAccountsInfo)
/// - `-2`   : rejected (unparseable variable-length fields)
#[rustfmt::skip]
const SWAP_VARIANT_SIZES: [i8; SWAP_VARIANT_COUNT] = [
    0,   //   0: Saber
    0,   //   1: SaberAddDecimalsDeposit
    0,   //   2: SaberAddDecimalsWithdraw
    0,   //   3: TokenSwap
    0,   //   4: Sencha
    0,   //   5: Step
    0,   //   6: Cropper
    0,   //   7: Raydium
    1,   //   8: Crema { a_to_b: bool }
    0,   //   9: Lifinity
    0,   //  10: Mercurial
    0,   //  11: Cykura
    1,   //  12: Serum { side: Side }
    0,   //  13: MarinadeDeposit
    0,   //  14: MarinadeUnstake
    1,   //  15: Aldrin { side: Side }
    1,   //  16: AldrinV2 { side: Side }
    1,   //  17: Whirlpool { a_to_b: bool }
    1,   //  18: Invariant { x_to_y: bool }
    0,   //  19: Meteora
    0,   //  20: GooseFX
    1,   //  21: DeltaFi { stable: bool }
    0,   //  22: Balansol
    1,   //  23: MarcoPolo { x_to_y: bool }
    1,   //  24: Dradex { side: Side }
    0,   //  25: LifinityV2
    0,   //  26: RaydiumClmm
    1,   //  27: Openbook { side: Side }
    1,   //  28: Phoenix { side: Side }
    16,  //  29: Symmetry { from_token_id: u64, to_token_id: u64 }
    0,   //  30: TokenSwapV2
    0,   //  31: HeliumTreasuryManagementRedeemV0
    0,   //  32: StakeDexStakeWrappedSol
    4,   //  33: StakeDexSwapViaStake { bridge_stake_seed: u32 }
    0,   //  34: GooseFXV2
    0,   //  35: Perps
    0,   //  36: PerpsAddLiquidity
    0,   //  37: PerpsRemoveLiquidity
    0,   //  38: MeteoraDlmm
    1,   //  39: OpenBookV2 { side: Side }
    0,   //  40: RaydiumClmmV2
    4,   //  41: StakeDexPrefundWithdrawStakeAndDepositStake { bridge_stake_seed: u32 }
    3,   //  42: Clone { pool_index: u8, quantity_is_input: bool, quantity_is_collateral: bool }
    10,  //  43: SanctumS { u8, u8, u32, u32 }
    5,   //  44: SanctumSAddLiquidity { u8, u32 }
    5,   //  45: SanctumSRemoveLiquidity { u8, u32 }
    0,   //  46: RaydiumCP
    -1,  //  47: WhirlpoolSwapV2 { bool, Option<RemainingAccountsInfo> }
    0,   //  48: OneIntro
    0,   //  49: PumpWrappedBuy
    0,   //  50: PumpWrappedSell
    0,   //  51: PerpsV2
    0,   //  52: PerpsV2AddLiquidity
    0,   //  53: PerpsV2RemoveLiquidity
    0,   //  54: MoonshotWrappedBuy
    0,   //  55: MoonshotWrappedSell
    0,   //  56: StabbleStableSwap
    0,   //  57: StabbleWeightedSwap
    1,   //  58: Obric { x_to_y: bool }
    0,   //  59: FoxBuyFromEstimatedCost
    1,   //  60: FoxClaimPartial { is_y: bool }
    1,   //  61: SolFi { is_quote_to_base: bool }
    0,   //  62: SolayerDelegateNoInit
    0,   //  63: SolayerUndelegateNoInit
    1,   //  64: TokenMill { side: Side }
    0,   //  65: DaosFunBuy
    0,   //  66: DaosFunSell
    0,   //  67: ZeroFi
    0,   //  68: StakeDexWithdrawWrappedSol
    0,   //  69: VirtualsBuy
    0,   //  70: VirtualsSell
    2,   //  71: Perena { in_index: u8, out_index: u8 }
    0,   //  72: PumpSwapBuy
    0,   //  73: PumpSwapSell
    0,   //  74: Gamma
    -1,  //  75: MeteoraDlmmSwapV2 { RemainingAccountsInfo }
    0,   //  76: Woofi
    0,   //  77: MeteoraDammV2
    0,   //  78: MeteoraDynamicBondingCurveSwap
    0,   //  79: StabbleStableSwapV2
    0,   //  80: StabbleWeightedSwapV2
    8,   //  81: RaydiumLaunchlabBuy { share_fee_rate: u64 }
    8,   //  82: RaydiumLaunchlabSell { share_fee_rate: u64 }
    0,   //  83: BoopdotfunWrappedBuy
    0,   //  84: BoopdotfunWrappedSell
    1,   //  85: Plasma { side: Side }
    2,   //  86: GoonFi { is_bid: bool, blacklist_bump: u8 }
    9,   //  87: HumidiFi { swap_id: u64, is_base_to_quote: bool }
    0,   //  88: MeteoraDynamicBondingCurveSwapWithRemainingAccounts
    1,   //  89: TesseraV { side: Side }
    0,   //  90: PumpWrappedBuyV2
    0,   //  91: PumpWrappedSellV2
    0,   //  92: PumpSwapBuyV2
    0,   //  93: PumpSwapSellV2
    1,   //  94: Heaven { a_to_b: bool }
    1,   //  95: SolFiV2 { is_quote_to_base: bool }
    0,   //  96: Aquifer
    0,   //  97: PumpWrappedBuyV3
    0,   //  98: PumpWrappedSellV3
    0,   //  99: PumpSwapBuyV3
    0,   // 100: PumpSwapSellV3
    0,   // 101: JupiterLendDeposit
    0,   // 102: JupiterLendRedeem
    -1,  // 103: DefiTuna { bool, Option<RemainingAccountsInfo> }
    1,   // 104: AlphaQ { a_to_b: bool }
    0,   // 105: RaydiumV2
    1,   // 106: SarosDlmm { swap_for_y: bool }
    1,   // 107: Futarchy { side: Side }
    0,   // 108: MeteoraDammV2WithRemainingAccounts
    0,   // 109: Obsidian
    1,   // 110: WhaleStreet { side: Side }
    -2,  // 111: DynamicV1 — REJECTED (Vec<CandidateSwap> + Option<u8>)
    0,   // 112: PumpWrappedBuyV4
    0,   // 113: PumpWrappedSellV4
    0,   // 114: CarrotIssue
    0,   // 115: CarrotRedeem
    1,   // 116: Manifest { side: Side }
    1,   // 117: BisonFi { a_to_b: bool }
    9,   // 118: HumidiFiV2 { swap_id: u64, is_base_to_quote: bool }
    1,   // 119: PerenaStar { is_mint: bool }
    -2,  // 120: JupiterRfqV2 — REJECTED (Side + Vec<u8>)
    1,   // 121: GoonFiV2 { is_bid: bool }
    16,  // 122: Scorch { swap_id: u128 }
    48,  // 123: VaultLiquidUnstake { [u64; 5], u64 }
    0,   // 124: XOrca
    1,   // 125: Quantum { side: Side }
    17,  // 126: WhaleStreetV2 { Side, u64, u64 }
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Verify Jupiter V6 swap slippage is within policy limits.
///
/// Front-parses the instruction data through the variable-length route plan
/// to locate the exact suffix position. Rejects any trailing bytes that would
/// shift tail reads to attacker-controlled values.
///
/// Supports V1 instructions: `route`, `shared_accounts_route`,
/// `exact_out_route`, `shared_accounts_exact_out_route`.
pub fn verify_jupiter_slippage(ix_data: &[u8], max_slippage_bps: u16) -> Result<()> {
    // Minimum sanity: disc(8) + vec_len(4) + suffix(19) = 31
    require!(ix_data.len() >= 24, SigilError::InvalidJupiterInstruction);

    // 1. Parse discriminator — determine instruction variant
    let disc = &ix_data[..8];
    let has_id = disc == SHARED_ACCOUNTS_ROUTE_DISC || disc == SHARED_ACCOUNTS_EXACT_OUT_ROUTE_DISC;
    let is_known = has_id || disc == ROUTE_DISC || disc == EXACT_OUT_ROUTE_DISC;
    require!(is_known, SigilError::InvalidJupiterInstruction);

    // 2. Cursor after disc (and optional id byte for shared_accounts variants)
    let mut cursor: usize = if has_id { 9 } else { 8 };

    // 3. Read route plan vec_len (u32 LE)
    let end4 = cursor
        .checked_add(4)
        .ok_or(error!(SigilError::InvalidJupiterInstruction))?;
    require!(
        ix_data.len() >= end4,
        SigilError::InvalidJupiterInstruction
    );
    let vec_len = u32::from_le_bytes(
        ix_data[cursor..end4]
            .try_into()
            .map_err(|_| error!(SigilError::InvalidJupiterInstruction))?,
    );
    cursor = end4;

    require!(
        vec_len <= MAX_ROUTE_STEPS,
        SigilError::InvalidJupiterInstruction
    );

    // 4. Parse each RoutePlanStep: swap_disc(1) + swap_fields(N) + percent(1)
    //    + input_index(1) + output_index(1)
    for _ in 0..vec_len {
        // Read swap variant discriminator
        require!(
            ix_data.len() > cursor,
            SigilError::InvalidJupiterInstruction
        );
        let swap_disc = ix_data[cursor] as usize;
        cursor = cursor
            .checked_add(1)
            .ok_or(error!(SigilError::InvalidJupiterInstruction))?;

        // Reject unknown variants
        require!(
            swap_disc < SWAP_VARIANT_COUNT,
            SigilError::InvalidJupiterInstruction
        );

        let size = SWAP_VARIANT_SIZES[swap_disc];
        if size >= 0 {
            // Fixed-size variant
            cursor = cursor
                .checked_add(size as usize)
                .ok_or(error!(SigilError::InvalidJupiterInstruction))?;
        } else if size == -1 {
            // Variable-size variant (parseable)
            skip_variable_swap_fields(ix_data, &mut cursor, swap_disc as u8)?;
        } else {
            // Rejected variant (size == -2)
            return Err(error!(SigilError::InvalidJupiterInstruction));
        }

        // Skip percent(1) + input_index(1) + output_index(1)
        cursor = cursor
            .checked_add(3)
            .ok_or(error!(SigilError::InvalidJupiterInstruction))?;
    }

    // 5. Verify exact length: cursor + V1_SUFFIX_SIZE == data.len()
    //    Any trailing bytes are rejected here.
    let expected_len = cursor
        .checked_add(V1_SUFFIX_SIZE)
        .ok_or(error!(SigilError::InvalidJupiterInstruction))?;
    require!(
        ix_data.len() == expected_len,
        SigilError::InvalidJupiterInstruction
    );

    // 6. Read suffix fields
    let quoted_out_bytes: [u8; 8] = ix_data[cursor + 8..cursor + 16]
        .try_into()
        .map_err(|_| error!(SigilError::InvalidJupiterInstruction))?;
    let quoted_out = u64::from_le_bytes(quoted_out_bytes);

    let slippage_bps = u16::from_le_bytes([ix_data[cursor + 16], ix_data[cursor + 17]]);

    // 7. Verify slippage within policy
    require!(quoted_out > 0, SigilError::SwapSlippageExceeded);
    require!(
        slippage_bps <= max_slippage_bps,
        SigilError::SwapSlippageExceeded
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Variable variant helpers
// ---------------------------------------------------------------------------

/// Dispatch variable-length Swap variant parsing.
fn skip_variable_swap_fields(data: &[u8], cursor: &mut usize, variant: u8) -> Result<()> {
    match variant {
        47 | 103 => {
            // WhirlpoolSwapV2 / DefiTuna: bool + Option<RemainingAccountsInfo>
            *cursor = cursor
                .checked_add(1)
                .ok_or(error!(SigilError::InvalidJupiterInstruction))?;
            skip_option_remaining_accounts_info(data, cursor)?;
        }
        75 => {
            // MeteoraDlmmSwapV2: RemainingAccountsInfo (required, not Option)
            skip_remaining_accounts_info(data, cursor)?;
        }
        _ => {
            return Err(error!(SigilError::InvalidJupiterInstruction));
        }
    }
    Ok(())
}

/// Skip `RemainingAccountsInfo` = `Vec<RemainingAccountsSlice>` (each slice = 2 bytes).
fn skip_remaining_accounts_info(data: &[u8], cursor: &mut usize) -> Result<()> {
    let end = cursor
        .checked_add(4)
        .ok_or(error!(SigilError::InvalidJupiterInstruction))?;
    require!(data.len() >= end, SigilError::InvalidJupiterInstruction);
    let vec_len = u32::from_le_bytes(
        data[*cursor..end]
            .try_into()
            .map_err(|_| error!(SigilError::InvalidJupiterInstruction))?,
    ) as usize;
    *cursor = end;

    // Each RemainingAccountsSlice = AccountsType(u8) + length(u8) = 2 bytes
    let skip = vec_len
        .checked_mul(2)
        .ok_or(error!(SigilError::InvalidJupiterInstruction))?;
    *cursor = cursor
        .checked_add(skip)
        .ok_or(error!(SigilError::InvalidJupiterInstruction))?;

    require!(
        data.len() >= *cursor,
        SigilError::InvalidJupiterInstruction
    );
    Ok(())
}

/// Skip `Option<RemainingAccountsInfo>` (1-byte tag + optional payload).
fn skip_option_remaining_accounts_info(data: &[u8], cursor: &mut usize) -> Result<()> {
    require!(data.len() > *cursor, SigilError::InvalidJupiterInstruction);
    let tag = data[*cursor];
    *cursor = cursor
        .checked_add(1)
        .ok_or(error!(SigilError::InvalidJupiterInstruction))?;

    if tag == 1 {
        skip_remaining_accounts_info(data, cursor)?;
    } else {
        require!(tag == 0, SigilError::InvalidJupiterInstruction);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a valid Jupiter V1 instruction data buffer.
    ///
    /// Layout: disc(8) [id(1) if has_id] vec_len(4) [steps...] suffix(19)
    /// Each step: swap_disc(1) + swap_fields + percent(1) + input_index(1) + output_index(1)
    fn build_v1_data(
        disc: [u8; 8],
        has_id: bool,
        steps: &[(u8, Vec<u8>)],
        in_amount: u64,
        quoted_out: u64,
        slippage_bps: u16,
        platform_fee_bps: u8,
    ) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&disc);
        if has_id {
            data.push(0); // id byte
        }
        // vec_len
        data.extend_from_slice(&(steps.len() as u32).to_le_bytes());
        // steps
        for (swap_disc, fields) in steps {
            data.push(*swap_disc);
            data.extend_from_slice(fields);
            data.push(100); // percent
            data.push(0); // input_index
            data.push(1); // output_index
        }
        // suffix
        data.extend_from_slice(&in_amount.to_le_bytes());
        data.extend_from_slice(&quoted_out.to_le_bytes());
        data.extend_from_slice(&slippage_bps.to_le_bytes());
        data.push(platform_fee_bps);
        data
    }

    // --- Test 1: Valid shared_accounts_route, 1-step Saber (variant 0, 0 fields) ---
    #[test]
    fn valid_shared_accounts_route_1_step() {
        let data = build_v1_data(
            SHARED_ACCOUNTS_ROUTE_DISC,
            true,
            &[(0, vec![])], // Saber
            1_000_000,
            1_000_000,
            50,
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 2: Valid route disc, slippage at max ---
    #[test]
    fn valid_route_slippage_at_max() {
        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[(7, vec![])], // Raydium
            500_000,
            500_000,
            100, // exactly at max
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 3: Valid exact_out_route disc ---
    #[test]
    fn valid_exact_out_route() {
        let data = build_v1_data(
            EXACT_OUT_ROUTE_DISC,
            false,
            &[(0, vec![])],
            1_000_000,
            1_000_000,
            30,
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 4: Valid shared_accounts_exact_out_route disc ---
    #[test]
    fn valid_shared_accounts_exact_out_route() {
        let data = build_v1_data(
            SHARED_ACCOUNTS_EXACT_OUT_ROUTE_DISC,
            true,
            &[(17, vec![1])], // Whirlpool { a_to_b: true }
            2_000_000,
            1_950_000,
            50,
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 5: Trailing bytes (3) → rejected ---
    #[test]
    fn trailing_bytes_3_rejected() {
        let mut data = build_v1_data(
            SHARED_ACCOUNTS_ROUTE_DISC,
            true,
            &[(0, vec![])],
            1_000_000,
            1_000_000,
            50,
            0,
        );
        data.extend_from_slice(&[0, 0, 0]); // 3 trailing bytes
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::InvalidJupiterInstruction)
        );
    }

    // --- Test 6: Trailing bytes (20) → rejected ---
    #[test]
    fn trailing_bytes_20_rejected() {
        let mut data = build_v1_data(
            ROUTE_DISC,
            false,
            &[(0, vec![])],
            1_000_000,
            1_000_000,
            50,
            0,
        );
        data.extend(vec![0u8; 20]); // 20 trailing bytes
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::InvalidJupiterInstruction)
        );
    }

    // --- Test 7: Unknown Swap variant (index 127) → rejected ---
    #[test]
    fn unknown_swap_variant_rejected() {
        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[(127, vec![])], // index >= SWAP_VARIANT_COUNT
            1_000_000,
            1_000_000,
            50,
            0,
        );
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::InvalidJupiterInstruction)
        );
    }

    // --- Test 8: DynamicV1 (variant 111) → rejected ---
    #[test]
    fn dynamic_v1_variant_rejected() {
        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[(111, vec![])], // DynamicV1 = -2 (rejected)
            1_000_000,
            1_000_000,
            50,
            0,
        );
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::InvalidJupiterInstruction)
        );
    }

    // --- Test 9: WhirlpoolSwapV2 (47) with Option None → OK ---
    #[test]
    fn whirlpool_swap_v2_option_none() {
        // Fields: a_to_b(1) + Option tag 0 (None)(1) = 2 bytes
        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[(47, vec![1, 0])], // a_to_b=true, Option=None
            1_000_000,
            1_000_000,
            50,
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 10: WhirlpoolSwapV2 (47) with Option Some, 2 slices → OK ---
    #[test]
    fn whirlpool_swap_v2_option_some_2_slices() {
        // Fields: a_to_b(1) + Option=Some(1) + vec_len=2(4) + 2*2 bytes slices = 10
        let mut fields = vec![1u8]; // a_to_b
        fields.push(1); // Option Some
        fields.extend_from_slice(&2u32.to_le_bytes()); // vec_len = 2
        fields.extend_from_slice(&[0, 3]); // slice 1: AccountsType=0, length=3
        fields.extend_from_slice(&[1, 2]); // slice 2: AccountsType=1, length=2

        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[(47, fields)],
            1_000_000,
            1_000_000,
            50,
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 11: MeteoraDlmmSwapV2 (75) with 1 slice → OK ---
    #[test]
    fn meteora_dlmm_swap_v2_1_slice() {
        // Fields: vec_len=1(4) + 1*2 bytes = 6 total
        let mut fields = Vec::new();
        fields.extend_from_slice(&1u32.to_le_bytes()); // vec_len = 1
        fields.extend_from_slice(&[0, 5]); // slice: AccountsType=0, length=5

        let data = build_v1_data(
            SHARED_ACCOUNTS_ROUTE_DISC,
            true,
            &[(75, fields)],
            1_000_000,
            1_000_000,
            50,
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 12: Zero-step route plan (vec_len=0), exact length → OK ---
    #[test]
    fn zero_step_route_plan() {
        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[], // 0 steps
            1_000_000,
            1_000_000,
            50,
            0,
        );
        // disc(8) + vec_len(4) + suffix(19) = 31
        assert_eq!(data.len(), 31);
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 13: Zero-step with 1 trailing byte → rejected ---
    #[test]
    fn zero_step_trailing_byte_rejected() {
        let mut data = build_v1_data(ROUTE_DISC, false, &[], 1_000_000, 1_000_000, 50, 0);
        data.push(0xFF); // 1 trailing byte
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::InvalidJupiterInstruction)
        );
    }

    // --- Test 14: Slippage exceeds policy → SwapSlippageExceeded ---
    #[test]
    fn slippage_exceeds_policy() {
        let data = build_v1_data(
            SHARED_ACCOUNTS_ROUTE_DISC,
            true,
            &[(0, vec![])],
            1_000_000,
            1_000_000,
            101, // exceeds max of 100
            0,
        );
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::SwapSlippageExceeded)
        );
    }

    // --- Test 15: Zero quoted output → SwapSlippageExceeded ---
    #[test]
    fn zero_quoted_output_rejected() {
        let data = build_v1_data(
            SHARED_ACCOUNTS_ROUTE_DISC,
            true,
            &[(0, vec![])],
            1_000_000,
            0, // zero quoted out
            50,
            0,
        );
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::SwapSlippageExceeded)
        );
    }

    // --- Test 16: Instruction too short (< 24 bytes) → rejected ---
    #[test]
    fn instruction_too_short_rejected() {
        let data = vec![
            193, 32, 155, 51, 65, 214, 156, 129, // disc
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(data.len(), 23);
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::InvalidJupiterInstruction)
        );
    }

    // --- Test 17: vec_len > 10 → rejected ---
    #[test]
    fn vec_len_exceeds_max_rejected() {
        // Manually build data with vec_len = 11
        let mut data = Vec::new();
        data.extend_from_slice(&ROUTE_DISC);
        data.extend_from_slice(&11u32.to_le_bytes()); // vec_len = 11
                                                      // Pad enough for the check to reach the vec_len validation
        data.extend(vec![0u8; 200]);
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::InvalidJupiterInstruction)
        );
    }

    // --- Test 18: max_slippage_bps=0 rejects slippage=1 ---
    #[test]
    fn max_slippage_zero_rejects_one() {
        let data = build_v1_data(
            SHARED_ACCOUNTS_ROUTE_DISC,
            true,
            &[(0, vec![])],
            1_000_000,
            1_000_000,
            1, // slippage = 1 bps
            0,
        );
        let result = verify_jupiter_slippage(&data, 0);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::SwapSlippageExceeded)
        );
    }

    // --- Test 19: max_slippage_bps=0 allows slippage=0 ---
    #[test]
    fn max_slippage_zero_allows_zero() {
        let data = build_v1_data(
            SHARED_ACCOUNTS_ROUTE_DISC,
            true,
            &[(0, vec![])],
            1_000_000,
            1_000_000,
            0, // slippage = 0
            0,
        );
        assert!(verify_jupiter_slippage(&data, 0).is_ok());
    }

    // --- Test 20: Multi-step route (3 fixed variants) correct length ---
    #[test]
    fn multi_step_route_3_fixed_variants() {
        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[
                (0, vec![]),         // Saber (0 fields)
                (17, vec![1]),       // Whirlpool { a_to_b: true }
                (29, vec![0u8; 16]), // Symmetry { from_token_id, to_token_id }
            ],
            5_000_000,
            4_900_000,
            50,
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }

    // --- Test 21: JupiterRfqV2 (variant 120) → rejected ---
    #[test]
    fn jupiter_rfq_v2_rejected() {
        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[(120, vec![])], // JupiterRfqV2 = -2 (rejected)
            1_000_000,
            1_000_000,
            50,
            0,
        );
        let result = verify_jupiter_slippage(&data, 100);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            anchor_lang::error!(SigilError::InvalidJupiterInstruction)
        );
    }

    // --- Test 22: DefiTuna (variant 103) with Option None → OK ---
    #[test]
    fn defi_tuna_option_none() {
        // Fields: a_to_b(1) + Option=None(1) = 2 bytes
        let data = build_v1_data(
            ROUTE_DISC,
            false,
            &[(103, vec![0, 0])], // a_to_b=false, Option=None
            1_000_000,
            1_000_000,
            50,
            0,
        );
        assert!(verify_jupiter_slippage(&data, 100).is_ok());
    }
}
