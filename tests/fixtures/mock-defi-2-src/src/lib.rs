//! Second test-only mock DeFi program.
//!
//! A byte-for-byte clone of `mock-defi` (tests/fixtures/mock-defi-src) with a
//! DISTINCT `declare_id!`. It exists solely so Sigil's LiteSVM cap tests can
//! load TWO independent allowlisted DeFi programs and prove per-protocol cap
//! INDEPENDENCE — a spend routed through one program must NOT consume the
//! other program's per-protocol cap.
//!
//! Loading the existing `mock-defi.so` at a second address does not work:
//! Anchor's runtime `declare_id!` check compares the program's own ID against
//! the executing address and reverts on mismatch (DeclaredProgramIdMismatch).
//! A second program ID therefore requires a second compiled binary, which is
//! this crate. Its `drain_via_delegation(amount)` instruction is identical to
//! mock-defi's — a CPI SPL token transfer using the agent's validate-time
//! delegation, producing a real vault-ATA balance decrease that
//! `finalize_session` measures as `actual_spend` (so the per-protocol cap
//! genuinely charges).
//!
//! Not deployed to devnet or mainnet. The `declare_id!` is the deterministic
//! pubkey of tests/fixtures keypair generated at crate creation; tests load
//! the committed `tests/fixtures/mock-defi-2.so` at this exact address.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("6VR8Jnj9vjQhFkTZgShbvS3VJMEXmtsqggBEc3awkiLE");

#[program]
pub mod mock_defi_2 {
    use super::*;

    pub fn open_position(_ctx: Context<MockNoop>) -> Result<()> {
        Ok(())
    }

    pub fn close_position(_ctx: Context<MockNoop>) -> Result<()> {
        Ok(())
    }

    /// CPI SPL Token transfer using the agent (signer) as authority — see the
    /// mock-defi twin for the full rationale. Moves `amount` out of `source`
    /// to `destination` using the validate-time SPL delegation.
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

    /// Models an ACQUIRING swap for the M1 output-ownership tests — twin of
    /// mock-defi's `swap_to_vault`. Pulls `in_amount` of the input mint out of
    /// the vault (agent delegation) AND delivers `out_amount` of a DIFFERENT
    /// mint INTO a vault-owned output account, so a stablecoin-input spend
    /// satisfies finalize's M1 output-ownership gate (err 6112).
    pub fn swap_to_vault(ctx: Context<SwapToVault>, in_amount: u64, out_amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.input_sink.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            in_amount,
        )?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.output_source.to_account_info(),
                    to: ctx.accounts.vault_output.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            out_amount,
        )
    }
}

#[derive(Accounts)]
pub struct MockNoop<'info> {
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct DrainViaDelegation<'info> {
    /// Source SPL token account (typically the vault's ATA). The CPI succeeds
    /// when `source.delegate == authority.key()` and
    /// `source.delegated_amount >= amount` — established by validate's
    /// `token::approve`.
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    /// Destination token account (same mint as `source`).
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    /// Authority signer — the validate-approved delegate (the agent).
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SwapToVault<'info> {
    /// Vault input ATA (delegated to the agent at validate). Leg 1 source.
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    /// Where the pulled input lands (a pool/sink). Leg 1 destination.
    #[account(mut)]
    pub input_sink: Account<'info, TokenAccount>,

    /// Agent-owned reserve of the OUTPUT mint (test-only swap funding). Leg 2 source.
    #[account(mut)]
    pub output_source: Account<'info, TokenAccount>,

    /// The VAULT-OWNED output account the swap credits (a DIFFERENT mint).
    #[account(mut)]
    pub vault_output: Account<'info, TokenAccount>,

    /// Agent signer — authority for both legs (vault delegation + own reserve).
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
