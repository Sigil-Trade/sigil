use anchor_lang::prelude::*;

/// Maximum number of oracle entries in the registry.
/// 104 entries (reduced from 105 to accommodate pending_authority + count
/// + padding in the zero-copy layout).
///
/// NOTE: If >104 entries are needed, add a realloc_oracle_registry
/// instruction to grow the account in a separate transaction (Solana
/// allows 10,240 bytes per realloc, supporting up to ~210 entries at
/// 20,480 bytes total).
pub const MAX_ORACLE_ENTRIES: usize = 104;

/// Zero-copy protocol-level oracle registry — maps token mints to oracle
/// feeds. Maintained by protocol admin. Shared across ALL vaults.
/// Any vault can use any registered token without per-vault configuration.
///
/// Seeds: `[b"oracle_registry"]`
///
/// Layout: disc(8) + authority(32) + pending_authority(32) + count(2) +
///         bump(1) + padding(5) + entries(97*104=10,088) = 10,168 bytes
///         (under 10,240 CPI limit)
#[account(zero_copy)]
#[repr(C)]
pub struct OracleRegistry {
    /// Authority who can add/remove entries (upgradeable to multisig/DAO
    /// via 2-step transfer)
    pub authority: Pubkey,

    /// Pending authority for 2-step transfer. Pubkey::default() = none.
    pub pending_authority: Pubkey,

    /// Number of active entries in the `entries` array
    pub count: u16,

    /// Bump seed for PDA
    pub bump: u8,

    /// Padding for 8-byte alignment
    pub _padding: [u8; 5],

    /// Fixed-size entry array (only entries[..count] are active)
    pub entries: [OracleEntryZC; MAX_ORACLE_ENTRIES],
}

/// Zero-copy individual entry mapping a token mint to its oracle feed.
/// 97 bytes per entry, no padding needed (32+32+1+32 = 97).
#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct OracleEntryZC {
    /// SPL token mint address
    pub mint: Pubkey,

    /// Pyth or Switchboard oracle feed account.
    /// Ignored when is_stablecoin is 1.
    pub oracle_feed: Pubkey,

    /// 1 = stablecoin (1:1 USD, no oracle read needed), 0 = oracle-priced
    pub is_stablecoin: u8,

    /// Optional fallback oracle feed. Pubkey::default() = no fallback.
    /// Used when primary is stale/invalid. Cross-checked for divergence
    /// when both are available.
    pub fallback_feed: Pubkey,
}

impl OracleEntryZC {
    /// 32 (mint) + 32 (oracle_feed) + 1 (is_stablecoin) + 32 (fallback_feed) = 97 bytes
    pub const SIZE: usize = 32 + 32 + 1 + 32;
}

impl OracleRegistry {
    /// Total account size: discriminator (8) + data
    /// data = authority(32) + pending_authority(32) + count(2) + bump(1)
    ///      + padding(5) + entries(97 * 104) = 10,160
    /// total = 8 + 10,160 = 10,168
    pub const SIZE: usize = 8 + 32 + 32 + 2 + 1 + 5 + (OracleEntryZC::SIZE * MAX_ORACLE_ENTRIES);

    /// Find an oracle entry by token mint (linear scan over active entries)
    pub fn find_entry(&self, mint: &Pubkey) -> Option<&OracleEntryZC> {
        let count = self.count as usize;
        self.entries[..count].iter().find(|e| e.mint == *mint)
    }

    /// Find a mutable oracle entry by token mint
    pub fn find_entry_mut(&mut self, mint: &Pubkey) -> Option<&mut OracleEntryZC> {
        let count = self.count as usize;
        self.entries[..count].iter_mut().find(|e| e.mint == *mint)
    }
}

/// Borsh-serializable entry used as instruction argument.
/// Converted to/from OracleEntryZC for on-chain storage.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OracleEntry {
    /// SPL token mint address
    pub mint: Pubkey,

    /// Pyth or Switchboard oracle feed account.
    /// Ignored when is_stablecoin is true.
    pub oracle_feed: Pubkey,

    /// If true, token is 1:1 USD (no oracle read needed)
    pub is_stablecoin: bool,

    /// Optional fallback oracle feed. Pubkey::default() = no fallback.
    pub fallback_feed: Pubkey,
}

impl OracleEntry {
    /// 32 (mint) + 32 (oracle_feed) + 1 (is_stablecoin) + 32 (fallback_feed) = 97 bytes
    pub const SIZE: usize = 32 + 32 + 1 + 32;
}

impl From<&OracleEntry> for OracleEntryZC {
    fn from(e: &OracleEntry) -> Self {
        OracleEntryZC {
            mint: e.mint,
            oracle_feed: e.oracle_feed,
            is_stablecoin: if e.is_stablecoin { 1 } else { 0 },
            fallback_feed: e.fallback_feed,
        }
    }
}
