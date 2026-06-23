//! Item 3 — verified-build gate (on-chain hash check).
//!
//! A vault owner pins the SHA-256 of an allowlisted protocol's deployed ELF
//! into `PolicyConfig.protocol_hashes` (index-aligned to `protocols`). At
//! `validate_and_authorize`, if the target protocol has a non-zero pinned hash,
//! `enforce_program_build_hash` recomputes the hash of the target's currently
//! deployed ELF and rejects the bundle if it differs — closing the
//! upgrade-TOCTOU: an owner allowlists Jupiter, Jupiter is later upgraded to a
//! drain contract, and pure-pubkey allowlisting would otherwise keep
//! authorizing the (now-hostile) program.
//!
//! The hashed bytes are EXACTLY the bytes the SDK `getProgramDataHash`
//! (`sdk/kit/src/program-hash.ts`) hashes: the target's BPFLoaderUpgradeable
//! `ProgramData` account data past its 45-byte header. The
//! `UpgradeableLoaderState::ProgramData` serialization is:
//!
//!   4 bytes  enum discriminant (variant 3)
//!   8 bytes  slot (u64 LE)
//!   1 byte   Option<Pubkey> tag for upgrade_authority_address
//!  32 bytes  upgrade authority pubkey
//!  --------
//!  45 bytes  header, then the raw ELF to EOF.
//!
//! This helper MUST stay byte-identical to that offset + primitive (sha256),
//! or a hash pinned via the SDK will never match the on-chain recomputation.

use crate::errors::SigilError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use solana_program::hash::hashv;

/// Byte length of the `UpgradeableLoaderState::ProgramData` header that
/// precedes the ELF: 4 (enum discriminant) + 8 (slot u64) + 1 (Option tag) +
/// 32 (upgrade authority) = 45. The hashed payload is
/// `data[PROGRAM_DATA_HEADER_LEN..]`. Mirrors the SDK constant of the same name
/// in `sdk/kit/src/program-hash.ts`.
pub const PROGRAM_DATA_HEADER_LEN: usize = 45;

/// Enforce that the target protocol's currently-deployed ELF hashes to the
/// owner-pinned `expected_hash`.
///
/// `#[inline(never)]` is REQUIRED: `validate_and_authorize` runs near the
/// 4096-byte BPF stack ceiling (PolicyConfig + multiple `Box`ed accounts +
/// sysvar scans), and this helper borrows `ProgramData` account bytes + builds a
/// 32-byte hash buffer. Keeping it in its own stack frame protects the caller's
/// already-tight frame — the same established pattern as
/// `build_ta11_protected_set`. Do NOT inline.
///
/// Steps:
///   1. Derive expected ProgramData PDA =
///      `find_program_address([target_program_id], BPFLoaderUpgradeable)` and
///      require the supplied account matches it (closes a decoy-account attack).
///   2. Require the account is owned by BPFLoaderUpgradeable.
///   3. Require the account is larger than the 45-byte header (contains an ELF).
///   4. Recompute `sha256(data[45..])` and require byte-equality with the
///      owner-pinned `expected_hash`.
///
/// All failure modes except (4) surface as `ErrProgramDataUnresolvable` (6116);
/// a genuine hash divergence surfaces as `ErrProgramBuildMismatch` (6117).
#[inline(never)]
pub fn enforce_program_build_hash(
    program_data_account: &AccountInfo,
    target_program_id: &Pubkey,
    expected_hash: &[u8; 32],
) -> Result<()> {
    // 1. The supplied account MUST be the canonical ProgramData PDA for the
    //    target program. Without this, an attacker could pass ANY account whose
    //    bytes happen to hash to expected_hash (e.g. a self-deployed program at
    //    a different address) and pass the gate.
    let (expected_pda, _) =
        Pubkey::find_program_address(&[target_program_id.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(
        *program_data_account.key,
        expected_pda,
        SigilError::ErrProgramDataUnresolvable
    );

    // 2. Ownership: a genuine ProgramData account is owned by the upgradeable
    //    loader. (Defense-in-depth alongside the PDA-derivation check above.)
    require_keys_eq!(
        *program_data_account.owner,
        bpf_loader_upgradeable::ID,
        SigilError::ErrProgramDataUnresolvable
    );

    // 3. The account must hold an ELF past the 45-byte header.
    let data = program_data_account.try_borrow_data()?;
    require!(
        data.len() > PROGRAM_DATA_HEADER_LEN,
        SigilError::ErrProgramDataUnresolvable
    );

    // 4. Recompute SHA-256 over the ELF bytes and compare byte-for-byte against
    //    the owner-pinned hash. `hashv` over a single slice is the same
    //    primitive the SDK uses (sha256 of data[45..]).
    let actual = hashv(&[&data[PROGRAM_DATA_HEADER_LEN..]]).to_bytes();
    require!(&actual == expected_hash, SigilError::ErrProgramBuildMismatch);

    Ok(())
}
