use anchor_lang::prelude::*;

/// Maximum number of oracle entries in the registry.
/// 105 × 97 bytes = 10,185 → total account = 8+32+4+10,185+1 = 10,230
/// (under 10,240 CPI account creation limit)
/// NOTE: If >105 entries are needed, add a realloc_oracle_registry
/// instruction to grow the account in a separate transaction (Solana
/// allows 10,240 bytes per realloc, supporting up to ~210 entries at
/// 20,480 bytes total).
pub const MAX_ORACLE_ENTRIES: usize = 105;

/// Protocol-level oracle registry — maps token mints to oracle feeds.
/// Maintained by protocol admin. Shared across ALL vaults.
/// Any vault can use any registered token without per-vault configuration.
///
/// Seeds: `[b"oracle_registry"]`
#[account]
pub struct OracleRegistry {
    /// Authority who can add/remove entries (upgradeable to multisig/DAO)
    pub authority: Pubkey,

    /// Token mint → oracle feed mappings
    pub entries: Vec<OracleEntry>,

    /// Bump seed for PDA
    pub bump: u8,
}

/// Individual entry mapping a token mint to its oracle feed.
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
    /// Used when primary is stale/invalid. Cross-checked for divergence
    /// when both are available.
    pub fallback_feed: Pubkey,
}

impl OracleEntry {
    /// 32 (mint) + 32 (oracle_feed) + 1 (is_stablecoin) + 32 (fallback_feed) = 97 bytes
    pub const SIZE: usize = 32 + 32 + 1 + 32;
}

impl OracleRegistry {
    /// discriminator (8) + authority (32) + vec prefix (4) +
    /// entries (97 × MAX_ORACLE_ENTRIES) + bump (1)
    pub const SIZE: usize = 8 + 32 + (4 + OracleEntry::SIZE * MAX_ORACLE_ENTRIES) + 1;

    /// Find an oracle entry by token mint
    pub fn find_entry(&self, mint: &Pubkey) -> Option<&OracleEntry> {
        self.entries.iter().find(|e| e.mint == *mint)
    }
}
