pub mod agent_spend_overlay;
// M1-04: kept agnostic-assertion primitives (ConstraintOperator, bytes_match,
// ct_eq_32, …) relocated here from the now-deleted constraints engine.
// Consumers import `state::assertions::X` explicitly (no glob re-export).
pub mod assertions;
pub mod audit_log_rejected;
pub mod audit_log_success;
pub mod pending_agent_grant;
pub mod pending_agent_perms;
pub mod pending_ownership_transfer;
pub mod pending_policy;
pub mod policy;
pub mod post_assertions;
pub mod session;
pub mod tracker;
pub mod vault;

pub use agent_spend_overlay::*;
pub use audit_log_rejected::*;
pub use audit_log_success::*;
pub use pending_agent_grant::*;
pub use pending_agent_perms::*;
pub use pending_ownership_transfer::*;
pub use pending_policy::*;
pub use policy::*;
pub use post_assertions::*;
pub use session::*;
pub use tracker::*;
pub use vault::*;

/// Maximum number of agents per vault
pub const MAX_AGENTS_PER_VAULT: usize = 10;

/// Full capability level — Operator (spending + non-spending).
/// Used in tests and presets where the agent should have full access.
pub const FULL_CAPABILITY: u8 = 2; // CAPABILITY_OPERATOR

/// Maximum number of allowed protocols in a policy
pub const MAX_ALLOWED_PROTOCOLS: usize = 10;

/// Maximum number of allowed destination addresses for agent transfers
pub const MAX_ALLOWED_DESTINATIONS: usize = 10;

/// Default session duration in seconds (when `policy.session_expiry_seconds == 0`).
///
/// **Why timestamp-based, not slot-based:** Solana slot times vary 400ms-1.5s
/// under congestion. The previous slot-based bound (20 slots) ranged from 8s
/// (target) to 30s (worst-case observed) — a 3.75x variance window. Audit
/// finding F5-H1 (third-pass adversarial review) flagged this as HIGH severity
/// because the documented "8 seconds" assumption was load-bearing for
/// agent-permission risk modeling.
///
/// `Clock::unix_timestamp` is wall-clock and unaffected by congestion.
pub const SESSION_DURATION_SECONDS: i64 = 30;

/// Minimum owner-configurable session duration. Sessions shorter than this
/// are rejected at `queue_policy_update` (a 1-second window is unusable in
/// practice and indicates misconfiguration).
pub const MIN_SESSION_DURATION_SECONDS: u64 = 5;

/// Maximum owner-configurable session duration. Bounded to defend against
/// misconfiguration that would leave delegations live for minutes. Previous
/// slot-based bound (450) at 1.5s/slot would have permitted **11 minutes** of
/// live token delegation under congestion. 90 seconds is a hard worst-case.
pub const MAX_OWNER_SESSION_DURATION_SECONDS: u64 = 90;

/// Fee rate denominator — fee_rate / 1,000,000 = fractional fee
pub const FEE_RATE_DENOMINATOR: u64 = 1_000_000;

/// Protocol fee rate: 200 / 1,000,000 = 0.02% = 2 BPS (hardcoded)
pub const PROTOCOL_FEE_RATE: u16 = 200;

/// Maximum developer fee rate: 500 / 1,000,000 = 0.05% = 5 BPS
pub const MAX_DEVELOPER_FEE_RATE: u16 = 500;

/// Maximum allowed slippage in basis points (5000 = 50%).
/// Prevents misconfiguration while allowing wide flexibility.
pub const MAX_SLIPPAGE_BPS: u16 = 5000;

// MAX_ESCROW_DURATION constant REMOVED in v2 revamp Stage 1 (escrow deleted).

/// Minimum timelock duration: 30 minutes in seconds.
/// Enforced at vault creation and in all queue/apply paths.
/// Once a vault has a timelock, it can never be reduced below this floor.
pub const MIN_TIMELOCK_DURATION: u64 = 1800;

/// F-10 audit fix: maximum age (in slots) between queue and apply for any
/// pending administrative update.
///
/// Defends against durable-nonce pre-signing attacks where an attacker
/// pre-signs `apply_*` and submits weeks/months later — the Drift Protocol
/// April 2026 $285M analog. The on-chain queue already enforces a minimum
/// delay (`MIN_TIMELOCK_DURATION`) before apply, but had no upper bound:
/// a durable-nonce holder could sit on a signed `apply_*` indefinitely and
/// fire it at the moment that hurts the vault most (e.g. right after a
/// loosening policy change clears).
///
/// 216,000 slots = ~24h at 400ms slots, ~90h at 1.5s slots — large enough
/// to absorb any legitimate timelock + execution window, small enough to
/// kill the "weeks later" attack surface. Beyond this window, the queued
/// update is stale and must be re-queued by the owner.
pub const MAX_APPLY_AGE_SLOTS: u64 = 216_000;

/// CH-1 close (Bucket-3 audit 2026-05-23): F-10 freshness window for the
/// two TIMELOCKED-ADMIN pending PDA families (PendingAgentGrant +
/// PendingOwnershipTransfer). These default to MIN_DELAY = 172_800s (48h),
/// so the normal 216_000-slot (~24h) freshness window would reject
/// legitimate apply attempts that come AFTER the timelock matures.
///
/// 700_000 slots ≈ 78 hours at 400ms/slot — leaves 48h timelock + 24h
/// owner-grace + 6h network-clock-skew margin. Wider than the 216_000
/// non-admin window because the 48h timelock is the PRIMARY defense for
/// these elevation primitives; F-10 is supplementary (caps the pre-sign
/// hold window, not the timelock itself).
pub const MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN: u64 = 700_000;

/// TA-07 (Phase 3): 24-hour graylist friction window in seconds.
///
/// New destinations added to `allowed_destinations` via
/// `queue_policy_update` enter `PolicyConfig.destination_graylist` with
/// `unlock_unix = now + GRAYLIST_FRICTION_SECONDS`. Until either
/// (a) the unlock time elapses OR (b) the owner promotes the destination
/// via `promote_graylist_destination`, spending paths reject the
/// destination with `ErrGraylistFriction`.
///
/// 86,400s = 24h. Owner-side `auto_promote_grays` bypass is available
/// (digest-bound).
pub const GRAYLIST_FRICTION_SECONDS: i64 = 86_400;

/// TA-17 (Phase 3): minimum auto_revoke_threshold owners can configure.
///
/// Floor of 3 prevents trivial brick-by-3 attacks (one bad seal in a
/// burst would revoke a working agent). Lower thresholds aren't accepted.
pub const AUTO_REVOKE_THRESHOLD_MIN: u8 = 3;

/// TA-17 (Phase 3): maximum auto_revoke_threshold owners can configure.
///
/// Ceiling of 20 prevents owners from setting the threshold impractically
/// high to disable the gate (a no-op auto-revoke is worse than no
/// auto-revoke, because it gives a false sense of security).
pub const AUTO_REVOKE_THRESHOLD_MAX: u8 = 20;

/// TA-17 (Phase 3): default auto_revoke_threshold for new vaults.
pub const AUTO_REVOKE_THRESHOLD_DEFAULT: u8 = 5;

/// Squads V4 multisig program ID on Solana mainnet (deployed Q4 2025).
/// Base58: SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
///
/// Council ISC-A7 + ISC-135: bound as a named constant so a future Squads
/// migration (V5+) is a one-line change with full grep visibility. Inline
/// usage (`Pubkey::new_from_array(...)` outside this definition) is forbidden
/// for Squads — all program-ID equality checks MUST reference this constant.
///
/// V1 verification depth: program-ID match only (the
/// `accept_ownership_transfer_multisig` handler checks
/// `multisig_pda.owner == &SQUADS_V4_PROGRAM_ID`). Stronger structural
/// checks (multisig threshold > 0, vault discriminator parse,
/// anti-1-of-1-self-multisig) are deferred to V1.1.
pub const SQUADS_V4_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 129, 196, 206, 71, 226, 35, 104, 184, 177, 85, 94, 200, 135, 175, 9, 46, 252, 126, 251, 182,
    108, 163, 245, 47, 191, 104, 212, 172, 156, 183, 168,
]);

/// TA-17 (Phase 3): numeric range of on-chain "policy-violation" error
/// codes that count toward the consecutive-failures counter.
///
/// ⚠ RENUMBER-SENSITIVE: these are positional error codes. On any change to
/// the SigilError enum order, re-derive the band from ErrMintNotPinned..=
/// ErrOutputBelowFloor (see target/idl/sigil.json). Post M1-04 teardown:
///
/// 6074..=6091 covers:
///   - 6074 ErrMintNotPinned (TA-03)
///   - 6075 ErrOutsideOperatingHours (TA-05)
///   - 6076 ErrCooldownActive (TA-06)
///   - 6077 ErrGraylistFriction (TA-07)
///   - 6078 ErrGraylistFull (TA-07)
///   - 6079 ErrToken2022ExtensionForbidden (TA-08)
///   - 6080 ErrCosignRequired (TA-09)
///   - 6081 ErrAutoRevoked (TA-17)
///   - 6082-6091 Phase 4 + Phase 5 post-exec assertions (ErrSandwichIntegrity
///     .. ErrOutputBelowFloor); ErrDeclarationInconsistent (6092) is excluded.
///
/// EXCLUDED:
///   - 6062 SysvarScanBoundExceeded (CU exhaustion / external pad attack)
///   - 6063 AsyncFulfillmentNotPermitted (external program-id quirk)
///   - 6000-6073 auth / init / wrapping errors (not policy violations;
///     auto-revoking on UnauthorizedOwner 6002 would let an attacker
///     brick a working agent by spamming wrong-key seal attempts)
///
/// The filter is by NUMERIC RANGE, not string match — robust against
/// future error message changes.
pub fn is_policy_violation_code(code: u32) -> bool {
    // Audit 2026-06-11 (L-1): 6084 (ErrSessionNonceMismatch — durable-nonce
    // replay defense) and 6089 (MintDeltaCapMisconfigured — caller-side config
    // bug, "not an attack signal" per errors.rs) are NOT policy violations. The
    // ErrAutoRevoked doc above explicitly excludes "nonce desync". Carve them out
    // so a benign nonce race or a caller misconfig cannot count toward auto-
    // revoking a working agent. Still by NUMERIC RANGE (renumber-sensitive).
    (6074..=6083).contains(&code)
        || (6085..=6088).contains(&code)
        || (6090..=6091).contains(&code)
}

/// sha256("global:finalize_session")[0..8] — used by validate_and_authorize
/// to identify finalize_session instructions in the transaction.
pub const FINALIZE_SESSION_DISCRIMINATOR: [u8; 8] = [34, 148, 144, 47, 37, 130, 206, 161];

/// sha256("global:validate_and_authorize")[0..8] — used by validate_and_authorize
/// to detect SIBLING `validate_and_authorize` ix in the same transaction.
///
/// TA-10 (Phase 4) sandwich-integrity uniqueness: at most ONE
/// `validate_and_authorize` per (vault, agent, mint) tuple per transaction.
/// A second matching ix would let an attacker stage a nested authorization
/// inside the first (with the second session's expanded capability) before
/// the first finalize's revocation runs.
///
/// Verified against codama-generated `VALIDATE_AND_AUTHORIZE_DISCRIMINATOR`
/// in `sdk/kit/src/generated/instructions/validateAndAuthorize.ts`.
pub const VALIDATE_AND_AUTHORIZE_DISCRIMINATOR: [u8; 8] = [22, 183, 48, 222, 218, 11, 197, 152];

/// TA-11 (Phase 4) — protected seed-prefix family for the dynamic
/// writable-PDA check.
///
/// Every Sigil-owned PDA seed prefix that MUST NOT appear as a writable
/// account-meta inside a foreign instruction between validate and finalize.
/// The bundle-entry scan at `validate_and_authorize` derives each family's
/// pubkeys for the current vault context (owner / vault_id / agent / mint)
/// and rejects with `ErrProtectedWritable` if any sibling instruction passes
/// one of those pubkeys with `is_writable=true`.
///
/// **Why a prefix list, not an enum.** The list is iterated by the derivation
/// helper but each entry's "extra seeds" vary (vault has owner+vault_id;
/// session has vault+agent+mint; constraints has vault). The prefix is the
/// load-bearing identifier — derivation is per-prefix in the scan code.
///
/// **Forward-looking entries.** `audit_success` / `audit_rejected` (Phase 7
/// audit log), `cosign` (Phase 3 cosign session), `recipient` (post-exec
/// per-recipient cap), `pending_owner` (Phase 8 ownership transfer) are
/// listed proactively: when those PDAs ship, no Phase 4 amendment is
/// required to protect them. The derivation loop will skip families whose
/// seeds aren't yet known at the current vault (no false positives).
///
/// **Defense-in-depth pairing.** The seed-prefix list alone is insufficient
/// because an attacker could deploy their own program at the derived pubkey
/// (impossible without an address collision but defensible). Per F-20 + F-30,
/// the scan ALSO verifies `account.owner == sigil_program_id` for any
/// candidate match before rejecting (see validate_and_authorize.rs TA-11
/// scan site).
pub const PROTECTED_SEED_PREFIXES: [&[u8]; 14] = [
    b"vault",
    b"policy",
    b"tracker",
    b"session",
    b"post_assertions",
    b"audit_success",
    b"audit_rejected",
    b"cosign",
    b"recipient",
    b"pending_policy",
    b"pending_agent_perms",
    b"pending_owner",
    // Phase 8 PEN-CROSS-1 (audit 2026-05-19): queue/apply timelock-gated
    // OPERATOR-class agent grant PDA. Listed here so the TA-11 dynamic
    // writable-PDA check rejects any foreign instruction that tries to
    // pass this PDA as writable between validate and finalize.
    b"pending_agent_grant",
    b"agent_spend",
    // M1-04c: pending_constraints, pending_close_constraints, and constraints
    // seeds removed — the constraints engine is gone, those PDAs can never be
    // allocated, so denylisting them protected nothing.
];

/// Ceiling fee: ceil(amount * rate / FEE_RATE_DENOMINATOR).
/// Guarantees non-zero fee for any non-zero amount with non-zero rate.
/// Zero-product (amount=0 or rate=0) naturally returns 0.
pub(crate) fn ceil_fee(amount: u64, rate: u64) -> Result<u64> {
    amount
        .checked_mul(rate)
        .ok_or(error!(SigilError::Overflow))?
        .checked_add(FEE_RATE_DENOMINATOR - 1)
        .ok_or(error!(SigilError::Overflow))?
        .checked_div(FEE_RATE_DENOMINATOR)
        .ok_or(error!(SigilError::Overflow))
}

// Build requires exactly one of: --features mainnet OR --features devnet
#[cfg(not(any(feature = "mainnet", feature = "devnet")))]
compile_error!("Build requires --features mainnet OR --features devnet");

#[cfg(all(feature = "mainnet", feature = "devnet"))]
compile_error!("Cannot enable both mainnet and devnet simultaneously");

#[cfg(all(feature = "mainnet", feature = "devnet-testing"))]
compile_error!("devnet-testing is a devnet-only feature and cannot be combined with mainnet");

#[cfg(feature = "devnet")]
/// Protocol treasury address (devnet)
/// Base58: 6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp
///
/// Phase 10b (audit 2026-05-23): swapped from `ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT`
/// (the prior devnet treasury keypair, no longer accessible to the team)
/// to the user's wallet `6wrkKTM2pj...`. Treasury swap is BAKED INTO the
/// same .so binary as the Phase 10 program-ID redeploy (CH-* findings
/// closed at the same commit) — there is no runtime `set_treasury` ix.
pub const PROTOCOL_TREASURY: Pubkey = Pubkey::new_from_array([
    88, 88, 12, 26, 164, 64, 182, 168, 149, 18, 132, 97, 242, 247, 243, 69, 120, 91, 235, 116, 3,
    15, 221, 72, 102, 252, 128, 127, 102, 40, 56, 157,
]);

/// Protocol treasury address (mainnet).
/// Base58: 7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy
///
/// This is the Squads V4 multisig **vault PDA** (signer derived from the multisig
/// account), 3-of-5 threshold, 5 distinct human signers. Squads V4 derivation
/// reuses the same `createKey` + program id, so this address is identical on
/// devnet and mainnet — devnet rehearsals exercise the exact byte sequence below.
///
/// Pre-mainnet checklist completed (PR-10 / M4):
///   [x] Squads multisig vault PDA derived (2026-05-09)
///   [x] Real 32-byte Pubkey pinned below; sentinel `compile_error!` removed
///   [x] CI 'mainnet-build-readiness' job exercises this constant
///   [ ] Squads members confirmed accepting (5/5) before mainnet binary tag
///   [ ] Tag the release commit; build mainnet binary from this commit
///
/// Why compile-time, not runtime?
///   The previous implementation used a [0u8; 32] sentinel and relied on the
///   deposit handler's `treasury_token.owner == PROTOCOL_TREASURY` check to
///   fail at runtime. That meant a mainnet binary CAN be built and deployed
///   with the sentinel; the bug surfaces only on the first deposit. Converting
///   to a compile-time guard makes a mainnet build fail at `cargo build` time
///   if the constant is unset — defense in depth (the runtime check stays).
///
/// To recreate the un-pinned state for tests: replace the byte array below with
/// `[0u8; 32]` and uncomment the previous `compile_error!` block. The runtime
/// owner check at `instructions/{agent_transfer,
/// validate_and_authorize}.rs` is preserved as a second layer.
#[cfg(feature = "mainnet")]
pub const PROTOCOL_TREASURY: Pubkey = Pubkey::new_from_array([
    102, 115, 120, 152, 65, 88, 210, 76, 7, 220, 80, 231, 112, 6, 22, 32, 26, 4, 137, 55, 84, 52,
    4, 200, 254, 195, 18, 105, 97, 38, 227, 136,
]);

// --- Stablecoin mint constants ---

/// USDC mint (devnet: DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH)
/// Test-controlled keypair — we own the mint authority for devnet testing.
#[cfg(feature = "devnet")]
pub const USDC_MINT: Pubkey = Pubkey::new_from_array([
    183, 123, 243, 77, 18, 80, 250, 164, 199, 89, 146, 151, 150, 233, 12, 20, 206, 135, 29, 138,
    218, 153, 91, 77, 84, 71, 174, 53, 139, 167, 156, 54,
]);

/// USDC mint (mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
#[cfg(feature = "mainnet")]
pub const USDC_MINT: Pubkey = Pubkey::new_from_array([
    198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49, 177, 187, 228,
    194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
]);

/// USDT mint (devnet: 43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze)
/// Test-controlled keypair — we own the mint authority for devnet testing.
#[cfg(feature = "devnet")]
pub const USDT_MINT: Pubkey = Pubkey::new_from_array([
    45, 62, 128, 117, 22, 254, 177, 202, 78, 70, 249, 101, 252, 36, 244, 42, 82, 77, 95, 72, 170,
    154, 33, 171, 68, 12, 82, 27, 106, 105, 202, 15,
]);

/// USDT mint (mainnet: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)
#[cfg(feature = "mainnet")]
pub const USDT_MINT: Pubkey = Pubkey::new_from_array([
    206, 1, 14, 96, 175, 237, 178, 39, 23, 189, 99, 25, 47, 84, 20, 90, 63, 150, 90, 51, 187, 130,
    210, 199, 2, 158, 178, 206, 30, 32, 130, 100,
]);

/// M4 (PR-10): Mainnet treasury guard is now COMPILE-TIME, not runtime.
///
/// The mainnet PROTOCOL_TREASURY constant uses `compile_error!` so a mainnet
/// build with the [0u8; 32] sentinel fails at `cargo build` rather than at
/// first deposit. The previous M8 runtime test (`mainnet_treasury_must_not_be_zero`)
/// is structurally redundant: a `--features mainnet` build cannot reach the
/// test runner if the constant is unset, because compilation halts first.
///
/// The runtime owner check in `instructions/{agent_transfer,
/// validate_and_authorize}.rs` is preserved as defense in depth.
#[cfg(test)]
mod treasury_tests {
    /// S-5: Documents the compile_error! guard for devnet-testing + mainnet.
    /// The actual guard at lines 63-64 is verified by CI:
    ///   cargo build --no-default-features --features "devnet-testing,mainnet"
    /// which fails with compile_error. This test verifies related constants are sane.
    #[test]
    fn devnet_testing_mainnet_guard_constants_sane() {
        use super::*;
        assert!(
            SESSION_DURATION_SECONDS > 0,
            "session duration must be positive"
        );
        assert!(
            MIN_SESSION_DURATION_SECONDS < MAX_OWNER_SESSION_DURATION_SECONDS,
            "min must be below max owner-configurable bound"
        );
        assert!(MAX_AGENTS_PER_VAULT > 0, "must allow at least one agent");
        assert!(FULL_CAPABILITY > 0, "capability value must be non-zero");
    }
}

#[cfg(test)]
mod ta17_policy_violation_filter_tests {
    use super::*;

    /// TA-17: codes 6074-6091 are policy violations.
    #[test]
    fn policy_violation_accepts_phase3_codes() {
        assert!(is_policy_violation_code(6074), "TA-03 ErrMintNotPinned");
        assert!(
            is_policy_violation_code(6075),
            "TA-05 ErrOutsideOperatingHours"
        );
        assert!(is_policy_violation_code(6076), "TA-06 ErrCooldownActive");
        assert!(is_policy_violation_code(6077), "TA-07 ErrGraylistFriction");
        assert!(is_policy_violation_code(6078), "TA-07 ErrGraylistFull");
        assert!(
            is_policy_violation_code(6079),
            "TA-08 ErrToken2022ExtensionForbidden"
        );
        assert!(is_policy_violation_code(6080), "TA-09 ErrCosignRequired");
        assert!(is_policy_violation_code(6081), "TA-17 ErrAutoRevoked");
    }

    /// TA-17: reserved range 6082-6091 accepted EXCEPT the two non-violation
    /// codes carved out in L-1 (6084 nonce-mismatch, 6089 mint-delta-misconfig).
    #[test]
    fn policy_violation_accepts_reserved_phase45_range() {
        for code in 6082..=6091 {
            if code == 6084 || code == 6089 {
                continue; // L-1: non-violation codes, excluded from the band
            }
            assert!(
                is_policy_violation_code(code),
                "reserved {} must accept",
                code
            );
        }
    }

    /// TA-17: SysvarScanBoundExceeded (6068) is NOT a policy violation —
    /// CU-exhaustion / external pad attack.
    #[test]
    fn policy_violation_rejects_cu_exhaustion() {
        assert!(!is_policy_violation_code(6062));
    }

    /// TA-17: AsyncFulfillmentNotPermitted (6069) is NOT a policy violation
    /// — external program-id quirk.
    #[test]
    fn policy_violation_rejects_async_fulfillment() {
        assert!(!is_policy_violation_code(6063));
    }

    /// TA-17: UnauthorizedOwner (6002) is NOT a policy violation. Auto-
    /// revoking on auth errors would let an attacker brick a working
    /// agent by spamming wrong-key seal attempts.
    #[test]
    fn policy_violation_rejects_unauthorized_owner() {
        assert!(!is_policy_violation_code(6002));
    }

    /// L-1 (audit 2026-06-11): ErrSessionNonceMismatch (6084) is a durable-nonce
    /// replay-defense signal, NOT a policy violation — must not count toward
    /// auto-revoke (the ErrAutoRevoked doc excludes "nonce desync").
    #[test]
    fn policy_violation_rejects_session_nonce_mismatch() {
        assert!(!is_policy_violation_code(6084));
    }

    /// L-1 (audit 2026-06-11): MintDeltaCapMisconfigured (6089) is a caller-side
    /// configuration bug ("not an attack signal", per errors.rs) — must not
    /// count toward auto-revoke.
    #[test]
    fn policy_violation_rejects_mint_delta_misconfigured() {
        assert!(!is_policy_violation_code(6089));
    }

    /// TA-17: Codes outside 6074-6091 reject (lower boundary 6073).
    #[test]
    fn policy_violation_rejects_just_below_range() {
        assert!(
            !is_policy_violation_code(6073),
            "ActiveVaultRequiresAllowlist"
        );
    }

    /// TA-17: Codes outside 6074-6091 reject (upper boundary 6092).
    #[test]
    fn policy_violation_rejects_just_above_range() {
        assert!(!is_policy_violation_code(6092));
    }

    /// TA-17: arbitrary error codes (lower range) reject.
    #[test]
    fn policy_violation_rejects_arbitrary_low() {
        assert!(!is_policy_violation_code(0));
        assert!(!is_policy_violation_code(1000));
        assert!(!is_policy_violation_code(6000));
    }
}

#[cfg(test)]
mod ta03_pinned_deposit_mint_tests {
    use super::*;

    /// TA-03: pinned-deposit predicate must accept USDC under the
    /// non-devnet-testing build. cargo test for the lib runs with the
    /// default `devnet` feature; `devnet-testing` is enabled only by the
    /// dedicated `cargo test --features devnet-testing` job. We assert the
    /// strict path here because the strict variant is the one shipped.
    #[cfg(not(feature = "devnet-testing"))]
    #[test]
    fn pinned_deposit_accepts_usdc() {
        assert!(
            is_pinned_deposit_mint(&USDC_MINT),
            "USDC mint must pass the pinned-deposit gate"
        );
    }

    /// TA-03: pinned-deposit must accept USDT.
    #[cfg(not(feature = "devnet-testing"))]
    #[test]
    fn pinned_deposit_accepts_usdt() {
        assert!(
            is_pinned_deposit_mint(&USDT_MINT),
            "USDT mint must pass the pinned-deposit gate"
        );
    }

    /// TA-03: pinned-deposit MUST reject an arbitrary unrecognized mint.
    /// Closes the deposit-time gap where an exotic mint could be parked in
    /// the vault and trigger `is_stablecoin_mint=true` only via the
    /// devnet-testing escape — the strict build must reject.
    #[cfg(not(feature = "devnet-testing"))]
    #[test]
    fn pinned_deposit_rejects_arbitrary_mint() {
        let arbitrary = Pubkey::new_from_array([7u8; 32]);
        assert!(
            !is_pinned_deposit_mint(&arbitrary),
            "arbitrary mint MUST be rejected by the pinned-deposit gate"
        );
    }

    /// TA-03: under devnet-testing, the pin is open — same escape hatch as
    /// `is_stablecoin_mint`. Required so LiteSVM + Surfpool integration
    /// suites can drive deposits with arbitrary test mints.
    #[cfg(feature = "devnet-testing")]
    #[test]
    fn pinned_deposit_devnet_testing_accepts_arbitrary_mint() {
        let arbitrary = Pubkey::new_from_array([7u8; 32]);
        assert!(
            is_pinned_deposit_mint(&arbitrary),
            "devnet-testing must keep the deposit gate open for integration suites"
        );
    }
}

/// Check if a mint address is a recognized stablecoin (USDC or USDT).
/// With `devnet-testing` feature, accepts any mint for integration testing
/// on devnet where Circle-controlled USDC cannot be minted.
#[cfg(not(feature = "devnet-testing"))]
pub fn is_stablecoin_mint(mint: &Pubkey) -> bool {
    *mint == USDC_MINT || *mint == USDT_MINT
}

#[cfg(feature = "devnet-testing")]
pub fn is_stablecoin_mint(_mint: &Pubkey) -> bool {
    true
}

/// TA-03 — pinned-deposit allowlist for `deposit_funds`.
///
/// `is_stablecoin_mint` above is used throughout the spending path (balance
/// delta verification, output-mint checks, fee accounting). It must NOT widen
/// or it loosens existing security paths. TA-03 introduces a separate,
/// narrower predicate that gates **deposits only** to the exact set of mints
/// the program has been built for.
///
/// Mainnet: exactly USDC + USDT.
/// Devnet:  the devnet test-keypair USDC + USDT minted under our control.
/// `devnet-testing` (LiteSVM integration / Surfpool runs): any mint accepted,
/// matching the `is_stablecoin_mint` escape hatch — required because we can't
/// mint Circle-controlled USDC in these environments.
///
/// Together with the existing compile-time `mainnet|devnet` feature gate
/// (`compile_error!` in state/mod.rs), this provides build-time pinning: a
/// mainnet binary literally cannot be built against an unpinned mint set.
#[cfg(not(feature = "devnet-testing"))]
pub fn is_pinned_deposit_mint(mint: &Pubkey) -> bool {
    *mint == USDC_MINT || *mint == USDT_MINT
}

#[cfg(feature = "devnet-testing")]
pub fn is_pinned_deposit_mint(_mint: &Pubkey) -> bool {
    true
}

// --- Protocol program IDs (same address on mainnet and devnet) ---

// JUPITER_PROGRAM constant removed in Phase 1 (Option A demolition). The Jupiter
// V6 program ID is no longer referenced by on-chain code. SDK-side allowlist
// configuration uses the literal pubkey string `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
// passed through PolicyConfig.protocols at vault creation time — generic primitive,
// not Jupiter-specific.

// ─── ADR-M1 (2026-05-31): is_recognized_defi markers REMOVED ────────────────
// The four former "recognized DeFi marker" constants (FLASH_TRADE_PROGRAM,
// JUPITER_LEND_PROGRAM, JUPITER_EARN_PROGRAM, JUPITER_BORROW_PROGRAM) were
// DELETED. They existed only to gate `ProtocolMismatch` enforcement and
// `defi_ix_count` accounting for four hardcoded programs in
// `validate_and_authorize`. Those checks now apply AGNOSTICALLY to every
// allowlisted protocol (any instruction reaching ScanAction::PassedSharedChecks
// is treated as a DeFi instruction), so no per-protocol marker set is needed.
// Removing them eliminates protocol-specific code from the core enforcement
// path and closes the gap where non-hardcoded allowlisted protocols (Orca,
// Raydium, Kamino, …) escaped the single-DeFi-ix limit + target match.
//
// The async-fulfillment constants below are DIFFERENT in kind: they are
// program IDs REJECTED outright (KNOWN_ASYNC_FULFILLMENT_PROGRAMS) because
// their request/keeper-fill model lands the real SPL transfer 5-45s AFTER
// finalize_session, defeating Sigil's stablecoin balance-delta measurement.
// They are kept; see the block immediately below.
// ─────────────────────────────────────────────────────────────────────────────

// --- Async-fulfillment programs (C4 audit fix) ---
//
// These three protocols use a request/fulfillment model: the user submits a
// `request*` instruction and the keeper submits the actual SPL transfer in a
// SEPARATE transaction 5-45s later. Because the transfer happens after
// `finalize_session` returns, Sigil's stablecoin balance-delta measurement is
// always 0, so daily caps + per-protocol caps + spend tracker never record
// the real spend, and the vault drains silently.
//
// V1 mitigation (Option C): hardcode-reject these program IDs in the
// instruction scan. A future release may re-enable them via the constraints
// PDA + post-execution assertions once we can prove keeper-tx accounting
// across atomic boundaries.
//
// Source: Sigil security audit C4 (2026-05). See also:
// - Jupiter Perps:    PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
// - Drift v2:         dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH
// - Drift JIT proxy:  J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP

/// Jupiter Perpetuals program
/// Base58: PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
pub const JUPITER_PERPS_PROGRAM: Pubkey = Pubkey::new_from_array([
    5, 177, 243, 202, 241, 148, 98, 239, 135, 96, 240, 171, 222, 117, 205, 61, 158, 227, 27, 58,
    50, 198, 32, 232, 148, 18, 46, 156, 155, 129, 69, 250,
]);

/// Drift v2 protocol program
/// Base58: dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH
pub const DRIFT_V2_PROGRAM: Pubkey = Pubkey::new_from_array([
    9, 84, 219, 190, 158, 201, 96, 201, 138, 122, 41, 63, 226, 19, 54, 150, 111, 225, 128, 209, 81,
    174, 75, 129, 121, 86, 31, 137, 133, 74, 83, 246,
]);

/// Drift JIT proxy program
/// Base58: J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP
pub const DRIFT_JIT_PROXY_PROGRAM: Pubkey = Pubkey::new_from_array([
    252, 180, 245, 243, 227, 226, 41, 248, 219, 192, 203, 167, 225, 83, 228, 133, 83, 109, 79, 110,
    62, 225, 115, 177, 71, 201, 141, 78, 240, 248, 168, 126,
]);

/// Programs whose spending Sigil cannot measure synchronously inside
/// `validate_and_authorize` because they use a request/fulfillment model
/// (the keeper submits the actual SPL transfer 5-45s later in a separate
/// transaction). Hardcode-rejected in V1; see C4 audit finding above.
pub const KNOWN_ASYNC_FULFILLMENT_PROGRAMS: [Pubkey; 3] = [
    JUPITER_PERPS_PROGRAM,
    DRIFT_V2_PROGRAM,
    DRIFT_JIT_PROXY_PROGRAM,
];

/// Token-2022 program ID
/// Base58: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
pub const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);

/// ComputeBudget program ID — used by `validate_and_authorize` + `finalize_session`
/// to identify (and skip) ComputeBudget instructions during the sysvar instruction
/// scan. P3.1 audit fix (2026-05-19): single source of truth, eliminates the
/// 32-byte literal duplication previously inlined at both call sites.
/// Base58: ComputeBudget111111111111111111111111111111
pub const COMPUTE_BUDGET_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187,
    197, 247, 18, 107, 44, 67, 155, 58, 64, 0, 0, 0,
]);

/// USD amounts use 6 decimal places (matching USDC/USDT precision).
/// $1.00 = 1_000_000, $500.00 = 500_000_000
pub const USD_DECIMALS: u8 = 6;

/// 10^6 — base multiplier for USD amounts with 6 decimals
pub const USD_BASE: u64 = 1_000_000;

use crate::errors::SigilError;
use anchor_lang::prelude::*;

/// Vault status enum
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub enum VaultStatus {
    /// Vault is active, agent can execute actions
    #[default]
    Active,
    /// Vault is frozen (kill switch activated), no agent actions allowed
    Frozen,
    /// Vault is closed, all funds withdrawn, PDAs can be reclaimed
    Closed,
}

// PositionEffect enum REMOVED — position counter system deleted wholesale per council
// decision (9-1 vote, 2026-04-19). See Plans/we-need-to-plan-serialized-summit.md.
//
// ActionType enum REMOVED — spending classification now derives from
// `amount > 0` at runtime (validate_and_authorize.rs). The previously-stored
// `is_spending` field on ConstraintEntryZC was deleted (M2 Option A) because
// the runtime never read it. See RFC-ACTIONTYPE-ELIMINATION.md.
// Agent permissions use the 2-bit capability field (CAPABILITY_OBSERVER / CAPABILITY_OPERATOR)
// instead of the old 21-bit bitmask.

#[cfg(test)]
mod seed_uniqueness {
    //! Council ISC-133 — PDA seed prefix uniqueness invariant.
    //!
    //! Every seed prefix declared anywhere in the program must be byte-distinct
    //! from every other declared prefix. Two prefix families colliding would
    //! mean two PDAs share a derivation namespace once a vault/key disambiguator
    //! is added — an audit-class issue: an attacker who could choose the
    //! disambiguator could trick the program into accepting account A for
    //! family B's role.
    //!
    //! Source of truth: `PROTECTED_SEED_PREFIXES` already enumerates every
    //! protected family for the TA-11 derivation scan. This test verifies
    //! the list is internally unique, AND that the live list still matches
    //! the prefixes actually used by `seeds = [...]` declarations elsewhere
    //! in the codebase (the cargo test can't grep the codebase, so the
    //! out-of-band check is documented in the doctest below and enforced
    //! by code review).
    //!
    //! When a new PDA family is added (e.g. a future "audit_v2" prefix),
    //! it MUST be appended to both `PROTECTED_SEED_PREFIXES` and to the
    //! `expected` array below. The array length is pinned to the live
    //! `PROTECTED_SEED_PREFIXES` length so this test fails compilation
    //! if either list grows without the other being updated.

    use super::PROTECTED_SEED_PREFIXES;

    /// Live enumeration sourced from `PROTECTED_SEED_PREFIXES`. Includes the
    /// Phase 8 `pending_owner` entry that ships with this batch (already
    /// pre-listed in `PROTECTED_SEED_PREFIXES` for forward-compat).
    #[test]
    fn pda_seed_prefixes_unique() {
        let prefixes: &[&[u8]] = PROTECTED_SEED_PREFIXES.as_slice();
        for i in 0..prefixes.len() {
            for j in (i + 1)..prefixes.len() {
                assert_ne!(
                    prefixes[i],
                    prefixes[j],
                    "PDA seed prefix collision: {:?} vs {:?}",
                    std::str::from_utf8(prefixes[i]).unwrap_or("<non-utf8 prefix>"),
                    std::str::from_utf8(prefixes[j]).unwrap_or("<non-utf8 prefix>"),
                );
            }
        }
    }

    /// Council ISC-133 — pin the LIVE prefix list so a future addition that
    /// forgets to update this test fails compilation. If you add a prefix to
    /// `PROTECTED_SEED_PREFIXES`, mirror it in `expected` below.
    #[test]
    fn pda_seed_prefixes_matches_expected_canonical_list() {
        let expected: [&[u8]; 14] = [
            b"vault",
            b"policy",
            b"tracker",
            b"session",
            b"post_assertions",
            b"audit_success",
            b"audit_rejected",
            b"cosign",
            b"recipient",
            b"pending_policy",
            b"pending_agent_perms",
            b"pending_owner",
            // Phase 8 PEN-CROSS-1 (audit 2026-05-19): pending_agent_grant
            // landed in Batch 6.
            b"pending_agent_grant",
            b"agent_spend",
            // M1-04c: pending_constraints, pending_close_constraints, constraints removed.
        ];
        assert_eq!(
            PROTECTED_SEED_PREFIXES.len(),
            expected.len(),
            "PROTECTED_SEED_PREFIXES len drift — update both lists",
        );
        for (i, want) in expected.iter().enumerate() {
            assert_eq!(
                PROTECTED_SEED_PREFIXES[i],
                *want,
                "PROTECTED_SEED_PREFIXES[{}] drift — got {:?}, expected {:?}",
                i,
                std::str::from_utf8(PROTECTED_SEED_PREFIXES[i]).unwrap_or("<non-utf8>"),
                std::str::from_utf8(want).unwrap_or("<non-utf8>"),
            );
        }
    }
}
