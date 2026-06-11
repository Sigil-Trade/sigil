//! Phase 6 finalize-time helpers for Maestro borrow variants R-1..R-4.
//!
//! These exist primarily for **stack budget management**. The BPF VM caps
//! function frames at 4096 bytes (`Error: Stack offset of XXXX exceeded max
//! offset of 4096`). The Phase 6 entry-array grow (4 → 8) doubled the
//! per-snapshot-array stack footprint inside `finalize_session::handler`,
//! and inlining the four new verify branches pushed the frame over the cap
//! by 8 bytes.
//!
//! Splitting each variant's logic into a `#[inline(never)]` helper forces
//! BPF to allocate fresh stack frames for the per-variant locals so they
//! don't accumulate into the handler's frame. The frame budget audit lives
//! in `programs/sigil/src/instructions/finalize_session.rs` — the helpers
//! must stay `#[inline(never)]` to keep the budget within the 4096 ceiling.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::errors::SigilError;
use crate::state::post_assertions::PostAssertionEntryZC;
use crate::state::TOKEN_2022_PROGRAM_ID;

/// Phase 6 R-1 MintDeltaCap finalize-time check.
///
/// Re-sums vault-owned ATAs (scope=0) or the single declared account
/// (scope=1) for the configured mint and asserts the net decrease is within
/// `max_net_decrease`.
#[inline(never)]
pub fn verify_mint_delta_cap(
    entry: &PostAssertionEntryZC,
    snapshot: &[u8; 32],
    snapshot_len: u8,
    vault_key: &Pubkey,
    remaining: &[AccountInfo],
) -> Result<()> {
    require!(snapshot_len == 8, SigilError::SnapshotNotCaptured);

    let mut mint_bytes = [0u8; 32];
    mint_bytes.copy_from_slice(&entry.expected_value[0..32]);
    let mint = Pubkey::new_from_array(mint_bytes);
    let scope = entry.aux_byte;
    let max_dec = u64::from_le_bytes(entry.aux_value);

    let target_account = Pubkey::new_from_array(entry.target_account);
    let post_sum = crate::utils::mint_delta_cap::sum_vault_mint_balance(
        vault_key,
        &mint,
        scope,
        &target_account,
        remaining,
    )?;

    let mut snap_bytes = [0u8; 8];
    snap_bytes.copy_from_slice(&snapshot[0..8]);
    let pre_sum = u64::from_le_bytes(snap_bytes);

    // saturating_sub: a balance INCREASE saturates to 0 and the check
    // passes — R-1 measures decrease only.
    let net_decrease = pre_sum.saturating_sub(post_sum);
    require!(net_decrease <= max_dec, SigilError::ErrMintDeltaCapExceeded);

    Ok(())
}

/// Phase 6 R-2 AtaAuthorityPin finalize-time check.
#[inline(never)]
pub fn verify_ata_authority_pin(
    entry: &PostAssertionEntryZC,
    vault_key: &Pubkey,
    remaining: &[AccountInfo],
) -> Result<()> {
    let target_pubkey = Pubkey::new_from_array(entry.target_account);
    let target = remaining
        .iter()
        .find(|a| a.key() == target_pubkey)
        .ok_or(error!(SigilError::ErrAtaAuthorityChanged))?;

    // Owner-program must still be a known token program.
    require!(
        target.owner == &anchor_spl::token::ID || target.owner == &TOKEN_2022_PROGRAM_ID,
        SigilError::ErrAtaAuthorityChanged
    );

    let target_data = target.try_borrow_data()?;
    // R-2 length-check tighten (audit 2026-05-21 L-5 defense-in-depth):
    // The authority field lives at bytes 32..64, so `>= 64` is technically
    // sufficient to read the slice. We tighten to `>= 165` (the SPL Token
    // packed `Account` length) to reject malformed/truncated token-account
    // buffers earlier. Both SPL Token (always 165) and Token-2022 (base
    // 165, may carry TLV extensions after byte 165) satisfy this bound —
    // the owner-program check above already guarantees we're looking at a
    // known token account, not an arbitrary 64-byte struct.
    require!(target_data.len() >= 165, SigilError::ErrAtaAuthorityChanged);
    let mut authority_bytes = [0u8; 32];
    authority_bytes.copy_from_slice(&target_data[32..64]);
    let authority = Pubkey::new_from_array(authority_bytes);
    require!(authority == *vault_key, SigilError::ErrAtaAuthorityChanged);

    Ok(())
}

/// Phase 6 R-3 OutputBalanceFloor finalize-time check.
///
/// §RP HIGH (Phase 6 review): pairs the existing balance-floor logic with
/// a vault-ownership require. R-3's semantic is "the VAULT's output balance
/// must rise by ≥ min_increase". Without owner-field enforcement, R-3 could
/// be misconfigured (or attacker-supplied via a future dashboard) to point
/// at an attacker-controlled token account; the attacker then funds their
/// own account between validate and finalize and R-3 passes vacuously. The
/// vault-ownership check forces R-3 to measure inflows that reach the
/// vault. A "fee recipient floor" variant for non-vault destinations would
/// be a separate primitive and is deferred.
#[inline(never)]
pub fn verify_output_balance_floor(
    entry: &PostAssertionEntryZC,
    snapshot: &[u8; 32],
    snapshot_len: u8,
    vault_key: &Pubkey,
    remaining: &[AccountInfo],
) -> Result<()> {
    require!(snapshot_len == 8, SigilError::SnapshotNotCaptured);

    let target_pubkey = Pubkey::new_from_array(entry.target_account);
    let target = remaining
        .iter()
        .find(|a| a.key() == target_pubkey)
        .ok_or(error!(SigilError::PostAssertionFailed))?;
    require!(
        target.owner == &anchor_spl::token::ID || target.owner == &TOKEN_2022_PROGRAM_ID,
        SigilError::PostAssertionFailed
    );
    let target_data = target.try_borrow_data()?;
    require!(target_data.len() >= 72, SigilError::PostAssertionFailed);

    // §RP HIGH: vault-ownership check — must mirror the validate-time
    // require in validate_and_authorize.rs so the snapshot vs finalize
    // pair always measures the same vault-owned account.
    let mut authority_bytes = [0u8; 32];
    authority_bytes.copy_from_slice(&target_data[32..64]);
    let authority = Pubkey::new_from_array(authority_bytes);
    require!(
        authority == *vault_key,
        SigilError::MintDeltaCapMisconfigured
    );

    let mut amount_bytes = [0u8; 8];
    amount_bytes.copy_from_slice(&target_data[64..72]);
    let post_balance = u64::from_le_bytes(amount_bytes);

    let mut snap_bytes = [0u8; 8];
    snap_bytes.copy_from_slice(&snapshot[0..8]);
    let pre_balance = u64::from_le_bytes(snap_bytes);

    let min_increase = u64::from_le_bytes(entry.aux_value);
    let delta = post_balance.saturating_sub(pre_balance);
    require!(delta >= min_increase, SigilError::ErrOutputBelowFloor);

    Ok(())
}

/// Phase 6 R-4 DeclarationConsistency finalize-time check.
///
/// Loads the DeFi instruction from sysvar instructions (at
/// `current_index - 1`), indexes into its account-meta list at
/// `entry.aux_byte`, then asserts the resolved token account's mint and
/// owner match the declared values.
///
/// §RP MED (Phase 6 review) verification scope:
///
/// **R-4 verifies the account at `account_meta_index` IS a token account
/// matching the declared `(recipient, mint)` pair. It does NOT verify the
/// SPL Token transfer's actual destination is this meta.** Two protocol
/// patterns to know:
///
/// 1. **Safe (fixed destination meta convention).** Protocols where the
///    SPL Token CPI's destination account is at a known, fixed meta index
///    agreed in advance — Jupiter v6 uses a fixed `dst_token_account`
///    meta index per swap. Configure R-4 with that index; verification is
///    sound because the protocol's own logic transfers to exactly that
///    meta.
///
/// 2. **Unsafe (ix-data-routed destination).** Protocols that select the
///    SPL Token transfer destination via an instruction-data field (e.g.,
///    `destination_index: u8` encoded in ix-data) can route to meta[i] for
///    any `i`. R-4 against a fixed meta index is bypassable in this
///    pattern — the attacker can satisfy R-4 by placing a declaration-
///    matching account at meta[N] while routing the actual transfer to
///    meta[N±k].
///
/// **Best practice: pair R-4 with R-1 MintDeltaCap.** Even if an attacker
/// routes the transfer to a non-declared meta, R-1 (vault-wide drain
/// ceiling) catches the resulting balance decrease. R-4 + R-1 = belt-and-
/// suspenders for protocols whose destination-routing convention isn't
/// fully known to the configuring owner.
#[inline(never)]
pub fn verify_declaration_consistency(
    entry: &PostAssertionEntryZC,
    instructions_sysvar: &AccountInfo,
    remaining: &[AccountInfo],
) -> Result<()> {
    let cur_idx = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(SigilError::ErrDeclarationInconsistent))? as usize;
    require!(cur_idx >= 1, SigilError::ErrDeclarationInconsistent);
    let defi_idx = cur_idx.saturating_sub(1);
    let defi_ix = load_instruction_at_checked(defi_idx, instructions_sysvar)
        .map_err(|_| error!(SigilError::ErrDeclarationInconsistent))?;

    let meta_index = entry.aux_byte as usize;
    require!(
        meta_index < defi_ix.accounts.len(),
        SigilError::ErrDeclarationInconsistent
    );
    let meta = &defi_ix.accounts[meta_index];

    let target = remaining
        .iter()
        .find(|a| a.key() == meta.pubkey)
        .ok_or(error!(SigilError::ErrDeclarationInconsistent))?;
    require!(
        target.owner == &anchor_spl::token::ID || target.owner == &TOKEN_2022_PROGRAM_ID,
        SigilError::ErrDeclarationInconsistent
    );
    let target_data = target.try_borrow_data()?;
    // L-5 follow-up (Phase 6-9 re-audit 2026-05-21): symmetric tightening
    // to the R-2 site at line 96. Reading bytes 0..64 (mint + owner) is
    // technically satisfied by >= 64, but SPL Token packed length is 165
    // and Token-2022 base layout is also >= 165 (TLV extensions live
    // AFTER byte 165). Reject malformed/short token-account buffers
    // earlier. The owner-program check above already prevents arbitrary
    // 64-byte structs from reaching this require! — this is defense in
    // depth against a future caller-passed account that happens to be
    // owned by Token program but truncated.
    require!(
        target_data.len() >= 165,
        SigilError::ErrDeclarationInconsistent
    );

    let mut declared_mint_bytes = [0u8; 32];
    declared_mint_bytes.copy_from_slice(&entry.expected_value[0..32]);
    let declared_mint = Pubkey::new_from_array(declared_mint_bytes);
    let declared_recipient = Pubkey::new_from_array(entry.target_account);

    let mut actual_mint_bytes = [0u8; 32];
    actual_mint_bytes.copy_from_slice(&target_data[0..32]);
    let actual_mint = Pubkey::new_from_array(actual_mint_bytes);
    let mut actual_owner_bytes = [0u8; 32];
    actual_owner_bytes.copy_from_slice(&target_data[32..64]);
    let actual_owner = Pubkey::new_from_array(actual_owner_bytes);

    require!(
        actual_mint == declared_mint,
        SigilError::ErrDeclarationInconsistent
    );
    require!(
        actual_owner == declared_recipient,
        SigilError::ErrDeclarationInconsistent
    );

    Ok(())
}
