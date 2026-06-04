//! F-Q6 (2026-06-02) — OPERATOR-grant authorization tiering.
//!
//! Core principle (LOCKED): an OPERATOR-class agent grant may be INSTANT only
//! if it carries **>= 2 authorization factors**; otherwise it MUST pass
//! through a time-delay (the delay substitutes for the missing 2nd factor).
//! The vault's factor count is derived from two stored facts:
//!   - `vault.owner_type` (0 = single-key EOA, 1 = N-of-M multisig), recorded
//!     ONCE at the verified ownership-transfer site (program-set, NOT
//!     owner-supplied — see `state/vault.rs`).
//!   - `policy.cosign_required` + `policy.cosign_session_pubkey`: a BOUND
//!     cosigner (non-default pubkey) is a real 2nd factor; an unbound
//!     (default) cosigner is NOT (C-1).
//!
//! Three tiers result:
//!   - `Multisig`    (owner_type == 1)                       → >= 2 factors
//!   - `CosignBound` (cosign_required && cosign_pubkey bound) → 2 factors
//!   - `SingleKey`   (everything else)                        → 1 factor
//!
//! The owner-configurable knob `policy.operator_grant_delay_seconds`
//! (default 0) sets the delay. `SingleKey` is floored at
//! `SINGLE_KEY_OPERATOR_DELAY_FLOOR` (the missing-2nd-factor substitute);
//! `Multisig`/`CosignBound` use the configured value verbatim (0 = instant).
//!
//! Pure functions — unit-tested below WITHOUT LiteSVM (same pattern as
//! `register_agent::has_non_owner_signer`). These are the load-bearing
//! security decisions for `register_agent` (instant eligibility + C-1 bound
//! cosigner) and `queue_agent_grant` (the queue-time effective delay, H-1).

use anchor_lang::prelude::*;

use crate::state::OWNER_TYPE_MULTISIG;

/// Forced minimum OPERATOR-grant delay for a single-key vault (seconds) — 10
/// minutes. The time-delay IS the missing 2nd authorization factor: a phished
/// single owner key cannot INSTANTLY seat an OPERATOR — the owner gets a
/// >=10-minute window to detect the queued grant and `cancel_agent_grant`.
/// Cosign/multisig vaults already carry a 2nd factor, so they are NOT floored.
pub const SINGLE_KEY_OPERATOR_DELAY_FLOOR: u64 = 600;

/// Maximum owner-configurable OPERATOR-grant delay (seconds) — 48h.
///
/// Bounded (enforced at the `queue_policy_update` write site) so the
/// queue→apply window always fits inside the apply-time freshness ceiling
/// `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN` (~78h at apply). A delay larger than
/// that ceiling would make the grant PERMANENTLY unapplyable — the timelock
/// would never elapse inside the freshness window — a tier-2 liveness brick.
/// 48h equals the proven `PendingAgentGrant::DEFAULT_MIN_DELAY`, already shown
/// to apply within the ceiling across the elevated-grant test suite. The
/// compile-time assert below pins MAX <= that proven value so they can never
/// drift into a brick. (A too-high value is also OWNER-recoverable by lowering
/// the knob, but the hard cap removes the foot-gun + the i64-cast edge.)
pub const MAX_OPERATOR_GRANT_DELAY: u64 = 172_800;

// Compile-time brick-guard: the configurable cap must never exceed the proven
// elevated-grant window known to apply within the freshness ceiling. If a
// future edit raises MAX_OPERATOR_GRANT_DELAY past DEFAULT_MIN_DELAY this
// fails the build rather than shipping a potentially-unapplyable grant.
const _MAX_OPERATOR_GRANT_DELAY_FITS_APPLY_WINDOW: () = assert!(
    MAX_OPERATOR_GRANT_DELAY
        <= crate::state::pending_agent_grant::PendingAgentGrant::DEFAULT_MIN_DELAY,
    "MAX_OPERATOR_GRANT_DELAY must stay <= the proven-applyable DEFAULT_MIN_DELAY (else grants brick)"
);

// F-Q6: the `queue_agent_permissions_update` Observer→OPERATOR elevation path
// relies on `policy.timelock_duration` (floored at MIN_TIMELOCK_DURATION) to
// satisfy the single-key OPERATOR delay floor WITHOUT pulling in the (up-to-48h)
// configurable `operator_grant_delay_seconds` — because that path's apply-time
// freshness ceiling is the narrow ~24h window. Pin MIN_TIMELOCK_DURATION >= the
// floor so the perms-update elevation can never drop below the F-Q6 single-key
// minimum even if MIN_TIMELOCK_DURATION is later lowered.
const _MIN_TIMELOCK_COVERS_SINGLE_KEY_FLOOR: () = assert!(
    crate::state::MIN_TIMELOCK_DURATION >= SINGLE_KEY_OPERATOR_DELAY_FLOOR,
    "MIN_TIMELOCK_DURATION must stay >= SINGLE_KEY_OPERATOR_DELAY_FLOOR (perms-update OPERATOR floor)"
);

/// Authorization-factor tier of a vault for OPERATOR-grant purposes (F-Q6).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OperatorGrantTier {
    /// `owner_type == OWNER_TYPE_MULTISIG`: the owner is an N-of-M multisig
    /// whose threshold already approved off-chain (>= 2 factors).
    Multisig,
    /// `cosign_required == true` AND `cosign_session_pubkey != default`:
    /// owner + a specifically-BOUND cosigner (2 factors). An unbound
    /// (default) cosigner does NOT qualify — it falls through to `SingleKey`
    /// (C-1: a leaked owner key + throwaway 2nd key must not pass).
    CosignBound,
    /// One signing key (1 factor). The default tier, and the fall-through for
    /// a cosign-required-but-unbound vault. OPERATOR grants here are forced
    /// through the time-delayed `queue_agent_grant` → `apply_agent_grant` path.
    SingleKey,
}

/// Classify a vault's OPERATOR-grant tier from the stored `owner_type` and the
/// live cosign policy.
///
/// Fails SAFE: any `owner_type` other than `OWNER_TYPE_MULTISIG` is treated as
/// not-multisig (→ `CosignBound` or `SingleKey`, the more-restrictive tiers),
/// so a stale/corrupt owner_type can never UPGRADE a vault into the instant
/// multisig path. The read-site `require!(owner_type <= OWNER_TYPE_MULTISIG)`
/// is the canonical explicit rejection (ISC-33); this fail-safe is the
/// belt-and-suspenders second layer.
pub fn classify_operator_grant_tier(
    owner_type: u8,
    cosign_required: bool,
    cosign_session_pubkey: &Pubkey,
) -> OperatorGrantTier {
    if owner_type == OWNER_TYPE_MULTISIG {
        OperatorGrantTier::Multisig
    } else if cosign_required && *cosign_session_pubkey != Pubkey::default() {
        OperatorGrantTier::CosignBound
    } else {
        OperatorGrantTier::SingleKey
    }
}

/// Effective OPERATOR-grant delay (seconds) for a tier + configured value.
///
/// `SingleKey` is floored at `SINGLE_KEY_OPERATOR_DELAY_FLOOR` (the missing
/// 2nd factor); the 2-factor tiers use the configured value verbatim (0 =
/// instant-eligible). The configured value is assumed already bounded to
/// `MAX_OPERATOR_GRANT_DELAY` at the `queue_policy_update` write site, so the
/// result is always `<= MAX_OPERATOR_GRANT_DELAY` and safe to cast to `i64`
/// for the timelock math at queue/apply.
pub fn effective_operator_grant_delay(tier: OperatorGrantTier, configured: u64) -> u64 {
    match tier {
        OperatorGrantTier::SingleKey => configured.max(SINGLE_KEY_OPERATOR_DELAY_FLOOR),
        OperatorGrantTier::Multisig | OperatorGrantTier::CosignBound => configured,
    }
}

/// Whether an OPERATOR grant is eligible for an INSTANT `register_agent` (no
/// queue): true ONLY when no delay applies AND the vault carries >= 2 factors.
///
/// `SingleKey` is never instant-eligible — its effective delay is always
/// `>= SINGLE_KEY_OPERATOR_DELAY_FLOOR > 0`. A 2-factor tier is instant-
/// eligible iff the owner left the delay at 0 (the default); a configured
/// delay routes even cosign/multisig through the queue path.
pub fn operator_grant_is_instant_eligible(tier: OperatorGrantTier, configured: u64) -> bool {
    effective_operator_grant_delay(tier, configured) == 0
        && matches!(
            tier,
            OperatorGrantTier::Multisig | OperatorGrantTier::CosignBound
        )
}

#[cfg(test)]
mod operator_grant_tier_tests {
    //! F-Q6 — pin the tier classification + effective-delay + instant-
    //! eligibility logic. These are the security decisions that gate whether
    //! a phished single owner key can instantly seat an OPERATOR (it cannot:
    //! SingleKey is always delayed) and whether a cosign vault's instant path
    //! requires a BOUND cosigner (C-1: an unbound cosign vault degrades to
    //! SingleKey).

    use super::*;

    fn bound_pk() -> Pubkey {
        Pubkey::new_from_array([7u8; 32])
    }

    // ── classify_operator_grant_tier ───────────────────────────────────────

    #[test]
    fn classify_multisig_owner_is_multisig_regardless_of_cosign() {
        // owner_type==1 wins even if cosign fields are set/unset.
        assert_eq!(
            classify_operator_grant_tier(OWNER_TYPE_MULTISIG, false, &Pubkey::default()),
            OperatorGrantTier::Multisig
        );
        assert_eq!(
            classify_operator_grant_tier(OWNER_TYPE_MULTISIG, true, &bound_pk()),
            OperatorGrantTier::Multisig
        );
    }

    #[test]
    fn classify_eoa_cosign_required_and_bound_is_cosignbound() {
        assert_eq!(
            classify_operator_grant_tier(0, true, &bound_pk()),
            OperatorGrantTier::CosignBound
        );
    }

    #[test]
    fn classify_eoa_cosign_required_but_unbound_is_singlekey() {
        // C-1: cosign_required==true but cosign_session_pubkey==default →
        // NOT a real 2nd factor → SingleKey (forced delay).
        assert_eq!(
            classify_operator_grant_tier(0, true, &Pubkey::default()),
            OperatorGrantTier::SingleKey
        );
    }

    #[test]
    fn classify_eoa_no_cosign_is_singlekey() {
        assert_eq!(
            classify_operator_grant_tier(0, false, &bound_pk()),
            OperatorGrantTier::SingleKey
        );
        assert_eq!(
            classify_operator_grant_tier(0, false, &Pubkey::default()),
            OperatorGrantTier::SingleKey
        );
    }

    #[test]
    fn classify_unknown_owner_type_fails_safe_to_non_multisig() {
        // Out-of-range owner_type (only reachable via corruption — the read
        // site require!s <= 1) must NEVER classify as Multisig. With cosign
        // bound → CosignBound; without → SingleKey. Either way it can only
        // be a MORE-restrictive tier than Multisig.
        assert_eq!(
            classify_operator_grant_tier(2, false, &Pubkey::default()),
            OperatorGrantTier::SingleKey
        );
        assert_eq!(
            classify_operator_grant_tier(255, true, &bound_pk()),
            OperatorGrantTier::CosignBound
        );
    }

    // ── effective_operator_grant_delay ──────────────────────────────────────

    #[test]
    fn single_key_is_floored_at_600() {
        assert_eq!(
            effective_operator_grant_delay(OperatorGrantTier::SingleKey, 0),
            SINGLE_KEY_OPERATOR_DELAY_FLOOR
        );
        assert_eq!(
            effective_operator_grant_delay(OperatorGrantTier::SingleKey, 300),
            SINGLE_KEY_OPERATOR_DELAY_FLOOR
        );
        assert_eq!(
            effective_operator_grant_delay(OperatorGrantTier::SingleKey, 600),
            600
        );
    }

    #[test]
    fn single_key_above_floor_uses_configured() {
        assert_eq!(
            effective_operator_grant_delay(OperatorGrantTier::SingleKey, 1_000),
            1_000
        );
        assert_eq!(
            effective_operator_grant_delay(OperatorGrantTier::SingleKey, MAX_OPERATOR_GRANT_DELAY),
            MAX_OPERATOR_GRANT_DELAY
        );
    }

    #[test]
    fn two_factor_tiers_use_configured_verbatim() {
        for tier in [OperatorGrantTier::CosignBound, OperatorGrantTier::Multisig] {
            assert_eq!(effective_operator_grant_delay(tier, 0), 0);
            assert_eq!(effective_operator_grant_delay(tier, 1_000), 1_000);
            assert_eq!(
                effective_operator_grant_delay(tier, MAX_OPERATOR_GRANT_DELAY),
                MAX_OPERATOR_GRANT_DELAY
            );
        }
    }

    // ── operator_grant_is_instant_eligible ──────────────────────────────────

    #[test]
    fn single_key_never_instant_eligible() {
        // The whole point: a single key cannot instantly seat an OPERATOR,
        // even at the default delay of 0 (floored to 600).
        assert!(!operator_grant_is_instant_eligible(
            OperatorGrantTier::SingleKey,
            0
        ));
        assert!(!operator_grant_is_instant_eligible(
            OperatorGrantTier::SingleKey,
            600
        ));
        assert!(!operator_grant_is_instant_eligible(
            OperatorGrantTier::SingleKey,
            10_000
        ));
    }

    #[test]
    fn two_factor_tiers_instant_only_at_zero_delay() {
        for tier in [OperatorGrantTier::CosignBound, OperatorGrantTier::Multisig] {
            assert!(operator_grant_is_instant_eligible(tier, 0));
            assert!(!operator_grant_is_instant_eligible(tier, 1));
            assert!(!operator_grant_is_instant_eligible(tier, 600));
            assert!(!operator_grant_is_instant_eligible(
                tier,
                MAX_OPERATOR_GRANT_DELAY
            ));
        }
    }

    // ── constant sanity ─────────────────────────────────────────────────────

    #[test]
    fn constants_match_documented_values() {
        assert_eq!(SINGLE_KEY_OPERATOR_DELAY_FLOOR, 600);
        assert_eq!(MAX_OPERATOR_GRANT_DELAY, 172_800);
        // brick-guard mirror of the compile-time assert (explicit at runtime).
        assert!(
            MAX_OPERATOR_GRANT_DELAY
                <= crate::state::pending_agent_grant::PendingAgentGrant::DEFAULT_MIN_DELAY
        );
    }
}
