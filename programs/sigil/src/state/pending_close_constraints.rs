use anchor_lang::prelude::*;

/// Queued constraint closure. Minimal — just needs the timelock gate.
/// PDA seeds: [b"pending_close_constraints", vault.key().as_ref()]
#[account]
pub struct PendingCloseConstraints {
    pub vault: Pubkey,
    pub queued_at: i64,
    pub executes_at: i64,
    pub bump: u8,
}

impl PendingCloseConstraints {
    /// 8 (discriminator) + 32 (vault) + 8 (queued_at) + 8 (executes_at) + 1 (bump)
    pub const SIZE: usize = 57;

    pub fn is_ready(&self, current_timestamp: i64) -> bool {
        current_timestamp >= self.executes_at
    }
}
