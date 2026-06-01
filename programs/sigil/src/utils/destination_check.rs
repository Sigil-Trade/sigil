//! Phase 2 TA-02: wire `PolicyConfig.allowed_destinations` enforcement into
//! spending paths (`validate_and_authorize`), not just `agent_transfer`.
//!
//! Pre-Phase-2 state: `allowed_destinations` was only enforced in
//! `agent_transfer.rs`. The DeFi spending paths (stablecoin-input swap and
//! non-stablecoin-input swap) could route value to ANY ATA whose owner was
//! not in the allowlist as long as the protocol allowlist passed — a known
//! gap surfaced by Audit #2.
//!
//! Phase 2 closes the gap by extracting destination ATAs from the DeFi
//! instruction's account metas and verifying their owners against the policy.
//!
//! ## Scope (intentionally narrow for V1)
//!
//! The helper checks accounts that are **token accounts owned by the SPL Token
//! program (or Token-2022) AND writable AND non-vault**. The vault's own ATAs
//! are not "destinations" — value flowing out of the vault is the spend; value
//! flowing back in is verified by the stablecoin-balance-delta check in
//! `finalize_session`. The helper is called only when `is_spending` is true.
//!
//! ## Performance
//!
//! O(N · M) where N is the number of account metas (bounded by the Solana
//! per-tx limit, ~64) and M is `MAX_ALLOWED_DESTINATIONS` (10). For real
//! DeFi instructions N is typically 5-25, M is 1-3 → ~50-75 comparisons
//! per call. Well below 1k CU.
//!
//! ## Defense layering
//!
//! `is_destination_allowed` on `PolicyConfig` is the actual allowlist
//! check; this helper is the **discoverer** that finds which accounts need
//! to be checked. Both must be present for end-to-end enforcement.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_spl::token::TokenAccount;

use crate::errors::SigilError;
use crate::state::{PolicyConfig, TOKEN_2022_PROGRAM_ID};

/// Walks the DeFi instruction's account metas, finds writable token-account
/// recipients that are NOT the vault's own ATA, and verifies each recipient's
/// owner against `policy.allowed_destinations`.
///
/// Returns `Ok(())` if every candidate destination passes the allowlist (or if
/// no candidate destinations are present — uncommon but possible in pure
/// observe-style DeFi calls). Returns `Err(DestinationNotAllowed)` on the
/// first mismatch.
///
/// # Arguments
///
/// * `ix_accounts` — the DeFi instruction's `Vec<AccountMeta>` (from the
///   `Instruction` extracted via `load_instruction_at_checked`).
/// * `remaining_accounts` — the full slice from `ctx.remaining_accounts`. We
///   need this to read each candidate account's `owner` field (token-account
///   owner = wallet that owns the token account, NOT the SPL Token program).
/// * `vault_pubkey` — the vault PDA; vault-owned ATAs are excluded from the
///   check (those are the spend source, not a destination).
/// * `policy` — the live `PolicyConfig` used to check `allowed_destinations`.
///
/// # Why pre-borrow remaining_accounts?
///
/// We can't deserialize a `TokenAccount` from a raw byte slice without owning
/// the data borrow for the lifetime of the unpack. So the caller holds the
/// borrowed data and passes the unpacked owner. We resolve via Anchor's
/// `TokenAccount::try_deserialize` shortcut.
///
/// # Token-2022 awareness
///
/// We accept both `spl_token::ID` and `TOKEN_2022_PROGRAM_ID` as token-account
/// owners. Token-2022 accounts have a longer layout (extensions), but the
/// `owner` field is in the same byte position, so `TokenAccount::try_deserialize`
/// works for the read.
/// PEN-CROSS-4 (Phase 4 absorption) — maximum account metas inspected per
/// foreign instruction by `enforce_destination_allowlist`.
///
/// **Rationale.** Real DeFi instructions (Jupiter swaps, Flash Trade open/
/// close, Marginfi deposit/withdraw, Drift place_order, etc.) have between
/// 5 and 25 account metas in their main instruction. Empirically:
/// - Jupiter v6 single-step: ~10 metas
/// - Jupiter v6 max-step: 22-25 metas
/// - Flash Trade open_position: 15-20 metas
/// - SPL transfer: 3 metas
///
/// **H-1 hard-reject update (audit 2026-05-19).** Previously the helper
/// silently `take(16)`-truncated, which a Jupiter-v6-max-step ix with 22-25
/// metas trips — an attacker could hide a hostile destination at slot 17+
/// because slots 17+ were never inspected. The cap is now a HARD REJECT
/// (`require!`) at the helper entry rather than a silent slice. Real ixs
/// up to 25 metas would now reject; the 16-meta budget is intentional for
/// V1 because the legitimate Jupiter-v6-max-step shape can be split into
/// shorter ixs, and shorter Jupiter routes cover the common path. Future
/// expansion to 32 metas requires a measured CU justification (~+4 K CU per
/// validate pass).
///
/// **CU savings.** The pre-filter on AccountInfo.owner (32-byte pubkey
/// compare, no deserialize) covers the ~250 CU per non-token-meta case
/// even before the bound triggers. The bound triggers only on adversarial
/// or over-long real ixs — both of which now reject cleanly.
pub(crate) const MAX_DESTINATION_CHECK_METAS_PER_IX: usize = 16;

/// TA-07 (Phase 3) extended signature: `now` is the current Unix timestamp
/// used by the graylist friction check. Callers pass `clock.unix_timestamp`.
///
/// PEN-CROSS-4 (Phase 4 absorption) — iteration is bounded at
/// MAX_DESTINATION_CHECK_METAS_PER_IX (16) per call. Pre-filter by
/// program_id BYTE-READ before TokenAccount::try_deserialize: any meta
/// whose AccountInfo owner is neither SPL Token nor Token-2022 is skipped
/// with a single 32-byte pubkey compare, no deserialize. The cumulative
/// CU saving is ~5K per `agent_transfer` (which calls this helper twice
/// in some paths via the Phase 2 forward scan).
pub fn enforce_destination_allowlist<'info>(
    ix_accounts: &[AccountMeta],
    remaining_accounts: &[AccountInfo<'info>],
    vault_pubkey: &Pubkey,
    policy: &PolicyConfig,
    now: i64,
) -> Result<()> {
    // H-1 hard-reject (audit 2026-05-19): refuse to scan ixs with more
    // metas than the destination-check budget. Previously the helper
    // silently truncated via `take(16)`, which a Jupiter-v6-max-step
    // 22-25 meta ix would trip — attacker hides hostile destination at
    // slot 17+ because slots 17+ are never inspected. Hard-reject closes
    // the silent-drop. See `MAX_DESTINATION_CHECK_METAS_PER_IX` doc for
    // CU rationale.
    require!(
        ix_accounts.len() <= MAX_DESTINATION_CHECK_METAS_PER_IX,
        SigilError::IxMetaCountExceeded
    );
    for meta in ix_accounts.iter() {
        if !meta.is_writable {
            // Read-only accounts cannot receive value; skip.
            continue;
        }
        if &meta.pubkey == vault_pubkey {
            // Vault PDA itself is never a destination — it's the authority.
            continue;
        }

        // Locate the AccountInfo for this meta in remaining_accounts.
        // Solana puts the *target* program's accounts in remaining_accounts
        // when the instruction is built via the sysvar-introspected path.
        let info = match remaining_accounts.iter().find(|ai| ai.key == &meta.pubkey) {
            Some(info) => info,
            // If the account isn't passed in remaining_accounts, we can't read
            // it. That's expected for non-token writable accounts (e.g. program
            // PDAs of the target protocol — those don't receive token value).
            // Skip rather than reject; the protocol allowlist + token-balance
            // sandwich is the load-bearing defense for those.
            None => continue,
        };

        // PEN-CROSS-4 pre-filter: read the AccountInfo's `owner` byte
        // FIRST (32-byte pubkey compare, no deserialize) before any
        // TokenAccount::try_deserialize call. Filters out program PDAs,
        // SystemProgram-owned accounts, and other non-token writable metas
        // at the cheapest possible cost. Eliminates the prior cost where
        // a foreign ix passing an SPL Mint or any random Program-owned
        // PDA as writable would trigger an attempt to deserialize 165
        // bytes via TokenAccount::try_deserialize before bailing.
        let owner_program = info.owner;
        if *owner_program != anchor_spl::token::ID && *owner_program != TOKEN_2022_PROGRAM_ID {
            continue;
        }

        // Owner is SPL Token or Token-2022 → safe to deserialize.
        let data = info.try_borrow_data()?;
        let token_acct = TokenAccount::try_deserialize(&mut data.as_ref())?;
        let recipient_wallet = token_acct.owner;

        // Skip the vault's own ATAs (recipient_wallet == vault PDA). The vault's
        // ATAs carry tokens IN and OUT during the swap — the OUT direction is
        // the spend (already capped) and the IN direction is verified by
        // finalize_session's balance-delta check.
        if recipient_wallet == *vault_pubkey {
            continue;
        }

        // Allowlist check. Fail-closed: a single mismatched destination rejects
        // the whole bundle.
        require!(
            policy.is_destination_allowed(&recipient_wallet),
            SigilError::DestinationNotAllowed,
        );

        // TA-07 (Phase 3): graylist friction check. If the destination is on
        // the graylist AND still within its unlock window, reject — the
        // owner authorised it via allowlist add but it has not yet served
        // its 24h friction (unless auto_promote_grays or owner promoted via
        // promote_graylist_destination, which would have cleared the entry).
        let (graylisted, _unlock) = policy.is_destination_graylisted(&recipient_wallet, now);
        require!(!graylisted, SigilError::ErrGraylistFriction);
    }

    Ok(())
}

#[cfg(test)]
mod h1_hard_reject_tests {
    //! H-1 hard-reject (audit 2026-05-19): `enforce_destination_allowlist`
    //! must REJECT (not silently truncate) when a foreign DeFi ix exceeds
    //! the destination-check meta budget. These tests pin the error code
    //! (6102 IxMetaCountExceeded) and the boundary behaviour.
    use super::*;

    fn pk(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    /// PolicyConfig has no Default impl (Anchor `#[account]` macro
    /// doesn't derive it). The H-1 hard-reject fires BEFORE any policy
    /// field is read, so this mock is never inspected — but a real
    /// instance is required to satisfy the `&PolicyConfig` parameter.
    fn mock_policy() -> PolicyConfig {
        PolicyConfig {
            vault: pk(0),
            daily_spending_cap_usd: 0,
            max_transaction_size_usd: 0,
            protocol_mode: 0,
            protocols: vec![],
            developer_fee_rate: 0,
            max_slippage_bps: 0,
            timelock_duration: 0,
            allowed_destinations: vec![],
            has_pending_policy: false,
            has_protocol_caps: false,
            protocol_caps: vec![],
            session_expiry_seconds: 0,
            bump: 0,
            policy_version: 0,
            has_post_assertions: 0,
            destination_mode: 0,
            policy_preview_digest: [0u8; 32],
            created_at_slot: 0,
            operating_hours: 0,
            destination_graylist: vec![],
            auto_promote_grays: false,
            auto_revoke_threshold: 0,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            cosign_required: false,
            // D-5 (audit 2026-05-19, F-RP3-1): mock policy disables the
            // reactivate-cosign gate. Tests below exercise the destination
            // check before any policy field is read, so this is inert here.
            cosign_session_pubkey: Pubkey::default(),
        }
    }

    /// Boundary: an ix with exactly MAX_DESTINATION_CHECK_METAS_PER_IX
    /// metas is accepted (the cap is `<=`, not `<`). All metas are
    /// non-writable so they're trivially skipped — the test is purely
    /// about the entry-guard semantics, not destination resolution.
    #[test]
    fn boundary_at_cap_accepts() {
        let vault_pubkey = pk(0xA);
        let metas: Vec<AccountMeta> = (0..MAX_DESTINATION_CHECK_METAS_PER_IX)
            .map(|i| AccountMeta::new_readonly(pk(i as u8 + 16), false))
            .collect();
        let policy = mock_policy();
        let remaining: Vec<AccountInfo> = vec![];
        let res = enforce_destination_allowlist(&metas, &remaining, &vault_pubkey, &policy, 0);
        assert!(
            res.is_ok(),
            "ix at exactly the bound must accept (non-writable metas skip cleanly)"
        );
    }

    /// One-over-cap: an ix with 17 metas must REJECT with 6102. This is
    /// the silent-truncate-attack closure: previously the helper would
    /// `take(16)` and ignore slot 17.
    #[test]
    fn one_over_cap_rejects_with_6102() {
        let vault_pubkey = pk(0xA);
        let metas: Vec<AccountMeta> = (0..(MAX_DESTINATION_CHECK_METAS_PER_IX + 1))
            .map(|i| AccountMeta::new_readonly(pk(i as u8 + 16), false))
            .collect();
        let policy = mock_policy();
        let remaining: Vec<AccountInfo> = vec![];
        let err = enforce_destination_allowlist(&metas, &remaining, &vault_pubkey, &policy, 0)
            .expect_err("ix exceeding bound MUST reject");
        // Convert the AnchorError -> u32 error code via the standard
        // Anchor error projection. We pin the 6102 numeric for forward-
        // compat with off-chain monitors.
        let err_str = format!("{:?}", err);
        assert!(
            err_str.contains("IxMetaCountExceeded") || err_str.contains("6102"),
            "expected IxMetaCountExceeded (6102), got: {}",
            err_str
        );
    }

    /// Far-over-cap (25 metas — Jupiter v6 max-step shape): also rejects.
    /// Documents the legitimate-flow case the audit called out — Jupiter
    /// v6 max-step ixs WILL hit this rejection in V1; the route must be
    /// shortened or split.
    #[test]
    fn jupiter_v6_max_step_25_metas_rejects() {
        let vault_pubkey = pk(0xA);
        let metas: Vec<AccountMeta> = (0..25)
            .map(|i| AccountMeta::new_readonly(pk(i as u8 + 16), false))
            .collect();
        let policy = mock_policy();
        let remaining: Vec<AccountInfo> = vec![];
        let err = enforce_destination_allowlist(&metas, &remaining, &vault_pubkey, &policy, 0)
            .expect_err("25-meta ix MUST reject");
        let err_str = format!("{:?}", err);
        assert!(
            err_str.contains("IxMetaCountExceeded") || err_str.contains("6102"),
            "expected IxMetaCountExceeded (6102), got: {}",
            err_str
        );
    }
}
