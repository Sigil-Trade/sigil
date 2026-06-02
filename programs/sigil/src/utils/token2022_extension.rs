//! TA-08 (Phase 3 pre-execution guard #5): Token-2022 mint extension
//! ALLOWLIST.
//!
//! Walks the TLV blob trailing the base Mint layout in a Token-2022 mint
//! account. Allowlists exactly the custody-safe, measurement-inert extension
//! type IDs (F-Q4 accept-set):
//!   - MemoTransfer (id 8)
//!   - MetadataPointer (id 18)
//!   - TokenMetadata (id 19)
//!   - GroupPointer (id 20), TokenGroup (id 21),
//!     GroupMemberPointer (id 22), TokenGroupMember (id 23)
//!
//! NonTransferable (id 9) is NOT allowlisted — a vault that acquires such a
//! token can never move it out (tier-1 lockout / trapped capital). Any other
//! extension — including the DRAIN/FREEZE/MEASUREMENT-BREAK ones
//! (PermanentDelegate, TransferHook, ConfidentialTransfer, TransferFee,
//! DefaultAccountState, …) and future-added type IDs we don't yet know about —
//! REJECTS with `ErrToken2022ExtensionForbidden` (6079). The forward-secure
//! default is REJECT (not skip), so a future extension with hostile semantics
//! cannot slip past.
//!
//! ## TLV layout
//!
//! A Token-2022 mint WITH extensions lays out its data as (authoritative:
//! spl-token-2022 `type_and_tlv_indices`):
//!
//!   ```text
//!   bytes 0..82       base Mint (legacy SPL layout)
//!   bytes 82..165     zero padding (out to Account::LEN, so a mint-with-
//!                     extensions is distinguishable from a 165-byte Account)
//!   byte  165         AccountType discriminator (1 = Mint, 2 = Account)
//!   bytes 166..       TLV: [u16 LE type, u16 LE len, bytes data]+
//!   ```
//!
//! A bare mint with NO extensions is exactly 82 bytes — no padding, no
//! AccountType byte — so we skip the TLV walk for any account whose data length
//! is `<= 82`. A length in `83..=165` is a malformed mint, rejected fail-closed.
//!
//! For accounts with `> 165` bytes, we assert the [82..165] padding is zero and
//! byte 165 == 1 (Mint type), then walk the TLV from byte 166. Each entry
//! consumes 4 header bytes (type + len, both u16 LE). The walk stops at end of
//! buffer OR `type == 0` (Uninitialized — Token-2022's "no more extensions"
//! sentinel).
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

/// Token-2022 Mint AccountType discriminator. For a mint WITH extensions this
/// byte lives at index 165 (Account::LEN), NOT 82 — a mint-with-extensions is
/// zero-padded from its 82-byte base out to 165 so it cannot be confused with a
/// 165-byte token Account. Value 1 = Mint, 2 = Account, 0 = Uninitialized.
const TOKEN_2022_ACCOUNT_TYPE_MINT: u8 = 1;

/// Token-2022 base Mint layout size (a bare mint, no extensions): 82 bytes,
/// identical to the legacy SPL Token Mint.
const TOKEN_2022_MINT_BASE_LEN: usize = 82;

/// Index of the AccountType byte in a Token-2022 mint-WITH-extensions buffer.
/// Authoritative (spl-token-2022 `type_and_tlv_indices`):
/// `account_type_index = BASE_ACCOUNT_LENGTH = Account::LEN = 165`; the TLV
/// blob begins at 166; bytes [82..165] are zero padding the program enforces.
const TOKEN_2022_ACCOUNT_TYPE_INDEX: usize = 165;

/// Token-2022 extension type ID: Uninitialized (sentinel for "no more
/// extensions"). Walker treats this as end-of-list.
const EXT_UNINITIALIZED: u16 = 0;

// ─── Allowlist (forward-secure: accept known custody-safe, reject all else) ──
// Accept ONLY custody-safe, measurement-inert mint extensions. Everything else
// — including unknown/future IDs and all DRAIN / FREEZE / MEASUREMENT-BREAK
// extensions — REJECTS (fail-closed, zero monitoring burden).
//
// F-Q4 (2026-06-02) accept-set revision:
//  - REMOVED NonTransferable(9): a vault that ACQUIRES it can never move the
//    token out = trapped capital = tier-1 lockout (permanent loss of control,
//    ranked equal to theft). A spending vault has no use for an unspendable
//    token, so admitting it only creates a brick vector.
//  - ADDED the inert metadata/group extensions (19-23): they carry no
//    transfer/freeze/amount semantics; rejecting them would reject legitimate
//    well-formed metadata-bearing Token-2022 tokens (MetadataPointer +
//    TokenMetadata is the common pairing) for no custody reason.

/// MemoTransfer = 8 (benign: requires a memo on transfer; no custody effect).
const EXT_MEMO_TRANSFER: u16 = 8;

/// MetadataPointer = 18 (benign: points to the metadata account).
const EXT_METADATA_POINTER: u16 = 18;

/// TokenMetadata = 19 (benign: inline name/symbol/URI; the update authority can
/// rename but cannot move/freeze/rescale the vault's holding).
const EXT_TOKEN_METADATA: u16 = 19;

/// GroupPointer = 20 (benign: points to a token-group config account).
const EXT_GROUP_POINTER: u16 = 20;

/// TokenGroup = 21 (benign: inline group/collection root data).
const EXT_TOKEN_GROUP: u16 = 21;

/// GroupMemberPointer = 22 (benign: points to a group-member config account).
const EXT_GROUP_MEMBER_POINTER: u16 = 22;

/// TokenGroupMember = 23 (benign: inline group-membership data).
const EXT_TOKEN_GROUP_MEMBER: u16 = 23;

/// Returns true iff the extension type ID is on the custody-safe allowlist.
fn is_allowlisted_extension(ext_type: u16) -> bool {
    matches!(
        ext_type,
        EXT_MEMO_TRANSFER
            | EXT_METADATA_POINTER
            | EXT_TOKEN_METADATA
            | EXT_GROUP_POINTER
            | EXT_TOKEN_GROUP
            | EXT_GROUP_MEMBER_POINTER
            | EXT_TOKEN_GROUP_MEMBER
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
///   - Otherwise the mint is zero-padded to Account::LEN (165): asserts the
///     [82..165] padding is zero and byte 165 == 1 (Mint AccountType), then
///     walks the TLV blob from byte 166 onward.
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

    // 2) No extensions present (a bare Token-2022 mint is exactly the 82-byte
    //    base, identical to a legacy SPL mint).
    if data_len <= TOKEN_2022_MINT_BASE_LEN {
        return Ok(());
    }

    // 3) A Token-2022 mint WITH extensions is zero-padded out to Account::LEN
    //    (165) — so it can't be confused with a 165-byte token Account — then
    //    carries the AccountType byte at index 165 and the TLV blob from 166.
    //    Anything 83..=165 bytes is a malformed mint → fail closed.
    require!(
        data_len > TOKEN_2022_ACCOUNT_TYPE_INDEX,
        SigilError::ErrToken2022ExtensionForbidden
    );

    // 3a) The [82..165] region MUST be zero padding (program-enforced on every
    //     write). A non-zero byte there is malformed / non-standard → reject.
    require!(
        data[TOKEN_2022_MINT_BASE_LEN..TOKEN_2022_ACCOUNT_TYPE_INDEX]
            .iter()
            .all(|b| *b == 0),
        SigilError::ErrToken2022ExtensionForbidden
    );

    // 3b) AccountType byte (index 165) must be Mint (1). Any other value
    //     (e.g. 2 = Account) is the wrong account kind — reject.
    require!(
        data[TOKEN_2022_ACCOUNT_TYPE_INDEX] == TOKEN_2022_ACCOUNT_TYPE_MINT,
        SigilError::ErrToken2022ExtensionForbidden
    );

    // 4) Walk the TLV from index 166 (immediately after the AccountType byte).
    //    Each entry consumes 4 header bytes (2 type, 2 len) plus `len` data.
    let mut cursor = TOKEN_2022_ACCOUNT_TYPE_INDEX
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
        if data.len() <= TOKEN_2022_ACCOUNT_TYPE_INDEX {
            return Err(6079); // 83..=165 bytes = malformed mint
        }
        if data[TOKEN_2022_MINT_BASE_LEN..TOKEN_2022_ACCOUNT_TYPE_INDEX]
            .iter()
            .any(|b| *b != 0)
        {
            return Err(6079); // [82..165] padding must be zero
        }
        if data[TOKEN_2022_ACCOUNT_TYPE_INDEX] != TOKEN_2022_ACCOUNT_TYPE_MINT {
            return Err(6079);
        }
        let mut cursor = TOKEN_2022_ACCOUNT_TYPE_INDEX + 1;
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

    /// Build a mock Token-2022 mint buffer in the REAL layout: 82-byte base
    /// zero-padded out to Account::LEN (165), the AccountType byte at 165, then
    /// a series of (type, len, payload) TLV entries from 166.
    fn mock_mint(extensions: &[(u16, &[u8])]) -> Vec<u8> {
        let mut buf = vec![0u8; TOKEN_2022_ACCOUNT_TYPE_INDEX]; // [0..165] base + zero padding
        buf.push(TOKEN_2022_ACCOUNT_TYPE_MINT); // [165] AccountType = Mint
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
    fn non_transferable_rejects() {
        // F-Q4: NonTransferable (ID 9) is REMOVED from the allowlist — a vault
        // that acquires such a token can never move it out (tier-1 lockout /
        // trapped capital), so it must now REJECT. 0-byte extension (no payload).
        let buf = mock_mint(&[(9, &[])]);
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn memo_transfer_only_accepts() {
        let buf = mock_mint(&[(EXT_MEMO_TRANSFER, &[1u8])]);
        assert!(walk_mint_tlv(&buf).is_ok());
    }

    #[test]
    fn allowlisted_extensions_accept() {
        // F-Q4 accept-set core: MemoTransfer(8) + MetadataPointer(18).
        let buf = mock_mint(&[
            (EXT_MEMO_TRANSFER, &[1u8]),
            (EXT_METADATA_POINTER, &[0u8; 64]),
        ]);
        assert!(walk_mint_tlv(&buf).is_ok());
    }

    #[test]
    fn metadata_and_group_extensions_accept() {
        // F-Q4: the inert metadata/group extensions (19-23) are custody-safe
        // (no transfer/freeze/amount semantics) and must ACCEPT, so legitimate
        // metadata-bearing Token-2022 tokens are not rejected.
        for ext_id in [
            EXT_TOKEN_METADATA,
            EXT_GROUP_POINTER,
            EXT_TOKEN_GROUP,
            EXT_GROUP_MEMBER_POINTER,
            EXT_TOKEN_GROUP_MEMBER,
        ] {
            let buf = mock_mint(&[(ext_id, &[0u8; 16])]);
            assert!(
                walk_mint_tlv(&buf).is_ok(),
                "extension {ext_id} should be allowlisted",
            );
        }
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
        let mut buf = vec![0u8; TOKEN_2022_ACCOUNT_TYPE_INDEX]; // base + zero padding
        buf.push(TOKEN_2022_ACCOUNT_TYPE_MINT); // AccountType @ 165
        buf.extend_from_slice(&EXT_METADATA_POINTER.to_le_bytes());
        buf.extend_from_slice(&(65000u16).to_le_bytes()); // huge length
        buf.extend_from_slice(&[0u8; 32]); // far less than 65000
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }

    #[test]
    fn account_type_non_mint_rejects() {
        // AccountType byte = 2 (Account) instead of 1 (Mint) — reject.
        let mut buf = vec![0u8; TOKEN_2022_ACCOUNT_TYPE_INDEX]; // base + zero padding
        buf.push(2); // AccountType @ 165 = Account (not Mint) → reject
        buf.extend_from_slice(&EXT_METADATA_POINTER.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(walk_mint_tlv(&buf), Err(6079));
    }
}
