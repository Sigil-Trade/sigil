//! Phase 6 R-1 MintDeltaCap support helpers.
//!
//! Two entry shapes:
//!
//! - `scope=0` (vault-wide canonical-ATA only): sum the SPL Token classic
//!   ATA plus the Token-2022 ATA for `(vault, mint)`. Up to
//!   `MAX_ATAS_PER_MINT` PDAs are enumerated. Today's realistic max is 2
//!   ATAs per (vault, mint) pair (one per token program); slots 2-4 are
//!   reserved for future SIMD-style ATA programs but currently unused —
//!   adding a third would silently lower CU headroom without test coverage,
//!   so derivation stays at 2.
//!
//!   §RP MED (Phase 6 review) scope=0 footgun: this branch enumerates
//!   **ONLY canonical ATAs**. Vault-owned NON-canonical token accounts —
//!   protocol-auto-created position-tied accounts (Drift user spot, Kamino
//!   reserve user, Marginfi insurance fund, Jupiter Perps PositionRequest)
//!   or manually-created token accounts where the vault PDA is the
//!   authority — are **NOT** covered by scope=0. An agent draining such an
//!   account leaves the sum unchanged and the cap silently passes. Use
//!   scope=1 with `target_account` set to the non-canonical account to
//!   close that gap. Future phases may add a scope=2 = "enumerate via
//!   remaining_accounts" for vaults that hold many non-canonical accounts
//!   per mint.
//!
//!   §RP CRIT-2 (Phase 6 review) omission posture: every derived ATA pubkey
//!   MUST be in `remaining_accounts`. Previously a `None => continue`
//!   silently skipped omitted PDAs; an agent could then drain a real ATA
//!   while pre_sum/post_sum both measured 0 for it. The new posture is the
//!   symmetric of scope=1: missing → `MintDeltaCapMisconfigured`. An ATA
//!   that has never been initialized (zero-length data buffer) is detected
//!   in-place and treated as balance=0; the caller must still pass its
//!   derived pubkey.
//!
//! - `scope=1` (single account): read the entry's `target_account` directly.
//!   The caller is responsible for declaring which token account they want
//!   measured (typical pattern: a non-canonical program-owned vault account).
//!
//! Token-2022 accounts may carry extension data after byte 165, but the
//! canonical fields (mint, owner, amount) live at the same offsets as SPL
//! classic: 0..32, 32..64, 64..72. We read those slices directly rather than
//! calling `Account::unpack`, which would fail on Token-2022 extension-bearing
//! accounts. The raw read keeps R-1 protocol-agnostic across both token
//! programs.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

use crate::errors::SigilError;
use crate::state::post_assertions::MAX_ATAS_PER_MINT;
use crate::state::TOKEN_2022_PROGRAM_ID;

/// SPL classic Token program — bound at compile time via anchor_spl re-export.
fn spl_token_id() -> Pubkey {
    anchor_spl::token::ID
}

/// Derive every plausible vault-owned ATA for `(vault, mint)` across the
/// known token programs. Returns at most `MAX_ATAS_PER_MINT` PDAs.
///
/// Order is deterministic — SPL classic first, then Token-2022 — so the same
/// (vault, mint) pair always produces the same enumeration regardless of
/// caller. Off-chain decoders depend on the order for replaying the snapshot
/// sum from the post-execution state.
pub fn derive_vault_atas(vault: &Pubkey, mint: &Pubkey) -> Vec<Pubkey> {
    let mut atas = Vec::with_capacity(MAX_ATAS_PER_MINT);
    // 1. SPL classic.
    atas.push(get_associated_token_address_with_program_id(
        vault,
        mint,
        &spl_token_id(),
    ));
    // 2. Token-2022.
    atas.push(get_associated_token_address_with_program_id(
        vault,
        mint,
        &TOKEN_2022_PROGRAM_ID,
    ));
    // Slots 2..MAX_ATAS_PER_MINT are reserved for future ATA programs but
    // not derived today — adding them would silently lower CU headroom
    // without coverage. The cap is the upper bound, not the floor.
    atas
}

/// Read the canonical SPL/Token-2022 amount field (bytes 64..72, u64 LE) from
/// an account. Returns `None` if the account isn't owned by a known token
/// program OR if the data buffer is too short to hold the fixed prefix.
///
/// **Why not unpack:** Token-2022 accounts carry TLV extension data after the
/// fixed 165-byte base layout. `spl_token::state::Account::unpack` will
/// reject a Token-2022 extension-bearing account because its packed length
/// doesn't equal 165. Reading the raw bytes at the prefix offsets is the
/// protocol-agnostic move — the layout has been stable since SPL Token v1.
fn read_token_amount(info: &AccountInfo) -> Option<u64> {
    if info.owner != &spl_token_id() && info.owner != &TOKEN_2022_PROGRAM_ID {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() < 72 {
        return None;
    }
    let mut amount_bytes = [0u8; 8];
    amount_bytes.copy_from_slice(&data[64..72]);
    Some(u64::from_le_bytes(amount_bytes))
}

/// Read the owner field (bytes 32..64) of a token account.
fn read_token_owner(info: &AccountInfo) -> Option<Pubkey> {
    if info.owner != &spl_token_id() && info.owner != &TOKEN_2022_PROGRAM_ID {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() < 64 {
        return None;
    }
    let mut owner_bytes = [0u8; 32];
    owner_bytes.copy_from_slice(&data[32..64]);
    Some(Pubkey::new_from_array(owner_bytes))
}

/// Read the mint field (bytes 0..32) of a token account.
fn read_token_mint(info: &AccountInfo) -> Option<Pubkey> {
    if info.owner != &spl_token_id() && info.owner != &TOKEN_2022_PROGRAM_ID {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() < 32 {
        return None;
    }
    let mut mint_bytes = [0u8; 32];
    mint_bytes.copy_from_slice(&data[0..32]);
    Some(Pubkey::new_from_array(mint_bytes))
}

/// Sum the balances of vault-owned ATAs for `mint` (scope=0) OR a single
/// declared account (scope=1).
///
/// **scope=0 semantic:** iterate the derived ATA list; for each derived PDA
/// that the caller has actually included in `remaining_accounts`, validate
/// (a) the account is owned by a known token program, (b) the deserialized
/// mint matches, (c) the deserialized owner is the vault, then add its
/// balance. Missing derived ATAs contribute 0 — this is the legitimate case
/// where the vault has no balance in that token program.
///
/// **scope=1 semantic:** require `target_account` to be in
/// `remaining_accounts`; validate ownership = vault AND mint matches; return
/// its balance. Any mismatch errors with `MintDeltaCapMisconfigured` so the
/// caller can correct the entry rather than silently passing a 0-balance.
///
/// **CU bound:** `MAX_ATAS_PER_MINT` (5) PDA derivations + per-derivation
/// linear scan over `remaining_accounts`. Phase 6 sets the cap so worst-case
/// CU stays inside the existing finalize budget.
pub fn sum_vault_mint_balance(
    vault: &Pubkey,
    mint: &Pubkey,
    scope: u8,
    target_account: &Pubkey,
    remaining: &[AccountInfo],
) -> Result<u64> {
    match scope {
        0 => {
            let derived = derive_vault_atas(vault, mint);
            let mut sum: u64 = 0;
            for pda in derived.iter().take(MAX_ATAS_PER_MINT) {
                // §RP CRIT-2 (Phase 6 review): the caller MUST include every
                // derived ATA pubkey in remaining_accounts. Previously this
                // loop silently skipped missing derived PDAs (`None => continue`),
                // which allowed an agent to drain an existing ATA mid-sandwich
                // simply by omitting it at validate (pre_sum = 0) and re-
                // including it at finalize (post_sum = 500K, saturating_sub
                // = 0 — R-1 passes). The fix mirrors scope=1's pattern: the
                // derived ATA must be present.
                //
                // Accounts that have NEVER been initialized on chain (no
                // SystemProgram-allocated data buffer) ARE legitimately missing
                // a balance. The caller still has to pass the derived pubkey
                // in remaining_accounts; the helper detects an uninitialized
                // account via `data.is_empty()` (zero-length buffer) OR a
                // wrong owner program, and treats either as balance = 0.
                // The agent cannot use this to evade the check because an
                // uninitialized ATA cannot hold value mid-sandwich; the moment
                // the agent funds it, the account becomes initialized and
                // subsequent reads see the real balance.
                let info = remaining
                    .iter()
                    .find(|a| a.key() == *pda)
                    .ok_or(error!(SigilError::MintDeltaCapMisconfigured))?;

                // Uninitialized account at this derived PDA — treated as
                // balance 0. This is the legitimate case where the vault has
                // never created the variant (e.g., vault holds SPL classic but
                // never opened a Token-2022 ATA for the same mint).
                if info.data_is_empty() {
                    continue;
                }
                // Account exists but owned by a non-token program — also
                // treated as 0 balance. The pubkey at the derived PDA could
                // be an unrelated account in the wild (very rare given ATA
                // derivation, but defensible).
                if info.owner != &spl_token_id() && info.owner != &TOKEN_2022_PROGRAM_ID {
                    continue;
                }
                // Token-program-owned but data buffer too short to hold the
                // canonical (mint, owner, amount) prefix — malformed; skip.
                let data = info.try_borrow_data()?;
                if data.len() < 72 {
                    continue;
                }
                drop(data);

                // Defensive: the account at this derived PDA must hold the
                // configured mint AND be owned by the vault. A divergence
                // here means the PDA was hijacked (close+recreate with
                // attacker authority OR funded with wrong mint). R-2
                // (AtaAuthorityPin) catches the attacker-authority case at
                // finalize when paired; here in the validate snapshot we
                // skip a malformed account so the sum reflects only
                // legitimately-vault-owned balances.
                let Some(acct_mint) = read_token_mint(info) else {
                    continue;
                };
                if acct_mint != *mint {
                    continue;
                }
                let Some(acct_owner) = read_token_owner(info) else {
                    continue;
                };
                if acct_owner != *vault {
                    continue;
                }
                let Some(amount) = read_token_amount(info) else {
                    continue;
                };
                sum = sum.checked_add(amount).ok_or(SigilError::Overflow)?;
            }
            Ok(sum)
        }
        1 => {
            // Single account: require the entry's target_account to be
            // present + vault-owned + mint matches.
            let info = remaining
                .iter()
                .find(|a| a.key() == *target_account)
                .ok_or(error!(SigilError::MintDeltaCapMisconfigured))?;
            let acct_mint =
                read_token_mint(info).ok_or(error!(SigilError::MintDeltaCapMisconfigured))?;
            require!(acct_mint == *mint, SigilError::MintDeltaCapMisconfigured);
            let acct_owner =
                read_token_owner(info).ok_or(error!(SigilError::MintDeltaCapMisconfigured))?;
            require!(acct_owner == *vault, SigilError::MintDeltaCapMisconfigured);
            let amount =
                read_token_amount(info).ok_or(error!(SigilError::MintDeltaCapMisconfigured))?;
            Ok(amount)
        }
        // validate_entries already rejects scope > 1, but defense-in-depth.
        _ => Err(error!(SigilError::MintDeltaCapMisconfigured)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Derivation is deterministic across calls — the ATA list never changes
    /// for a given (vault, mint) pair within a program version.
    #[test]
    fn derive_vault_atas_is_deterministic() {
        let vault = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let a = derive_vault_atas(&vault, &mint);
        let b = derive_vault_atas(&vault, &mint);
        assert_eq!(a, b);
        assert_eq!(a.len(), 2); // SPL classic + Token-2022
    }

    /// SPL classic ATA is always at index 0 — off-chain decoders depend on
    /// the slot ordering for snapshot replay.
    #[test]
    fn derive_vault_atas_classic_first() {
        let vault = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let atas = derive_vault_atas(&vault, &mint);
        let expected_classic =
            get_associated_token_address_with_program_id(&vault, &mint, &spl_token_id());
        assert_eq!(atas[0], expected_classic);
    }

    /// Different mints produce different ATAs.
    #[test]
    fn derive_vault_atas_changes_with_mint() {
        let vault = Pubkey::new_unique();
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        assert_ne!(
            derive_vault_atas(&vault, &mint_a)[0],
            derive_vault_atas(&vault, &mint_b)[0]
        );
    }

    /// MAX_ATAS_PER_MINT bound holds — derivation never exceeds it.
    #[test]
    fn derive_vault_atas_respects_cap() {
        let vault = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert!(derive_vault_atas(&vault, &mint).len() <= MAX_ATAS_PER_MINT);
    }

    /// §RP CRIT-2 boundary: scope=0 with an empty `remaining_accounts` slice
    /// MUST return `MintDeltaCapMisconfigured` for every derived ATA, not
    /// silently sum to 0. Previously the loop's `None => continue` silently
    /// skipped missing PDAs, enabling the omission-bypass attack where the
    /// agent drains an existing ATA at the DeFi step while pre_sum/post_sum
    /// both measure 0 for it.
    ///
    /// We can't construct real `AccountInfo` lifetimes in this unit-test
    /// context (RefCell + lifetimes), but the function behavior is pinned
    /// at the type level: with `remaining = &[]` and `scope = 0`, the very
    /// first `.find()` returns None → `ok_or(MintDeltaCapMisconfigured)?`
    /// fires immediately. Integration coverage of the full omission scenario
    /// lives in `tests/post-assertions-sandwich.ts`.
    #[test]
    fn scope_0_rejects_empty_remaining_accounts() {
        let vault = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let result = sum_vault_mint_balance(&vault, &mint, 0, &Pubkey::default(), &[]);
        assert!(
            result.is_err(),
            "scope=0 with empty remaining_accounts must reject (was previously silent 0)",
        );
        // Sanity: scope=1 with empty remaining_accounts ALSO rejects (the
        // existing required-presence path). The fix harmonizes scope=0 to
        // the same posture.
        let result1 = sum_vault_mint_balance(&vault, &mint, 1, &Pubkey::new_unique(), &[]);
        assert!(result1.is_err(), "scope=1 must also reject");
    }
}
