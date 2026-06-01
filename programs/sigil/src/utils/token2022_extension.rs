//! TA-08 (Phase 3 pre-execution guard #5): Token-2022 mint extension
//! ALLOWLIST.
//!
//! Walks the TLV blob trailing the base Mint layout in a Token-2022 mint
//! account. Allowlists exactly 3 extension type IDs (per HARDENED prompt
//! §6 lines 695-704):
//!   - MemoTransfer (id 8)
//!   - NonTransferable (id 9)
//!   - MetadataPointer (id 18)
//!
//! Any other extension — including future-added type IDs we don't yet know
//! about — REJECTS with `ErrToken2022ExtensionForbidden` (6079). The
//! forward-secure default is REJECT (not skip), so a future extension that
//! introduces hostile semantics cannot slip past V1 deposits.
//!
//! ## TLV layout
//!
//! Token-2022 mints lay out their data as:
//!
//!   ```text
//!   bytes 0..82       base Mint (legacy SPL layout)
//!   byte  82          AccountType discriminator (1 = Mint)
//!   bytes 83..        TLV: [u16 LE type, u16 LE len, bytes data]+
//!   ```
//!
//! When the mint has no extensions, the account size is exactly 82 bytes
//! (the legacy Mint size) — the `AccountType` byte is omitted. So we
//! defensively skip the TLV walk for any account whose data length is
//! `<= 82` bytes.
//!
//! For accounts with `> 82` bytes, we assert byte 82 == 1 (Mint type) then
//! walk the TLV starting at byte 83. Each entry consumes 4 header bytes
//! (type + len, both u16 LE). The walk stops when the cursor reaches end
//! of buffer OR encounters `type == 0` (Uninitialized — Token-2022's
//! standard "no more extensions" sentinel).
//!
//! ## Defensive notes
//!
//! - This is layered with the existing validate-time SPL/Token-2022 opcode
//!   blocklist at `validate_and_authorize.rs` (per F-5). BOTH layers
//!   remain in V1 — deposit-time mint allowlist (this file) + runtime
//!   instruction-opcode blocklist (validate_and_authorize).
//! - `try_borrow_data` is used (not `data`) so the borrow lifetime is
//!   bounded and a corrupt mint account triggers an explicit error
//!   instead of a panic.
//! - The walker is bounded by buffer length; a malformed TLV that claims
//!   `len = u16::MAX` while the buffer is shorter will trip the
//!   `cursor + len > data.len()` check and reject.

use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::state::TOKEN_2022_PROGRAM_ID;

/// Token-2022 Mint AccountType discriminator (byte 82 of a Token-2022 mint).
/// Value 1. Value 0 = Uninitialized / no extensions present.
const TOKEN_2022_ACCOUNT_TYPE_MINT: u8 = 1;

/// Token-2022 base Mint layout size, BEFORE the AccountType byte.
/// Identical to the legacy SPL Token Mint layout: 82 bytes.
const TOKEN_2022_MINT_BASE_LEN: usize = 82;

/// Token-2022 extension type ID: Uninitialized (sentinel for "no more
/// extensions"). Walker treats this as end-of-list.
const EXT_UNINITIALIZED: u16 = 0;

// ─── Allowlist (per HARDENED prompt §6 lines 695-704) ────────────────────────
// Exactly 3 extension type IDs are accepted. Anything else (including
// future-added IDs) REJECTS.

/// Extension type ID for MemoTransfer. Source:
/// `spl_token_2022::extension::ExtensionType::MemoTransfer = 8`.
const EXT_MEMO_TRANSFER: u16 = 8;

/// Extension type ID for NonTransferable. Source:
/// `spl_token_2022::extension::ExtensionType::NonTransferable = 9`.
const EXT_NON_TRANSFERABLE: u16 = 9;

/// Extension type ID for MetadataPointer. Source:
/// `spl_token_2022::extension::ExtensionType::MetadataPointer = 18`.
const EXT_METADATA_POINTER: u16 = 18;

/// Returns true iff the extension type ID is on the V1 allowlist.
fn is_allowlisted_extension(ext_type: u16) -> bool {
    matches!(
        ext_type,
        EXT_MEMO_TRANSFER | EXT_NON_TRANSFERABLE | EXT_METADATA_POINTER
    )
}

/// TA-08 main entry: validates the mint at `mint_info` against the
/// Phase 3 V1 extension allowlist.
///
/// Behaviour:
///   - If `mint_info.owner != TOKEN_2022_PROGRAM_ID`, the function is a
///     no-op (SPL-classic mints have no extension surface).
///   - If `mint_info.data.len() <= TOKEN_2022_MINT_BASE_LEN` (82), the
///     mint has no extensions — no-op.
///   - Otherwise, asserts byte 82 == 1 (Mint AccountType) then walks
///     the TLV blob from byte 83 onward.
///   - Each non-Uninitialized extension type ID is checked against the
///     allowlist; first mismatch returns `ErrToken2022ExtensionForbidden`.
///   - A malformed TLV (length-overflows-buffer) returns the same
///     error — fail closed.
pub fn enforce_token2022_extension_allowlist(mint_info: &AccountInfo<'_>) -> Result<()> {
    // 1) Owner check: legacy SPL mints have no extensions to validate.
    if *mint_info.owner != TOKEN_2022_PROGRAM_ID {
        return Ok(());
    }

    let data = mint_info.try_borrow_data()?;
    let data_len = data.len();

    // 2) No extensions present (mint is exactly the base size).
    if data_len <= TOKEN_2022_MINT_BASE_LEN {
        return Ok(());
    }

    // 3) AccountType byte must be Mint (1). Any other value is malformed
    //    or a non-Mint account — reject.
    require!(
        data[TOKEN_2022_MINT_BASE_LEN] == TOKEN_2022_ACCOUNT_TYPE_MINT,
        SigilError::ErrToken2022ExtensionForbidden
    );

    // 4) Walk the TLV. Cursor starts immediately after the AccountType
    //    byte (i.e. at index 83). Each entry consumes 4 header bytes
    //    (2 for type, 2 for len) plus `len` data bytes.
    let mut cursor = TOKEN_2022_MINT_BASE_LEN
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    // Defensive iteration bound: at minimum 4 bytes per extension. So
    // the worst-case iteration count is `data_len / 4`. In practice
    // Token-2022 mints have <10 extensions. A bound of 64 is comfortably
    // above any legitimate count and below any DoS-pad attack.
    const MAX_TLV_ITERATIONS: usize = 64;
    let mut iter_count: usize = 0;

    while cursor + 4 <= data_len {
        require!(
            iter_count < MAX_TLV_ITERATIONS,
            SigilError::ErrToken2022ExtensionForbidden
        );
        iter_count = iter_count.saturating_add(1);

        let ext_type = u16::from_le_bytes([data[cursor], data[cursor + 1]]);
        let ext_len = u16::from_le_bytes([data[cursor + 2], data[cursor + 3]]) as usize;

        // Uninitialized = end-of-list sentinel. Done.
        if ext_type == EXT_UNINITIALIZED {
            break;
        }

        // Reject any extension not on the allowlist.
        require!(
            is_allowlisted_extension(ext_type),
            SigilError::ErrToken2022ExtensionForbidden
        );

        // Length overflow safety: header (4) + payload (ext_len) must fit.
        let next = cursor
            .checked_add(4)
            .ok_or(error!(SigilError::ErrToken2022ExtensionForbidden))?
            .checked_add(ext_len)
            .ok_or(error!(SigilError::ErrToken2022ExtensionForbidden))?;
        // Reject TLV that claims to extend past the buffer.
        require!(next <= data_len, SigilError::ErrToken2022ExtensionForbidden);

        cursor = next;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The on-chain validator uses `AccountInfo<'_>`, which is awkward to
    // synthesize from raw bytes in a unit test (AccountInfo wants a
    // `RefCell<&'info mut [u8]>`). For unit tests we exercise the core
    // walker logic via a standalone function over `&[u8]`.

    /// Same walking logic as `enforce_token2022_extension_allowlist` but
    /// operating directly on a byte slice. Used by unit tests.
    fn walk_mint_tlv(data: &[u8]) -> std::result::Result<(), u32> {
        if data.len() <= TOKEN_2022_MINT_BASE_LEN {
            return Ok(());
        }
        if data[TOKEN_2022_MINT_BASE_LEN] != TOKEN_2022_ACCOUNT_TYPE_MINT {
            return Err(6079);
        }
        let mut cursor = TOKEN_2022_MINT_BASE_LEN + 1;
        let mut iter = 0;
        while cursor + 4 <= data.len() {
            if iter >= 64 {
                return Err(6079);
            }
            iter += 1;
            let ext_type = u16::from_le_bytes([data[cursor], data[cursor + 1]]);
            let ext_len = u16::from_le_bytes([data[cursor + 2], data[cursor + 3]]) as usize;
            if ext_type == EXT_UNINITIALIZED {
                break;
            }
            if !is_allowlisted_extension(ext_type) {
                return Err(6079);
            }
            let next = cursor + 4 + ext_len;
            if next > data.len() {
                return Err(6079);
            }
            cursor = next;
        }
        Ok(())
    }

    /// Build a minimal mock Token-2022 mint buffer: 82 zero bytes (base
    /// layout doesn't matter for the TLV walker), one AccountType byte,
    /// then a series of (type, len, payload) entries.
    fn mock_mint(extensions: &[(u16, &[u8])]) -> Vec<u8> {
        let mut buf = vec![0u8; TOKEN_2022_MINT_BASE_LEN];
        buf.push(TOKEN_2022_ACCOUNT_TYPE_MINT);
        for (ext_type, payload) in extensions {
            buf.extend_from_slice(&ext_type.to_le_bytes());
            let len: u16 = payload.len() as u16;
            buf.extend_from_slice(&len.to_le_bytes());
            buf.extend_from_slice(payload);
        }
        buf
    }

    #[test]
    fn no_extensions_accepts() {
        // 82-byte mint = base layout, no extensions at all.
        let buf = vec![0u8; TOKEN_2022_MINT_BASE_LEN];
        assert!(walk_mint_tlv(&buf).is_ok());
    }

    #[test]
    fn metadata_pointer_only_accepts() {
        let buf = mock_mint(&[(EXT_METADATA_POINTER, &[0u8; 64])]);
        assert!(walk_mint_tlv(&buf).is_ok());
    }

    #[test]
    fn non_transferable_only_accepts() {
        // NonTransferable is a 0-byte extension (no payload).
        let buf = mock_mint(&[(EXT_NON_TRANSFERABLE, &[])]);
        assert!(walk_mint_tlv(&buf).is_ok());
    }

    #[test]
    fn memo_transfer_only_accepts() {
        let buf = mock_mint(&[(EXT_MEMO_TRANSFER, &[1u8])]);
        assert!(walk_mint_tlv(&buf).is_ok());
    }

    #[test]
    fn all_three_allowlist_extensions_accept() {
        let buf = mock_mint(&[
            (EXT_MEMO_TRANSFER, &[1u8]),
            (EXT_NON_TRANSFERABLE, &[]),
            (EXT_METADATA_POINTER, &[0u8; 64]),
        ]);
        assert!(walk_mint_tlv(&buf).is_ok());
    }

    #[test]
    fn transfer_fee_config_rejects() {
        // ExtensionType::TransferFeeConfig = 1 — NOT on allowlist.
        let buf = mock_mint(&[(1, &[0u8; 64])]);
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn permanent_delegate_rejects() {
        // ExtensionType::PermanentDelegate = 12 — NOT on allowlist.
        let buf = mock_mint(&[(12, &[0u8; 32])]);
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn transfer_hook_rejects() {
        // ExtensionType::TransferHook = 14 — NOT on allowlist.
        let buf = mock_mint(&[(14, &[0u8; 64])]);
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn confidential_transfer_mint_rejects() {
        // ExtensionType::ConfidentialTransferMint = 4 — NOT on allowlist.
        let buf = mock_mint(&[(4, &[0u8; 32])]);
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn default_account_state_rejects() {
        // ExtensionType::DefaultAccountState = 6 — NOT on allowlist.
        let buf = mock_mint(&[(6, &[1u8])]);
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn future_extension_id_rejects_forward_secure() {
        // A future-added extension type ID (e.g. 99) must REJECT — the
        // forward-secure default closes the gap where an attacker could
        // introduce hostile semantics in a new extension we haven't yet
        // catalogued.
        let buf = mock_mint(&[(99, &[0u8; 32])]);
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn mixed_allowlist_plus_forbidden_rejects_at_forbidden() {
        // Allowlist entry FIRST, then a forbidden entry — must REJECT.
        let buf = mock_mint(&[
            (EXT_MEMO_TRANSFER, &[1u8]),
            (1, &[0u8; 64]), // TransferFeeConfig — forbidden
        ]);
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn uninitialized_sentinel_stops_walk() {
        // After EXT_UNINITIALIZED (0), the walker stops. Any bytes after
        // are NOT scanned. (Bytes-after-uninit are leftover padding.)
        let mut buf = mock_mint(&[(EXT_METADATA_POINTER, &[0u8; 64])]);
        // Append a 0-type entry (uninitialized) then garbage.
        buf.extend_from_slice(&0u16.to_le_bytes()); // type = 0
        buf.extend_from_slice(&0u16.to_le_bytes()); // len = 0
        buf.extend_from_slice(&[0xFFu8; 16]); // garbage past sentinel
        assert!(walk_mint_tlv(&buf).is_ok());
    }

    #[test]
    fn malformed_length_overflow_rejects() {
        // Claim length = 65000 but actual buffer is shorter — must REJECT.
        let mut buf = vec![0u8; TOKEN_2022_MINT_BASE_LEN];
        buf.push(TOKEN_2022_ACCOUNT_TYPE_MINT);
        buf.extend_from_slice(&EXT_METADATA_POINTER.to_le_bytes());
        buf.extend_from_slice(&(65000u16).to_le_bytes()); // huge length
        buf.extend_from_slice(&[0u8; 32]); // far less than 65000
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn account_type_non_mint_rejects() {
        // AccountType byte = 2 (Account) instead of 1 (Mint) — reject.
        let mut buf = vec![0u8; TOKEN_2022_MINT_BASE_LEN];
        buf.push(2);
        buf.extend_from_slice(&EXT_METADATA_POINTER.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }
}
