use anchor_lang::prelude::*;

/// Queued agent permissions update. Timelock-gated.
/// PDA seeds: [b"pending_agent_perms", vault.key().as_ref(), agent.as_ref()]
/// Per-agent PDA — allows concurrent pending updates for different agents.
#[account]
pub struct PendingAgentPermissionsUpdate {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub new_capability: u8,
    pub _reserved_cap: [u8; 7],
    pub spending_limit_usd: u64,
    pub queued_at: i64,
    pub executes_at: i64,
    /// Slot number when this update was queued. Paired with `MAX_APPLY_AGE_SLOTS`
    /// to enforce a freshness ceiling — defends against durable-nonce pre-signing
    /// attacks (F-10 audit fix, Drift Protocol April 2026 $285M analog).
    pub queued_at_slot: u64,
    pub bump: u8,
    /// TA-06 (Phase 3): per-agent cooldown in seconds. 0 disables. Bound
    /// at apply time onto `AgentSpendOverlay.cooldown_seconds[slot]`.
    /// APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability.
    pub cooldown_seconds: u64,
    /// Round 2 F-RP3-2 fix (audit 2026-05-19): cosign-binding digest for
    /// elevated mutations. When `queue_agent_permissions_update` detects
    /// that the request RAISES an agent's capability, RAISES the spending
    /// limit, or SHORTENS the cooldown — AND `policy.cosign_required ==
    /// true` — the owner MUST supply a co-signing session in the accounts.
    /// The queue handler computes a sha256 over the canonical pending args
    /// and stores it here; `apply_agent_permissions_update` re-asserts the
    /// digest equality.
    ///
    /// `[0u8; 32]` = no cosign required (non-elevated mutation OR cosign
    /// not opted in on this vault). Any non-zero digest indicates this
    /// pending was bound to a specific cosign and the apply handler MUST
    /// re-compute and equal-check.
    ///
    /// APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability.
    pub cosign_digest: [u8; 32],
    /// Round 2 F-RP3-2 fix (audit 2026-05-19): pubkey of the session that
    /// co-signed this queue. Recorded for audit. `Pubkey::default()` =
    /// no cosign (non-elevated OR not opted in).
    ///
    /// APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability.
    pub cosign_session: Pubkey,
}

impl PendingAgentPermissionsUpdate {
    /// 8 (discriminator) + 32 (vault) + 32 (agent) + 8 (new_capability + reserved)
    /// + 8 (spending_limit_usd) + 8 (queued_at) + 8 (executes_at)
    /// + 8 (queued_at_slot, F-10) + 1 (bump) + 8 (cooldown_seconds TA-06)
    /// + 32 (cosign_digest, F-RP3-2) + 32 (cosign_session, F-RP3-2)
    ///   = 185 bytes
    pub const SIZE: usize = 185;

    pub fn is_ready(&self, current_timestamp: i64) -> bool {
        current_timestamp >= self.executes_at
    }
}
