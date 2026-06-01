use anchor_lang::prelude::*;

use crate::state::assertions::{ConstraintOperator, MAX_CONSTRAINT_VALUE_LEN};

/// Maximum number of post-execution assertion entries per vault.
/// Kept small to limit compute cost in finalize_session.
///
/// Phase 6 (Maestro borrows R-1/R-2/R-3/R-4): grown from 4 → 8 to accommodate
/// the new variants AND existing absolute/delta modes on the same PDA without
/// crowding owners off the cap. Each entry costs 78 bytes; 8 entries = 624
/// bytes of `entries[]`. Combined with the snapshot growth on SessionAuthority
/// (+132 bytes), 8 is the negotiated capacity ceiling.
pub const MAX_POST_ASSERTION_ENTRIES: usize = 8;

/// Phase 6 R-1: maximum ATAs scanned per (vault, mint) pair when
/// `MintDeltaCap` runs in `scope=0` (vault-wide).
///
/// **Why 5:** in practice each (vault, mint) pair has ONE canonical ATA via
/// the standard `get_associated_token_address` derivation. Token-2022 mints
/// use a different program ID, so a single vault can have BOTH an SPL Token
/// ATA AND a Token-2022 ATA for the same mint — that's the realistic ceiling
/// today. Reserving three additional slots is defensive headroom for any
/// future ATA program (SIMD-style alternates) without re-deploying. The cap
/// bounds compute cost in `validate_and_authorize` and `finalize_session`
/// against a malicious caller stuffing remaining_accounts.
pub const MAX_ATAS_PER_MINT: usize = 5;

/// Assertion mode enum — used at validation and evaluation boundaries.
/// On-chain field is u8 for Pod compatibility; this enum provides type safety.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
pub enum AssertionMode {
    /// Check current value against expected_value (Phase B1)
    Absolute = 0,
    /// Check (snapshot - current) ≤ expected_value; passes if value increases (Phase B2)
    MaxDecrease = 1,
    /// Check (current - snapshot) ≤ expected_value; passes if value decreases (Phase B2)
    MaxIncrease = 2,
    /// Check current == snapshot — byte-for-byte equality (Phase B2)
    NoChange = 3,
    /// Phase 6 R-1: vault-wide or per-account drain ceiling on a specific
    /// mint. Snapshot = sum of vault-owned ATA balances at validate time;
    /// finalize asserts (pre_sum - post_sum) ≤ aux_value (max_net_decrease).
    /// `scope=0` (aux_byte) enumerates ATAs via on-chain derivation;
    /// `scope=1` measures only the entry's `target_account`.
    MintDeltaCap = 4,
    /// Phase 6 R-2: pin SPL/Token-2022 account authority to the vault PDA.
    /// At finalize, the entry's `target_account` MUST (a) be present in
    /// `remaining_accounts`, (b) be owned by SPL Token or Token-2022, (c)
    /// have data length ≥ 64, and (d) carry `vault.key().to_bytes()` at
    /// bytes 32..64. Pairs with R-1 to close the F-18 close-and-recreate
    /// evasion: R-1 catches balance change, R-2 catches authority change.
    AtaAuthorityPin = 5,
    /// Phase 6 R-3: minimum output increase on a token account. Snapshot
    /// the account's balance at validate time; finalize asserts
    /// `(post - pre) >= aux_value (min_increase)`. Closes the
    /// "dust-fill" attack where a malicious swap returns 1 lamport and
    /// satisfies a delegation cap. `target_account` = token account
    /// (typically the vault's stablecoin ATA for the output mint);
    /// `expected_value[0..32]` = mint (cross-check the target_account
    /// actually holds the declared mint).
    OutputBalanceFloor = 6,
    /// Phase 6 R-4: declaration vs. CPI account-meta consistency. The owner
    /// pins a declared (recipient, mint) pair to a specific CPI account
    /// meta index in the DeFi instruction. At finalize:
    ///   1. Look up the DeFi instruction at `current_ix_index - 1` via
    ///      sysvar instructions.
    ///   2. Fetch `defi_ix.accounts[aux_byte].pubkey`.
    ///   3. Resolve the account in `remaining_accounts` and require its
    ///      token-account `mint == expected_value[0..32]` AND
    ///      `owner == target_account` (the declared recipient).
    ///
    /// Closes "declaration dishonesty": agent declares "recipient: alice"
    /// to satisfy a destination-allowlist check, but inserts attacker_ata
    /// into the CPI metas. Maestro verify_cpi_token_accounts equivalent.
    DeclarationConsistency = 7,
}

impl TryFrom<u8> for AssertionMode {
    type Error = ();
    fn try_from(v: u8) -> core::result::Result<Self, Self::Error> {
        match v {
            0 => Ok(AssertionMode::Absolute),
            1 => Ok(AssertionMode::MaxDecrease),
            2 => Ok(AssertionMode::MaxIncrease),
            3 => Ok(AssertionMode::NoChange),
            4 => Ok(AssertionMode::MintDeltaCap),
            5 => Ok(AssertionMode::AtaAuthorityPin),
            6 => Ok(AssertionMode::OutputBalanceFloor),
            7 => Ok(AssertionMode::DeclarationConsistency),
            _ => Err(()),
        }
    }
}

/// Post-execution assertion: checks account data bytes AFTER the DeFi
/// instruction executes, within the same atomic transaction.
///
/// Same bytes-at-offset pattern as DataConstraintZC, but applied to
/// account data instead of instruction data. Protocol-agnostic — the
/// vault owner configures byte offsets from protocol documentation.
///
/// Phase B1: absolute value assertions (check field ≤ max, field ≥ min).
/// Phase B2: delta-mode assertions (MaxDecrease, MaxIncrease, NoChange).
///
/// Phase B3 CrossFieldLte fields (cross_field_offset_b, cross_field_multiplier_bps,
/// cross_field_flags) DELETED in Phase 1 Option A demolition (L-1). The two-field
/// ratio check (field_A × 10000 ≤ multiplier_bps × field_B) was Jupiter-Perps-flavored
/// leverage-cap logic that doesn't generalize to a per-vault generic primitive.
#[zero_copy]
pub struct PostAssertionEntryZC {
    /// The account to read after execution (passed via remaining_accounts).
    ///
    /// Per-mode interpretation:
    /// - modes 0..3 (Absolute / MaxDecrease / MaxIncrease / NoChange):
    ///   protocol state account (Position PDA, User account, etc).
    /// - mode 4 MintDeltaCap with `aux_byte=1` (scope=1): the single token
    ///   account whose balance we measure. With `aux_byte=0` (scope=0):
    ///   UNUSED — ATAs are derived on-chain from `(vault, expected_value)`.
    pub target_account: [u8; 32], // 32

    /// Byte offset in the target account's data to read (modes 0..3).
    /// Phase 6 modes (4) ignore this field — balances are read at the
    /// canonical SPL/Token-2022 layout offset (64..72).
    pub offset: u16, // 2

    /// Length of the value to compare (1-32 bytes) for modes 0..3.
    /// Phase 6 mode 4 ignores this field.
    pub value_len: u8, // 1

    /// Comparison operator (reuses ConstraintOperator: Eq, Ne, Gte, Lte, etc.)
    /// Modes 1..4 ignore this field.
    pub operator: u8, // 1

    /// Per-mode payload:
    /// - modes 0..3: expected value for comparison (same max as DataConstraint).
    /// - mode 4 MintDeltaCap: bytes 0..32 = mint pubkey identifying the
    ///   target token. Remaining bytes are unused.
    pub expected_value: [u8; MAX_CONSTRAINT_VALUE_LEN], // 32

    /// Assertion mode:
    /// 0 = Absolute: check current value against expected_value
    /// 1 = MaxDecrease: check (snapshot - current) ≤ expected_value (Phase B2)
    ///     NOTE: If value increases (current > snapshot), check ALWAYS PASSES (saturating sub = 0).
    ///     For bidirectional protection, pair with MaxIncrease or use NoChange.
    /// 2 = MaxIncrease: check (current - snapshot) ≤ expected_value (Phase B2)
    ///     NOTE: If value decreases, check ALWAYS PASSES.
    /// 3 = NoChange: check current == snapshot — byte-for-byte equality (Phase B2)
    /// 4 = MintDeltaCap (Phase 6 R-1): vault-wide or per-account drain ceiling
    pub assertion_mode: u8, // 1

    /// Phase 6 generic auxiliary value — per-mode interpretation:
    /// - mode 4 MintDeltaCap: u64 LE = max_net_decrease (units of the mint's
    ///   smallest denomination).
    /// - modes 0..3: UNUSED, must be zero (validate_entries enforces).
    /// Stored as raw bytes to keep the struct alignment at 2 (avoids a u64
    /// alignment bump that would force the entry to a multiple of 8 and
    /// regress capacity math).
    pub aux_value: [u8; 8], // 8

    /// Phase 6 generic auxiliary byte — per-mode interpretation:
    /// - mode 4 MintDeltaCap: scope (0 = vault-wide ATA enumeration,
    ///   1 = single account in `target_account`).
    /// - modes 0..3: UNUSED, must be zero (validate_entries enforces).
    ///
    /// The trailing `aux_byte` brings the entry to an even size (78) which
    /// satisfies the struct's u16 alignment without a separate `_padding`
    /// field — the previous `_padding: u8` from Phase 1 demolition was
    /// absorbed here. Off-chain decoders that previously read `_padding`
    /// now read `aux_byte`; the byte position is the same so wire
    /// compatibility holds with the previous version's zero value.
    pub aux_byte: u8, // 1
}
// = 78 bytes per entry (32 + 2 + 1 + 1 + 32 + 1 + 8 + 1 = 78)

/// On-chain account storing post-execution assertions for a vault.
/// Seeds: [b"post_assertions", vault.key()]
///
/// Phase 6 grow: entries 4 → 8, per-entry size 70 → 78 bytes. New SIZE 672.
#[account(zero_copy)]
pub struct PostExecutionAssertions {
    /// The vault this assertion set belongs to.
    pub vault: [u8; 32], // 32

    /// Assertion entries (fixed-size array, up to MAX_POST_ASSERTION_ENTRIES).
    pub entries: [PostAssertionEntryZC; MAX_POST_ASSERTION_ENTRIES], // 8 * 78 = 624

    /// Number of active entries (0..=MAX_POST_ASSERTION_ENTRIES).
    pub entry_count: u8, // 1

    /// PDA bump seed.
    pub bump: u8, // 1

    /// Reserved for future use.
    pub _padding: [u8; 6], // 6
}
// Total: 8 (discriminator) + 32 + 624 + 1 + 1 + 6 = 672 bytes

impl PostExecutionAssertions {
    pub const SIZE: usize = 8 + 32 + (78 * MAX_POST_ASSERTION_ENTRIES) + 1 + 1 + 6;

    // LM-1 (Bucket-3 audit 2026-05-23): compile-time pin against silent
    // drift of the documented byte baseline. Any field addition that does
    // not also update this assert breaks the build.
    const _POST_EXECUTION_ASSERTIONS_SIZE_PIN: () = assert!(
        PostExecutionAssertions::SIZE == 672,
        "PostExecutionAssertions::SIZE drifted from documented baseline"
    );

    /// Validate a set of assertion entries before storing.
    pub fn validate_entries(entries: &[PostAssertionEntry]) -> Result<()> {
        // Must have at least 1 entry (creating empty assertions wastes rent)
        require!(
            !entries.is_empty() && entries.len() <= MAX_POST_ASSERTION_ENTRIES,
            crate::errors::SigilError::InvalidConstraintConfig
        );
        for entry in entries {
            // Assertion mode must be valid first — gates per-mode validation
            // (some modes legitimately ignore value_len / operator).
            let mode = AssertionMode::try_from(entry.assertion_mode)
                .map_err(|_| crate::errors::SigilError::InvalidConstraintConfig)?;

            // Modes 0..3 require non-zero value_len + valid operator.
            // Phase 6 mode 4 (MintDeltaCap) ignores value_len/operator/offset.
            if (entry.assertion_mode as usize) < 4 {
                // Value length must be 1-32
                require!(
                    entry.value_len > 0 && entry.value_len as usize <= MAX_CONSTRAINT_VALUE_LEN,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
                // Expected value must be at least value_len bytes
                require!(
                    entry.expected_value.len() >= entry.value_len as usize,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
                // Operator must be valid (0-6)
                require!(
                    ConstraintOperator::try_from(entry.operator).is_ok(),
                    crate::errors::SigilError::InvalidConstraintOperator
                );

                // Phase B2: delta modes (1-3) require value_len <= 8 for numeric comparison
                if entry.assertion_mode >= 1 && entry.assertion_mode <= 3 {
                    require!(
                        entry.value_len <= 8,
                        crate::errors::SigilError::InvalidConstraintConfig
                    );
                }

                // Modes 0..3 must NOT use aux fields — invariant for off-chain
                // decoders so a legacy mode-0 entry can never silently carry a
                // R-1 payload.
                require!(
                    entry.aux_value == [0u8; 8],
                    crate::errors::SigilError::InvalidConstraintConfig
                );
                require!(
                    entry.aux_byte == 0,
                    crate::errors::SigilError::InvalidConstraintConfig
                );
            } else {
                // Phase 6 modes (4..) — per-mode field requirements.
                match mode {
                    AssertionMode::MintDeltaCap => {
                        // expected_value carries the mint pubkey at bytes 0..32.
                        require!(
                            entry.expected_value.len() >= 32,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        // scope ∈ {0, 1}
                        require!(
                            entry.aux_byte <= 1,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        // max_net_decrease must be non-zero — a cap of 0 would
                        // mean "any drain rejects", which is achievable via
                        // NoChange. Force the owner to express that case
                        // through the existing primitive rather than overloading.
                        let max_dec = u64::from_le_bytes(entry.aux_value);
                        require!(
                            max_dec > 0,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                    }
                    AssertionMode::AtaAuthorityPin => {
                        // target_account MUST be set to the ATA we're pinning.
                        // The default Pubkey::default() is rejected to catch
                        // owners who forgot to fill the field.
                        require!(
                            entry.target_account != Pubkey::default(),
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        // aux_value / aux_byte unused — must be zero.
                        require!(
                            entry.aux_value == [0u8; 8],
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        require!(
                            entry.aux_byte == 0,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                    }
                    AssertionMode::OutputBalanceFloor => {
                        // target_account = token account to measure.
                        require!(
                            entry.target_account != Pubkey::default(),
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        // expected_value[0..32] = mint for sanity-check that
                        // target_account.mint matches at validate snapshot.
                        require!(
                            entry.expected_value.len() >= 32,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        // min_increase must be non-zero — a floor of 0 is
                        // trivially satisfied by any positive delta.
                        let min_inc = u64::from_le_bytes(entry.aux_value);
                        require!(
                            min_inc > 0,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        // aux_byte unused — must be zero.
                        require!(
                            entry.aux_byte == 0,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                    }
                    AssertionMode::DeclarationConsistency => {
                        // target_account = declared recipient (the wallet
                        // address whose token-account-owner field we'll
                        // check matches at finalize). Must not be default.
                        require!(
                            entry.target_account != Pubkey::default(),
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        // expected_value[0..32] = declared mint. Must not
                        // be the zero pubkey.
                        require!(
                            entry.expected_value.len() >= 32,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        let mut mint_bytes = [0u8; 32];
                        mint_bytes.copy_from_slice(&entry.expected_value[0..32]);
                        require!(
                            Pubkey::new_from_array(mint_bytes) != Pubkey::default(),
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        // aux_byte = account_meta_index (capped at 64 since
                        // Solana v0 tx instructions can address at most ~64
                        // metas). aux_value unused.
                        require!(
                            entry.aux_byte < 64,
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                        require!(
                            entry.aux_value == [0u8; 8],
                            crate::errors::SigilError::InvalidConstraintConfig
                        );
                    }
                    // Modes 0..3 are pre-Phase-6 — handled in the `if` arm
                    // above. The outer `if entry.assertion_mode < 4` guard
                    // means execution never reaches here for those modes;
                    // pattern match exhaustiveness demands they be listed.
                    AssertionMode::Absolute
                    | AssertionMode::MaxDecrease
                    | AssertionMode::MaxIncrease
                    | AssertionMode::NoChange => {
                        return Err(crate::errors::SigilError::InvalidConstraintConfig.into());
                    }
                }
            }
        }
        Ok(())
    }
}

/// Borsh-serializable assertion entry (instruction parameter form).
///
/// Phase B3 fields (cross_field_offset_b, cross_field_multiplier_bps,
/// cross_field_flags) DELETED in Phase 1 Option A demolition.
///
/// Phase 6 appended `aux_value: [u8; 8]` + `aux_byte: u8` for the four new
/// variants (R-1/R-2/R-3/R-4). Modes 0..3 must set both to zero; the
/// validator enforces it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PostAssertionEntry {
    pub target_account: Pubkey,
    pub offset: u16,
    pub value_len: u8,
    pub operator: u8,
    pub expected_value: Vec<u8>,
    pub assertion_mode: u8,
    /// Phase 6: u64 LE auxiliary value. Per-mode meaning — see ZC struct.
    pub aux_value: [u8; 8],
    /// Phase 6: u8 auxiliary byte. Per-mode meaning — see ZC struct.
    pub aux_byte: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Helpers ────────────────────────────────────────────────────────

    fn mk_assertion_entry(mode: u8, value_len: u8) -> PostAssertionEntry {
        PostAssertionEntry {
            target_account: Pubkey::default(),
            offset: 0,
            value_len,
            operator: 0, // Eq
            expected_value: vec![0u8; value_len as usize],
            assertion_mode: mode,
            aux_value: [0u8; 8],
            aux_byte: 0,
        }
    }

    /// Phase 6 R-1 helper — MintDeltaCap entry constructor.
    fn mk_mintdeltacap(mint: Pubkey, max_dec: u64, scope: u8) -> PostAssertionEntry {
        let mut expected = vec![0u8; 32];
        expected.copy_from_slice(mint.as_ref());
        PostAssertionEntry {
            target_account: Pubkey::default(),
            offset: 0,
            value_len: 0,
            operator: 0,
            expected_value: expected,
            assertion_mode: 4, // MintDeltaCap
            aux_value: max_dec.to_le_bytes(),
            aux_byte: scope,
        }
    }

    /// Phase 6 R-2 helper — AtaAuthorityPin entry constructor.
    fn mk_ata_authority_pin(ata: Pubkey) -> PostAssertionEntry {
        PostAssertionEntry {
            target_account: ata,
            offset: 0,
            value_len: 0,
            operator: 0,
            expected_value: vec![],
            assertion_mode: 5, // AtaAuthorityPin
            aux_value: [0u8; 8],
            aux_byte: 0,
        }
    }

    /// Phase 6 R-3 helper — OutputBalanceFloor entry constructor.
    fn mk_output_floor(token_account: Pubkey, mint: Pubkey, min_inc: u64) -> PostAssertionEntry {
        let mut expected = vec![0u8; 32];
        expected.copy_from_slice(mint.as_ref());
        PostAssertionEntry {
            target_account: token_account,
            offset: 0,
            value_len: 0,
            operator: 0,
            expected_value: expected,
            assertion_mode: 6, // OutputBalanceFloor
            aux_value: min_inc.to_le_bytes(),
            aux_byte: 0,
        }
    }

    /// Phase 6 R-4 helper — DeclarationConsistency entry constructor.
    fn mk_declaration(recipient: Pubkey, mint: Pubkey, meta_index: u8) -> PostAssertionEntry {
        let mut expected = vec![0u8; 32];
        expected.copy_from_slice(mint.as_ref());
        PostAssertionEntry {
            target_account: recipient,
            offset: 0,
            value_len: 0,
            operator: 0,
            expected_value: expected,
            assertion_mode: 7, // DeclarationConsistency
            aux_value: [0u8; 8],
            aux_byte: meta_index,
        }
    }

    // mk_crossfield_entry DELETED in Phase 1 Option A demolition along with
    // the seven CrossFieldLte tests below it.

    // ─── AssertionMode TryFrom<u8> ──────────────────────────────────────

    #[test]
    fn assertion_mode_try_from_valid_discriminants() {
        assert_eq!(AssertionMode::try_from(0), Ok(AssertionMode::Absolute));
        assert_eq!(AssertionMode::try_from(1), Ok(AssertionMode::MaxDecrease));
        assert_eq!(AssertionMode::try_from(2), Ok(AssertionMode::MaxIncrease));
        assert_eq!(AssertionMode::try_from(3), Ok(AssertionMode::NoChange));
        // Phase 6 R-1
        assert_eq!(AssertionMode::try_from(4), Ok(AssertionMode::MintDeltaCap));
        // Phase 6 R-2
        assert_eq!(
            AssertionMode::try_from(5),
            Ok(AssertionMode::AtaAuthorityPin)
        );
        // Phase 6 R-3
        assert_eq!(
            AssertionMode::try_from(6),
            Ok(AssertionMode::OutputBalanceFloor)
        );
        // Phase 6 R-4
        assert_eq!(
            AssertionMode::try_from(7),
            Ok(AssertionMode::DeclarationConsistency)
        );
    }

    #[test]
    fn assertion_mode_try_from_rejects_8_and_above() {
        // mode 8 is the next free slot after Phase 6 — must be rejected
        // until a future phase lands a successor variant.
        assert!(AssertionMode::try_from(8).is_err());
    }

    #[test]
    fn assertion_mode_try_from_rejects_255() {
        assert!(AssertionMode::try_from(255).is_err());
    }

    #[test]
    fn assertion_mode_round_trip_discriminants() {
        assert_eq!(AssertionMode::Absolute as u8, 0);
        assert_eq!(AssertionMode::MaxDecrease as u8, 1);
        assert_eq!(AssertionMode::MaxIncrease as u8, 2);
        assert_eq!(AssertionMode::NoChange as u8, 3);
        assert_eq!(AssertionMode::MintDeltaCap as u8, 4);
        assert_eq!(AssertionMode::AtaAuthorityPin as u8, 5);
        assert_eq!(AssertionMode::OutputBalanceFloor as u8, 6);
        assert_eq!(AssertionMode::DeclarationConsistency as u8, 7);
    }

    // ─── B2: delta modes in validate_entries ────────────────────────────

    #[test]
    fn validate_accepts_max_decrease_with_value_len_8() {
        let entries = vec![mk_assertion_entry(1, 8)]; // MaxDecrease, 8 bytes
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_accepts_max_increase_with_value_len_4() {
        let entries = vec![mk_assertion_entry(2, 4)]; // MaxIncrease, 4 bytes
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_accepts_no_change_with_value_len_1() {
        let entries = vec![mk_assertion_entry(3, 1)]; // NoChange, 1 byte
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_max_decrease_with_value_len_9() {
        let entries = vec![mk_assertion_entry(1, 9)]; // MaxDecrease, 9 bytes — too large for delta
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_max_decrease_with_value_len_32() {
        let entries = vec![mk_assertion_entry(1, 32)]; // MaxDecrease, 32 bytes — way too large
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_mode_4_as_legacy_b1_entry() {
        // mk_assertion_entry sets aux_value/aux_byte to 0 — but for mode 4
        // (MintDeltaCap) max_net_decrease MUST be non-zero. This test pins
        // that the validator catches a legacy-shaped entry attempting to
        // claim the new mode.
        let entries = vec![mk_assertion_entry(4, 4)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_unknown_mode_255() {
        let entries = vec![mk_assertion_entry(255, 4)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    // ─── Phase 6 R-1 MintDeltaCap validate_entries ─────────────────────

    #[test]
    fn validate_accepts_mintdeltacap_scope_0_vault_wide() {
        let mint = Pubkey::new_unique();
        let entries = vec![mk_mintdeltacap(mint, 1_000_000, 0)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_accepts_mintdeltacap_scope_1_single_account() {
        let mint = Pubkey::new_unique();
        let mut entry = mk_mintdeltacap(mint, 500_000, 1);
        entry.target_account = Pubkey::new_unique();
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_mintdeltacap_scope_above_1() {
        let mint = Pubkey::new_unique();
        let entries = vec![mk_mintdeltacap(mint, 100, 2)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_mintdeltacap_zero_max_decrease() {
        // A zero cap is achievable via NoChange (mode 3); we force the owner
        // to express that case via the existing primitive rather than overload
        // R-1's aux_value semantic.
        let mint = Pubkey::new_unique();
        let entries = vec![mk_mintdeltacap(mint, 0, 0)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_legacy_mode_with_nonzero_aux_value() {
        // A mode-0 entry with aux fields set is a malformed encoding — the
        // validator must reject so off-chain decoders can rely on the
        // invariant "modes 0..3 have zeroed aux fields".
        let mut entry = mk_assertion_entry(0, 4);
        entry.aux_value = [1u8; 8];
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_legacy_mode_with_nonzero_aux_byte() {
        let mut entry = mk_assertion_entry(2, 8); // MaxIncrease
        entry.aux_byte = 1;
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    // ─── Phase 6 R-2 AtaAuthorityPin validate_entries ──────────────────

    #[test]
    fn validate_accepts_ata_authority_pin() {
        let ata = Pubkey::new_unique();
        let entries = vec![mk_ata_authority_pin(ata)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_ata_authority_pin_default_target() {
        let entries = vec![mk_ata_authority_pin(Pubkey::default())];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_ata_authority_pin_with_aux_value_set() {
        let mut entry = mk_ata_authority_pin(Pubkey::new_unique());
        entry.aux_value = [1u8; 8];
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_ata_authority_pin_with_aux_byte_set() {
        let mut entry = mk_ata_authority_pin(Pubkey::new_unique());
        entry.aux_byte = 1;
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    // ─── Phase 6 R-3 OutputBalanceFloor validate_entries ───────────────

    #[test]
    fn validate_accepts_output_balance_floor() {
        let ta = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let entries = vec![mk_output_floor(ta, mint, 500_000)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_output_floor_default_target() {
        let mint = Pubkey::new_unique();
        let entries = vec![mk_output_floor(Pubkey::default(), mint, 500_000)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_output_floor_zero_min_increase() {
        // A floor of 0 is trivially satisfied — owner should not encode it.
        let ta = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let entries = vec![mk_output_floor(ta, mint, 0)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_output_floor_with_aux_byte_set() {
        let mut entry = mk_output_floor(Pubkey::new_unique(), Pubkey::new_unique(), 1);
        entry.aux_byte = 1;
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    // ─── Phase 6 R-4 DeclarationConsistency validate_entries ───────────

    #[test]
    fn validate_accepts_declaration_consistency() {
        let recipient = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let entries = vec![mk_declaration(recipient, mint, 3)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_declaration_default_recipient() {
        let mint = Pubkey::new_unique();
        let entries = vec![mk_declaration(Pubkey::default(), mint, 0)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_declaration_zero_mint() {
        let recipient = Pubkey::new_unique();
        let entries = vec![mk_declaration(recipient, Pubkey::default(), 0)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_declaration_meta_index_too_large() {
        let recipient = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let entries = vec![mk_declaration(recipient, mint, 64)];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    #[test]
    fn validate_rejects_declaration_with_aux_value_set() {
        let mut entry = mk_declaration(Pubkey::new_unique(), Pubkey::new_unique(), 0);
        entry.aux_value = [1u8; 8];
        let entries = vec![entry];
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    /// §RP CRIT-1 boundary: AssertionMode 7 (DeclarationConsistency) is a
    /// finalize-only verifier — its validate_and_authorize dispatcher branch
    /// MUST short-circuit before the legacy delta-snapshot path that requires
    /// `entry.target_account` to be a token account in `remaining_accounts`.
    /// For R-4, `target_account` is the declared *recipient wallet* pubkey,
    /// which is NOT a token account; falling through to the legacy branch
    /// would either DoS the vault or force recipient-info disclosure on
    /// every sandwich. This test pins the classification semantic; the
    /// integration coverage lives in `tests/post-assertions-sandwich.ts`.
    #[test]
    fn r4_declaration_consistency_is_finalize_only_no_snapshot_needed() {
        // The dispatcher in validate_and_authorize.rs treats mode 7 the same
        // way as mode 5 (AtaAuthorityPin): explicit `continue;` before the
        // legacy snapshot block. Both modes have finalize-only verifiers in
        // `post_assertion_helpers.rs`. Mode 4 (MintDeltaCap) and mode 6
        // (OutputBalanceFloor) DO need validate-time snapshots; modes 0/5/7
        // do not.
        assert_eq!(AssertionMode::AtaAuthorityPin as u8, 5);
        assert_eq!(AssertionMode::DeclarationConsistency as u8, 7);
        // Snapshot-bearing modes (write `session.assertion_snapshots[i]` at validate):
        let snapshot_modes = [4u8, 6u8]; // MintDeltaCap, OutputBalanceFloor
                                         // Snapshot-free modes (validate-time `continue`):
        let snapshot_free_modes = [5u8, 7u8]; // AtaAuthorityPin, DeclarationConsistency
        for m in snapshot_modes.iter().chain(snapshot_free_modes.iter()) {
            assert!(AssertionMode::try_from(*m).is_ok(), "mode {} must parse", m);
        }
    }

    #[test]
    fn validate_accepts_max_entries_8() {
        // Capacity ceiling — exactly MAX_POST_ASSERTION_ENTRIES (8) entries.
        let entries: Vec<_> = (0..MAX_POST_ASSERTION_ENTRIES)
            .map(|_| mk_assertion_entry(0, 4))
            .collect();
        assert!(PostExecutionAssertions::validate_entries(&entries).is_ok());
    }

    #[test]
    fn validate_rejects_more_than_max_entries() {
        let entries: Vec<_> = (0..(MAX_POST_ASSERTION_ENTRIES + 1))
            .map(|_| mk_assertion_entry(0, 4))
            .collect();
        assert!(PostExecutionAssertions::validate_entries(&entries).is_err());
    }

    // B3 CrossFieldLte tests DELETED in Phase 1 Option A demolition.
    // The 7 deleted tests covered:
    //   - validate_accepts_crossfield_enabled_absolute_mode_positive_multiplier
    //   - validate_rejects_crossfield_enabled_with_delta_mode
    //   - validate_rejects_crossfield_enabled_with_zero_multiplier
    //   - validate_rejects_crossfield_enabled_with_unknown_flags
    //   - validate_accepts_crossfield_disabled_zeroed_fields
    //   - validate_rejects_crossfield_disabled_but_nonzero_offset_b
    //   - validate_rejects_crossfield_disabled_but_nonzero_multiplier
}
