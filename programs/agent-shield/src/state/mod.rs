pub mod pending_policy;
pub mod policy;
pub mod registry;
pub mod session;
pub mod tracker;
pub mod vault;

pub use pending_policy::*;
pub use policy::*;
pub use registry::*;
pub use session::*;
pub use tracker::*;
pub use vault::*;

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

// --- Oracle constants ---

/// Pyth Receiver program (same mainnet/devnet).
/// Base58: rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
pub const PYTH_RECEIVER_PROGRAM: Pubkey = Pubkey::new_from_array([
    12, 183, 250, 187, 82, 247, 166, 72, 187, 91, 49, 125, 154, 1, 139, 144, 87, 203, 2, 71, 116,
    250, 254, 1, 230, 196, 223, 152, 204, 56, 88, 129,
]);

/// Switchboard On-Demand program (same mainnet/devnet).
/// Base58: SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv
pub const SWITCHBOARD_ON_DEMAND_PROGRAM: Pubkey = Pubkey::new_from_array([
    6, 115, 189, 70, 242, 228, 126, 4, 241, 43, 217, 47, 183, 49, 150, 142, 205, 157, 151, 87, 194,
    116, 218, 135, 71, 111, 70, 92, 4, 12, 101, 115,
]);

/// Maximum staleness for oracle feed values (in slots).
/// 50 slots ≈ 20s normal, ~37s congested. Pyth updates every slot.
/// Drift uses 10% conf threshold (no separate staleness gate in public docs).
/// LIVENESS TRADEOFF: During oracle outages, vault transactions requiring
/// oracle pricing will be blocked until fresh data is available. This is
/// the correct security posture for a spending cap system — stale prices
/// create greater risk than temporary unavailability. The fallback oracle
/// mitigates single-provider outages when configured.
pub const MAX_ORACLE_STALE_SLOTS: u32 = 50;

/// Minimum number of oracle samples required for a valid price.
/// Switchboard examples commonly use 5; higher values improve median
/// robustness.
pub const MIN_ORACLE_SAMPLES: u32 = 5;

/// Maximum confidence cap for adjusted pricing (BPS).
/// 200 = 2%. Spot confidence is CAPPED at this level, bounding the
/// maximum spending cap overcount for any token regardless of volatility.
/// A $500 cap loses at most $10 to overcount; a $5M cap loses at most $100K.
pub const MAX_CONF_CAP_BPS: u64 = 200;

/// Safety valve: reject if spot confidence exceeds this (BPS).
/// 2000 = 20%. Only fires for genuinely broken oracle feeds, not
/// normal market volatility. Replaces the old 5% gate that blocked
/// meme coin trading during routine confidence spikes.
pub const ORACLE_SAFETY_VALVE_BPS: u64 = 2000;

/// Adaptive confidence multiplier. If spot_conf > MULTIPLIER × ema_conf,
/// the oracle is showing unusual uncertainty for this specific token.
/// 5× means SOL (ema_conf ~0.1%) blocks at 0.5%, BONK (ema_conf ~3%)
/// blocks at 15%. Auto-calibrated per-token, no configuration needed.
pub const ADAPTIVE_CONF_MULTIPLIER: u64 = 5;

/// Minimum adaptive confidence threshold in BPS of spot price.
/// Prevents ema_conf=0 (new/stable feeds) from blocking all trades.
/// 50 BPS = 0.5%.
pub const MIN_ADAPTIVE_CONF_BPS: u64 = 50;

/// Max divergence between primary and fallback oracle (BPS).
/// 500 = 5%. Rejects if both return valid but divergent prices.
pub const MAX_ORACLE_DIVERGENCE_BPS: u64 = 500;

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
}
