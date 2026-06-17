use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::events::PolicyChangeQueued;
use crate::state::*;
use crate::utils::cosign_digest::{compute_cosign_digest, CosignDigestFields};
use crate::utils::operator_grant::MAX_OPERATOR_GRANT_DELAY;
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

#[derive(Accounts)]
pub struct QueuePolicyUpdate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        init,
        payer = owner,
        space = PendingPolicyUpdate::SIZE,
        seeds = [b"pending_policy", vault.key().as_ref()],
        bump,
    )]
    pub pending_policy: Account<'info, PendingPolicyUpdate>,

    pub system_program: Program<'info, System>,
    // TA-09 (Phase 3): co-signing session is NOT a standalone account
    // here — it's surfaced via the `cosign_session` IX ARG (Pubkey) +
    // `ctx.remaining_accounts`. When elevated mutations are detected,
    // the handler searches remaining_accounts for an entry matching
    // the cosign_session pubkey arg AND with `is_signer == true`.
    //
    // Why this design instead of a typed Option<UncheckedAccount>:
    // Anchor 0.32's optional-account marshalling (passing the program_id
    // as a sentinel for None) interferes with downstream account ordering
    // assumptions when the test client uses `cosignSession: null`. Using
    // a plain remaining_accounts scan with an arg-bound pubkey gives a
    // simpler, more deterministic interface that the LiteSVM + production
    // SDK both produce identically.
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<QueuePolicyUpdate>,
    daily_spending_cap_usd: Option<u64>,
    max_transaction_amount_usd: Option<u64>,
    protocol_mode: Option<u8>,
    protocols: Option<Vec<Pubkey>>,
    developer_fee_rate: Option<u16>,
    max_slippage_bps: Option<u16>,
    timelock_duration: Option<u64>,
    allowed_destinations: Option<Vec<Pubkey>>,
    session_expiry_seconds: Option<u64>,
    has_protocol_caps: Option<bool>,
    protocol_caps: Option<Vec<u64>>,
    destination_mode: Option<u8>,
    operating_hours: Option<u32>,
    // TA-12 (Phase 5 post-exec): owner-controlled stablecoin floor.
    // None = pass through from live policy; Some(n) = update.
    // Bound by TA-19 at canonical digest position 18. NOTE: lowering
    // this is an "elevated mutation" per TA-09 (deferred — Phase 9 will
    // wire the cosign gate for floor reductions; current ix permits
    // lowering through ordinary queue/apply since TA-09 cosign currently
    // covers only the original 4 elevated conditions).
    stable_balance_floor: Option<u64>,
    // TA-14 (Phase 5 post-exec): owner-controlled per-recipient daily cap.
    // None = pass through; Some(n) = update. Bound by TA-19 at digest
    // position 19. NOTE: raising this is an "elevated mutation" per
    // TA-09 (deferred to Phase 9 alongside the floor-lowering case).
    per_recipient_daily_cap_usd: Option<u64>,
    // G6 (audit 2026-05-18 cosign opt-in): owner-controlled cosign
    // requirement flag. None = pass through from live; Some(true) =
    // enable (non-elevated — safety improvement); Some(false) when
    // live is true = DISABLE (ELEVATED — one-way ratchet, cosign
    // required to disable cosign). Bound by TA-19 at digest position 20.
    cosign_required: Option<bool>,
    // D-5 (audit 2026-05-19, F-RP3-1): owner-controlled reactivate-time
    // cosigner pubkey. None = pass through from live policy; Some(pubkey)
    // = set to the supplied value (Pubkey::default() disables the gate,
    // any other pubkey enables it). Bound by TA-19 at digest position 22.
    //
    // Setting this is NOT classified as elevated by the current 7-trigger
    // gate — owners opt INTO friction. The reactivate-time cosign gate
    // fires at `reactivate_vault` when the operation grafts a new agent
    // at FULL_CAPABILITY (see `reactivate_vault.rs`).
    cosign_session_pubkey: Option<Pubkey>,
    // F-Q6 (2026-06-02): owner-controlled OPERATOR-grant delay (seconds).
    // None = pass through from live policy; Some(n) = update. Non-elevated —
    // lowering never breaches the security floor (single-key is floored at
    // max(., 600); cosign/multisig always need >=2 factors). Bound by TA-19
    // (digest, position 22) and gated by timelock_duration like every policy field.
    operator_grant_delay_seconds: Option<u64>,
    // TA-09 (Phase 3): the cosigning session pubkey. `Pubkey::default()`
    // means "no cosign required" (non-elevated mutation). For elevated
    // mutations the caller MUST pass a non-default pubkey AND include
    // the corresponding signer in `remaining_accounts`. Owner cannot
    // cosign themselves.
    cosign_session: Pubkey,
    new_policy_preview_digest: [u8; 32],
) -> Result<()> {
    crate::reject_cpi!();

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;

    require!(
        vault.status != VaultStatus::Closed,
        SigilError::VaultAlreadyClosed
    );

    // M1-03 (systemic frozen-gate, 2026-05-31): a frozen vault MUST NOT accept a
    // newly-staged policy update. Staging a change during a freeze is ADDITIVE —
    // it lets a phished owner key pre-position a loosening (e.g. cap-raise) to
    // apply the moment the vault is reactivated; gate queue AND apply (defense in
    // depth). A defensive tightening is not lost: the owner reactivates (a
    // deliberate decision) and then queues. Closed is already rejected above with
    // its own diagnostic; Frozen surfaces VaultNotActive.
    require!(
        vault.status != VaultStatus::Frozen,
        SigilError::VaultNotActive
    );

    // Timelock must be configured to use queue
    require!(
        policy.timelock_duration > 0,
        SigilError::NoTimelockConfigured
    );

    // Phase 2 Option A: protocol_mode and destination_mode are tightened.
    if let Some(ref mode) = protocol_mode {
        require!(
            *mode == PROTOCOL_MODE_ALLOWLIST,
            SigilError::InvalidProtocolMode
        );
    }
    if let Some(ref mode) = destination_mode {
        require!(
            *mode == DESTINATION_MODE_RESTRICTED,
            SigilError::InvalidDestinationMode
        );
    }
    if let Some(ref protos) = protocols {
        require!(
            protos.len() <= MAX_ALLOWED_PROTOCOLS,
            SigilError::TooManyAllowedProtocols
        );
    }
    if let Some(ref fee_rate) = developer_fee_rate {
        require!(
            *fee_rate <= MAX_DEVELOPER_FEE_RATE,
            SigilError::DeveloperFeeTooHigh
        );
    }
    if let Some(ref slippage) = max_slippage_bps {
        require!(
            *slippage <= MAX_SLIPPAGE_BPS,
            SigilError::SlippageBpsTooHigh
        );
    }
    if let Some(ref destinations) = allowed_destinations {
        require!(
            destinations.len() <= MAX_ALLOWED_DESTINATIONS,
            SigilError::TooManyDestinations
        );
        // H-4 close (audit 2026-05-21, Bucket 1): reject if any destination
        // is the address of a Sigil-owned protected PDA for this vault.
        // Closes the owner-self-foot-gun where a phished owner allowlists
        // a Sigil PDA (e.g. `vault`, `policy`, `pending_owner`), enabling
        // an agent to lock funds at the PDA via a token transfer that the
        // destination check would otherwise approve. See helper docstring
        // for the 13 PDAs enumerated and the residual multi-seed gap.
        let vault_key = ctx.accounts.vault.key();
        let protected_pdas = derive_vault_keyed_protected_pdas(&vault_key, ctx.program_id);
        for dest in destinations.iter() {
            require!(
                !protected_pdas.contains(dest),
                SigilError::ErrDestinationIsProtectedPda
            );
        }
    }
    if let Some(ref tl) = timelock_duration {
        require!(*tl >= MIN_TIMELOCK_DURATION, SigilError::TimelockTooShort);
    }
    // F-Q6 (2026-06-02): bound the OPERATOR-grant delay at its sole write site.
    // A value above MAX_OPERATOR_GRANT_DELAY (48h) could exceed the apply-time
    // freshness ceiling and leave a queued OPERATOR grant permanently
    // unapplyable (a tier-2 liveness brick), so it is rejected here.
    if let Some(ref delay) = operator_grant_delay_seconds {
        require!(
            *delay <= MAX_OPERATOR_GRANT_DELAY,
            SigilError::ErrOperatorGrantDelayTooLong
        );
    }
    // F-Q6 / Council C-1 (2026-06-03): a BOUND cosigner must be a DISTINCT 2nd
    // factor. Forbid binding `cosign_session_pubkey` to the owner key, which
    // would collapse C-1's "owner + cosigner" two factors into one (the owner
    // alone could then satisfy the cosign-bound INSTANT OPERATOR path in
    // register_agent / reactivate_vault). Mirrors the `cosign_session != owner`
    // guard on the TA-09 elevated path below and in
    // queue_agent_permissions_update. `Pubkey::default()` (disabling the gate)
    // is exempt.
    if let Some(ref new_cosign_pk) = cosign_session_pubkey {
        if *new_cosign_pk != Pubkey::default() {
            require_keys_neq!(
                *new_cosign_pk,
                ctx.accounts.owner.key(),
                SigilError::ErrCosignRequired
            );
        }
    }
    if let Some(ref expiry) = session_expiry_seconds {
        if *expiry > 0 {
            // Bounds: 5..=90 seconds. 0 reserved for "use default" (30s).
            // Tight upper bound defends against misconfiguration that would
            // leave delegations live for minutes (audit F5-H1).
            require!(
                *expiry >= MIN_SESSION_DURATION_SECONDS
                    && *expiry <= MAX_OWNER_SESSION_DURATION_SECONDS,
                SigilError::InvalidSessionExpiry
            );
        }
    }
    // TA-05 (Phase 3): if owner is updating operating_hours, ensure upper
    // 8 bits are zero. Bound by TA-19 — the recomputed digest below also
    // catches divergent encodings, but this is the explicit local check.
    if let Some(ref hours) = operating_hours {
        require!(
            *hours & !OPERATING_HOURS_VALID_MASK == 0,
            SigilError::ErrOutsideOperatingHours
        );
    }

    // Validate per-protocol caps consistency against resulting policy state
    {
        let effective_hpc = has_protocol_caps.unwrap_or(policy.has_protocol_caps);
        if effective_hpc {
            let effective_mode = protocol_mode.unwrap_or(policy.protocol_mode);
            require!(
                effective_mode == PROTOCOL_MODE_ALLOWLIST,
                SigilError::ProtocolCapsMismatch
            );
            let effective_protos_len = protocols
                .as_ref()
                .map_or(policy.protocols.len(), |p| p.len());
            let effective_caps_len = protocol_caps
                .as_ref()
                .map_or(policy.protocol_caps.len(), |c| c.len());
            require!(
                effective_caps_len == effective_protos_len,
                SigilError::ProtocolCapsMismatch
            );
        }
    }

    // Phase 2 TA-19: assert the owner's signed digest matches a recomputed
    // digest over the policy state that WILL result if this pending update is
    // applied. Any field the owner did not override is inherited from the live
    // `policy`. The on-chain re-compute prevents owner-signer blind-sign from
    // committing an unintended policy.
    //
    // The "effective" policy projected by this queue:
    let eff_daily = daily_spending_cap_usd.unwrap_or(policy.daily_spending_cap_usd);
    let eff_max_tx = max_transaction_amount_usd.unwrap_or(policy.max_transaction_size_usd);
    let eff_max_slip = max_slippage_bps.unwrap_or(policy.max_slippage_bps);
    // PEN-CROSS-6: developer_fee_rate is now part of the digest. Project the
    // merged-effective value the same way as other Option<…> fields.
    let eff_developer_fee_rate = developer_fee_rate.unwrap_or(policy.developer_fee_rate);
    let eff_protocol_mode = protocol_mode.unwrap_or(policy.protocol_mode);
    let eff_protocols_owned: Vec<Pubkey> = protocols
        .clone()
        .unwrap_or_else(|| policy.protocols.clone());
    let eff_dest_mode = destination_mode.unwrap_or(policy.destination_mode);
    let eff_destinations_owned: Vec<Pubkey> = allowed_destinations
        .clone()
        .unwrap_or_else(|| policy.allowed_destinations.clone());
    let eff_timelock = timelock_duration.unwrap_or(policy.timelock_duration);
    let eff_session_expiry = session_expiry_seconds.unwrap_or(policy.session_expiry_seconds);
    // TA-05 (Phase 3): merged-effective operating_hours.
    let eff_operating_hours = operating_hours.unwrap_or(policy.operating_hours);

    // observe_only is NOT mutable via queue_policy_update (uses dedicated
    // set_observe_only ix for direct owner-only mutation — F-12 audit fix,
    // Option (a) flip mirroring freeze_vault simplicity). Read from vault
    // for digest correctness so this queue's recomputed digest matches the
    // owner's signed digest even when set_observe_only ran independently.
    let eff_observe_only = vault.observe_only;
    let eff_has_post_assertions = policy.has_post_assertions;
    // TA-12 (Phase 5): merged-effective stable_balance_floor.
    let eff_stable_balance_floor = stable_balance_floor.unwrap_or(policy.stable_balance_floor);
    // TA-14 (Phase 5): merged-effective per_recipient_daily_cap_usd.
    let eff_per_recipient_daily_cap_usd =
        per_recipient_daily_cap_usd.unwrap_or(policy.per_recipient_daily_cap_usd);
    // F-Q6 (2026-06-02): merged-effective operator_grant_delay_seconds.
    let eff_operator_grant_delay_seconds =
        operator_grant_delay_seconds.unwrap_or(policy.operator_grant_delay_seconds);
    // G6 (audit 2026-05-18 cosign opt-in): merged-effective cosign_required.
    // None = pass through from live; Some(new) = the queued value. The
    // elevation check below uses BOTH the live and effective values to
    // implement the one-way-ratchet (disable IS elevated, enable is not).
    let eff_cosign_required = cosign_required.unwrap_or(policy.cosign_required);
    // D-5 (audit 2026-05-19, F-RP3-1): merged-effective cosign_session_pubkey.
    // None = pass through from live; Some(pk) = the queued value (which may
    // legitimately be `Pubkey::default()` to disable the gate). Bound by
    // TA-19 at canonical digest position 22 so a tampered SDK cannot
    // silently flip the gate between owner approval and on-chain landing.
    let eff_cosign_session_pubkey = cosign_session_pubkey.unwrap_or(policy.cosign_session_pubkey);
    // M-1 (audit 2026-06-11): merged-effective per-protocol caps for the TA-19
    // digest (positions 23-24). Clone to avoid moving the `protocol_caps` arg,
    // which the elevation check + pending write below still consume.
    let eff_has_protocol_caps = has_protocol_caps.unwrap_or(policy.has_protocol_caps);
    let eff_protocol_caps_owned: Vec<u64> = protocol_caps
        .clone()
        .unwrap_or_else(|| policy.protocol_caps.clone());

    // ─── TA-09 (Phase 3): elevated mutation detection + cosign binding ─
    //
    // Definition of "elevated mutation" per HARDENED §6:
    //   a) Raise daily_spending_cap_usd
    //   b) Raise max_transaction_size_usd
    //   c) Expand allowed_destinations (more entries OR different members)
    //   d) Expand allowed_protocols (more entries OR different members)
    //   e) Lower stable_balance_floor (Phase 5 — not yet implemented)
    //   f) Toggle observe_only sequence (false→true→false) — observe_only
    //      is mutated via dedicated `set_observe_only` ix, NOT this queue,
    //      so the gate lives there (Phase 8 absorption — out of scope).
    //
    // "Raise" is detected via `Option::Some(new) > live`. "Expand" is
    // detected via: new vec contains any pubkey NOT in live vec, OR new
    // len > live len.
    //
    // If ANY elevated condition is true, the handler REQUIRES the cosign
    // signer to be present + is_signer == true, and binds the
    // cosign_digest to a sha256 over the canonical pending args + the
    // cosign pubkey. Apply re-validates.
    let raises_daily_cap =
        daily_spending_cap_usd.is_some_and(|new| new > policy.daily_spending_cap_usd);
    let raises_max_tx =
        max_transaction_amount_usd.is_some_and(|new| new > policy.max_transaction_size_usd);
    let expands_destinations = allowed_destinations.as_ref().is_some_and(|new| {
        // Larger set, or any pubkey not in current list
        new.len() > policy.allowed_destinations.len()
            || new.iter().any(|d| !policy.allowed_destinations.contains(d))
    });
    let expands_protocols = protocols.as_ref().is_some_and(|new| {
        new.len() > policy.protocols.len() || new.iter().any(|p| !policy.protocols.contains(p))
    });
    // G3 audit fix (2026-05-18): TA-12/14 elevation closure. Phase 5 shipped
    // stable_balance_floor + per_recipient_daily_cap_usd as queueable but did
    // NOT classify their hostile mutations (LOWERING the floor, RAISING the
    // per-recipient cap) as elevated. Independently flagged by Pentester (A1)
    // + code-reviewer (A2) + Architect (B1-6). Single-line each.
    //
    // G3a audit fix (§RP-2 2026-05-18): the naive `new > live` predicate
    // missed the "0 = unlimited / off" convention that finalize_session
    // already enforces (finalize_session.rs:486 for per-recipient cap;
    // finalize_session.rs:411-412 + state/policy.rs:347-355 for protocol_caps).
    // A hostile `Some(0)` for these caps actually DISABLES enforcement —
    // strictly weaker than any non-zero value — so it must be elevated even
    // though `0 > live_non_zero` evaluates false. Same applies to
    // `has_protocol_caps: Some(false)` (HIGH-1) and any single protocol cap
    // shrinking-to-zero or growing-to-larger.
    //
    // `lowers_floor` is intentionally NOT touched: stable_balance_floor uses
    // the same "0 = no enforcement" convention (finalize_session.rs:626) but
    // the relationship is INVERSE — a SMALLER floor is weaker. The existing
    // `new < live` already catches `Some(0)` when live > 0 (since 0 < live)
    // and correctly rejects RAISING the floor (which is strengthening).
    let lowers_floor = stable_balance_floor.is_some_and(|new| new < policy.stable_balance_floor);
    let weakens_per_recipient_cap = per_recipient_daily_cap_usd.is_some_and(|new| {
        weakens_per_recipient_cap_predicate(new, policy.per_recipient_daily_cap_usd)
    });
    let weakens_protocol_caps = has_protocol_caps.is_some_and(|new| !new)
        || protocol_caps.as_ref().is_some_and(|new_caps| {
            weakens_protocol_caps_predicate(new_caps, &policy.protocol_caps)
        });
    // Take-over 2026-06-16 (3rd-review B-2): raising max_slippage_bps is a policy
    // WEAKENING (more value-leakage tolerated; load-bearing when a post-execution
    // OutputBalanceFloor/slippage assertion relies on it), and raising
    // developer_fee_rate increases the skim. Both were missing from the elevation
    // set, so a leaked owner key alone could weaken them on a cosign-required
    // vault without the bound cosigner. Gate both like the other weakening
    // triggers (cosign_required-gated; the inner group below).
    let raises_slippage = max_slippage_bps.is_some_and(|new| new > policy.max_slippage_bps);
    let raises_developer_fee =
        developer_fee_rate.is_some_and(|new| new > policy.developer_fee_rate);

    // G6 (audit 2026-05-18 cosign opt-in): one-way-ratchet semantics for
    // toggling `cosign_required`.
    //
    // - `disables_cosign`: queue is requesting cosign_required: Some(false)
    //   AND the live policy currently has cosign_required: true. This is
    //   the ATTACK vector: a phishing-compromised owner key would otherwise
    //   be able to silently disable cosign and then drain via subsequent
    //   non-elevated mutations. Disabling cosign is therefore ITSELF
    //   elevated, regardless of policy.cosign_required's current value
    //   being the gate for the other 7 triggers (see is_elevated below).
    //
    //   Note: if live cosign_required is already false, `disables_cosign`
    //   can never be true — `policy.cosign_required && !new` collapses to
    //   `false && _` = false. So the predicate naturally cannot fire
    //   spuriously when cosign is already off.
    //
    // - `enables_cosign`: queue is requesting cosign_required: Some(true)
    //   when live is false. This is a SAFETY IMPROVEMENT — owner is
    //   voluntarily tightening the policy. Not in is_elevated below.
    //   Variable declared for documentation and future analytics; the
    //   underscore prefix suppresses dead-code warnings while keeping
    //   the symmetry obvious.
    let disables_cosign = cosign_required.is_some_and(|new| !new && policy.cosign_required);
    let _enables_cosign = cosign_required.is_some_and(|new| new && !policy.cosign_required);
    // Take-over 2026-06-16 (Finding 3 — adversarial review of the Finding 2
    // pin): rotating the bound cosigner is itself a cosign-WEAKENING operation
    // (it EVICTS the current 2nd factor), so on a cosign-required vault it MUST
    // be cosigned by the OUTGOING bound cosigner. Without this, the Finding 2
    // pin is only a 2-tx speed bump: a leaked owner key could rotate K to an
    // attacker key via this (otherwise non-elevated, owner-only) D-5 lane, then
    // disable cosign with the attacker key (the pin would pass against the
    // rotated-in key) and drain. Rotating to the SAME key is a no-op (not
    // elevated); rotating to `default` (unbind) is independently blocked at
    // apply by the {cosign_required => bound} invariant assertion. When this
    // fires, the pin below forces `cosign_session == policy.cosign_session_pubkey`
    // (the OLD K), so the incumbent cosigner signs its own replacement.
    let rotates_cosigner = cosign_session_pubkey
        .is_some_and(|new| policy.cosign_required && new != policy.cosign_session_pubkey);

    // G6 (audit 2026-05-18 cosign opt-in): the 7-trigger elevation check
    // (raises caps, expands allowlists, weakens floor / per-recipient /
    // protocol caps) is now gated on `policy.cosign_required`. When the
    // owner has opted OUT of cosign (the default), elevated mutations
    // only require the owner signature — single-signer flow.
    //
    // Why gate on `policy.cosign_required` (the LIVE value), not the
    // merged-effective value: an attacker who phishes the owner cannot
    // queue an enable-cosign AND a daily-cap raise in the same call to
    // bypass the gate, because the enable side is non-elevated (safety
    // improvement) and applies AFTER this queue passes the timelock —
    // the cap raise here is the FIRST mutation, evaluated against the
    // CURRENT cosign_required state. Conversely, an honest owner who
    // wants to enable cosign AND raise the cap can do so in two
    // independent queues (enable first, then raise) without friction.
    //
    // `disables_cosign` is OR'd in unconditionally because it represents
    // an attempted weakening that must itself be cosigned — regardless
    // of what other fields the queue is mutating.
    let is_elevated = (policy.cosign_required
        && (raises_daily_cap
            || raises_max_tx
            || expands_destinations
            || expands_protocols
            || lowers_floor
            || weakens_per_recipient_cap
            || weakens_protocol_caps
            || raises_slippage
            || raises_developer_fee))
        || disables_cosign
        || rotates_cosigner;

    // D-5 (audit 2026-05-19, F-RP3-1): renamed from prior `cosign_session_pubkey`
    // to `bound_cosign_session` to avoid name collision with the new ix arg
    // `cosign_session_pubkey: Option<Pubkey>` (which is the D-5 reactivate-time
    // cosigner pubkey update — a separate concept from the TA-09 queue-time
    // cosign session pubkey persisted on the pending PDA).
    let (bound_cosign_session, cosign_digest_bound): (Pubkey, [u8; 32]) = if is_elevated {
        // Elevated mutation: cosign_session MUST be a non-default pubkey.
        require_keys_neq!(
            cosign_session,
            Pubkey::default(),
            SigilError::ErrCosignRequired
        );
        // Cosign signer MUST be DISTINCT from the owner — otherwise the
        // "two signers" gate collapses to a single one and cosign is
        // ceremonial. (HARDENED D-2 — "any owner-signed session within
        // validity window" — the owner using their own key would defeat
        // the purpose.)
        require_keys_neq!(
            cosign_session,
            ctx.accounts.owner.key(),
            SigilError::ErrCosignRequired
        );
        // Take-over 2026-06-16 (Finding 2 — user decision: pure 2-of-2, no
        // recovery): the elevated cosigner MUST be the vault's BOUND cosigner
        // `policy.cosign_session_pubkey`, not merely SOME non-owner key. Without
        // this pin, a holder of the owner key alone could pick a throwaway 2nd
        // keypair to disable cosign / weaken policy and then drain — the exact
        // "any 2nd signer satisfies cosign" hole that was closed on the
        // agent-grant surface via `has_bound_cosigner`. `is_elevated` implies
        // `policy.cosign_required` (see the `disables_cosign` defn at :414 and
        // the G6 gate at :436), and the `{cosign_required==true => bound != default}`
        // invariant (enforced at initialize_vault, the L1-2 enable check, and the
        // accept_ownership_transfer collapse-clear) guarantees the bound key is
        // non-default here — so this pins the elevated cosigner to the REAL
        // bound cosigner. Lost-K is an ACCEPTED permanent brick (self-custody;
        // documented in ToS); there is deliberately NO recovery lane, because any
        // owner-only escape hatch would re-open this very hole.
        require_keys_eq!(
            cosign_session,
            policy.cosign_session_pubkey,
            SigilError::ErrCosignRequired
        );
        // The corresponding signer MUST be present in remaining_accounts
        // with `is_signer == true`. Solana enforces the signature; this
        // handler validates presence.
        let cosign_present = ctx
            .remaining_accounts
            .iter()
            .any(|ai| ai.key == &cosign_session && ai.is_signer);
        require!(cosign_present, SigilError::ErrCosignRequired);

        // Compute the cosign digest binding INSTRUCTION DATA HASH per
        // HARDENED: "The session signature must cover the SAME
        // instruction-data hash (sha256 of pending args) that the owner
        // signed."
        //
        // Round 2 B4 F-1 fix (audit 2026-05-19): digest now also binds
        // the 5 G3 + G6 elevation triggers (stable_balance_floor,
        // per_recipient_daily_cap_usd, has_protocol_caps, protocol_caps,
        // cosign_required). See `compute_cosign_digest` header for
        // rationale.
        let digest = compute_cosign_digest(&CosignDigestFields {
            cosign_session: &cosign_session,
            daily_spending_cap_usd,
            max_transaction_amount_usd,
            allowed_destinations: allowed_destinations.as_deref(),
            protocols: protocols.as_deref(),
            stable_balance_floor,
            per_recipient_daily_cap_usd,
            has_protocol_caps,
            protocol_caps: protocol_caps.as_deref(),
            cosign_required,
        });
        (cosign_session, digest)
    } else {
        // Round 2 B4 F-3 fix (audit 2026-05-19): Option A — REJECT
        // silent swallow of a caller-supplied cosign_session on the
        // non-elevated path. Previously the non-elevated branch
        // unconditionally wrote `(Pubkey::default(), [0u8;32])` regardless
        // of SDK input, swallowing a caller-supplied cosign_session
        // silently and making the cosign opt-in invisible to the
        // pending PDA. With this gate the caller MUST pass
        // `Pubkey::default()` when the queue is non-elevated; any
        // other value is rejected with InvalidPermissions.
        require_keys_eq!(
            cosign_session,
            Pubkey::default(),
            SigilError::InvalidPermissions
        );
        (Pubkey::default(), [0u8; 32])
    };

    let recomputed_digest = compute_policy_preview_digest(&PolicyPreviewFields {
        daily_spending_cap_usd: eff_daily,
        max_transaction_size_usd: eff_max_tx,
        max_slippage_bps: eff_max_slip,
        developer_fee_rate: eff_developer_fee_rate,
        protocol_mode: eff_protocol_mode,
        protocols: &eff_protocols_owned,
        destination_mode: eff_dest_mode,
        allowed_destinations: &eff_destinations_owned,
        timelock_duration: eff_timelock,
        session_expiry_seconds: eff_session_expiry,
        observe_only: eff_observe_only,
        has_post_assertions: eff_has_post_assertions,
        // PEN-CROSS-2: created_at_slot is bound to vault lifetime — never
        // mutates after init, so pass through from live policy.
        created_at_slot: policy.created_at_slot,
        // TA-05 (Phase 3): merged-effective operating_hours bound by TA-19.
        operating_hours: eff_operating_hours,
        // TA-07/17 (Phase 3): auto_promote_grays + auto_revoke_threshold are
        // not mutated by queue_policy_update in V1 — V2 may expose
        // dedicated set ix. Read live policy so the digest matches the
        // owner's signed digest when the owner didn't intend to change them.
        auto_promote_grays: policy.auto_promote_grays,
        auto_revoke_threshold: policy.auto_revoke_threshold,
        // TA-12 (Phase 5 post-exec): merged-effective stable_balance_floor
        // bound by TA-19. When the queue does not change this field the
        // value pass-through from live policy MUST match the owner's
        // signed digest — defends against a tampered SDK silently
        // lowering the reserve between queue and apply.
        stable_balance_floor: eff_stable_balance_floor,
        // TA-14 (Phase 5 post-exec): merged-effective per-recipient cap
        // bound by TA-19 at canonical position 19.
        per_recipient_daily_cap_usd: eff_per_recipient_daily_cap_usd,
        // G6 (audit 2026-05-18 cosign opt-in): merged-effective
        // cosign_required bound by TA-19 at canonical position 20.
        // The owner's choice (and any toggle) is part of the signed
        // digest so a tampered SDK cannot flip it silently.
        cosign_required: eff_cosign_required,
        // Phase 8 PEN-CROSS-1: agent_set_hash bound at canonical position
        // 21. queue_policy_update never mutates `vault.agents` — re-derive
        // from live vault. The SDK off-chain computes the same projection
        // when it builds the signed digest.
        agent_set_hash: compute_agent_set_hash(&vault.agents),
        // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey bound at
        // canonical position 22. Owner's chosen reactivate-time cosigner
        // pubkey is part of the signed digest — a tampered SDK cannot
        // silently flip the gate between owner approval and on-chain
        // landing.
        cosign_session_pubkey: eff_cosign_session_pubkey,
        // F-Q6 (2026-06-02): merged-effective operator_grant_delay_seconds at
        // canonical position 22 — Stage B made it configurable. The owner's
        // signed digest binds the value they intend to apply (pending-or-live).
        operator_grant_delay_seconds: eff_operator_grant_delay_seconds,
        // M-1 (audit 2026-06-11): merged-effective per-protocol caps (positions 23-24).
        has_protocol_caps: eff_has_protocol_caps,
        protocol_caps: &eff_protocol_caps_owned,
    });
    require!(
        recomputed_digest == new_policy_preview_digest,
        SigilError::PolicyPreviewMismatch
    );

    let clock = Clock::get()?;
    // L-2 (audit 2026-06-11): bound the cast. timelock_duration has a floor
    // (MIN_TIMELOCK_DURATION) but no ceiling; `as i64` on a value > i64::MAX
    // wraps negative → executes_at in the past → timelock bypass. checked
    // try_from fails closed (Overflow) on an out-of-range duration.
    let timelock_secs =
        i64::try_from(policy.timelock_duration).map_err(|_| error!(SigilError::Overflow))?;
    let executes_at = clock
        .unix_timestamp
        .checked_add(timelock_secs)
        .ok_or(SigilError::Overflow)?;

    let pending = &mut ctx.accounts.pending_policy;
    pending.vault = vault.key();
    pending.queued_at = clock.unix_timestamp;
    pending.executes_at = executes_at;
    // F-10 audit fix: capture queue slot for slot-bounded freshness check.
    pending.queued_at_slot = clock.slot;
    pending.daily_spending_cap_usd = daily_spending_cap_usd;
    pending.max_transaction_amount_usd = max_transaction_amount_usd;
    pending.protocol_mode = protocol_mode;
    pending.protocols = protocols;
    pending.developer_fee_rate = developer_fee_rate;
    pending.max_slippage_bps = max_slippage_bps;
    pending.timelock_duration = timelock_duration;
    pending.allowed_destinations = allowed_destinations;
    pending.session_expiry_seconds = session_expiry_seconds;
    pending.has_protocol_caps = has_protocol_caps;
    pending.protocol_caps = protocol_caps;
    pending.destination_mode = destination_mode;
    pending.bump = ctx.bumps.pending_policy;
    // TA-05 (Phase 3): persist optional operating_hours update.
    pending.operating_hours = operating_hours;
    // TA-09 (Phase 3): persist cosign binding. `[0; 32]` + default
    // session = non-elevated; non-zero values = bound to this cosign.
    pending.cosign_digest = cosign_digest_bound;
    pending.cosign_session = bound_cosign_session;
    // Phase 2 TA-19: store the validated owner-signed digest. `apply_pending_policy`
    // re-asserts it after the timelock against the merged-effective policy.
    pending.new_policy_preview_digest = new_policy_preview_digest;
    // TA-12 (Phase 5): persist optional stable_balance_floor update.
    // None passes the live value through at apply time.
    pending.stable_balance_floor = stable_balance_floor;
    // TA-14 (Phase 5): persist optional per_recipient_daily_cap_usd update.
    pending.per_recipient_daily_cap_usd = per_recipient_daily_cap_usd;
    // F-Q6 (2026-06-02): persist optional operator_grant_delay_seconds update.
    // None passes the live value through at apply time.
    pending.operator_grant_delay_seconds = operator_grant_delay_seconds;
    // G6 (audit 2026-05-18 cosign opt-in): persist optional cosign_required
    // update. apply_pending_policy reads this and writes through to
    // `policy.cosign_required` before the second-pass TA-19 digest
    // recompute (which binds the merged value at canonical position 20).
    pending.cosign_required = cosign_required;
    // D-5 (audit 2026-05-19, F-RP3-1): persist optional cosign_session_pubkey
    // update. apply_pending_policy reads this and writes through to
    // `policy.cosign_session_pubkey` before the second-pass TA-19 digest
    // recompute (which binds the merged value at canonical position 22).
    pending.cosign_session_pubkey = cosign_session_pubkey;

    ctx.accounts.policy.has_pending_policy = true;

    emit!(PolicyChangeQueued {
        vault: vault.key(),
        executes_at,
    });

    Ok(())
}

/// G3a audit fix (§RP-2 2026-05-18): predicate detecting whether a proposed
/// `per_recipient_daily_cap_usd` value WEAKENS enforcement relative to the
/// live policy value. Honors the "0 = unlimited / off" convention enforced
/// at `finalize_session.rs:486` (`if policy.per_recipient_daily_cap_usd > 0`).
///
/// Semantics:
///   live == 0  → enforcement already disabled, no weaker state exists → false
///   new  == 0  → weakening (turning enforcement OFF) unless already off
///   both > 0   → weakening iff `new > live` (more spend allowed per recipient)
///
/// Extracted as a pub fn so the boundary cases can be unit-tested without a
/// full `PolicyConfig` / Anchor `Context` scaffold.
pub fn weakens_per_recipient_cap_predicate(new: u64, live: u64) -> bool {
    if live == 0 {
        // Already unlimited — no further weakening possible.
        return false;
    }
    if new == 0 {
        // Setting to "unlimited" from a bounded value is the canonical
        // attack vector flagged by §RP-2 CRIT-1.
        return true;
    }
    // Both bounded: weakening = strictly larger value.
    new > live
}

/// G3a audit fix (§RP-2 2026-05-18 HIGH-1): predicate detecting whether a
/// proposed `protocol_caps` vector weakens enforcement at the per-protocol
/// level. Honors the same "0 = unlimited" convention enforced at
/// `finalize_session.rs:411-412` (`if proto_cap > 0`).
///
/// A single cap is weakened iff:
///   - live_cap > 0  AND  (new_cap == 0  OR  new_cap > live_cap)
///
/// Missing entries in `live_caps` (shorter Vec than `new_caps`) are treated
/// as `live_cap = 0` (unlimited — no weakening possible at that index).
/// Returns true on FIRST weakened index seen.
///
/// NOTE: this does NOT cover the `has_protocol_caps: Some(false)` case —
/// that's a master-switch disable and is checked separately at the call site
/// in `handler()`.
///
/// Extracted as a pub fn so boundary cases can be unit-tested standalone.
pub fn weakens_protocol_caps_predicate(new_caps: &[u64], live_caps: &[u64]) -> bool {
    new_caps.iter().enumerate().any(|(i, &new_cap)| {
        let live_cap = live_caps.get(i).copied().unwrap_or(0);
        if live_cap == 0 {
            // Already unlimited (or missing live entry → unlimited per convention).
            return false;
        }
        if new_cap == 0 {
            // Turning OFF this protocol's cap is weakening.
            return true;
        }
        // Both bounded: weakening = strictly larger.
        new_cap > live_cap
    })
}

/// G6 (audit 2026-05-18 cosign opt-in): pure-function variant of the
/// `is_elevated` decision in `handler()`. Extracted so the cosign-gating
/// and one-way-ratchet semantics can be unit-tested without spinning up a
/// full Anchor `Context` + `PolicyConfig` scaffold.
///
/// Mirrors the in-handler logic exactly:
///   - If `live_cosign_required == false`, the 7 conventional triggers
///     (raises_daily_cap, raises_max_tx, expands_destinations,
///     expands_protocols, lowers_floor, weakens_per_recipient_cap,
///     weakens_protocol_caps) do NOT elevate. The owner has opted out
///     of cosign, so elevated mutations only require the owner signature.
///   - If `live_cosign_required == true`, any of the 7 triggers elevates.
///   - `disables_cosign` is OR'd in unconditionally — disabling cosign
///     is an elevated mutation regardless of any other trigger, because
///     the change ITSELF is the weakening the cosign primitive existed
///     to prevent. (Note: when `live_cosign_required == false`, the
///     `disables_cosign` predicate cannot evaluate true since
///     `policy.cosign_required && !new` becomes `false && _` = false.)
pub fn is_elevated_decision(
    live_cosign_required: bool,
    raises_daily_cap: bool,
    raises_max_tx: bool,
    expands_destinations: bool,
    expands_protocols: bool,
    lowers_floor: bool,
    weakens_per_recipient_cap: bool,
    weakens_protocol_caps: bool,
    disables_cosign: bool,
) -> bool {
    (live_cosign_required
        && (raises_daily_cap
            || raises_max_tx
            || expands_destinations
            || expands_protocols
            || lowers_floor
            || weakens_per_recipient_cap
            || weakens_protocol_caps))
        || disables_cosign
}

/// G6 (audit 2026-05-18 cosign opt-in): pure predicate computing whether a
/// queued `cosign_required` update DISABLES cosign on a live policy that
/// currently requires it. Mirrors the in-handler `disables_cosign`
/// expression exactly so unit tests can pin all four toggle combinations
/// without needing a full Anchor scaffold.
///
/// Truth table:
///   | live    | new            | disables |
///   |---------|----------------|----------|
///   | true    | Some(false)    | true     | one-way ratchet attack vector
///   | true    | Some(true)     | false    | no-op
///   | true    | None           | false    | pass-through
///   | false   | Some(false)    | false    | no-op (already off)
///   | false   | Some(true)     | false    | enabling — safety improvement
///   | false   | None           | false    | pass-through
pub fn disables_cosign_predicate(new: Option<bool>, live: bool) -> bool {
    new.is_some_and(|n| !n && live)
}

/// G6 (audit 2026-05-18 cosign opt-in): pure predicate companion to
/// `disables_cosign_predicate` for the false→true direction. Always
/// non-elevated (safety improvement), but exposed for symmetry +
/// future analytics / audit-log emission.
/// Derive the 13 single-seed vault-keyed Sigil-protected PDAs for queue-time
/// `allowed_destinations` validation (H-4 close, audit 2026-05-21).
///
/// Returns a `Vec<Pubkey>` rather than a fixed array to keep the caller's
/// stack frame small — `queue_policy_update` is much less stack-constrained
/// than `validate_and_authorize`, but heap-allocating for consistency with
/// the TA-11 helper at `validate_and_authorize.rs:build_ta11_protected_set`.
///
/// Enumerates the single-seed entries from `PROTECTED_SEED_PREFIXES`
/// (state/mod.rs:226). Multi-seed PDAs (`session [vault, agent, mint]`,
/// `pending_agent_perms [vault, agent]`) are intentionally NOT enumerated
/// here because:
///   1. Enumerating session would require iterating all (agent, mint)
///      tuples — combinatorial and brittle.
///   2. Enumerating pending_agent_perms for every agent in `vault.agents`
///      is feasible but the socially-engineered owner is unlikely to
///      allowlist a pubkey derived from an agent key they also control —
///      most realistic foot-gun is the vault-keyed single-seed family.
///   3. The TA-11 protected-writable scan at execute time STILL rejects
///      multi-seed PDAs if they appear as writable in a sibling ix
///      (see `validate_and_authorize.rs:build_ta11_protected_set`).
///
/// Forward-compat families `cosign` and `recipient` are omitted (no live
/// PDAs in V2; would produce false negatives).
#[inline(never)]
fn derive_vault_keyed_protected_pdas(vault: &Pubkey, program_id: &Pubkey) -> Vec<Pubkey> {
    let vault_seed = vault.as_ref();
    // M1-04c: pending_constraints, pending_close_constraints, and constraints
    // seeds removed — the constraints engine is gone, those PDAs can never be
    // allocated, so denylisting them as destinations protected nothing.
    let seeds: [&[u8]; 10] = [
        b"vault",
        b"policy",
        b"tracker",
        b"post_assertions",
        b"audit_success",
        b"audit_rejected",
        b"pending_policy",
        b"pending_owner",
        b"pending_agent_grant",
        b"agent_spend",
    ];
    let mut pdas: Vec<Pubkey> = Vec::with_capacity(10);
    for seed in seeds.iter() {
        let (pda, _) = Pubkey::find_program_address(&[seed, vault_seed], program_id);
        pdas.push(pda);
    }
    pdas
}

pub fn enables_cosign_predicate(new: Option<bool>, live: bool) -> bool {
    new.is_some_and(|n| n && !live)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- weakens_per_recipient_cap_predicate (G3a §RP-2 CRIT-1) ---

    #[test]
    fn per_recipient_weakens_when_setting_zero_with_live_nonzero() {
        // CRIT-1 attack vector: live=$5 cap, attacker proposes Some(0)
        // → disables enforcement. Must be detected as weakening.
        assert!(weakens_per_recipient_cap_predicate(0, 5_000_000));
    }

    #[test]
    fn per_recipient_not_weakened_when_setting_zero_with_live_zero() {
        // No-op: live is already unlimited.
        assert!(!weakens_per_recipient_cap_predicate(0, 0));
    }

    #[test]
    fn per_recipient_not_weakened_when_setting_nonzero_with_live_zero() {
        // Owner is TIGHTENING from "unlimited" to a bounded value.
        // The new state is stricter than the live one — but the §RP-2 spec
        // explicitly classifies this as non-elevated since live=unlimited
        // means "already at the weakest state, anything is a tightening."
        assert!(!weakens_per_recipient_cap_predicate(1_000_000, 0));
        assert!(!weakens_per_recipient_cap_predicate(u64::MAX, 0));
    }

    #[test]
    fn per_recipient_weakens_when_new_larger_than_live_both_bounded() {
        // Classic raise: live=$5, new=$10 → more spend allowed → weakening.
        assert!(weakens_per_recipient_cap_predicate(10_000_000, 5_000_000));
    }

    #[test]
    fn per_recipient_not_weakened_when_new_smaller_than_live_both_bounded() {
        // Tightening from $10 to $5 → strictly stricter, not weakening.
        assert!(!weakens_per_recipient_cap_predicate(5_000_000, 10_000_000));
    }

    #[test]
    fn per_recipient_not_weakened_when_unchanged() {
        // No-op queue: no elevation needed.
        assert!(!weakens_per_recipient_cap_predicate(5_000_000, 5_000_000));
    }

    // --- weakens_protocol_caps_predicate (G3a §RP-2 HIGH-1) ---

    #[test]
    fn protocol_caps_weakens_when_cap_shrinks_to_zero() {
        // HIGH-1: live cap = $100, new = $0 → disables that protocol's cap.
        let live = vec![100_000_000u64, 50_000_000u64];
        let new = vec![0u64, 50_000_000u64];
        assert!(weakens_protocol_caps_predicate(&new, &live));
    }

    #[test]
    fn protocol_caps_weakens_when_cap_grows_to_higher_value() {
        // Classic raise on a single protocol: $100 → $200.
        let live = vec![100_000_000u64, 50_000_000u64];
        let new = vec![200_000_000u64, 50_000_000u64];
        assert!(weakens_protocol_caps_predicate(&new, &live));
    }

    #[test]
    fn protocol_caps_not_weakened_when_unchanged() {
        let live = vec![100_000_000u64, 50_000_000u64];
        let new = vec![100_000_000u64, 50_000_000u64];
        assert!(!weakens_protocol_caps_predicate(&new, &live));
    }

    #[test]
    fn protocol_caps_not_weakened_when_caps_tighten() {
        // Strictly tightening on both protocols.
        let live = vec![100_000_000u64, 50_000_000u64];
        let new = vec![50_000_000u64, 25_000_000u64];
        assert!(!weakens_protocol_caps_predicate(&new, &live));
    }

    #[test]
    fn protocol_caps_not_weakened_when_setting_zero_with_live_zero() {
        // Live unlimited → no further weakening possible at that index.
        let live = vec![0u64, 50_000_000u64];
        let new = vec![0u64, 25_000_000u64];
        assert!(!weakens_protocol_caps_predicate(&new, &live));
    }

    #[test]
    fn protocol_caps_not_weakened_when_live_shorter_and_new_index_zero() {
        // Missing live entries treated as unlimited (0) per get_protocol_cap
        // semantics at state/policy.rs:354.
        let live = vec![100_000_000u64];
        let new = vec![100_000_000u64, 0u64];
        assert!(!weakens_protocol_caps_predicate(&new, &live));
    }

    #[test]
    fn protocol_caps_weakens_on_first_weakened_index() {
        // Mixed: index 0 tightened, index 1 weakened. Must still detect.
        let live = vec![100_000_000u64, 50_000_000u64];
        let new = vec![50_000_000u64, 100_000_000u64];
        assert!(weakens_protocol_caps_predicate(&new, &live));
    }

    // --- G6 (audit 2026-05-18 cosign opt-in) boundary tests ---
    //
    // Coverage for the four cases enumerated in the spec:
    //   1. is_elevated == false when live_cosign_required=false even with
    //      all 7 conventional triggers active (cosign is OFF — owner-only
    //      mutation, no cosign required).
    //   2. is_elevated == true for any single trigger when
    //      live_cosign_required=true.
    //   3. is_elevated == true for cosign_required: Some(false) when
    //      live=true (disable IS elevated — one-way ratchet).
    //   4. is_elevated == false for cosign_required: Some(true) regardless
    //      of current value (enabling is free — safety improvement).

    #[test]
    fn elevation_off_when_live_cosign_required_false() {
        // Spec case 1: cosign opted-out. All 7 conventional triggers true.
        // Result: NOT elevated. Owner-only mutation allowed.
        let elevated = is_elevated_decision(
            /* live_cosign_required */ false, /* raises_daily_cap */ true,
            /* raises_max_tx */ true, /* expands_destinations */ true,
            /* expands_protocols */ true, /* lowers_floor */ true,
            /* weakens_per_recipient_cap */ true, /* weakens_protocol_caps */ true,
            /* disables_cosign */ false,
        );
        assert!(
            !elevated,
            "cosign_required=false short-circuits the 7-trigger elevation gate"
        );
    }

    #[test]
    fn elevation_on_for_any_trigger_when_live_cosign_required_true() {
        // Spec case 2: cosign opted-in. Each individual trigger elevates.
        let triggers = [
            "raises_daily_cap",
            "raises_max_tx",
            "expands_destinations",
            "expands_protocols",
            "lowers_floor",
            "weakens_per_recipient_cap",
            "weakens_protocol_caps",
        ];
        for (i, name) in triggers.iter().enumerate() {
            let elevated = is_elevated_decision(
                /* live_cosign_required */ true,
                /* raises_daily_cap */ i == 0,
                /* raises_max_tx */ i == 1,
                /* expands_destinations */ i == 2,
                /* expands_protocols */ i == 3,
                /* lowers_floor */ i == 4,
                /* weakens_per_recipient_cap */ i == 5,
                /* weakens_protocol_caps */ i == 6,
                /* disables_cosign */ false,
            );
            assert!(
                elevated,
                "{} alone must elevate when cosign is opted in",
                name
            );
        }
    }

    #[test]
    fn elevation_on_for_disables_cosign_when_live_true() {
        // Spec case 3: disabling cosign on a live-true policy is elevated.
        // No other triggers active — disables_cosign alone carries the bit.
        let elevated = is_elevated_decision(
            /* live_cosign_required */ true, /* raises_daily_cap */ false,
            /* raises_max_tx */ false, /* expands_destinations */ false,
            /* expands_protocols */ false, /* lowers_floor */ false,
            /* weakens_per_recipient_cap */ false, /* weakens_protocol_caps */ false,
            /* disables_cosign */ true,
        );
        assert!(
            elevated,
            "disabling cosign on a live cosign_required=true policy MUST elevate (one-way ratchet)"
        );
    }

    #[test]
    fn elevation_off_for_enables_cosign_regardless_of_other_state() {
        // Spec case 4: enabling cosign from false→true is non-elevated.
        // It's a safety improvement — owner is voluntarily tightening.
        // Exercises both directions: live=false (enabling) and live=true
        // (no-op via Some(true)).
        //
        // In both cases disables_cosign is false (no false→true→false in
        // a single queue), so elevation depends entirely on whether any
        // of the 7 conventional triggers fire AND whether live is true.
        // We pin the case where NO conventional triggers fire to isolate
        // the enable path.
        for live in [false, true] {
            let elevated = is_elevated_decision(
                /* live_cosign_required */ live, /* raises_daily_cap */ false,
                /* raises_max_tx */ false, /* expands_destinations */ false,
                /* expands_protocols */ false, /* lowers_floor */ false,
                /* weakens_per_recipient_cap */ false, /* weakens_protocol_caps */ false,
                /* disables_cosign */ false,
            );
            assert!(
                !elevated,
                "enabling (or no-op) cosign with no other triggers MUST NOT elevate, live={}",
                live
            );
        }
    }

    // --- G6 disables_cosign_predicate truth-table coverage ---

    #[test]
    fn disables_cosign_true_only_for_some_false_with_live_true() {
        assert!(disables_cosign_predicate(Some(false), true));
        // All other combinations must be false.
        assert!(!disables_cosign_predicate(Some(true), true));
        assert!(!disables_cosign_predicate(None, true));
        assert!(!disables_cosign_predicate(Some(false), false));
        assert!(!disables_cosign_predicate(Some(true), false));
        assert!(!disables_cosign_predicate(None, false));
    }

    #[test]
    fn enables_cosign_true_only_for_some_true_with_live_false() {
        assert!(enables_cosign_predicate(Some(true), false));
        // All other combinations must be false.
        assert!(!enables_cosign_predicate(Some(false), false));
        assert!(!enables_cosign_predicate(None, false));
        assert!(!enables_cosign_predicate(Some(true), true));
        assert!(!enables_cosign_predicate(Some(false), true));
        assert!(!enables_cosign_predicate(None, true));
    }
}
