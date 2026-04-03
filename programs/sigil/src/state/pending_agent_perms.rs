use anchor_lang::prelude::*;

/// Queued agent permissions update. Timelock-gated.
/// PDA seeds: [b"pending_agent_perms", vault.key().as_ref(), agent.as_ref()]
/// Per-agent PDA — allows concurrent pending updates for different agents.
#[account]
pub struct PendingAgentPermissionsUpdate {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub new_permissions: u64,
    pub spending_limit_usd: u64,
    pub queued_at: i64,
    pub executes_at: i64,
    pub bump: u8,
}

impl PendingAgentPermissionsUpdate {
    /// 8 (discriminator) + 32 (vault) + 32 (agent) + 8 (new_permissions)
    /// + 8 (spending_limit_usd) + 8 (queued_at) + 8 (executes_at) + 1 (bump)
    pub const SIZE: usize = 105;

    pub fn is_ready(&self, current_timestamp: i64) -> bool {
        current_timestamp >= self.executes_at
    }
}
