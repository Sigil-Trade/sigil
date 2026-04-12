use anchor_lang::prelude::*;

use crate::errors::SigilError;
use crate::state::policy::PolicyConfig;
use crate::state::post_assertions::PostExecutionAssertions;
use crate::state::vault::AgentVault;

#[derive(Accounts)]
pub struct ClosePostAssertions<'info> {
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
        mut,
        seeds = [b"post_assertions", vault.key().as_ref()],
        bump = post_assertions.load()?.bump,
        close = owner,
    )]
    pub post_assertions: AccountLoader<'info, PostExecutionAssertions>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClosePostAssertions>) -> Result<()> {
    crate::reject_cpi!();

    let vault_key = ctx.accounts.vault.key();

    // Clear the feature flag on PolicyConfig
    let policy = &mut ctx.accounts.policy;
    policy.has_post_assertions = 0;

    emit!(crate::events::PostAssertionsClosed {
        vault: vault_key,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
