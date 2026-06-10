//! Test-only mock DeFi program.
//!
//! Exists solely to give Sigil's LiteSVM integration tests a real Anchor
//! program (with stable 8-byte discriminators) to route instruction-sysvar
//! matching against. Three instructions:
//!   - `open_position`  — no-op, stable discriminator for constraint tests
//!   - `close_position` — no-op, stable discriminator for constraint tests
//!   - `drain_via_delegation(amount)` — CPI SPL token transfer using the
//!     agent's validate-time delegation. Used by Phase 6.1 sandwich
//!     integration tests to make a vault ATA balance actually decrease
//!     between `validate_and_authorize` (pre-snapshot) and
//!     `finalize_session` (post-snapshot), which triggers R-1 MintDeltaCap
//!     and TA-14 per-recipient-cap violations.
//!
//! Not deployed to devnet or mainnet. The fixed `declare_id!` is
//! deterministic across builds so test constraint entries can hard-code the
//! program ID.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("2heRcfqPUcSiWpH1rAp2Zf4c4ZxfKmKaaVbJWGRa7Qm6");

#[program]
pub mod mock_defi {
    use super::*;

    pub fn open_position(_ctx: Context<MockNoop>) -> Result<()> {
        Ok(())
    }

    pub fn close_position(_ctx: Context<MockNoop>) -> Result<()> {
        Ok(())
    }

    /// CPI SPL Token transfer using the agent (signer) as authority.
    ///
    /// In the canonical Sigil sandwich, `validate_and_authorize` runs
    /// `token::approve` granting the agent SPL delegation over the vault's
    /// token account. This instruction sits between validate and finalize
    /// and uses that delegation to actually move tokens out of the vault
    /// — producing a real balance decrease that R-1 MintDeltaCap and
    /// TA-14 per-recipient-cap can detect at finalize.
    ///
    /// Top-level SPL Token Transfer is BLOCKED at validate-time
    /// (UnauthorizedTokenTransfer), so the transfer MUST happen at the
    /// CPI level — which is what this instruction provides.
    pub fn drain_via_delegation(ctx: Context<DrainViaDelegation>, amount: u64) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)
    }
}

#[derive(Accounts)]
pub struct MockNoop<'info> {
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct DrainViaDelegation<'info> {
    /// Source SPL token account (typically the vault's ATA). The CPI
    /// will succeed when `source.delegate == authority.key()` and
    /// `source.delegated_amount >= amount` — i.e., when validate's
    /// `token::approve` granted the agent delegation just before this ix.
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    /// Destination token account (must hold the same mint as `source`).
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    /// Authority signer — the validate-approved delegate. In the Sigil
    /// sandwich, this is the agent. SPL Token verifies the delegation
    /// invariant inside its `Transfer` handler.
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
