use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum EscrowStatus {
    Active,
    Settled,
    Refunded,
}

#[account]
pub struct EscrowDeposit {
    pub source_vault: Pubkey,      // 32
    pub destination_vault: Pubkey, // 32
    pub escrow_id: u64,            // 8
    pub amount: u64,               // 8 — NET amount (after fees)
    pub token_mint: Pubkey,        // 32
    pub created_at: i64,           // 8
    pub expires_at: i64,           // 8
    pub status: EscrowStatus,      // 1
    pub condition_hash: [u8; 32],  // 32 — SHA-256 or [0u8;32] for unconditional
    pub bump: u8,                  // 1
}
// SIZE = 8 + 32 + 32 + 8 + 8 + 32 + 8 + 8 + 1 + 32 + 1 = 170

impl EscrowDeposit {
    pub const SIZE: usize = 170;
}
