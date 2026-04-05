use anchor_lang::prelude::*;

use super::constraints::{ConstraintEntryZC, MAX_CONSTRAINT_ENTRIES};

/// Queued instruction constraints update that becomes executable after
/// a timelock period. Mirrors `PendingPolicyUpdate` pattern.
///
/// PDA seeds: `[b"pending_constraints", vault.key().as_ref()]`
///
/// Zero-copy layout — same entries array as InstructionConstraints
/// plus queued_at and executes_at timestamps.
#[account(zero_copy)]
pub struct PendingConstraintsUpdate {
    /// Associated vault pubkey (as raw bytes for Pod compatibility)
    pub vault: [u8; 32],

    /// New constraint entries to apply (fixed array, use entry_count for active)
    pub entries: [ConstraintEntryZC; MAX_CONSTRAINT_ENTRIES],

    /// Number of active entries (0..=64)
    pub entry_count: u8,

    /// Whether to reject programs without matching constraint entries (0 = permissive, non-zero = strict)
    pub strict_mode: u8,

    /// Bump seed for PDA
    pub bump: u8,

    /// Alignment padding
    pub _padding: [u8; 5],

    /// Unix timestamp when this update was queued
    pub queued_at: i64,

    /// Unix timestamp when this update becomes executable
    pub executes_at: i64,
}

impl PendingConstraintsUpdate {
    // SIZE = 8 (disc) + 32 (vault) + 64*560 (entries) + 1+1+1+5 (flags+pad) + 8+8 (timestamps)
    // = 8 + 32 + 35840 + 8 + 16 = 35,904 bytes
    pub const SIZE: usize = 8 + 32 + (560 * MAX_CONSTRAINT_ENTRIES) + 1 + 1 + 1 + 5 + 8 + 8;

    /// Returns true if the timelock period has expired and the update
    /// can be applied.
    pub fn is_ready(&self, current_timestamp: i64) -> bool {
        current_timestamp >= self.executes_at
    }
}
