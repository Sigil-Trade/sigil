//! F-Q1a destination COMPLETENESS + sink-scoped allowlist for the spending
//! path (`validate_and_authorize`), complementing the single-recipient allowlist
//! in `agent_transfer`.
//!
//! ## What this helper does (and does NOT do)
//!
//! It walks the sandwiched DeFi instruction's account metas (introspected from
//! the instructions sysvar — a TRUSTED source the SVM actually executes) and,
//! for every account that is **writable AND non-vault**, enforces a
//! **completeness invariant**: the account MUST be resolvable in
//! `remaining_accounts` so the guard can read its owner byte and classify it.
//! An unresolvable writable meta is rejected FAIL-CLOSED
//! (`DestinationAccountUnresolvable`) rather than silently skipped — the seal()
//! satisfier is responsible for passing every writable account of the DeFi ix.
//!
//! It does **NOT** hard-reject a resolved-but-non-allowlisted destination. On a
//! swap, value flows *through* AMM pool vaults / Jupiter program-authority ATAs
//! that legitimately receive the vault's value in flight and are
//! byte-indistinguishable from a final sink — they can never be on an owner's
//! allowlist. A non-allowlisted resolved token account is therefore treated as a
//! transient route hop and SKIPPED (resolve-required, not allowlist-required).
//! Hard "value may only leave to an allowlisted owner" (WHERE) is undecidable on
//! the swap path and is enforced only on the single-recipient `agent_transfer`
//! path. The decidable swap-path guarantees are COMPLETENESS (here) + MAGNITUDE
//! (global/per-tx caps + the per-recipient cap in `finalize`) + CONSERVATION
//! (the finalize balance-delta) + the output/input ATA pins (F-Q8). The model is
//! WHERE+MAGNITUDE only — never VERB.
//!
//! ## Why completeness matters
//!
//! Pre-F-Q1a the helper did `None => continue` (fail-open) and `seal()` passed
//! empty `remaining_accounts`, so EVERY meta was skipped — the destination
//! check, the per-recipient cap, and the floor sum were all dead on the only
//! production path. Forcing every writable account into THIS instruction's view
//! (and rejecting omissions) makes the destination set fully visible at
//! `validate`. The per-recipient cap and floor run in `finalize_session`, which
//! carries its OWN `remaining_accounts`; `seal()` feeds finalize the same
//! writable set (so they are live on the honest seal() path), but finalize does
//! not yet INDEPENDENTLY fail-closed on omission — a raw-tx caller could omit a
//! meta from finalize and shrink per-recipient/floor attribution. That residual
//! is bounded by the global/per-tx magnitude cap (which reads the vault's own
//! balance delta and is NOT omittable) and is tracked as F-Q1b/M2 (full-bundle
//! binding). Do not over-claim finalize-side non-omittability here.
//!
//! ## Performance
//!
//! O(N·M): N writable metas (hard-capped at `MAX_DESTINATION_WRITABLE_METAS`),
//! M = `MAX_ALLOWED_DESTINATIONS`. A 32-byte `owner` pre-filter skips non-token
//! writables before any deserialize. Classifying 24 token accounts is ~36K CU
//! (<3% of the 1.4M budget).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::errors::SigilError;
use crate::state::{PolicyConfig, TOKEN_2022_PROGRAM_ID};

/// F-Q1a security cap: hard-reject when the DeFi ix carries more than this many
/// **writable** account metas. Only writable accounts can receive value (and
/// only they are ever deserialized), so the writable/classified set — not the
/// total meta count — is the exfiltration surface and the CU driver. Gating on
/// writables is the tightest bound that still admits real routes: a single-hop
/// Jupiter `sharedAccountsRoute` carries ~6-9 writable metas, a 3-4-leg
/// max-step route ~12-20. 24 admits observed max-step routes with margin
/// (~36K CU, ~+34 tx bytes — both <3% of budget). The cap is a HARD REJECT, not
/// a silent truncate, preserving the H-1 closure (an attacker must not be able
/// to hide a hostile writable destination beyond a truncation point). Oversized
/// routes atomically REVERT; Sigil never reshapes a route to fit (atomic-guard).
///
/// Corrects the pre-F-Q1a cap, which gated TOTAL metas at 16 and thus rejected
/// essentially every real `sharedAccountsRoute` swap (13 fixed accounts + >=1
/// pool > 16) — a latent liveness bug never caught because the seal() path was
/// only exercised with System-transfer mock DeFi ixs.
pub(crate) const MAX_DESTINATION_WRITABLE_METAS: usize = 24;

/// Loose total-meta iteration guard (DoS backstop ONLY — the security bound is
/// `MAX_DESTINATION_WRITABLE_METAS`). Bounds the cheap skip/filter loop over all
/// metas; sized above Solana's practical per-ix account count so it never
/// rejects a legitimate route on its own.
pub(crate) const MAX_DESTINATION_CHECK_TOTAL_METAS: usize = 64;

/// Enforce the F-Q1a destination completeness invariant + sink-scoped allowlist.
///
/// For every account meta of the sandwiched DeFi instruction that is writable
/// and not the vault PDA:
/// - if it is **absent** from `remaining_accounts` → reject FAIL-CLOSED
///   (`DestinationAccountUnresolvable`): the guard cannot classify an account it
///   cannot read, and the seal() satisfier is contractually required to pass it;
/// - if it is **present but non-token** (owner ∉ {SPL Token, Token-2022}) → skip
///   (provably cannot hold SPL token value);
/// - if it is a **vault-owned** token account → skip (spend source / swap return);
/// - if it is a **non-allowlisted** token account → skip (transient route hop:
///   AMM pool vault / DEX-internal / program-authority ATA — not a final sink we
///   can decide on-chain);
/// - if it is an **allowlisted** token account → enforce graylist friction.
///
/// # Arguments
///
/// * `ix_accounts` — the DeFi instruction's `Vec<AccountMeta>`, read via
///   `load_instruction_at_checked` (runtime truth, not caller-asserted).
/// * `remaining_accounts` — `ctx.remaining_accounts`; supplies each candidate's
///   on-chain bytes (owner field) for classification.
/// * `vault_pubkey` — the vault PDA; its own ATAs are not destinations.
/// * `policy` — live `PolicyConfig` (`allowed_destinations` + graylist).
/// * `now` — `clock.unix_timestamp` for the graylist friction window.
///
/// # Token-2022 awareness
///
/// Accepts both `spl_token::ID` and `TOKEN_2022_PROGRAM_ID` owners. The `mint`
/// (bytes 0..32) and `owner` (bytes 32..64) fields share the same base layout
/// for SPL-classic and Token-2022 token accounts, so they are read RAW — NOT
/// via the 165-exact `Account::unpack`, which would revert on a larger real
/// Token-2022 ATA (it carries the ImmutableOwner extension). For a vault-owned
/// Token-2022 account, the acquired token's mint extensions are then vetted by
/// the forward-secure allowlist (F-Q4).
pub fn enforce_destination_allowlist<'info>(
    ix_accounts: &[AccountMeta],
    remaining_accounts: &[AccountInfo<'info>],
    vault_pubkey: &Pubkey,
    policy: &PolicyConfig,
    now: i64,
) -> Result<()> {
    // Loose total-iteration guard (DoS backstop). Sized above any real route so
    // it never rejects a legitimate swap on its own.
    require!(
        ix_accounts.len() <= MAX_DESTINATION_CHECK_TOTAL_METAS,
        SigilError::IxMetaCountExceeded
    );

    // Security cap: hard-reject on the count of WRITABLE metas — the set that
    // can receive value and that may be deserialized. Read-only metas are inert.
    // Hard-reject (not truncate) keeps the H-1 silent-truncation hole closed.
    let writable_count = ix_accounts.iter().filter(|m| m.is_writable).count();
    require!(
        writable_count <= MAX_DESTINATION_WRITABLE_METAS,
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

        // COMPLETENESS (F-Q1a). The seal() satisfier MUST pass every writable
        // account of the DeFi ix into `remaining_accounts`. A writable, non-vault
        // meta that is absent here cannot be classified (we cannot read its owner
        // or type), so it is rejected FAIL-CLOSED rather than silently skipped.
        // This replaces the prior `None => continue` fail-open, which rewarded
        // omission and rendered the destination check, the per-recipient cap, and
        // the floor sum dead on the seal() path.
        let info = match remaining_accounts.iter().find(|ai| ai.key == &meta.pubkey) {
            Some(info) => info,
            None => return Err(error!(SigilError::DestinationAccountUnresolvable)),
        };

        // PEN-CROSS-4 pre-filter: read AccountInfo.owner (32-byte compare, no
        // deserialize). An account owned by neither SPL Token nor Token-2022
        // cannot hold SPL token value, so it is provably not a value
        // destination — safe to skip (we HAVE its data and proved it non-token,
        // unlike the absent case above which we cannot classify).
        let owner_program = info.owner;
        if *owner_program != anchor_spl::token::ID && *owner_program != TOKEN_2022_PROGRAM_ID {
            continue;
        }

        // Owner is SPL Token or Token-2022 → read mint + owner from the raw base
        // layout (bytes 0..32 mint, 32..64 owner — identical for SPL classic and
        // Token-2022 token accounts). RAW, not `TokenAccount::try_deserialize`:
        // the strict SPL unpack requires EXACTLY 165 bytes, but a real Token-2022
        // ATA is larger (it carries the ImmutableOwner extension), so the strict
        // unpack would revert the whole tx HERE — making the vault-owned
        // Token-2022 extension vetting below unreachable for real ATAs.
        let (token_mint, recipient_wallet) = {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 72, SigilError::InvalidTokenAccount);
            let mut mint_bytes = [0u8; 32];
            mint_bytes.copy_from_slice(&data[0..32]);
            let mut owner_bytes = [0u8; 32];
            owner_bytes.copy_from_slice(&data[32..64]);
            (
                Pubkey::new_from_array(mint_bytes),
                Pubkey::new_from_array(owner_bytes),
            )
        };

        // Vault's own ATAs carry value IN/OUT during a swap — the OUT direction
        // is the (capped) spend, the IN direction is verified by finalize's
        // balance-delta. Not a destination.
        if recipient_wallet == *vault_pubkey {
            // F-Q4 — a VAULT-OWNED token account here is a swap delivering
            // tokens INTO the vault. If it is Token-2022, the acquired token's
            // mint extensions MUST be vetted: a mint carrying PermanentDelegate
            // / TransferHook / ConfidentialTransfer could let a third party
            // drain (or hide) the vault's holding out-of-band, with no future
            // Sigil transaction. NON-OMITTABLE — it rides on the same
            // compiled-message writable meta + completeness that already forced
            // this token account into `remaining_accounts`.
            if *owner_program == TOKEN_2022_PROGRAM_ID {
                let mint_key = token_mint;
                let mint_info = match remaining_accounts.iter().find(|ai| ai.key == &mint_key) {
                    Some(info) => info,
                    None => return Err(error!(SigilError::ErrToken2022OutputMintUnresolvable)),
                };
                // Fake-mint guard: a real Token-2022 token account's mint is
                // ALWAYS owned by the Token-2022 program. A System-owned decoy
                // at the mint pubkey would make the allowlist walk a no-op and
                // slip a dangerous mint through — fail closed instead.
                require!(
                    *mint_info.owner == TOKEN_2022_PROGRAM_ID,
                    SigilError::ErrToken2022OutputMintUnresolvable
                );
                // Forward-secure allowlist: rejects PermanentDelegate,
                // TransferHook, ConfidentialTransfer, TransferFee,
                // DefaultAccountState, and any unknown/future extension
                // (ErrToken2022ExtensionForbidden 6079).
                crate::utils::token2022_extension::enforce_token2022_extension_allowlist(
                    mint_info,
                )?;
            }
            continue;
        }

        // SINK-SCOPED (F-Q1a — WHERE+MAGNITUDE model only). A non-vault token
        // account whose owner is NOT allowlisted is a transient route hop (an
        // AMM pool vault, a Jupiter program-authority ATA, a DEX-internal
        // account). In a swap such accounts legitimately receive value in flight
        // and are byte-indistinguishable from a final sink — so SKIP them
        // (resolve-required, not allowlist-required). Hard "value may only leave
        // to an allowlisted owner" is undecidable here (a pool legitimately
        // receives the vault's stablecoin) and is enforced only on the
        // single-recipient `agent_transfer` path. Magnitude leaving the vault is
        // bounded by the global/per-tx caps; the per-recipient cap in `finalize`
        // attributes only allowlisted recipients.
        if !policy.is_destination_allowed(&recipient_wallet) {
            continue;
        }

        // Allowlisted recipient → enforce graylist friction: the owner added it
        // but it has not yet served its unlock window (unless auto_promote_grays
        // or an explicit promotion cleared the entry).
        let (graylisted, _unlock) = policy.is_destination_graylisted(&recipient_wallet, now);
        require!(!graylisted, SigilError::ErrGraylistFriction);
    }

    Ok(())
}

#[cfg(test)]
mod cap_and_completeness_tests {
    //! F-Q1a unit tests for the entry guards: the WRITABLE-meta security cap
    //! (`MAX_DESTINATION_WRITABLE_METAS`), the loose total-iteration guard
    //! (`MAX_DESTINATION_CHECK_TOTAL_METAS`), and the completeness fail-closed
    //! (`DestinationAccountUnresolvable`) for an absent writable meta. The
    //! sink-scoped allowlist / graylist / classification paths need real
    //! `AccountInfo` bytes and are covered by the LiteSVM seal()-path tests.
    use super::*;

    fn pk(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    /// PolicyConfig has no Default impl (Anchor `#[account]` macro doesn't
    /// derive it). The cap/total guards and the completeness fail-closed all
    /// fire before any policy field is read, so this mock is inert here — but a
    /// real instance is required to satisfy the `&PolicyConfig` parameter.
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
            // D-5 (audit 2026-05-19, F-RP3-1): cosign gate disabled in the mock.
            cosign_session_pubkey: Pubkey::default(),
            // F-Q6 (2026-06-02): OPERATOR-grant delay default 0 in the mock.
            operator_grant_delay_seconds: 0,
        }
    }

    /// Boundary: exactly `MAX_DESTINATION_WRITABLE_METAS` writable metas is
    /// accepted (the cap is `<=`). All metas point at the vault PDA so they are
    /// skipped before the completeness check — this is purely a cap-arithmetic
    /// test (no destination resolution).
    #[test]
    fn writable_boundary_at_cap_accepts() {
        let vault_pubkey = pk(0xA);
        let metas: Vec<AccountMeta> = (0..MAX_DESTINATION_WRITABLE_METAS)
            .map(|_| AccountMeta::new(vault_pubkey, false))
            .collect();
        let policy = mock_policy();
        let remaining: Vec<AccountInfo> = vec![];
        let res = enforce_destination_allowlist(&metas, &remaining, &vault_pubkey, &policy, 0);
        assert!(
            res.is_ok(),
            "exactly the writable cap (all vault metas) must accept"
        );
    }

    /// One-over the writable cap rejects with `IxMetaCountExceeded` (6093). The
    /// cap fires before the loop, so `remaining_accounts` is never consulted.
    #[test]
    fn writable_one_over_cap_rejects() {
        let vault_pubkey = pk(0xA);
        let metas: Vec<AccountMeta> = (0..(MAX_DESTINATION_WRITABLE_METAS + 1))
            .map(|i| AccountMeta::new(pk(i as u8 + 16), false))
            .collect();
        let policy = mock_policy();
        let remaining: Vec<AccountInfo> = vec![];
        let err = enforce_destination_allowlist(&metas, &remaining, &vault_pubkey, &policy, 0)
            .expect_err("ix exceeding the writable cap MUST reject");
        let err_str = format!("{:?}", err);
        assert!(
            err_str.contains("IxMetaCountExceeded") || err_str.contains("6093"),
            "expected IxMetaCountExceeded (6093), got: {}",
            err_str
        );
    }

    /// The loose total-iteration guard rejects an ix with more than
    /// `MAX_DESTINATION_CHECK_TOTAL_METAS` total metas (here all read-only, so
    /// the writable cap is not what fires — the total guard is).
    #[test]
    fn total_iteration_guard_rejects() {
        let vault_pubkey = pk(0xA);
        let metas: Vec<AccountMeta> = (0..(MAX_DESTINATION_CHECK_TOTAL_METAS + 1))
            .map(|i| AccountMeta::new_readonly(pk(i as u8), false))
            .collect();
        let policy = mock_policy();
        let remaining: Vec<AccountInfo> = vec![];
        let err = enforce_destination_allowlist(&metas, &remaining, &vault_pubkey, &policy, 0)
            .expect_err("ix exceeding the total-meta guard MUST reject");
        let err_str = format!("{:?}", err);
        assert!(
            err_str.contains("IxMetaCountExceeded") || err_str.contains("6093"),
            "expected IxMetaCountExceeded (6093), got: {}",
            err_str
        );
    }

    /// COMPLETENESS fail-closed: a single writable, non-vault meta that is
    /// ABSENT from `remaining_accounts` rejects with
    /// `DestinationAccountUnresolvable` — the guard cannot classify what it
    /// cannot read, so omission is rejected, not silently skipped (the old
    /// `None => continue` fail-open).
    #[test]
    fn absent_writable_meta_fails_closed() {
        let vault_pubkey = pk(0xA);
        let metas = vec![AccountMeta::new(pk(0x20), false)]; // writable, non-vault
        let policy = mock_policy();
        let remaining: Vec<AccountInfo> = vec![]; // nothing to resolve against
        let err = enforce_destination_allowlist(&metas, &remaining, &vault_pubkey, &policy, 0)
            .expect_err("absent writable meta MUST fail closed");
        let err_str = format!("{:?}", err);
        assert!(
            err_str.contains("DestinationAccountUnresolvable"),
            "expected DestinationAccountUnresolvable, got: {}",
            err_str
        );
    }

    /// A read-only meta absent from `remaining_accounts` is fine — read-only
    /// accounts cannot receive value and are skipped before completeness.
    #[test]
    fn absent_readonly_meta_is_ignored() {
        let vault_pubkey = pk(0xA);
        let metas = vec![AccountMeta::new_readonly(pk(0x20), false)];
        let policy = mock_policy();
        let remaining: Vec<AccountInfo> = vec![];
        let res = enforce_destination_allowlist(&metas, &remaining, &vault_pubkey, &policy, 0);
        assert!(res.is_ok(), "read-only metas must never trip completeness");
    }
}
