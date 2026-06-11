//! Phase 7 audit-log helpers.
//!
//! Shared utilities for constructing an `AuditEntry` with FRESH sysvar-derived
//! slot/blockhash bytes on every call. Per Audit #1 AUD3-F5, uses
//! `slot_hashes_sysvar` (NOT deprecated `recent_blockhashes_sysvar`).

use anchor_lang::prelude::*;

use crate::state::audit_log_success::AuditEntry;

/// Read the most recent (slot, hash) pair from `slot_hashes_sysvar`.
///
/// Returns `(slot_le4, hash_first3)`:
///   - `slot_le4` = first 4 bytes of `slot_hashes_sysvar[0].slot` in
///     little-endian byte order.
///   - `hash_first3` = first 3 bytes of `slot_hashes_sysvar[0].hash`.
///
/// **Why slot_hashes, not recent_blockhashes:** the `recent_blockhashes`
/// sysvar was DEPRECATED in Solana 1.18+. The replacement is `slot_hashes`
/// — a queryable list of the 512 most recent (slot, hash) pairs. We sample
/// index 0 (most recent) on every audit-log write so the entry encodes
/// per-write temporal binding (C22 / N1).
///
/// **Why an AccountInfo + manual deserialise:** Anchor `Sysvar<SlotHashes>`
/// cannot be used because the sysvar is too large to fit in the syscall
/// scratch buffer. The standard pattern is to deserialise just the head
/// via raw-byte slicing; see `slot_hashes` Anza docs (Jan 2026).
///
/// **Account-level guard:** every Phase 7 call site declares the sysvar
/// account with the Anchor `address = SlotHashes::id()` constraint at the
/// `#[derive(Accounts)]` level, so this helper does NOT re-validate the
/// key at runtime — the framework rejects mismatched sysvar pubkeys
/// before the handler runs.
///
/// Returns zero-filled bytes ONLY when the sysvar is empty (a state that
/// never occurs in practice — there is always at least one slot hash in
/// the cluster history). This is a defensive default; callers should not
/// rely on it.
pub fn read_slot_hash_head(slot_hashes_sysvar: &AccountInfo) -> Result<([u8; 4], [u8; 3])> {
    let data = slot_hashes_sysvar.try_borrow_data()?;

    // SlotHashes serialised layout is:
    //   u64 LE   — number of entries
    //   (u64 slot LE, [u8;32] hash) × N
    //
    // We only need the FIRST entry, so read at most 8 + 8 + 32 = 48 bytes.
    if data.len() < 8 {
        return Ok(([0u8; 4], [0u8; 3]));
    }

    let mut len_bytes = [0u8; 8];
    len_bytes.copy_from_slice(&data[0..8]);
    let n = u64::from_le_bytes(len_bytes);

    // No entries → defensive zero-fill (unreachable in practice).
    if n == 0 || data.len() < 8 + 8 + 32 {
        return Ok(([0u8; 4], [0u8; 3]));
    }

    let mut slot_le4 = [0u8; 4];
    slot_le4.copy_from_slice(&data[8..12]);

    let mut hash_first3 = [0u8; 3];
    hash_first3.copy_from_slice(&data[16..19]);

    Ok((slot_le4, hash_first3))
}

/// Build an `AuditEntry` from the four "what happened" fields plus a sysvar
/// account info. Reads slot/blockhash FRESH from the sysvar on every call —
/// callers MUST NOT cache the returned bytes across instructions.
///
/// `subject` is the 32-byte pubkey stored at the entry's leading `subject`
/// slot. Its semantic is discriminator-dependent — see
/// `state::audit_log_success::AuditEntry::subject` for the per-discriminator
/// table. §RP-1 HIGH-2 (2026-05-19): previously named `target_protocol`, but
/// only finalize_session honoured that name; renamed to `subject` to remove
/// the misleading per-discriminator overload.
#[allow(clippy::too_many_arguments)]
pub fn build_audit_entry(
    discriminator: u8,
    subject: Pubkey,
    balance_delta_in: i64,
    balance_delta_out: i64,
    timestamp: i64,
    slot_hashes_sysvar: &AccountInfo,
) -> Result<AuditEntry> {
    let (slot_hash, blockhash) = read_slot_hash_head(slot_hashes_sysvar)?;
    Ok(AuditEntry {
        subject: subject.to_bytes(),
        balance_delta_in,
        balance_delta_out,
        timestamp,
        slot_hash,
        blockhash,
        discriminator,
    })
}
