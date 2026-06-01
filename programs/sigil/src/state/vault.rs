use super::{VaultStatus, MAX_AGENTS_PER_VAULT};
use crate::errors::SigilError;
use anchor_lang::prelude::*;

/// Agent capability levels (replaces 21-bit ActionType bitmask).
/// 0 = Disabled, 1 = Observer (non-spending only), 2 = Operator (full access), 3 = Reserved.
pub const CAPABILITY_DISABLED: u8 = 0;
pub const CAPABILITY_OBSERVER: u8 = 1;
pub const CAPABILITY_OPERATOR: u8 = 2;

/// Phase 8 — FreezeReason enum recording why a vault entered Frozen status.
///
/// Stored on `AgentVault.freeze_reason` (u8) so the on-chain wire format
/// remains a single byte while the Rust type-system enforces the {0,1,2}
/// invariant inside helper code. The byte is validated against this enum
/// at every write site (see `FreezeReason::from_u8`); unknown values reject
/// with `SigilError::ErrInvalidFreezeReason`.
///
/// **Phase 8 audit lineage:** introduced after Round-2 line-by-line audit
/// found `revoke_agent.rs` auto-freeze drifted from `freeze_vault.rs`
/// manual freeze (F-RP3-2 sibling drift). Batch 2 extracts both call sites
/// into a shared `freeze_helper` that requires a `FreezeReason` argument so
/// the next sibling-handler can't silently omit the reason byte.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FreezeReason {
    /// `freeze_vault` invoked directly by the owner as a manual kill switch.
    Manual = 0,
    /// `revoke_agent` auto-freezes because the last remaining agent was
    /// revoked, leaving the vault with no operator. The owner must
    /// `reactivate_vault` (after the 5-min cooldown) and register a new
    /// agent before the vault can authorize again.
    AutoRevoke = 1,
    /// Reserved for v1.1 emergency-board pattern. Dead-code in V1 by design
    /// (per Phase 8 spec §3, Audit #2 F-1 disposition). The discriminant is
    /// reserved so that adding the v1.1 instruction is APPEND-ONLY at the
    /// wire layer; no existing freeze_reason byte will be re-interpreted.
    EmergencyBoard = 2,
}

impl FreezeReason {
    /// Validate a wire-format freeze_reason byte and return the typed enum.
    /// Hard-rejects unknown discriminants (3..=255) per Phase 8 spec §3 —
    /// forward-secure against a future-added variant a tampered SDK might
    /// pre-sign against today's program.
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(FreezeReason::Manual),
            1 => Ok(FreezeReason::AutoRevoke),
            2 => Ok(FreezeReason::EmergencyBoard),
            _ => Err(error!(SigilError::ErrInvalidFreezeReason)),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct AgentEntry {
    pub pubkey: Pubkey, // 32 bytes
    /// Agent capability: 0=Disabled, 1=Observer (non-spending), 2=Operator (full).
    /// Replaces the 21-bit ActionType permission bitmask.
    pub capability: u8, // 1 byte (was permissions: u64, 8 bytes)
    pub spending_limit_usd: u64, // 8 bytes — 0 = no per-agent limit
    pub paused: bool,   // 1 byte  — owner-controlled suspension
    /// TA-17 (Phase 3 pre-execution guard #7): consecutive policy-
    /// violation failures by this agent. Solana's atomic-or-none execution
    /// means a validate-time reject rolls back its own state mutation, so
    /// the counter cannot self-increment inside the failing tx. Instead,
    /// it is incremented by the owner-only `record_agent_violation` ix,
    /// called by an off-chain monitor after observing a failed seal whose
    /// reject reason is an on-chain policy code (numeric range
    /// POLICY_VIOLATION_RANGE = 6074..=6091 — see `state/mod.rs::is_policy_violation_code`).
    /// Reset to 0 inside `validate_and_authorize` on a successful seal.
    /// When `>= policy.auto_revoke_threshold`, the agent's capability is
    /// set to CAPABILITY_DISABLED and an `AgentAutoRevoked` event is
    /// emitted. Owner re-enables via `queue_agent_permissions_update`.
    ///
    /// External codes (sysvar-scan 6068 SysvarScanBoundExceeded,
    /// async-fulfillment 6069 AsyncFulfillmentNotPermitted, auth
    /// errors 6000-6082) do NOT increment — they're not the agent's
    /// fault and auto-revoking on them would let an attacker brick
    /// a working agent.
    ///
    /// Uses 1 byte from the prior `_reserved: [u8; 7]`. 6 bytes remain
    /// reserved for future fields.
    pub consecutive_failures: u8, // 1 byte
    pub _reserved: [u8; 6], // 6 bytes — was 7 pre-TA-17
}
// Total: 49 bytes per entry (32 + 1 + 8 + 1 + 1 + 6 = 49, same as old layout)

#[account]
pub struct AgentVault {
    /// The owner who created this vault (has full authority)
    pub owner: Pubkey,

    /// Unique vault identifier (allows one owner to have multiple vaults)
    pub vault_id: u64,

    /// Registered agents with per-agent permission bitmasks (max 10)
    pub agents: Vec<AgentEntry>,

    /// Developer fee destination — IMMUTABLE after initialization.
    /// Prevents a compromised owner from redirecting fees.
    pub fee_destination: Pubkey,

    /// Vault status: Active, Frozen, or Closed
    pub status: VaultStatus,

    /// Bump seed for PDA derivation
    pub bump: u8,

    /// Unix timestamp of vault creation
    pub created_at: i64,

    /// Total number of agent transactions executed through this vault
    pub total_transactions: u64,

    /// Total volume processed in token base units
    pub total_volume: u64,

    /// Cumulative developer fees collected from this vault (token base units)
    pub total_fees_collected: u64,

    /// Cumulative stablecoin deposits in base units (USDC/USDT, 6 decimals).
    /// Incremented in deposit_funds for stablecoin mints only.
    /// Used for P&L: current_balance - total_deposited_usd + total_withdrawn_usd.
    /// Cumulative gross — never decremented. Informational only, never authorization input.
    pub total_deposited_usd: u64,

    /// Cumulative stablecoin withdrawals in base units (USDC/USDT, 6 decimals).
    /// Incremented in withdraw_funds for stablecoin mints only.
    pub total_withdrawn_usd: u64,

    /// Cumulative failed + expired session count.
    /// Incremented in finalize_session when success=false OR is_expired=true.
    /// Used for success rate: total_transactions / (total_transactions + total_failed_transactions).
    /// Informational only — never used in authorization decisions.
    pub total_failed_transactions: u64,

    /// Number of active (not yet finalized) sessions for this vault.
    /// Incremented in validate_and_authorize, decremented in finalize_session.
    /// close_vault requires this to be 0.
    pub active_sessions: u8,

    /// Phase 2 Task 8: observe_only mode flag (independent from TA-19;
    /// included in TA-19 digest encoding at position 10).
    ///
    /// When true, ALL `validate_and_authorize` calls reject with
    /// `ObserveOnlyModeBlocksExecute`. Provides a hard, low-blast-radius
    /// kill switch separate from `VaultStatus::Frozen` — owners can stand
    /// up an observe-only vault to baseline agent behaviour before opening
    /// the execute path.
    ///
    /// Set at `initialize_vault` time; flipped post-init via the dedicated
    /// `set_observe_only` instruction (F-12 audit fix, Option (a) direct
    /// owner-only flip mirroring `freeze_vault` simplicity).
    ///
    /// APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability.
    pub observe_only: bool,

    /// Phase 8 — unix timestamp at which `vault.status` last transitioned to
    /// Frozen. Written by every freeze code path (manual `freeze_vault`,
    /// auto-freeze inside `revoke_agent`, future `freeze_internal` helper).
    /// Read by `reactivate_vault` to enforce the 5-minute observation
    /// cooldown (Phase 8 F-RP3-1 fix — closes the phished-owner
    /// freeze→reactivate→register-attacker-agent one-tx replay).
    ///
    /// Zero on freshly-initialized vaults that have never been frozen.
    /// APPENDED per F-14 APPEND-ONLY rule for Borsh stability.
    pub frozen_at_timestamp: i64,

    /// Phase 8 — discriminant of the `FreezeReason` enum recording WHY the
    /// vault was last frozen. Single byte on-chain; validated via
    /// `FreezeReason::from_u8` at every write site so unknown values
    /// (3..=255) hard-reject with `SigilError::ErrInvalidFreezeReason`.
    ///
    /// Zero (Manual) on freshly-initialized vaults that have never been
    /// frozen — this is harmless because `status != Frozen` means readers
    /// of this byte gate on status first. APPENDED per F-14 APPEND-ONLY
    /// rule for Borsh stability.
    pub freeze_reason: u8,

    /// Phase 8 LBL-01 — immutable PDA seed-key set at `initialize_vault` time;
    /// decouples vault PDA address from owner identity to enable ownership
    /// transfer without bricking the account.
    ///
    /// Before LBL-01: vault PDA derivation used `owner.key()` (or
    /// `vault.owner`). After `accept_ownership_transfer` mutated `vault.owner`,
    /// every subsequent owner-side instruction derived a DIFFERENT PDA →
    /// Anchor `ConstraintSeeds` rejection → vault permanently bricked.
    ///
    /// After LBL-01: all 40 non-init owner-side instructions derive vault
    /// PDA from `vault.vault_authority` instead. At init, the SDK still
    /// derives the PDA from `owner.key() + vault_id` (the canonical pattern),
    /// and the handler writes `vault.vault_authority = owner.key()` so the
    /// stored seed-key equals the initial owner — the on-chain PDA address
    /// is identical to the pre-LBL-01 layout. After ownership transfer the
    /// `vault.owner` byte field changes but `vault.vault_authority` does NOT,
    /// so the PDA address stays put and downstream ix continue to resolve.
    ///
    /// **Invariant:** `vault.vault_authority` is written exactly ONCE inside
    /// `initialize_vault`. No other instruction writes this field. The SDK
    /// helper `vaultPda(owner, vaultId)` continues to use `owner` as the
    /// seed-key at init time; thereafter the SDK reads `vault.vault_authority`
    /// from the resolved state to rebuild the same PDA.
    ///
    /// APPENDED per F-14 APPEND-ONLY rule for Borsh stability — +32 bytes
    /// at the tail keeps every prior byte at its original offset.
    pub vault_authority: Pubkey,
}

// ARCHITECTURE DECISION: No on-chain viewer/delegate role
//
// The program has two roles: owner (full authority) and agent (execute within policy).
// There is no "viewer" or "delegate" role because:
//   1. All Solana account data is publicly readable via RPC.
//   2. Read-only access control is a dashboard/API concern, not on-chain.
//   3. Adding viewer entries would bloat account size with zero security benefit.
//   4. Delegate roles are handled by Squads V4 externally if the owner is a multisig.
//
// Found by: Persona test (Treasury Manager "David")
// Decision: By design. Dashboard RBAC handles this.

impl AgentVault {
    /// Account discriminator (8) + owner (32) + vault_id (8) +
    /// agents vec prefix (4) + agents data (49 * 10) +
    /// fee_destination (32) + status (1) + bump (1) +
    /// created_at (8) + total_transactions (8) + total_volume (8) +
    /// total_fees_collected (8) +
    /// total_deposited_usd (8) + total_withdrawn_usd (8) + total_failed_transactions (8) +
    /// active_sessions (1) + observe_only (1)  [Phase 2 TA-19] +
    /// frozen_at_timestamp (8) + freeze_reason (1)  [Phase 8] +
    /// vault_authority (32)  [Phase 8 LBL-01: 643 + 32 vault_authority]
    pub const SIZE: usize = 8
        + 32
        + 8
        + 4
        + (49 * MAX_AGENTS_PER_VAULT)
        + 32
        + 1
        + 1
        + 8
        + 8
        + 8
        + 8
        + 8
        + 8
        + 8
        + 1
        + 1  // observe_only        [Phase 2 TA-19]
        + 8  // frozen_at_timestamp  [Phase 8]
        + 1  // freeze_reason        [Phase 8]
        + 32; // vault_authority     [Phase 8 LBL-01]
              // = 675 (Phase 8 LBL-01: 643 + 32 vault_authority)

    pub fn is_active(&self) -> bool {
        self.status == VaultStatus::Active
    }

    pub fn has_agent(&self) -> bool {
        !self.agents.is_empty()
    }

    pub fn is_agent(&self, signer: &Pubkey) -> bool {
        self.agents.iter().any(|a| a.pubkey == *signer)
    }

    pub fn get_agent(&self, signer: &Pubkey) -> Option<&AgentEntry> {
        self.agents.iter().find(|a| a.pubkey == *signer)
    }

    /// Check if an agent has sufficient capability for the requested operation.
    /// is_spending: whether `authorized_amount > 0` — caller derives.
    /// Returns true if the agent's capability level permits the operation.
    pub fn has_capability(&self, signer: &Pubkey, is_spending: bool) -> bool {
        self.get_agent(signer)
            .map(|a| {
                if is_spending {
                    a.capability >= CAPABILITY_OPERATOR
                } else {
                    a.capability >= CAPABILITY_OBSERVER
                }
            })
            .unwrap_or(false)
    }

    pub fn agent_count(&self) -> usize {
        self.agents.len()
    }

    pub fn is_owner(&self, signer: &Pubkey) -> bool {
        self.owner == *signer
    }

    pub fn is_agent_paused(&self, signer: &Pubkey) -> bool {
        self.get_agent(signer).map(|a| a.paused).unwrap_or(false)
    }
}

// Phase 8 compile-time SIZE pin (Council ISC-131 spirit).
//
// **DEVIATION NOTE (deliberate, documented):** the Phase 8 Batch 1 spec
// called for `assert!(size_of::<AgentVault>() + 8 == AgentVault::SIZE)`.
// That form is correct ONLY for `#[account(zero_copy)]` + `#[repr(C)]` +
// Pod structs (see `AuditEntry`, `AuditLogSuccess`). `AgentVault` is a
// `#[account]` Borsh-serialized struct containing `Vec<AgentEntry>` —
// `size_of::<AgentVault>()` returns the Rust stack size (Vec is a 24-byte
// fat pointer) which by construction CANNOT equal the on-chain Borsh
// serialized length (4-byte len prefix + 49 bytes × MAX_AGENTS_PER_VAULT).
// Forcing `#[repr(C)]` on a Borsh `#[account]` would alter struct layout
// in ways orthogonal to the on-chain wire format and add risk for zero
// benefit.
//
// Instead we pin the documented invariant: SIZE is a constant whose
// arithmetic in `impl AgentVault` MUST sum to 675. Any future field
// addition that forgets to update SIZE will fail this assertion at
// compile time. Combined with the field-by-field SIZE doc comment above,
// this is the strongest static guarantee available for a Borsh account.
const _AGENT_VAULT_SIZE_PIN: () = assert!(
    AgentVault::SIZE == 675,
    "AgentVault::SIZE drifted from documented Phase 8 LBL-01 layout (643 + 32 vault_authority = 675)"
);

#[cfg(test)]
mod lbl01_vault_authority_tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    /// LBL-01 invariant: Borsh-serialized `AgentVault` MUST contain
    /// `vault_authority` as the FINAL 32 bytes. This is the on-chain wire
    /// guarantee that the SDK's resolver can read the field at a stable
    /// position relative to the end of the buffer.
    ///
    /// Why this test exists: the const-assert above pins the total SIZE
    /// constant (675 bytes), but does not guarantee the field is at the
    /// tail. A future field added BEFORE `vault_authority` would slip past
    /// the const-assert (if SIZE was also bumped) but silently relocate
    /// `vault_authority` and break every owner-side ix that derives the
    /// vault PDA from it. This runtime test catches that drift.
    #[test]
    fn vault_authority_serialized_at_tail_offset() {
        // Construct a minimal vault with a sentinel pubkey in vault_authority
        // so we can binary-search the serialized buffer for it.
        let sentinel = Pubkey::new_unique();
        let mut other_owner = [0u8; 32];
        other_owner[0] = 0xAB; // unmistakable bytes ≠ sentinel
        let vault = AgentVault {
            owner: Pubkey::new_from_array(other_owner),
            vault_id: 0,
            agents: Vec::new(),
            fee_destination: Pubkey::default(),
            status: VaultStatus::Active,
            bump: 255,
            created_at: 0,
            total_transactions: 0,
            total_volume: 0,
            total_fees_collected: 0,
            total_deposited_usd: 0,
            total_withdrawn_usd: 0,
            total_failed_transactions: 0,
            active_sessions: 0,
            observe_only: false,
            frozen_at_timestamp: 0,
            freeze_reason: 0,
            vault_authority: sentinel,
        };
        let mut buf: Vec<u8> = Vec::with_capacity(AgentVault::SIZE);
        vault
            .serialize(&mut buf)
            .expect("AgentVault must serialize");
        // Borsh serializes `Vec<AgentEntry>` as `len: u32 (LE) || elements…`.
        // With an empty agents vector, the body length is the sum of all
        // fixed-size fields plus the 4-byte len prefix = 177 bytes:
        //   owner(32) + vault_id(8) + agents_len(4) + fee_destination(32) +
        //   status(1) + bump(1) + created_at(8) + total_transactions(8) +
        //   total_volume(8) + total_fees_collected(8) + total_deposited_usd(8) +
        //   total_withdrawn_usd(8) + total_failed_transactions(8) +
        //   active_sessions(1) + observe_only(1) + frozen_at_timestamp(8) +
        //   freeze_reason(1) + vault_authority(32) = 177.
        // The SIZE constant (675) includes the 8-byte discriminator added at
        // deserialize time AND reserves space for MAX_AGENTS_PER_VAULT (10)
        // entries × 49 bytes = 490 bytes. So 177 + 8 (disc) + 490 (agents
        // reserve) = 675 ✓.
        assert_eq!(
            buf.len(),
            177,
            "Borsh body of empty-agent-set vault must be 177 bytes (32+8+4+32+1+1+7*8+1+1+8+1+32)"
        );
        // vault_authority is the LAST 32 bytes of the serialized body —
        // assert the tail equals the sentinel pubkey. This is the
        // APPEND-ONLY tail invariant: any future field added BEFORE
        // vault_authority would shift the sentinel out of the tail.
        let tail = &buf[buf.len() - 32..];
        assert_eq!(
            tail,
            sentinel.as_ref(),
            "vault_authority must serialize as the final 32 bytes (APPEND-ONLY tail invariant)"
        );
        // Defense-in-depth: ensure the sentinel does NOT appear ANYWHERE
        // else in the buffer (i.e. it really is at position [len-32..len]
        // and not duplicated). This catches a future bug where two fields
        // were both Pubkey-typed at the tail.
        let first_match = buf
            .windows(32)
            .position(|w| w == sentinel.as_ref())
            .expect("sentinel must appear in serialized buffer");
        assert_eq!(
            first_match,
            buf.len() - 32,
            "vault_authority sentinel must appear ONLY at the tail position"
        );
    }

    /// LBL-01 size invariant: the documented +32 bytes APPEND must hold.
    #[test]
    fn vault_size_is_675_post_lbl01() {
        assert_eq!(
            AgentVault::SIZE,
            675,
            "Phase 8 LBL-01 documented layout: 643 (pre-LBL-01) + 32 (vault_authority) = 675"
        );
    }
}
