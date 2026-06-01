use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::state::policy::PolicyConfig;
use crate::state::post_assertions::*;
use crate::state::vault::AgentVault;
use crate::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

#[derive(Accounts)]
pub struct CreatePostAssertions<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyConfig>,

    #[account(
        init,
        payer = owner,
        space = PostExecutionAssertions::SIZE,
        seeds = [b"post_assertions", vault.key().as_ref()],
        bump,
    )]
    pub post_assertions: AccountLoader<'info, PostExecutionAssertions>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreatePostAssertions>,
    entries: Vec<PostAssertionEntry>,
    // PEN-CROSS-3 (Phase 2 close-up): owner-signed expected digest covering
    // the POST-mutation policy state (with `has_post_assertions=1`).
    expected_digest: [u8; 32],
) -> Result<()> {
    crate::reject_cpi!();

    // Validate entries
    PostExecutionAssertions::validate_entries(&entries)?;

    let vault_key = ctx.accounts.vault.key();

    // Pack entries into zero-copy account
    let mut assertions = ctx.accounts.post_assertions.load_init()?;
    assertions.vault = vault_key.to_bytes();
    assertions.bump = ctx.bumps.post_assertions;
    assertions.entry_count = entries.len() as u8;

    for (i, entry) in entries.iter().enumerate() {
        let zc = &mut assertions.entries[i];
        zc.target_account = entry.target_account.to_bytes();
        zc.offset = entry.offset;
        zc.value_len = entry.value_len;
        zc.operator = entry.operator;
        zc.assertion_mode = entry.assertion_mode;

        // Phase B3 CrossFieldLte field copies DELETED in Phase 1 Option A demolition.

        // Copy expected value (padded to MAX_CONSTRAINT_VALUE_LEN)
        // M1-04: MAX_CONSTRAINT_VALUE_LEN relocated to state::assertions.
        let len = entry
            .expected_value
            .len()
            .min(crate::state::assertions::MAX_CONSTRAINT_VALUE_LEN);
        zc.expected_value[..len].copy_from_slice(&entry.expected_value[..len]);

        // Phase 6: copy the new aux fields. Without these copies, the
        // Phase 6 variants R-1/R-3 silently store aux_value = 0, which the
        // validate_entries check `max_dec > 0` would catch — BUT only if
        // the handler propagated the Borsh-decoded value. The omission
        // landed during the initial Task 1 commit and was caught by the
        // R-variants adversarial test pin.
        zc.aux_value = entry.aux_value;
        zc.aux_byte = entry.aux_byte;
    }

    // Set the feature flag on PolicyConfig.
    // TA-19 fix: has_post_assertions is part of the canonical
    // policy_preview_digest encoding. Recompute the stored digest from the
    // post-mutation policy state and bump policy_version (OCC counter).
    let policy = &mut ctx.accounts.policy;
    policy.has_post_assertions = 1;

    let recomputed_digest = compute_policy_preview_digest(&PolicyPreviewFields {
        daily_spending_cap_usd: policy.daily_spending_cap_usd,
        max_transaction_size_usd: policy.max_transaction_size_usd,
        max_slippage_bps: policy.max_slippage_bps,
        developer_fee_rate: policy.developer_fee_rate,
        protocol_mode: policy.protocol_mode,
        protocols: &policy.protocols,
        destination_mode: policy.destination_mode,
        allowed_destinations: &policy.allowed_destinations,
        timelock_duration: policy.timelock_duration,
        session_expiry_seconds: policy.session_expiry_seconds,
        observe_only: ctx.accounts.vault.observe_only,
        has_post_assertions: policy.has_post_assertions,
        // PEN-CROSS-2: created_at_slot is immutable post-init.
        created_at_slot: policy.created_at_slot,
        // TA-05 (Phase 3): operating_hours is policy-owned and bound by TA-19.
        // Sibling handler reads from live policy — never mutated here.
        operating_hours: policy.operating_hours,
        // TA-07/17 (Phase 3): bound by TA-19, never mutated by this ix.
        auto_promote_grays: policy.auto_promote_grays,
        auto_revoke_threshold: policy.auto_revoke_threshold,
        // TA-12 (Phase 5): bound by TA-19, never mutated by this ix.
        stable_balance_floor: policy.stable_balance_floor,
        // TA-14 (Phase 5): bound by TA-19, never mutated by this ix.
        per_recipient_daily_cap_usd: policy.per_recipient_daily_cap_usd,
        // G6 (audit 2026-05-18 cosign opt-in): bound by TA-19 at canonical
        // position 20. Sibling handler reads from live policy.
        cosign_required: policy.cosign_required,
        // Phase 8 PEN-CROSS-1: agent_set_hash bound at canonical position
        // 21. Sibling handler never mutates the agent set — re-derive
        // from live vault.
        agent_set_hash: compute_agent_set_hash(&ctx.accounts.vault.agents),
        // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey bound at
        // canonical position 22 — sibling handler never mutates it, so
        // pass-through from live policy keeps the re-bind digest matching
        // the queue-time digest.
        cosign_session_pubkey: policy.cosign_session_pubkey,
    });
    // PEN-CROSS-3: owner must have signed the post-mutation digest.
    require!(
        recomputed_digest == expected_digest,
        SigilError::PolicyPreviewMismatch
    );
    policy.policy_preview_digest = recomputed_digest;

    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(SigilError::Overflow))?;

    emit!(crate::events::PostAssertionsCreated {
        vault: vault_key,
        entry_count: entries.len() as u8,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
