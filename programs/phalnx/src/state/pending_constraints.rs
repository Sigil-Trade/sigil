use anchor_lang::prelude::*;

use super::constraints::ConstraintEntry;

/// Queued instruction constraints update that becomes executable after
/// a timelock period. Mirrors `PendingPolicyUpdate` pattern.
///
/// PDA seeds: `[b"pending_constraints", vault.key().as_ref()]`
#[account]
pub struct PendingConstraintsUpdate {
    /// Associated vault pubkey
    pub vault: Pubkey,

    /// New constraint entries to apply
    pub entries: Vec<ConstraintEntry>,

    /// Unix timestamp when this update was queued
    pub queued_at: i64,

    /// Unix timestamp when this update becomes executable
    pub executes_at: i64,

    /// Bump seed for PDA
    pub bump: u8,
}

impl PendingConstraintsUpdate {
    // SIZE = InstructionConstraints::SIZE + queued_at (8) + executes_at (8)
    // = 2355 + 8 + 8 = 2371
    pub const SIZE: usize = 2371;

    /// Returns true if the timelock period has expired and the update
    /// can be applied.
    pub fn is_ready(&self, current_timestamp: i64) -> bool {
        current_timestamp >= self.executes_at
    }
}
