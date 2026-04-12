use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::state::policy::PolicyConfig;
use crate::state::post_assertions::*;
use crate::state::vault::AgentVault;

#[derive(Accounts)]
pub struct CreatePostAssertions<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SigilError::UnauthorizedOwner,
        seeds = [b"vault", owner.key().as_ref(), vault.vault_id.to_le_bytes().as_ref()],
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

pub fn handler(ctx: Context<CreatePostAssertions>, entries: Vec<PostAssertionEntry>) -> Result<()> {
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

        // Copy expected value (padded to MAX_CONSTRAINT_VALUE_LEN)
        let len = entry
            .expected_value
            .len()
            .min(crate::state::constraints::MAX_CONSTRAINT_VALUE_LEN);
        zc.expected_value[..len].copy_from_slice(&entry.expected_value[..len]);
    }

    // Set the feature flag on PolicyConfig
    let policy = &mut ctx.accounts.policy;
    policy.has_post_assertions = 1;

    emit!(crate::events::PostAssertionsCreated {
        vault: vault_key,
        entry_count: entries.len() as u8,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
