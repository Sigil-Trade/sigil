use anchor_lang::prelude::*;

use crate::state::audit_log_success::AuditEntry;

/// Number of rejected-path audit entries retained per vault.
/// Half the success capacity per the §6 Phase 7 spec — rejects are sized
/// for the burst observed during a permissionless-crank attack window
/// (Audit #2 F-19), not steady-state operation.
pub const AUDIT_LOG_REJECTED_CAPACITY: usize = 64;

/// On-chain circular log of REJECTED finalize attempts for a vault.
///
/// Phase 7 writes only the `finalize_session` REJECT path (expired-finalize
/// permissionless cranks) into this buffer. Other instructions that error
/// out roll back atomically and produce no audit entry by design.
///
/// Audit #2 F-19 (audit log spam): kept separate from `AuditLogSuccess`
/// so the rejected stream cannot displace the success history. The two
/// buffers share the same `AuditEntry` shape so SDK decoders can be
/// shared.
///
/// Seeds: `[b"audit_rejected", vault.key().as_ref()]`
///
/// **Layout (within 8-byte Anchor discriminator):**
///   0..32      vault       Pubkey
///   32..4128   entries     [AuditEntry; 64]   (64 * 64 = 4,096)
///   4128..4129 head        u8
///   4129..4130 count       u8
///   4130..4143 _padding    [u8;13]
///   4143..4144 bump        u8
///   ──── total data: 4,144 bytes ────
///
/// Including 8-byte Anchor discriminator: **4,152 bytes total.**
///
/// **DEVIATION FROM SPEC:** The Phase 7 spec called for `_padding: [u8;6]`
/// with claimed SIZE = 4,145. Same Pod-alignment issue as `AuditLogSuccess`
/// — `[AuditEntry; 64]` is 8-byte aligned, so the struct must be a multiple
/// of 8. We widen padding from 6 → 13 to reach 4,144 data bytes; SIZE
/// becomes 4,152.
#[account(zero_copy)]
#[repr(C)]
pub struct AuditLogRejected {
    /// Associated vault pubkey. Verified by PDA seeds + has_one constraints
    /// at the instruction layer.
    pub vault: Pubkey, // 32 bytes
    /// Circular-buffer entries. Same shape as success buffer.
    pub entries: [AuditEntry; AUDIT_LOG_REJECTED_CAPACITY], // 64 * 64 = 4,096 bytes
    /// Next write position (0..=CAPACITY-1). Wraps modulo CAPACITY.
    pub head: u8, // 1 byte
    /// Total entries written, saturated at CAPACITY.
    pub count: u8, // 1 byte
    /// 13-byte explicit padding (Pod no-implicit-padding rule + future
    /// forward-compat appends).
    pub _padding: [u8; 13], // 13 bytes
    /// PDA bump seed.
    pub bump: u8, // 1 byte
}

impl AuditLogRejected {
    /// Total account size INCLUDING the 8-byte Anchor discriminator.
    ///
    ///   8 (discriminator) + 32 (vault) + (64 * 64 = 4,096 entries) +
    ///   1 (head) + 1 (count) + 13 (_padding) + 1 (bump) = 4,152 bytes
    pub const SIZE: usize =
        8 + 32 + (AUDIT_LOG_REJECTED_CAPACITY * AuditEntry::SIZE) + 1 + 1 + 13 + 1;

    /// Append a new entry at `head`, advance head modulo CAPACITY, saturate
    /// count at CAPACITY. Used only by the finalize_session REJECT path
    /// in Phase 7.
    pub fn append(&mut self, entry: AuditEntry) {
        let idx = (self.head as usize) % AUDIT_LOG_REJECTED_CAPACITY;
        self.entries[idx] = entry;
        self.head = (((self.head as usize) + 1) % AUDIT_LOG_REJECTED_CAPACITY) as u8;
        if (self.count as usize) < AUDIT_LOG_REJECTED_CAPACITY {
            self.count = self.count.saturating_add(1);
        }
    }
}

// Compile-time SIZE assertion.
// 8 + 32 + 4096 + 1 + 1 + 13 + 1 = 4,152.
const _: () = assert!(AuditLogRejected::SIZE == 4_152);
