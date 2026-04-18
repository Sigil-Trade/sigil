//! Test-only mock DeFi program.
//!
//! Exists solely to give Sigil's LiteSVM integration tests a real Anchor
//! program (with stable 8-byte discriminators) to route instruction-sysvar
//! matching against. Two no-op instructions — `open_position` and
//! `close_position` — let tests configure `InstructionConstraints` with
//! `position_effect = Increment` (open) and `position_effect = Decrement`
//! (close) respectively, so `vault.open_positions` auto-updates in
//! `finalize_session` without needing `sync_positions` as a workaround.
//!
//! Not deployed to devnet or mainnet. The fixed `declare_id!` is
//! deterministic across builds so test constraint entries can hard-code the
//! program ID.

use anchor_lang::prelude::*;

declare_id!("2pB26qKW73sToF7ETcdhXQTj8biYwAk9TCArVwgHBe24");

#[program]
pub mod mock_defi {
    use super::*;

    pub fn open_position(_ctx: Context<MockNoop>) -> Result<()> {
        Ok(())
    }

    pub fn close_position(_ctx: Context<MockNoop>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MockNoop<'info> {
    pub signer: Signer<'info>,
}
