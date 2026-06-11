use anchor_lang::prelude::*;

/// Phase 8 — C26 ownership transfer pending state.
///
/// Two-step ownership migration with mandatory timelock. The OWNER initiates
/// a transfer to a `new_owner` pubkey (any address — EOA or Squads V4 PDA),
/// the timelock elapses (default 172,800s = 48h), then either:
///   - `new_owner` (standard) calls `accept_ownership_transfer`, OR
///   - the multisig PDA itself (via Squads) calls
///     `accept_ownership_transfer_multisig` (Batch 4 — `is_multisig_target == true`).
///
/// The PDA closes on accept (rent → `new_owner`) or cancel (rent → `current_owner`).
/// `freeze_vault` will be wired to cancel any in-flight transfer atomically in
/// a subsequent batch (today's batch only ships the three owner-side
/// instructions plus the PDA).
///
/// Layout matches `Self::SIZE` exactly — the 6-byte tail padding keeps the
/// account's total bytes 8-aligned for downstream zero-copy compat and gives
/// us a safe additive cushion (any new field ≤ 6 bytes can land without
/// growing the PDA).
#[account]
#[derive(Default)]
pub struct PendingOwnershipTransfer {
    /// PDA-bound vault. Defense-in-depth duplicate of the [b"pending_owner",
    /// vault.key()] seed — also lets handlers reject stale accounts that were
    /// re-created against a different vault during a close-then-reuse race.
    pub vault: Pubkey, // 32

    /// Owner pubkey at queue time. `cancel_ownership_transfer` requires the
    /// signer match this field exactly (in addition to `has_one = owner` on
    /// the vault), and the PDA's rent reverts here on cancel.
    pub current_owner: Pubkey, // 32

    /// Target owner. `accept_ownership_transfer` requires the signer match
    /// this field exactly (standard EOA path). Multisig variant in Batch 4
    /// will also bind here when `is_multisig_target == true`.
    pub new_owner: Pubkey, // 32

    /// `Clock::unix_timestamp` at queue time. Timelock is enforced as
    /// `clock.unix_timestamp - queued_at >= min_delay_seconds`.
    pub queued_at: i64, // 8

    /// Owner-configurable timelock (seconds). Defaults to
    /// `Self::DEFAULT_MIN_DELAY` (172,800 / 48h). Owner can shorten in a
    /// future SDK call if `policy.timelock_duration` permits, but Batch 3
    /// pins the default — extension hook lives in Batch 4+.
    pub min_delay_seconds: u64, // 8

    /// `true` means the accept path will be `accept_ownership_transfer_multisig`
    /// (Batch 4 — Squads V4 vault-PDA-signs flow). `false` means the standard
    /// EOA accept path. Today's `accept_ownership_transfer` HARD-REJECTS when
    /// this is `true` so the multisig flow cannot be silently taken by the
    /// regular handler before Batch 4 ships.
    pub is_multisig_target: bool, // 1

    /// PDA bump.
    pub bump: u8, // 1

    /// 8-byte alignment cushion + additive headroom for Batch 4+ extensions
    /// (e.g. cooldown packing, multisig-attestation digest). Zero-init on
    /// `init` and unread today.
    pub _padding: [u8; 6], // 6

    /// CH-1 close (Bucket-3 audit 2026-05-23): slot at queue time for
    /// F-10 freshness. See pending_agent_grant.rs for the threat model.
    pub queued_at_slot: u64, // 8
}

impl PendingOwnershipTransfer {
    /// Account discriminator (8) + Pubkey×3 (96) + i64 (8) + u64 (8) +
    /// bool (1) + u8 (1) + padding[6] (6) + queued_at_slot (8) = 136 bytes.
    /// CH-1 close (Bucket-3 audit 2026-05-23): +8 bytes for `queued_at_slot`.
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 6 + 8;

    /// Default timelock: 48 hours (matches the policy-update / agent-perms
    /// pattern used elsewhere in the program and gives the owner a clear
    /// observation window to cancel a phished-key initiation).
    pub const DEFAULT_MIN_DELAY: u64 = 172_800;
}

/// Compile-time pin — any drift in the documented byte layout breaks the
/// build. Mirrors the §RP-1 pattern used for AuditEntry / SessionAuthority.
/// CH-1 close (Bucket-3 audit 2026-05-23): bumped 128 → 136 bytes (+8 for
/// `queued_at_slot`).
const _PENDING_OWNERSHIP_SIZE_PIN: () = assert!(
    PendingOwnershipTransfer::SIZE == 136,
    "PendingOwnershipTransfer::SIZE drifted from documented 136 bytes (CH-1 Bucket-3 baseline)",
);
