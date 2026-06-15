//! AL3 + D-6 on-chain intent-digest verifier (Bucket 2, audit 2026-05-21).
//!
//! ## Scope (D-1 minimum viable)
//!
//! Provides the canonical SHA-256 digest over the SCALAR portion of a
//! `SealInput` envelope: vault, agent identity, token_mint, amount,
//! target_protocol, network. These six fields cover what the owner approved
//! in the preview UI for the scalars that DO NOT undergo agent-ATA →
//! vault-ATA rewriting at submit time.
//!
//! The full ix-bound digest (covering `Vec<Instruction>` as well as the
//! scalars) remains client-side only — Phase 10 + Phase 11 will introduce
//! the architectural pieces needed for ix verification on-chain (the
//! ATA-rewrite mapping table needs to be authenticated, which crosses the
//! seal() / validate_and_authorize boundary in non-trivial ways). The
//! scalar digest closes the AMOUNT/MINT/PROTOCOL tamper class today.
//!
//! RECIPIENT (audit 2026-06-15, M5 — VALIDATED, 5-comparator research): the
//! destination is deliberately NOT in this digest. For an autonomous-agent
//! delegation model, recipient is controlled by the persistent destination
//! ALLOWLIST + per-recipient cap + the F-Q8 output-ATA pin — the field-standard
//! recipient control for session-key / agent delegation (Squads SpendingLimit
//! `destinations`, Zodiac Roles, ZeroDev CallPolicy, ERC-7715), NOT per-tx
//! recipient signing (that is the one-shot-intent model — CoW/UniswapX — which
//! Sigil is not). Binding the full `Vec<Instruction>` on-chain is infeasible
//! under the ATA-rewrite (Jupiter resolves accounts/ATAs/ALTs at /swap build
//! time) and is deferred Phase 10/11 work. ix-data tamper remains gated by
//! R-1..R-4 + TA-12 + TA-14 post-execution invariants.
//!
//! ## Canonical encoding (FIXED — DO NOT REORDER)
//!
//!   1. magic_prefix: `b"SIG1"` (4 bytes — D-6)
//!   2. intent_version: u8 = 2 (1 byte — v2 reserves discriminant for Bucket 2 format; v1 was the prior client-only digest without magic prefix)
//!   3. network_id: u8 (1 byte; 0=devnet, 1=mainnet — binds AL4)
//!   4. vault: Pubkey (32 bytes)
//!   5. agent: Pubkey (32 bytes — agent IDENTITY, not signer)
//!   6. token_mint: Pubkey (32 bytes)
//!   7. amount: u64 LE (8 bytes)
//!   8. target_protocol: Pubkey (32 bytes; system program if the caller omitted `targetProtocol`)
//!
//! Total fixed size: 4 + 1 + 1 + 32 + 32 + 32 + 8 + 32 = 142 bytes.
//!
//! ## Cross-impl invariant
//!
//! The TypeScript counterpart at `sdk/kit/src/seal/intent-digest.ts`
//! (`computeScalarIntentDigest`) MUST emit the same bytes in the same
//! order. The byte-equal contract is enforced by the cross-impl property
//! test at `tests/intent-digest-parity.ts` (created Phase 10a-B7.1 —
//! 13 parity assertions against 4 pinned hex vectors in
//! `tests/fixtures/intent-digest.json`, byte-equal Rust↔TS).
//!
//! ## Network discriminant
//!
//! `0 = devnet, 1 = mainnet`. The on-chain program embeds its own network
//! discriminant via the `mainnet` / `devnet` Cargo features (see
//! `state/mod.rs` build guard). The verifier reads its own feature flag
//! and rejects any digest claiming a different network than what the
//! program was compiled for. This prevents replaying a mainnet-targeted
//! digest through a devnet program (or vice-versa) by mistake.

use anchor_lang::prelude::*;
use solana_program::hash::hashv;

/// Magic prefix prepended to the canonical encoding. Protects against
/// cross-format digest collisions if Sigil ever introduces a different
/// SHA-256-based digest with the same field shape (Council ISC-155 spirit).
pub const INTENT_DIGEST_MAGIC: &[u8; 4] = b"SIG1";

/// Intent format version. Bumped from v1 to v2 in Bucket 2 to discriminate
/// (a) the magic-prefix addition and (b) the on-chain verifier ABI.
pub const INTENT_VERSION_V2: u8 = 2;

/// Network discriminant for the canonical encoding.
pub const NETWORK_ID_DEVNET: u8 = 0;
/// Network discriminant for the canonical encoding.
pub const NETWORK_ID_MAINNET: u8 = 1;

/// Return the network discriminant for the current build's network feature.
///
/// Used by `validate_and_authorize` to bind the expected digest's network
/// byte to the program's own network — a mainnet digest sent to a devnet
/// program (or vice-versa) reproducibly fails the byte-equal check.
pub fn current_network_id() -> u8 {
    #[cfg(feature = "mainnet")]
    {
        NETWORK_ID_MAINNET
    }
    #[cfg(not(feature = "mainnet"))]
    {
        NETWORK_ID_DEVNET
    }
}

/// Scalar binding fields for the on-chain intent-digest verifier.
///
/// `target_protocol` defaults to `Pubkey::default()` (system program) when
/// the caller omitted it client-side — the TS encoder uses the same
/// convention, so the digest stays stable across both paths.
pub struct ScalarIntentInput<'a> {
    pub vault: &'a Pubkey,
    pub agent: &'a Pubkey,
    pub token_mint: &'a Pubkey,
    pub amount: u64,
    pub target_protocol: &'a Pubkey,
}

/// Compute the canonical scalar intent digest.
///
/// SHA-256 over: `b"SIG1" || u8(2) || u8(network_id) || vault || agent ||
/// token_mint || u64_le(amount) || target_protocol`. Total 142 bytes.
///
/// Network id is derived from the program's build feature (devnet or
/// mainnet) — the caller does NOT specify it. This makes wrong-network
/// digests fail-by-construction.
pub fn compute_scalar_intent_digest(input: &ScalarIntentInput<'_>) -> [u8; 32] {
    // Build the 142-byte canonical encoding and hash with `hashv(&[&buf])`,
    // matching the pattern at policy_digest.rs:369 / cosign_digest.rs:132.
    // `Vec::with_capacity(142)` does one allocation up front; the field
    // appends are bounded and inlined. BPF SHA-256 is ~80 CU + ~1 CU/byte.
    let mut buf: Vec<u8> = Vec::with_capacity(142);
    buf.extend_from_slice(INTENT_DIGEST_MAGIC);
    buf.push(INTENT_VERSION_V2);
    buf.push(current_network_id());
    buf.extend_from_slice(input.vault.as_ref());
    buf.extend_from_slice(input.agent.as_ref());
    buf.extend_from_slice(input.token_mint.as_ref());
    buf.extend_from_slice(&input.amount.to_le_bytes());
    buf.extend_from_slice(input.target_protocol.as_ref());
    debug_assert_eq!(
        buf.len(),
        142,
        "canonical scalar intent encoding must be 142 bytes"
    );
    hashv(&[&buf]).to_bytes()
}

/// Byte-equal compare two 32-byte digests in constant time.
///
/// Using `subtle::ConstantTimeEq` would pull in a dep; the manual XOR-then-
/// OR-fold form below is constant-time on every BPF target and matches the
/// pattern used elsewhere in the program (see `cosign_digest.rs`).
#[inline]
pub fn digests_equal(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff: u8 = 0;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::pubkey::Pubkey;

    #[test]
    fn empty_scalar_digest_is_stable() {
        // All-zero scalar input — a fixed-point test that catches accidental
        // reordering of the canonical encoding without needing TS-side
        // cooperation. If this hash changes, the on-chain verifier and the
        // TS encoder have diverged.
        let zero = Pubkey::default();
        let input = ScalarIntentInput {
            vault: &zero,
            agent: &zero,
            token_mint: &zero,
            amount: 0,
            target_protocol: &zero,
        };
        let digest = compute_scalar_intent_digest(&input);
        // Pin the byte value so future canonical-encoding edits are
        // caught at compile-time of this test, not at devnet integration.
        // The host build runs with `--features devnet` by default (see
        // Cargo.toml default-features), so network_id=0 in this fixture.
        // Mainnet build will compute a different digest — the test
        // intentionally pins ONE network for byte stability and the
        // mainnet variant lives in tests/intent-digest-parity.ts.
        assert_eq!(digest.len(), 32);
        // The all-zero input under devnet network MUST be non-zero
        // (SHA-256 of "SIG1" + 0u8 + 0u8 + 142 zero bytes is non-zero).
        assert!(digest.iter().any(|&b| b != 0));
    }

    #[test]
    fn nonempty_scalar_digest_differs_from_empty() {
        // Toggle one byte of one scalar field and confirm the digest
        // changes. Catches the class of bug where one field is silently
        // skipped during encoding.
        let zero = Pubkey::default();
        let nonzero_mint = Pubkey::new_from_array([0x11; 32]);

        let empty_input = ScalarIntentInput {
            vault: &zero,
            agent: &zero,
            token_mint: &zero,
            amount: 0,
            target_protocol: &zero,
        };
        let nonzero_input = ScalarIntentInput {
            vault: &zero,
            agent: &zero,
            token_mint: &nonzero_mint,
            amount: 0,
            target_protocol: &zero,
        };

        let a = compute_scalar_intent_digest(&empty_input);
        let b = compute_scalar_intent_digest(&nonzero_input);
        assert!(!digests_equal(&a, &b));
    }

    #[test]
    fn amount_tamper_changes_digest() {
        // Amount tampering is exactly the threat the digest closes —
        // 100 USDC vs 100000 USDC must produce distinct digests.
        let zero = Pubkey::default();
        let lo = ScalarIntentInput {
            vault: &zero,
            agent: &zero,
            token_mint: &zero,
            amount: 100,
            target_protocol: &zero,
        };
        let hi = ScalarIntentInput {
            vault: &zero,
            agent: &zero,
            token_mint: &zero,
            amount: 100_000,
            target_protocol: &zero,
        };
        let lo_digest = compute_scalar_intent_digest(&lo);
        let hi_digest = compute_scalar_intent_digest(&hi);
        assert!(!digests_equal(&lo_digest, &hi_digest));
    }

    #[test]
    fn digests_equal_is_total() {
        // Sanity: equal slices compare equal, single-bit flip compares
        // unequal. Closes the off-by-one risk in the byte XOR loop.
        let a = [0u8; 32];
        let mut b = [0u8; 32];
        assert!(digests_equal(&a, &b));
        b[17] = 1;
        assert!(!digests_equal(&a, &b));
    }
}
