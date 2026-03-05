pub mod constraints;
pub mod escrow;
pub mod pending_constraints;
pub mod pending_policy;
pub mod policy;
pub mod session;
pub mod tracker;
pub mod vault;

pub use constraints::*;
pub use escrow::*;
pub use pending_constraints::*;
pub use pending_policy::*;
pub use policy::*;
pub use session::*;
pub use tracker::*;
pub use vault::*;

/// Maximum number of agents per vault
pub const MAX_AGENTS_PER_VAULT: usize = 10;

/// Full permission bitmask — bits 0-20 (21 ActionType variants).
pub const FULL_PERMISSIONS: u64 = (1u64 << 21) - 1;

/// Maximum number of allowed protocols in a policy
pub const MAX_ALLOWED_PROTOCOLS: usize = 10;

/// Maximum number of allowed destination addresses for agent transfers
pub const MAX_ALLOWED_DESTINATIONS: usize = 10;

/// Session expiry in slots (~20 slots ≈ 8 seconds)
pub const SESSION_EXPIRY_SLOTS: u64 = 20;

/// Fee rate denominator — fee_rate / 1,000,000 = fractional fee
pub const FEE_RATE_DENOMINATOR: u64 = 1_000_000;

/// Protocol fee rate: 200 / 1,000,000 = 0.02% = 2 BPS (hardcoded)
pub const PROTOCOL_FEE_RATE: u16 = 200;

/// Maximum developer fee rate: 500 / 1,000,000 = 0.05% = 5 BPS
pub const MAX_DEVELOPER_FEE_RATE: u16 = 500;

/// Maximum allowed slippage in basis points (5000 = 50%).
/// Prevents misconfiguration while allowing wide flexibility.
pub const MAX_SLIPPAGE_BPS: u16 = 5000;

/// Maximum escrow duration: 30 days in seconds
pub const MAX_ESCROW_DURATION: i64 = 2_592_000;

/// sha256("global:finalize_session")[0..8] — used by validate_and_authorize
/// to identify finalize_session instructions in the transaction.
pub const FINALIZE_SESSION_DISCRIMINATOR: [u8; 8] = [34, 148, 144, 47, 37, 130, 206, 161];

// Build requires exactly one of: --features mainnet OR --features devnet
#[cfg(not(any(feature = "mainnet", feature = "devnet")))]
compile_error!("Build requires --features mainnet OR --features devnet");

#[cfg(all(feature = "mainnet", feature = "devnet"))]
compile_error!("Cannot enable both mainnet and devnet simultaneously");

#[cfg(feature = "devnet")]
/// Protocol treasury address (devnet)
/// Base58: ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT
pub const PROTOCOL_TREASURY: Pubkey = Pubkey::new_from_array([
    140, 51, 155, 5, 120, 99, 25, 69, 20, 4, 163, 87, 229, 124, 111, 239, 107, 28, 230, 192, 254,
    239, 33, 251, 37, 93, 179, 29, 45, 226, 14, 172,
]);

/// Protocol treasury address (mainnet — all-zeros placeholder).
/// Deliberately invalid: treasury_token.owner check will fail at
/// runtime until replaced with the real mainnet treasury address.
#[cfg(feature = "mainnet")]
pub const PROTOCOL_TREASURY: Pubkey = Pubkey::new_from_array([0u8; 32]);

// --- Stablecoin mint constants ---

/// USDC mint (devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
#[cfg(feature = "devnet")]
pub const USDC_MINT: Pubkey = Pubkey::new_from_array([
    59, 68, 44, 179, 145, 33, 87, 241, 58, 147, 61, 1, 52, 40, 45, 3, 43, 95, 254, 205, 1, 162,
    219, 241, 183, 121, 6, 8, 223, 0, 46, 167,
]);

/// USDC mint (mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
#[cfg(feature = "mainnet")]
pub const USDC_MINT: Pubkey = Pubkey::new_from_array([
    198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49, 177, 187, 228,
    194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
]);

/// USDT mint (devnet: EJwZgeZrdC8TXTQbQBoL6bfuAnFUQS5S4iC5A2ciQtCK)
#[cfg(feature = "devnet")]
pub const USDT_MINT: Pubkey = Pubkey::new_from_array([
    197, 192, 127, 187, 120, 104, 92, 176, 205, 113, 5, 32, 101, 17, 150, 104, 203, 143, 154, 228,
    250, 183, 167, 185, 219, 40, 96, 134, 25, 221, 153, 132,
]);

/// USDT mint (mainnet: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)
#[cfg(feature = "mainnet")]
pub const USDT_MINT: Pubkey = Pubkey::new_from_array([
    206, 1, 14, 96, 175, 237, 178, 39, 23, 189, 99, 25, 47, 84, 20, 90, 63, 150, 90, 51, 187, 130,
    210, 199, 2, 158, 178, 206, 30, 32, 130, 100,
]);

/// M8: Build-time guard — mainnet treasury must not be the zero address.
/// Catches the all-zeros placeholder before it reaches production.
#[cfg(test)]
mod treasury_tests {
    #[test]
    #[cfg(feature = "mainnet")]
    fn mainnet_treasury_must_not_be_zero() {
        use super::*;
        assert_ne!(
            PROTOCOL_TREASURY,
            Pubkey::default(),
            "PROTOCOL_TREASURY must be set to a real address before mainnet deployment"
        );
    }
}

/// Check if a mint address is a recognized stablecoin (USDC or USDT).
/// With `devnet-testing` feature, accepts any mint for integration testing
/// on devnet where Circle-controlled USDC cannot be minted.
#[cfg(not(feature = "devnet-testing"))]
pub fn is_stablecoin_mint(mint: &Pubkey) -> bool {
    *mint == USDC_MINT || *mint == USDT_MINT
}

#[cfg(feature = "devnet-testing")]
pub fn is_stablecoin_mint(_mint: &Pubkey) -> bool {
    true
}

// --- Protocol program IDs (same address on mainnet and devnet) ---

/// Jupiter V6 program
/// Base58: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
pub const JUPITER_PROGRAM: Pubkey = Pubkey::new_from_array([
    4, 121, 213, 91, 242, 49, 192, 110, 238, 116, 197, 110, 206, 104, 21, 7, 253, 177, 178, 222,
    163, 244, 142, 81, 2, 177, 205, 162, 86, 188, 19, 143,
]);

/// Flash Trade (Perpetuals) program
/// Base58: FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn
pub const FLASH_TRADE_PROGRAM: Pubkey = Pubkey::new_from_array([
    212, 236, 82, 74, 222, 71, 209, 50, 127, 252, 246, 137, 90, 104, 93, 148, 41, 240, 55, 144,
    196, 35, 87, 71, 243, 123, 215, 163, 221, 165, 30, 221,
]);

/// Jupiter Lend program (wraps deposits/withdrawals)
/// Base58: JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu
pub const JUPITER_LEND_PROGRAM: Pubkey = Pubkey::new_from_array([
    4, 113, 24, 1, 43, 4, 76, 56, 240, 98, 104, 189, 87, 231, 52, 36, 154, 118, 168, 157, 132, 58,
    30, 222, 238, 9, 26, 161, 252, 73, 18, 120,
]);

/// Jupiter Earn program (on-chain deposit/withdraw target)
/// Base58: jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9
pub const JUPITER_EARN_PROGRAM: Pubkey = Pubkey::new_from_array([
    10, 254, 27, 145, 46, 72, 94, 149, 253, 21, 235, 41, 55, 223, 252, 75, 55, 163, 22, 208, 166,
    56, 18, 255, 2, 186, 73, 180, 198, 193, 141, 30,
]);

/// Jupiter Borrow/Vaults program
/// Base58: jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi
pub const JUPITER_BORROW_PROGRAM: Pubkey = Pubkey::new_from_array([
    10, 254, 31, 147, 34, 167, 161, 209, 195, 102, 29, 103, 23, 145, 202, 155, 48, 211, 32, 47, 30,
    31, 214, 135, 58, 119, 204, 220, 113, 143, 17, 51,
]);

/// USD amounts use 6 decimal places (matching USDC/USDT precision).
/// $1.00 = 1_000_000, $500.00 = 500_000_000
pub const USD_DECIMALS: u8 = 6;

/// 10^6 — base multiplier for USD amounts with 6 decimals
pub const USD_BASE: u64 = 1_000_000;

use anchor_lang::prelude::*;

/// Vault status enum
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub enum VaultStatus {
    /// Vault is active, agent can execute actions
    #[default]
    Active,
    /// Vault is frozen (kill switch activated), no agent actions allowed
    Frozen,
    /// Vault is closed, all funds withdrawn, PDAs can be reclaimed
    Closed,
}

/// Position effect classification for action types
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PositionEffect {
    /// Action opens a new position or commits capital
    Increment,
    /// Action closes a position or releases capital
    Decrement,
    /// Action has no effect on position count
    None,
}

/// Action types that agents can request
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ActionType {
    /// Token swap (e.g., Jupiter)
    Swap,
    /// Open a perpetual position (e.g., Flash Trade, Drift)
    OpenPosition,
    /// Close a perpetual position
    ClosePosition,
    /// Increase position size
    IncreasePosition,
    /// Decrease position size
    DecreasePosition,
    /// Deposit into a lending/yield protocol
    Deposit,
    /// Withdraw from a lending/yield protocol
    Withdraw,
    /// Direct token transfer to an allowed destination
    Transfer,
    /// Add collateral to an existing position
    AddCollateral,
    /// Remove collateral from an existing position
    RemoveCollateral,
    /// Place a trigger order (take-profit / stop-loss)
    PlaceTriggerOrder,
    /// Edit an existing trigger order
    EditTriggerOrder,
    /// Cancel a trigger order
    CancelTriggerOrder,
    /// Place a limit order (collateral committed on-chain)
    PlaceLimitOrder,
    /// Edit an existing limit order
    EditLimitOrder,
    /// Cancel a limit order (collateral returned)
    CancelLimitOrder,
    /// Swap token then open a perpetual position
    SwapAndOpenPosition,
    /// Close a perpetual position then swap output token
    CloseAndSwapPosition,
    /// Create an escrow deposit between two vaults
    CreateEscrow,
    /// Settle an escrow (destination agent claims funds)
    SettleEscrow,
    /// Refund an escrow (source agent/owner reclaims after expiry)
    RefundEscrow,
}

impl ActionType {
    /// Returns the permission bit index for this action type.
    /// Used with the per-agent permission bitmask in AgentEntry.
    pub fn permission_bit(&self) -> u8 {
        match self {
            ActionType::Swap => 0,
            ActionType::OpenPosition => 1,
            ActionType::ClosePosition => 2,
            ActionType::IncreasePosition => 3,
            ActionType::DecreasePosition => 4,
            ActionType::Deposit => 5,
            ActionType::Withdraw => 6,
            ActionType::Transfer => 7,
            ActionType::AddCollateral => 8,
            ActionType::RemoveCollateral => 9,
            ActionType::PlaceTriggerOrder => 10,
            ActionType::EditTriggerOrder => 11,
            ActionType::CancelTriggerOrder => 12,
            ActionType::PlaceLimitOrder => 13,
            ActionType::EditLimitOrder => 14,
            ActionType::CancelLimitOrder => 15,
            ActionType::SwapAndOpenPosition => 16,
            ActionType::CloseAndSwapPosition => 17,
            ActionType::CreateEscrow => 18,
            ActionType::SettleEscrow => 19,
            ActionType::RefundEscrow => 20,
        }
    }

    /// Whether this action spends tokens from the vault (fees, delegation,
    /// and spend tracking apply). Risk-reducing actions (ClosePosition,
    /// DecreasePosition, CloseAndSwapPosition) return collateral TO the
    /// vault and are therefore non-spending.
    pub fn is_spending(&self) -> bool {
        matches!(
            self,
            ActionType::Swap
                | ActionType::OpenPosition
                | ActionType::IncreasePosition
                | ActionType::Deposit
                | ActionType::Transfer
                | ActionType::AddCollateral
                | ActionType::PlaceLimitOrder
                | ActionType::SwapAndOpenPosition
                | ActionType::CreateEscrow
        )
    }

    /// The effect of this action on the vault's open position counter.
    pub fn position_effect(&self) -> PositionEffect {
        match self {
            ActionType::OpenPosition
            | ActionType::SwapAndOpenPosition
            | ActionType::PlaceLimitOrder => PositionEffect::Increment,
            ActionType::ClosePosition
            | ActionType::CloseAndSwapPosition
            | ActionType::CancelLimitOrder => PositionEffect::Decrement,
            _ => PositionEffect::None,
        }
    }

    /// Whether this action requires token delegation to the agent.
    pub fn needs_delegation(&self) -> bool {
        self.is_spending()
    }

    /// Whether this action is an escrow-specific action.
    /// Escrow actions use standalone instructions, not the validate→finalize composition flow.
    pub fn is_escrow_action(&self) -> bool {
        matches!(
            self,
            ActionType::CreateEscrow | ActionType::SettleEscrow | ActionType::RefundEscrow
        )
    }
}
