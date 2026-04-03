# Sigil: On-Chain Guardrails for AI Agents on Solana

## Project Overview

Sigil is the OpenZeppelin for AI agents on Solana. Import it, and your agent is secure by default. Three lines of code. No vault deposits. No PDA management. Just `shield(wallet)` and ship.

**The core problem:** Every AI agent on Solana today operates with unrestricted wallet access. The Solana Agent Kit gives agents raw keypair signing authority with zero spending limits, asset restrictions, or kill switches. There is no way for an agent owner to say "this agent can spend up to 500 USDC/day on Jupiter swaps and Flash Trade perps, nothing else." Sigil solves this.

**Solution:**

- **Primary API (`@usesigil/kit`):** One call gives you full protection — client-side fast deny, TEE key custody, and on-chain vault enforcement bundled as one product.
  ```typescript
  import { seal, SigilClient } from '@usesigil/kit';
  // seal() sandwiches any DeFi instruction with authorization + finalization
  // SigilClient wraps seal() with stateful vault/agent context
  ```

- **Client-side only (`shieldWallet()`):** For development/testing. Wraps any wallet with spending controls, protocol allowlists, and rate limiting. Zero on-chain overhead.

- **On-Chain Vault (`inscribe()`):** For power users. Adds on-chain enforcement to an existing shielded wallet.

---

## Architecture Overview

### System Design

```
┌─────────────────────────────────────────────────────┐
│                   AGENT OWNER                        │
│         (Human or DAO multisig via Squads)           │
│                                                      │
│  - Creates vault & sets policies                     │
│  - Registers agent signing keys                      │
│  - Can revoke/freeze at any time                     │
│  - Withdraws funds                                   │
└──────────────────────┬──────────────────────────────┘
                       │ owner authority
                       ▼
┌─────────────────────────────────────────────────────┐
│              SIGIL PROGRAM                     │
│          (On-chain Anchor Program)                   │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ AgentVault  │  │ PolicyConfig │  │ SpendTracker│ │
│  │   (PDA)     │  │   (PDA)      │  │   (PDA)    │ │
│  │             │  │              │  │            │ │
│  │ - Holds     │  │ - Daily cap  │  │ - Rolling  │ │
│  │   funds     │  │ - Asset list │  │   totals   │ │
│  │ - Owner     │  │ - Protocol   │  │ - Tx log   │ │
│  │   pubkey    │  │   whitelist  │  │ - Timestamps│ │
│  │ - Agent     │  │ - Max size   │  │            │ │
│  │   pubkey    │  │ - Leverage   │  │            │ │
│  │ - Status    │  │   limits     │  │            │ │
│  └─────────────┘  └──────────────┘  └────────────┘ │
│                                                      │
│  Instructions:                                       │
│  - initialize_vault                                  │
│  - register_agent                                    │
│  - update_policy                                     │
│  - execute_permitted_action (permission check)       │
│  - revoke_agent (kill switch)                        │
│  - withdraw_funds                                    │
│  - close_vault                                       │
└──────────────────────┬──────────────────────────────┘
                       │ validated transactions
                       ▼
┌─────────────────────────────────────────────────────┐
│              DEFI PROTOCOL LAYER                     │
│                                                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ Jupiter  │  │Flash Trade│  │  Drift / Kamino  │ │
│  │  Swaps   │  │   Perps   │  │  (Future phases) │ │
│  └──────────┘  └───────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Critical Solana Constraint: CPI Depth Limit

Solana enforces a **4-level CPI (Cross-Program Invocation) depth limit**. A naive implementation where Sigil wraps DeFi calls inside permission-checking CPIs would quickly exhaust this limit:

```
Sigil CPI → Jupiter CPI → Raydium CPI → Token Program = 4 levels (MAX)
```

**Solution: Instruction Composition Pattern**

Instead of nested CPI wrapping, Sigil uses **multi-instruction atomic transactions**:

```
Transaction {
  Instruction 1: Sigil::validate_and_authorize
    - Checks all policy constraints
    - Updates spend tracker
    - Sets "session_authorized" flag in a SessionPDA
    - Emits audit event
  
  Instruction 2: Jupiter::swap (or FlashTrade::open_position, etc.)
    - Executes the actual DeFi operation
    - Sigil vault PDA is the token source/destination
    
  Instruction 3: Sigil::finalize_session
    - Verifies the DeFi operation completed
    - Clears session flag
    - Records final state in audit log
}
```

All instructions succeed or all revert (atomic). This sidesteps CPI depth limits entirely.

### Outcome-Based Spending Detection

Spending caps are enforced in `finalize_session` based on **actual stablecoin balance delta**, not declared intent:

1. `validate_and_authorize` snapshots the vault's stablecoin balance before the DeFi instruction executes
2. The DeFi instruction runs (swap, position open, etc.)
3. `finalize_session` reads the current balance, computes the delta, and enforces caps on the real outcome

This prevents under-declaration attacks — an agent cannot claim "$5 swap" and execute a $500 swap, because the cap check measures what actually happened. Standalone instructions (`agentTransfer`, `createEscrow`) retain inline cap checks since they don't use the compose pattern.

The `seal()` SDK function takes arbitrary DeFi instructions from any source (Jupiter API, Solana Agent Kit, GOAT SDK, MCP servers) and sandwiches them with `validate_and_authorize` + `finalize_session`. Sigil is a security wrapper, not a DeFi SDK.

### Compute Budget Considerations

| Operation | Estimated CU | Budget |
|-----------|-------------|--------|
| Permission validation | 5,000 - 15,000 | Comfortable |
| Jupiter swap | 400,000 - 800,000 | Tight |
| Flash Trade position | 200,000 - 400,000 | Comfortable |
| Full composed tx | 600,000 - 1,000,000 | Within 1.4M max |

Request compute budget increase to 1.4M CU at the start of every composed transaction via `ComputeBudgetInstruction::set_compute_unit_limit`.

---

## Account Structures

Nine PDA account types. See `programs/sigil/src/state/` for source.

### AgentVault

Seeds: `[b"vault", owner, vault_id]` — SIZE: 600 bytes

```rust
#[account]
pub struct AgentVault {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub agents: Vec<AgentEntry>,       // Up to 10 agents per vault
    pub fee_destination: Pubkey,
    pub status: VaultStatus,           // Active | Frozen | Closed
    pub bump: u8,
    pub created_at: i64,
    pub total_transactions: u64,
    pub total_volume: u64,
    pub open_positions: u8,
    pub total_fees_collected: u64,
    pub treasury_shard: u8,
}

pub struct AgentEntry {
    pub pubkey: Pubkey,            // 32 bytes
    pub permissions: u64,          // Bitmask for 21 ActionType variants
    pub spending_limit_usd: u64,   // 0 = no per-agent limit
}
```

### PolicyConfig

Seeds: `[b"policy", vault]` — SIZE: 731 bytes

```rust
#[account]
pub struct PolicyConfig {
    pub vault: Pubkey,
    pub daily_spending_cap_usd: u64,
    pub max_transaction_size_usd: u64,
    pub protocol_mode: u8,              // 0=all, 1=allowlist, 2=denylist
    pub protocols: Vec<Pubkey>,         // Max 10
    pub max_leverage_bps: u16,
    pub can_open_positions: bool,
    pub max_concurrent_positions: u8,
    pub developer_fee_rate: u16,        // Max 500 = 5 BPS
    pub max_slippage_bps: u16,          // Max 5000 = 50%
    pub timelock_duration: u64,
    pub allowed_destinations: Vec<Pubkey>, // Max 10
    pub has_constraints: bool,
    pub has_protocol_caps: bool,
    pub session_expiry_slots: u64,      // Default 20 slots (~8s)
    pub bump: u8,
}
```

### SpendTracker (Zero-Copy)

Seeds: `[b"tracker", vault]` — SIZE: 2,832 bytes

```rust
#[account(zero_copy)]
pub struct SpendTracker {
    pub vault: Pubkey,
    pub buckets: [EpochBucket; 144],                // 2,304 bytes
    pub protocol_counters: [ProtocolSpendCounter; 10], // 480 bytes
    pub bump: u8,
    pub _padding: [u8; 7],
}

#[zero_copy]
pub struct EpochBucket {
    pub epoch_id: i64,     // unix_timestamp / 600
    pub usd_amount: u64,   // Aggregate USD spent in epoch
}
// 16 bytes per bucket. 144 buckets × 10 min = 24h rolling window.

#[zero_copy]
pub struct ProtocolSpendCounter {
    pub protocol: [u8; 32],   // Protocol pubkey
    pub window_start: i64,
    pub window_spend: u64,
}
```

### SessionAuthority (Ephemeral)

Seeds: `[b"session", vault, agent]` — SIZE: 288 bytes

```rust
#[account]
pub struct SessionAuthority {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub authorized: bool,
    pub authorized_amount: u64,
    pub authorized_token: Pubkey,
    pub authorized_protocol: Pubkey,
    pub action_type: ActionType,
    pub expires_at_slot: u64,
    pub delegated: bool,
    pub delegation_token_account: Pubkey,
    pub protocol_fee: u64,
    pub developer_fee: u64,
    pub output_mint: Pubkey,
    pub stablecoin_balance_before: u64,
    pub bump: u8,
}
```

### PendingPolicyUpdate (Timelocked)

Seeds: `[b"pending_policy", vault]` — SIZE: 755 bytes

```rust
#[account]
pub struct PendingPolicyUpdate {
    pub vault: Pubkey,
    pub queued_at: i64,
    pub executes_at: i64,
    // All policy fields as Option<T> — only non-None fields are applied
    pub daily_spending_cap_usd: Option<u64>,
    pub max_transaction_amount_usd: Option<u64>,
    pub protocol_mode: Option<u8>,
    pub protocols: Option<Vec<Pubkey>>,
    pub max_leverage_bps: Option<u16>,
    pub can_open_positions: Option<bool>,
    pub max_concurrent_positions: Option<u8>,
    pub developer_fee_rate: Option<u16>,
    pub max_slippage_bps: Option<u16>,
    pub timelock_duration: Option<u64>,
    pub allowed_destinations: Option<Vec<Pubkey>>,
    pub session_expiry_slots: Option<u64>,
    pub bump: u8,
}
```

### EscrowDeposit

Seeds: `[b"escrow", source_vault, escrow_id]` — SIZE: 170 bytes

```rust
#[account]
pub struct EscrowDeposit {
    pub source_vault: Pubkey,
    pub destination_vault: Pubkey,
    pub escrow_id: u64,
    pub amount: u64,              // NET amount after fees
    pub token_mint: Pubkey,
    pub created_at: i64,
    pub expires_at: i64,
    pub status: EscrowStatus,     // Active | Settled | Refunded
    pub condition_hash: [u8; 32], // SHA-256 for conditional release
    pub bump: u8,
}
```

### InstructionConstraints

Seeds: `[b"constraints", vault]` — SIZE: 4,045 bytes

```rust
#[account]
pub struct InstructionConstraints {
    pub vault: Pubkey,
    pub entries: Vec<ConstraintEntry>,   // Max 10
    pub bump: u8,
}

pub struct ConstraintEntry {
    pub program_id: Pubkey,
    pub data_constraints: Vec<DataConstraint>,       // Max 5
    pub account_constraints: Vec<AccountConstraint>, // Max 5
}

pub struct DataConstraint {
    pub offset: u16,
    pub operator: ConstraintOperator,  // Eq | Ne | Gte | Lte
    pub value: Vec<u8>,                // Max 32 bytes
}

pub struct AccountConstraint {
    pub index: u8,
    pub expected: Pubkey,
}
```

### PendingConstraintsUpdate

Seeds: `[b"pending_constraints", vault]` — SIZE: 8,334 bytes

```rust
#[account]
pub struct PendingConstraintsUpdate {
    pub vault: Pubkey,
    pub entries: Vec<ConstraintEntry>,  // Max 10
    pub queued_at: i64,
    pub executes_at: i64,
    pub bump: u8,
}
```

### AgentSpendOverlay (Zero-Copy)

Seeds: `[b"agent_spend", vault]` — SIZE: 2,528 bytes

```rust
#[account(zero_copy)]
pub struct AgentSpendOverlay {
    pub vault: Pubkey,
    pub sync_epochs: [i64; 144],                     // 1,152 bytes
    pub entries: [AgentContributionEntry; 7],         // 8,288 bytes
    pub bump: u8,
    pub _padding: [u8; 7],
}

#[zero_copy]
pub struct AgentContributionEntry {
    pub agent: [u8; 32],              // Fixed-size for zero_copy
    pub contributions: [u64; 144],    // Per-epoch spend amounts
}
```

---

## Program Instructions

### 1. `initialize_vault`

**Signer:** Owner  
**Creates:** AgentVault PDA, PolicyConfig PDA, SpendTracker PDA  
**Seeds:** `[b"vault", owner.key().as_ref(), vault_id.to_le_bytes().as_ref()]`

Sets up a new agent vault with initial policy configuration. Takes 11 parameters: vaultId, dailyCap, maxTx, protocolMode (0=all, 1=allowlist, 2=denylist), protocols, maxLeverage, maxPositions, developerFeeRate (max 500 = 5 BPS), timelockDuration, allowedDestinations, and maxSlippageBps. Also requires `fee_destination` account. Does NOT deposit funds yet (separate instruction).

### 2. `deposit_funds`

**Signer:** Owner  
**Action:** Transfers SPL tokens from owner's token account into the vault's PDA-controlled token account.

### 3. `register_agent`

**Signer:** Owner
**Action:** Registers an agent to the vault with a permission bitmask and optional per-agent spending limit. Up to 10 agents per vault. Takes `agent_pubkey: Pubkey`, `permissions: u64` (bitmask of 21 ActionType bits), and `spending_limit_usd: u64` (0 = no per-agent limit, vault cap still applies). The agent key should be generated in a TEE (Turnkey/Privy) in production, but accepts any pubkey.

### 4. `update_policy`

**Signer:** Owner
**Required accounts:** PolicyConfig PDA (no tracker needed)
**Action:** Updates the PolicyConfig for a vault. Takes 11 optional parameters (same fields as initialize_vault, including maxSlippageBps). Only non-null fields are applied. Cannot be called by the agent. If vault has a timelock configured, use `queue_policy_update` instead.

### 5. `validate_and_authorize` (Core Permission Check)

**Signer:** Agent  
**Action:** The critical instruction. Validates the requested action against all policy constraints:

```
1. Check vault status is Active
2. Check signer matches registered agent
3. Check token via is_stablecoin_mint() or verify stablecoin output for non-stablecoin swaps
4. Check requested protocol is in allowed_protocols (protocolMode + protocols list)
5. Check transaction amount <= max_transaction_size
6. Calculate rolling 24h spend, check amount + rolling < daily_spending_cap
7. If perp action: check leverage <= max_leverage_bps
8. If opening position: check concurrent positions < max_concurrent_positions
9. If all pass: create SessionAuthority PDA with authorized=true
10. Update SpendTracker with new spend entry
11. Emit ActionAuthorized event via Anchor events
```

CPI guard rejects if called via CPI. Finalize guard verifies finalize_session follows in same transaction.

If any check fails, the instruction reverts with a descriptive error code. The entire composed transaction (including the DeFi operation in subsequent instructions) atomically reverts.

### 6. `finalize_session`

**Signer:** Agent (or can be permissionless/crank)
**Action:** Closes the SessionAuthority PDA after the DeFi operation completes. Updates `vault.total_fees_collected` with fees already collected during `validate_and_authorize`. Reclaims rent from the ephemeral SessionAuthority account. Emits `SessionFinalized` event. Note: fees are collected upfront in `validate_and_authorize` (non-bypassable), not in finalize.

### 7. `revoke_agent` (Kill Switch)

**Signer:** Owner  
**Action:** Immediately sets vault status to Frozen. All subsequent `validate_and_authorize` calls will fail. The owner can still withdraw funds via `withdraw_funds`.

### 8. `withdraw_funds`

**Signer:** Owner  
**Action:** Withdraws tokens from the vault back to the owner. Works in any vault status (Active or Frozen).

### 9. `reactivate_vault`

**Signer:** Owner  
**Action:** Sets vault status back to Active from Frozen. Optionally updates the agent key (to rotate compromised keys).

### 10. `close_vault`

**Signer:** Owner
**Action:** Withdraws all remaining funds and closes all PDAs, reclaiming rent. Vault must have no open positions.

### 11. `queue_policy_update`

**Signer:** Owner
**Action:** Queues a policy change for vaults that have `timelock_duration > 0`. Creates a `PendingPolicyUpdate` PDA with all proposed changes stored as `Option<T>`. The update becomes executable at `current_timestamp + timelock_duration`. Emits `PolicyChangeQueued` event.

### 12. `apply_pending_policy`

**Signer:** Owner
**Required accounts:** PolicyConfig PDA, PendingPolicyUpdate PDA
**Action:** Applies a queued policy change after the timelock period has expired (`current_timestamp >= executes_at`). Merges all non-None fields from `PendingPolicyUpdate` into the vault's `PolicyConfig`. Closes the `PendingPolicyUpdate` PDA and reclaims rent. Emits `PolicyChangeApplied` event.

### 13. `cancel_pending_policy`

**Signer:** Owner
**Action:** Cancels a queued policy change before it has been applied. Closes the `PendingPolicyUpdate` PDA and reclaims rent. Emits `PolicyChangeCancelled` event.

### 14. `agent_transfer`

**Signer:** Agent
**Action:** Transfers tokens from the vault to a destination address that is in the vault's `allowed_destinations` list. Stablecoin-only (USDC/USDT) — non-stablecoins rejected via is_stablecoin_mint check. The transfer amount is checked against the vault's spending caps (USD-denominated). Updates the `SpendTracker` with the transfer. Emits `AgentTransferExecuted` event.

### 15. `sync_positions`

**Signer:** Owner
**Action:** Corrects the vault's `open_positions` counter when it drifts from the actual Flash Trade state. Drift occurs when keepers execute trigger orders (TP/SL) or fill limit orders outside Sigil's session pattern. Owner provides the actual position count (verified client-side via `countFlashTradePositions()`). Emits `PositionsSynced` event.

### 16. `create_instruction_constraints`

**Signer:** Owner
**Action:** Creates an `InstructionConstraints` PDA with up to 10 `ConstraintEntry` items, each specifying a `program_id` and up to 5 data constraints + 5 account constraints. Sets `policy.has_constraints = true`. Enables byte-level instruction verification during `validate_and_authorize`.

### 17. `update_instruction_constraints`

**Signer:** Owner
**Action:** Replaces the entries in an existing `InstructionConstraints` PDA. If vault has a timelock, use `queue_constraints_update` instead.

### 18. `close_instruction_constraints`

**Signer:** Owner
**Action:** Closes the `InstructionConstraints` PDA and reclaims rent. Sets `policy.has_constraints = false`.

### 19. `queue_constraints_update`

**Signer:** Owner
**Action:** Queues a constraints change for vaults with `timelock_duration > 0`. Creates a `PendingConstraintsUpdate` PDA. The update becomes executable at `current_timestamp + timelock_duration`.

### 20. `apply_constraints_update`

**Signer:** Owner
**Action:** Applies a queued constraints change after the timelock period. Merges entries from `PendingConstraintsUpdate` into `InstructionConstraints`. Closes the pending PDA.

### 21. `cancel_constraints_update`

**Signer:** Owner
**Action:** Cancels a queued constraints change before it has been applied. Closes the `PendingConstraintsUpdate` PDA.

### 22. `update_agent_permissions`

**Signer:** Owner
**Action:** Updates an agent's permission bitmask and/or per-agent spending limit. Takes `agent_pubkey: Pubkey`, `new_permissions: u64`, `new_spending_limit_usd: u64`. Emits `AgentPermissionsUpdated` event.

### 23. `create_escrow`

**Signer:** Agent
**Action:** Creates an `EscrowDeposit` between two vaults. Transfers tokens from source vault to an escrow PDA. Takes `escrow_id`, `amount`, `expires_at`, and optional `condition_hash` (SHA-256 for conditional release). Max duration: 30 days. Spending caps and fees apply (escrow creation is a spending action).

### 24. `settle_escrow`

**Signer:** Destination vault owner or agent
**Action:** Claims escrowed funds. If `condition_hash` is set, requires matching `proof` bytes (SHA-256 verified). Transfers funds from escrow PDA to destination vault's token account. Sets status to `Settled`.

### 25. `refund_escrow`

**Signer:** Source vault owner
**Action:** Refunds escrowed funds after expiry (`current_timestamp >= expires_at`). Transfers funds back to source vault's token account. Sets status to `Refunded`.

### 26. `close_settled_escrow`

**Signer:** Source vault owner
**Action:** Closes a settled or refunded `EscrowDeposit` PDA and reclaims rent. Escrow must be in `Settled` or `Refunded` status.

---

## Error Codes

70 error variants (6000–6069) defined in `programs/sigil/src/errors.rs`. See `docs/ERROR-CODES.md` for the full reference table with categories.

**Categories:** Vault state (7), Access control (2), Stablecoin (2), Policy (5), Spending (1), Session (2), Fee (3), Validation (6), Timelock (3), Security (4), Integration (4), Multi-agent (4), Escrow (6), Constraints (8), Arithmetic (1).

---

## Events (Anchor Events for Indexing)

31 events defined in `programs/sigil/src/events.rs`. All events are emitted via `emit!()` and indexed off-chain via Helius webhooks.

| # | Event | Key Fields |
|---|-------|------------|
| 1 | VaultCreated | vault, owner, vault_id, timestamp |
| 2 | FundsDeposited | vault, token_mint, amount, timestamp |
| 3 | AgentRegistered | vault, agent, permissions, spending_limit_usd, timestamp |
| 4 | AgentSpendLimitChecked | vault, agent, agent_rolling_spend, spending_limit_usd, amount, timestamp |
| 5 | PolicyUpdated | vault, daily_cap_usd, max_transaction_size_usd, protocol_mode, protocols_count, max_leverage_bps, developer_fee_rate, max_slippage_bps, timestamp |
| 6 | ActionAuthorized | vault, agent, action_type, token_mint, amount, usd_amount, protocol, rolling_spend_usd_after, daily_cap_usd, delegated, timestamp |
| 7 | SessionFinalized | vault, agent, success, is_expired, timestamp |
| 8 | DelegationRevoked | vault, token_account, timestamp |
| 9 | AgentRevoked | vault, agent, remaining_agents, timestamp |
| 10 | VaultReactivated | vault, new_agent, new_agent_permissions, timestamp |
| 11 | FundsWithdrawn | vault, token_mint, amount, destination, timestamp |
| 12 | FeesCollected | vault, token_mint, protocol_fee_amount, developer_fee_amount, protocol_fee_rate, developer_fee_rate, transaction_amount, protocol_treasury, developer_fee_destination, cumulative_developer_fees, timestamp |
| 13 | VaultClosed | vault, owner, timestamp |
| 14 | PolicyChangeQueued | vault, executes_at |
| 15 | PolicyChangeApplied | vault, applied_at |
| 16 | PolicyChangeCancelled | vault |
| 17 | AgentTransferExecuted | vault, destination, amount, mint |
| 18 | AgentPermissionsUpdated | vault, agent, old_permissions, new_permissions |
| 19 | PositionsSynced | vault, old_count, new_count, timestamp |
| 20 | InstructionConstraintsCreated | vault, entries_count, timestamp |
| 21 | InstructionConstraintsUpdated | vault, entries_count, timestamp |
| 22 | InstructionConstraintsClosed | vault, timestamp |
| 23 | ConstraintsChangeQueued | vault, executes_at |
| 24 | ConstraintsChangeApplied | vault, applied_at |
| 25 | ConstraintsChangeCancelled | vault |
| 26 | EscrowCreated | source_vault, destination_vault, escrow_id, amount, token_mint, expires_at, condition_hash |
| 27 | EscrowSettled | source_vault, destination_vault, escrow_id, amount, settled_by |
| 28 | EscrowRefunded | source_vault, destination_vault, escrow_id, amount, refunded_by |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| On-chain program | Rust, Anchor framework |
| Program testing | Anchor test framework (TypeScript), Bankrun |
| SDK | TypeScript, @solana/web3.js, @coral-xyz/anchor |
| Agent integrations | TypeScript (MCP server, SDK) |
| Dashboard | React, TypeScript, TailwindCSS |
| RPC | Helius (dev: free tier, prod: Professional) |
| Indexing | Helius webhooks + custom event parser |
| CI/CD | GitHub Actions |
| Deployment | Anchor CLI → Solana devnet → mainnet-beta |

---

## File Structure

```
agent-middleware/
├── programs/
│   └── sigil/
│       └── src/
│           ├── lib.rs                         # Program entrypoint, 29 instruction handlers
│           ├── instructions/
│           │   ├── initialize_vault.rs
│           │   ├── deposit_funds.rs
│           │   ├── register_agent.rs
│           │   ├── update_policy.rs
│           │   ├── validate_and_authorize.rs
│           │   ├── finalize_session.rs
│           │   ├── revoke_agent.rs
│           │   ├── reactivate_vault.rs
│           │   ├── withdraw_funds.rs
│           │   ├── close_vault.rs
│           │   ├── queue_policy_update.rs
│           │   ├── apply_pending_policy.rs
│           │   ├── cancel_pending_policy.rs
│           │   ├── agent_transfer.rs
│           │   ├── sync_positions.rs
│           │   ├── create_instruction_constraints.rs
│           │   ├── update_instruction_constraints.rs
│           │   ├── close_instruction_constraints.rs
│           │   ├── queue_constraints_update.rs
│           │   ├── apply_constraints_update.rs
│           │   ├── cancel_constraints_update.rs
│           │   ├── update_agent_permissions.rs
│           │   ├── create_escrow.rs
│           │   ├── settle_escrow.rs
│           │   ├── refund_escrow.rs
│           │   ├── close_settled_escrow.rs
│           │   ├── integrations/              # DeFi-specific verifiers
│           │   │   ├── jupiter.rs
│           │   │   ├── jupiter_lend.rs
│           │   │   ├── flash_trade.rs
│           │   │   └── generic_constraints.rs
│           │   ├── utils.rs
│           │   └── mod.rs
│           ├── state/
│           │   ├── vault.rs                   # AgentVault PDA (634 bytes)
│           │   ├── policy.rs                  # PolicyConfig PDA (817 bytes)
│           │   ├── tracker.rs                 # SpendTracker PDA (2,840 bytes, zero-copy)
│           │   ├── session.rs                 # SessionAuthority PDA (288 bytes)
│           │   ├── pending_policy.rs          # PendingPolicyUpdate PDA (755 bytes)
│           │   ├── escrow.rs                  # EscrowDeposit PDA (170 bytes)
│           │   ├── constraints.rs             # InstructionConstraints PDA (8,318 bytes)
│           │   ├── pending_constraints.rs     # PendingConstraintsUpdate PDA (8,334 bytes)
│           │   ├── agent_spend_overlay.rs     # AgentSpendOverlay PDA (2,528 bytes, zero-copy)
│           │   └── mod.rs
│           ├── certora/                       # Formal verification specs
│           │   ├── specs/
│           │   │   ├── access_control.rs
│           │   │   ├── session_lifecycle.rs
│           │   │   └── spending_caps.rs
│           │   └── envs/
│           ├── errors.rs                      # 70 error codes (6000–6069)
│           └── events.rs                      # 31 Anchor events
├── tests/
│   ├── sigil.ts                              # Core on-chain tests (LiteSVM)
│   ├── escrow-integration.ts
│   ├── instruction-constraints.ts
│   ├── jupiter-integration.ts
│   ├── jupiter-lend-integration.ts
│   ├── flash-trade-integration.ts
│   ├── security-exploits.ts
│   ├── surfpool-integration.ts                # Surfnet tests
│   ├── devnet-*.ts                            # 8 devnet test suites
│   └── helpers/litesvm-setup.ts
├── sdk/
│   ├── kit/                                   # @usesigil/kit (full SDK + merged core policy engine)
│   ├── platform/                              # @usesigil/platform (Solana Actions provisioning)
│   └── custody/                               # @usesigil/custody (TEE adapters: crossmint, privy, turnkey)
│       └── src/{crossmint,privy,turnkey}/      # Subpath exports
├── packages/
│   └── plugins/                               # @usesigil/plugins (agent framework adapters)
│       └── src/sak/                           # Solana Agent Kit adapter (./sak subpath)
│           ├── status.ts
│           ├── discovery.ts
│           ├── fund.ts
│           ├── protection.ts
│           ├── escrow.ts
│           ├── emergency-close-auth.ts
│           └── sync-positions.ts
├── skills/
│   └── openclaw/                              # OpenClaw AI agent skill
├── api/                                       # Vercel serverless functions
├── certora/                                   # Formal verification config
├── Anchor.toml
├── Cargo.toml
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

## Key Design Decisions

1. **Multi-agent vaults with per-agent permissions.** Up to 10 agents per vault, each with a 21-bit permission bitmask and optional per-agent spending limit. Agents are stored as `Vec<AgentEntry>` on the vault. Per-agent spend tracking uses a zero-copy `AgentSpendOverlay` PDA (10 agent slots, no shards). The permission model is "agent constraints, not agent autonomy" — the owner defines what each agent CAN do, the program enforces it.

2. **Instruction composition over CPI wrapping.** Avoids the 4-level CPI depth limit. The trade-off is that the SDK must construct multi-instruction transactions, but this is straightforward in TypeScript.

3. **Rolling 24h window, not calendar-day.** Spending caps use a rolling window (current_timestamp - 86400 seconds) rather than resetting at midnight UTC. More intuitive and harder to game.

4. **On-chain spend tracking is bounded.** The SpendTracker uses a fixed 144-epoch circular buffer (zero-copy, 2,840 bytes). Each epoch covers 10 minutes; 144 epochs = 24 hours. Full transaction history is available via Anchor events indexed off-chain. This prevents unbounded account growth.

5. **SessionAuthority is ephemeral.** Created in `validate_and_authorize`, closed in `finalize_session`. If a session isn't finalized (tx partially fails), expired sessions can be cleaned up by anyone (permissionless crank) to reclaim rent.

6. **USD-denominated caps use stablecoin identity.** USDC and USDT amounts are treated as 1:1 USD (amount / 10^6 = USD). No oracles. This eliminates oracle risk (staleness, confidence intervals, manipulation) entirely. Hardcoded mint addresses (feature-flagged for devnet/mainnet) prevent spoofed stablecoins. Non-stablecoin swaps require a stablecoin output — the stablecoin leg is the measured USD spend.

7. **Non-custodial design.** The program never takes ownership of funds in a traditional custodial sense. Funds sit in PDAs derived from the vault, and only the owner can withdraw. The agent can only execute pre-approved DeFi operations through the vault.

8. **Stablecoin-only architecture (implemented).** The program enforces stablecoin-denominated spend tracking: all USD amounts use stablecoin identity (USDC/USDT amount / 10^6 = USD). Non-stablecoin swaps must route through a stablecoin output. This gives Sigil the only verifiably accurate on-chain USD spend tracking in the ecosystem — zero oracle risk, zero confidence interval, zero staleness.

9. **Protocol fees are collected at authorization (upfront, non-bypassable).** Fees are calculated and transferred during `validate_and_authorize`, before the DeFi instruction executes. If the DeFi instruction fails, the entire atomic transaction reverts (including the fee transfer). This ensures fees cannot be bypassed even if `finalize_session` is somehow skipped. The fee is deducted from the vault's token balance, keeping the fee transparent and predictable. Fee rate (`developer_fee_rate`) is stored in PolicyConfig so the owner can see it before depositing, and is capped at 500 (5 BPS = 0.05%) as a hardcoded safety limit.

10. **Fee destination is set at vault creation and is immutable per vault.** This prevents any instruction from redirecting fees to an attacker's account. The fee_destination should be a protocol-controlled treasury wallet, ideally a Squads multisig. All vaults created through the official SDK will have the same fee_destination hardcoded.

---

## Ecosystem Positioning

Sigil occupies **Layer 2.5: Permission Enforcement** in the Solana AI agent stack:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: Agent Frameworks                                  │
│  MCP-compatible clients, GOAT SDK, Rig, CrewAI             │
│  (Decision-making, LLM orchestration, tool discovery)       │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Agent Discovery & Interfaces                      │
│  MCP Servers, x402 Payments, Agent Registries               │
│  (How agents find and pay for services)                     │
├─────────────────────────────────────────────────────────────┤
│  Layer 2.5: Permission Enforcement ← SIGIL           │
│  PDA vaults, policy configs, spending caps, audit logs      │
│  (What agents are ALLOWED to do with funds)                 │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Identity & Trust                                  │
│  Visa Trusted Agent Protocol, Civic Gateway, DID providers  │
│  (Who the agent is, how trustworthy)                        │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: DeFi Execution                                    │
│  Jupiter, Drift, Flash Trade, Kamino, Raydium               │
│  (Actual swaps, perps, lending, LP)                         │
├─────────────────────────────────────────────────────────────┤
│  Layer 0: Solana Runtime                                    │
│  Validators, SVM, Token Program, Compute Units              │
└─────────────────────────────────────────────────────────────┘
```

Sigil is the **only protocol-level permission layer** between agent frameworks and DeFi execution. Identity protocols tell you WHO the agent is; Sigil enforces WHAT the agent can do. Agent frameworks make decisions; Sigil gates execution of those decisions.

---

## Competitive Landscape

### Hackathon-Era Projects

Five projects in the Colosseum Agent Hackathon (Feb 2-12, 2026, $100k USDC, 750+ projects, 454 submitted — an AI-agent-builds-projects hackathon where agents write code and humans configure) address overlapping problem spaces:

| Competitor | Approach | Votes | Sigil Edge |
|------------|----------|-------|------------------|
| **AgentWallet Protocol** | PDA wallets + spending policies + x402 | 49 (toly endorsement) | Deeper policy engine: per-token/per-protocol whitelists, leverage limits, rolling 24h windows, dual fee model, ephemeral sessions |
| **Claw** | NFT = spending authority (ERC-7978 on Solana) | — | NFTs are less expressive than policy configs; no protocol-specific constraints, no leverage limits |
| **SolSkill** | Privy custody + 45 DeFi endpoints, off-chain SaaS | 96 | Not a Solana primitive — centralized trust model, no on-chain enforcement |
| **WUNDERLAND** | Dual-key architecture, 34 instructions, social network | — | Not focused on DeFi middleware; social features add attack surface |
| **AgentPay** | API-layer spending limits | — | Off-chain enforcement only — can be bypassed by crafting raw transactions |

### Industry Competitors

Ten established or well-funded projects fill overlapping parts of the agent permission stack. Each leaves gaps that Sigil fills.

| Competitor | What They Do | Their Gap (What Sigil Fills) |
|------------|-------------|-----------------------------------|
| **Coinbase Agentic Wallets** (Feb 11, 2026) | EVM + Solana agent wallets with 9 Solana policy criteria (programId, solData with IDL upload), KYT/OFAC sanctions screening. `netUSDChange` tracking on EVM only (NOT Solana). All enforcement off-chain/server-side. AgentKit supports LangChain, Vercel AI, OpenAI Agents SDK. | No protocol-specific policies (per-token/per-protocol whitelists), no leverage limits, no ephemeral session pattern, no on-chain audit trail. `netUSDChange` not available on Solana. Centralized custody — keys live in Coinbase infrastructure. KYT/OFAC is a unique differentiator Sigil lacks. |
| **GLAM Systems** | Multi-program architecture (8+ programs) with CPI proxy pattern. ~50 distinct on-chain permissions across 14 protocol integrations (Drift, Kamino, Marinade, Sanctum, Jupiter, CCTP). Per-signer per-token TransferTracker with calendar period resets (Day/Week/Month). Integration-specific policies (JupiterSwapPolicy, DriftProtocolPolicy). NAV/tokenization support. Multi-language SDKs + CLI. Closed-source Rust. | Asset management focused (NAV-oriented), not agent middleware. Calendar-day resets (not rolling 24h). No USD-aggregate spending caps (per-token amounts only). No ephemeral session pattern. No SDK plugins for agent frameworks (ElizaOS, Solana Agent Kit). No x402. No MCP server. CPI proxy limited by 4-level depth. |
| **Squads v4/v5** | SpendingLimitV2 with Custom period types and accumulation mode. Hooks system: pre/post CPI calls to external programs (extensibility mechanism). ProgramInteractionPolicy with DataConstraint for byte-level instruction introspection. 27 instruction handlers. Smart Account Program v0.1 live since March 2025. SPN announced but NOT live — still pre-launch/pre-testnet as of Feb 2026. | No agent-specific features: no session authority, no rolling 24h USD windows, no leverage limits, no position tracking, no oracle integration, no USD spend caps. Calendar-period resets. SPN will be general-purpose co-signer network, not DeFi-specific. No agent framework plugins. Hooks system is an extensibility gap Sigil should monitor. |
| **Turnkey** | TEE-based (AWS Nitro Enclaves) policy enforcement with JSON policy language (`sol.tx` namespace). IDL upload for program-specific instruction inspection. Per-transaction evaluation only — stateless, NO cumulative spending limits despite marketing claims. QuorumOS open-sourced. 50-100ms signing speed. Multi-chain. | No cumulative spend tracking — evaluates each tx in isolation (no rolling windows). No USD conversion (listed as future work). Top-level transfers only (CPI transfers excluded). No DeFi-specific policies. No on-chain enforcement. |
| **Privy** | 2-of-2 Shamir + TEE key custody. Default-deny policy engine with programId filtering, SOL/SPL limits, time windows on Solana. Has MCP server (`@privy-io/mcp-server`), OpenClaw skill, and x402 integration. Off-chain enforcement (enclave-based). | Off-chain only — no on-chain audit trail, no verifiable enforcement. No leverage limits, no position tracking, no protocol-specific sub-policies, no DeFi-specific constraints. Agent framework tooling (MCP, OpenClaw) directly competes with Sigil's distribution channels. |
| **Crossmint** | Dual-key (owner + agent in TEE). Uses Squads API on Solana. GOAT SDK integration (250+ actions, 40+ chains). Confirmed x402 support. Building with SPN for conditional signing. | Custody-focused. Policy enforcement depends on SPN (not yet live). No standalone DeFi policy engine. GOAT SDK breadth is wide but shallow — no DeFi-specific enforcement. |
| **ClawPay / Lobster.cash** (Crossmint + Visa + Circle, Feb 13, 2026) | Agent payments using Visa Trusted Agent Protocol. Agents pay for goods/services via Visa rails. | Payments-focused, not DeFi execution. No policy engine for swaps/perps/leverage. Doesn't enforce what agents do with DeFi protocols. |
| **LIT Protocol / Vincent** | Distributed Key Generation (DKG/MPC + TEE). Immutable IPFS-published Lit Actions. Has MCP server (`@lit-protocol/vincent-mcp-server`). 7,000+ Vincent Agent Wallets. DeFi abilities are EVM-only (Morpho, Aave, Uniswap, deBridge). **Solana NOT yet live** — EdDSA PKPs planned for v1. | General-purpose programmable signing, not DeFi-specific. No pre-built spending caps, leverage limits, or protocol policies. Each policy must be hand-coded as a Lit Action. Solana support not yet shipped — EVM-first. |
| **CloakedAgent** | Solana-native agent wallets with ZK privacy mode (Noir circuits, Barretenberg/UltraHonk, Sunspot Groth16). Per-tx, daily, and lifetime spending limits. Expiration timestamps on agent authority. | No oracle integration, no USD-denominated caps, no protocol-specific restrictions, no leverage limits, no position tracking. ZK privacy is a genuinely unique feature. Lifetime caps and agent expiration are simple features Sigil should adopt. |
| **Rain** | Visa Principal Member with native Solana + USDC settlement. B2B card issuing API. Multi-chain support. | Card/fiat offramp focused, not DeFi execution. No on-chain policy enforcement. Best potential offramp integration partner for Sigil. |

**Framing:** These fill different parts of a 5-layer stack:

```
Layer 5: Agent Commerce    — x402 (75M+ txs, $24M+ volume), Google AP2/UCP (20+ partners),
                             OpenAI ACP, Visa TAP, Skyfire/KYAPay, Mastercard Agent Pay (Q2 2026)
Layer 4: Policy Enforcement — Sigil ← WE ARE HERE (only on-chain DeFi-specific)
Layer 3: Key Custody       — Turnkey, Privy, Crossmint, Coinbase, LIT/Vincent
Layer 2: Smart Accounts    — Squads v4/v5, GLAM, CloakedAgent, GnosisPay Safe modules
Layer 1: DeFi Execution    — Jupiter, Flash Trade, Drift, Kamino
```

Coinbase/Privy/Turnkey protect keys (Layer 3). Squads gates multisig execution (Layer 2). ClawPay/x402 handle commerce (Layer 5). Sigil fills the gap at Layer 4 — **on-chain DeFi-specific policy enforcement** that none of these provide. The dual-layer model (custody + policy) makes Sigil complementary to every custody provider.

**Key competitive threats to watch:**
- **Crossmint + Squads SPN**: When SPN launches, Crossmint will have conditional co-signing with policy enforcement. But SPN is general-purpose — Sigil's DeFi-specific policies (leverage, positions, protocol whitelists) are deeper.
- **GLAM pivoting to agents**: GLAM's permission model is the closest architectural match (14 integrations, ~50 permissions). If they add agent framework plugins, USD-aggregate caps, and rolling windows, they become a direct competitor.
- **Privy expanding agent tooling**: Privy now has MCP server, OpenClaw skill, and x402 — directly competing for the same distribution channels (MCP, agent frameworks). Their off-chain enforcement is weaker but the developer experience is polished.
- **Sendai Kit adding security**: If Solana Agent Kit adds built-in security primitives, the plugin distribution channel narrows.
- **CloakedAgent's ZK privacy**: Privacy-preserving agent wallets are a genuinely novel angle. If ZK privacy becomes a market requirement, Sigil would need to add a privacy mode.
- **Google UCP + AP2 ecosystem**: Google's Universal Commerce Protocol has 20+ partners (Shopify, Walmart, Visa, Mastercard). AP2 + x402 integration confirmed (`google-agentic-commerce/a2a-x402`). Sigil must support AP2 Intent Mandates to participate in this ecosystem.

---

## What ONLY Sigil Does

Ten capabilities that no competitor (hackathon or industry) currently offers:

1. **Atomic DeFi-specific enforcement** — validate + DeFi + finalize in one transaction. Not just spending caps, but per-protocol/per-token/per-action policies enforced atomically. If the policy check fails, the DeFi operation never executes. GLAM has integration-specific policies but uses CPI wrapping (depth-limited). Squads has spending limits but no DeFi-specific constraints.

2. **Leverage and position tracking** — No competitor tracks open positions or enforces leverage limits on-chain. Sigil's PolicyConfig stores `max_leverage_bps` and `max_concurrent_positions`, and the program increments/decrements position counts during finalize. Position reconciliation (Phase L) handles keeper-executed orders that bypass the session pattern.

3. **Ephemeral session authority** — Prevents replay attacks with a 20-slot expiry SessionAuthority PDA. Created during validate, closed during finalize. Expired sessions can be cleaned up by anyone (permissionless crank). CPI guard (Phase L) prevents wrapping attacks. No one else has this pattern.

4. **Multi-protocol composition** — The same vault enforces policies across Jupiter, Flash Trade, Drift, and future protocols. Policies aren't siloed per protocol — one daily cap, one token whitelist, one leverage limit applies across all DeFi operations.

5. **On-chain audit trail** — Every action produces Anchor events (`ActionAuthorized`, `FeesCollected`, etc.). The SpendTracker provides a rolling 24h spend total via a 144-epoch circular buffer. Full event history enables regulatory-grade compliance data that custody providers and off-chain enforcers don't generate.

6. **Rolling 24h spending windows** — Spending caps use `current_timestamp - 86400` (rolling), not calendar-day, not session-based. This is harder to game than midnight-reset caps or per-session limits. Squads uses calendar-period resets. Turnkey evaluates per-transaction only (no cumulative tracking). Coinbase tracks cumulatively but off-chain only.

7. **Risk-reducing actions are cap-exempt by design** — ClosePosition, DecreasePosition, and RemoveCollateral never count against spending caps because they reduce risk exposure rather than increase it. This eliminates the "cap vs. risk management" dilemma entirely — agents can always close losing positions regardless of daily cap usage. A more granular emergency close authorization mechanism (time-limited owner-granted exemptions) is planned for a future redesign.

8. **Stablecoin-only verifiable spend tracking** — By enforcing stablecoin identity (USDC/USDT = 1:1 USD), Sigil achieves zero-oracle-risk USD spend tracking. No confidence intervals, no staleness, no price manipulation vectors. The stablecoin amount IS the spend amount. Non-stablecoin swaps require stablecoin output for measurement. No competitor has this — they all either skip USD tracking entirely or depend on oracles.

9. **Agent framework ecosystem coverage** — MCP server (49 tools) as universal integration surface. MCP is the industry-standard protocol for AI tool integration, covering Claude, Cursor, VS Code, Windsurf, and any MCP-compatible agent. No per-framework plugins needed — MCP provides framework-agnostic access to all Sigil capabilities.

10. **Server-side x402 paywall (Phase O.1)** — Sigil is the only system designed to both SEND and RECEIVE x402 payments with policy enforcement on both sides. `shieldedFetch()` handles the client side; the planned `@usesigil/paywall` middleware handles the server side — enabling developers to monetize their AI agent APIs with built-in spending controls.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **SIMD-0268 (CPI depth 4→8)** | Weakens "CPI depth limit" as architectural justification for instruction composition. | Reframe: instruction composition was chosen for flexibility, composability, and zero coupling — not just CPI limits. DeFi protocols don't need to know about Sigil. When SIMD-0268 activates, our pattern remains superior because any new DeFi integration requires only SDK changes, no program changes. The validate/execute/finalize separation also provides clean audit boundaries. |
| **Cold start / adoption** | No users without integrations, no integrations without users. | Mitigate via custody provider integration (Coinbase/Privy users get Sigil policies on top of their existing custody) and MCP server as the universal integration surface (vibe-coding onramp, framework-agnostic access). |
| **Fork risk** | Open-source program can be forked by competitors. | Mitigate via on-chain reputation scores (can't fork reputation data accrued over time), DeFi protocol partnerships (recognized sessions for fee discounts), and MCP server as the standard integration surface (network effects from tooling ecosystem). |
| **"Off-chain is good enough"** | Most agent builders may not care about on-chain enforcement. | Target the 20% that needs provable enforcement: institutional, regulated, high-value deployments. These users pay more and are stickier. The compliance audit trail is the killer feature for this segment. |

---

## Defensibility Strategy

Five moats that compound over time:

1. **Aggregate custody providers** — Work WITH Coinbase/Privy/Turnkey, not against them. "They protect keys, we enforce DeFi policies." The dual-layer model (custody + policy) makes Sigil complementary to every custody provider. Phase 6.7.

2. **MCP as universal integration surface** — The `@usesigil/mcp (planned)` server (49 tools) provides framework-agnostic access to all Sigil capabilities via the industry-standard Model Context Protocol. Any MCP-compatible agent (Claude, Cursor, VS Code, Windsurf, custom agents) gets Sigil integration without per-framework plugins.

3. **On-chain reputation network** — Vaults operating within policy for N days earn a verifiable on-chain reputation score stored in a PDA. Higher reputation → higher spending caps from DeFi protocol partners. Creates switching cost: leave Sigil = lose reputation history.

4. **DeFi protocol partnerships** — Get Jupiter/Drift to recognize Sigil sessions for fee discounts or priority routing. Protocols benefit from guaranteed-policy-compliant flow. This creates a flywheel: more protocols → more agents → more volume → more protocol interest.

5. **Audit standard** — Make Sigil's Anchor event format the standard that compliance tools accept. If regulators ask "show me your agent's trading history," Sigil events are the answer. First-mover advantage in defining the standard.

---

## Distribution Strategy (Ranked by ROI)

### Tier 1: High-Impact, Low-Effort

| Channel | Action | Expected Impact |
|---------|--------|-----------------|
| **awesome-mcp-servers** (81K stars) | PR to add `@usesigil/mcp (planned)` under Finance/Blockchain | High discovery — largest MCP directory |
| **mcp.so** (MCP Registry) | Submit via website form | Official MCP registry |
| **PulseMCP** | Submit via directory | Growing MCP aggregator |
| **Glama.ai** | Submit via MCP marketplace | Enterprise-focused MCP discovery |
| **GitHub repo optimization** | Set description, topics, social preview | SEO for organic discovery |
| **npm keyword optimization** | Add keywords to all 8 packages | npm search visibility |

### Tier 2: Ecosystem Integration

| Channel | Action | Expected Impact |
|---------|--------|-----------------|
| **awesome-solana** (2K stars) | PR under Security/Infrastructure | Solana developer discovery |
| **solana.com/ecosystem** | Submit via ecosystem portal | Official Solana ecosystem listing |
| **MCP ecosystem directories** | Submit to additional MCP registries as they emerge | Expanding MCP integration surface |

### Tier 3: Content & Awareness

| Channel | Action | Expected Impact |
|---------|--------|-----------------|
| **Technical blog post** | "How to add spending limits to your Solana AI agent in 3 lines" | Developer education |
| **Demo video** | MCP server demo with Claude Desktop | Visual proof of concept |
| **Twitter/X thread** | Architecture overview + competitive comparison | Community awareness |

---

## Key Metrics to Track Post-Launch

| Metric | Target (90 days) |
|--------|-----------------|
| npm weekly downloads (all packages) | 500+ |
| GitHub stars | 200+ |
| Vaults created on devnet | 50+ |
| MCP directory listings | 4 (mcp.so, PulseMCP, Glama, awesome-mcp-servers) |
| MCP ecosystem PRs merged | 2+ (awesome-mcp-servers, mcp.so) |
| Agent framework integrations via MCP | 3+ (Claude, Cursor, custom agents) |

---

## Integration Targets

Top trading agent projects from the Colosseum hackathon that execute DeFi trades and need permission guardrails — natural first SDK customers:

| Project | Description | Votes | Integration Opportunity |
|---------|-------------|-------|------------------------|
| **DeFi Risk Guardian** | Monitors lending positions, simulates and executes repay/rebalance actions | 668 (#1) | Gate execution of repay/rebalance actions through Sigil vaults with per-protocol policies |
| **SIDEX** | Autonomous perpetual trading via Llama 3, executes on Jupiter/Drift | 646 (#2) | Wrap Jupiter/Drift calls with spending limits and leverage caps |
| **Super Router** | Multi-agent Jupiter trading with strategy composition | 144 (#13) | Permission layer between individual agents and Jupiter execution |
| **SolSkill** | DeFi execution layer with 45 endpoints, Privy custody | 96 (#18) | Replace off-chain Privy enforcement with on-chain Sigil vaults |
| **CrewDegen Arena** | Multi-agent portfolio management via Drift | 83 (#19) | Spending caps + leverage limits on Drift actions per agent |

**Outreach strategy:** Provide each project a working integration example using their specific DeFi protocol combination. Offer a 30-day zero-fee trial (set `developer_fee_rate = 0`) to prove value before monetization. Focus outreach on funded/active projects, not just hackathon teams.

### Beyond the Hackathon

| Target Segment | Integration Opportunity |
|---------------|------------------------|
| **GLAM Systems users** | GLAM manages fund permissions but lacks multi-protocol DeFi middleware. Sigil adds per-protocol policies on top of GLAM's asset management. |
| **ClawPay / Lobster.cash ecosystem** | ClawPay handles agent payments but not DeFi execution. Sigil provides the DeFi guardrails their agents need. |
| **MCP-compatible agent builders** | Any agent using MCP (Claude, Cursor, VS Code, Windsurf, custom agents) gets Sigil integration via `@usesigil/mcp (planned)` — no per-framework plugins needed. |
| **Coinbase Agentic Wallet users** | Coinbase custody + Sigil policy = dual-layer protection. Agentic wallet holds keys, vault enforces DeFi policies. |
| **Privy / Turnkey users** | Same dual-layer model. Custody provider manages key security, Sigil manages spending/DeFi policies. |

---

## Business Model

Sigil generates revenue through on-chain fee collection at the protocol level — fees are collected upfront during `validate_and_authorize` (non-bypassable), making revenue directly proportional to agent transaction volume.

### Fee Structure

| Fee Type | Rate | Recipient | Set By |
|----------|------|-----------|--------|
| Protocol fee | 0.02% (2 BPS) | Sigil treasury (Squads multisig) | Hardcoded in program |
| Developer fee | 0–0.05% (0–5 BPS) | Vault creator's fee destination | Configurable per vault |
| **Combined max** | **0.07% (7 BPS)** | | |

### Revenue Projections (illustrative)

| Monthly Agent Volume | Protocol Fee (2 BPS) | Annual Revenue |
|---------------------|---------------------|----------------|
| $1M | $200 | $2,400 |
| $10M | $2,000 | $24,000 |
| $100M | $20,000 | $240,000 |
| $1B | $200,000 | $2,400,000 |

### Path to Sustainability

1. **Phase 6-7:** Free adoption period — get 5-10 trading agents using vaults on devnet/mainnet
2. **Phase 7-8:** Protocol fee active — revenue scales with agent transaction volume
3. **Phase 8+:** Developer fee enables agent-builder monetization — they earn fees on vaults they create, incentivizing SDK adoption

---

## Updated Tech Stack

| Layer | Technology | Status |
|-------|-----------|--------|
| On-chain program | Rust, Anchor 0.32.1, 29 instructions, 9 PDAs | Deployed (devnet) |
| Program testing | LiteSVM (in-process Solana VM), ts-mocha | Active |
| SDK | TypeScript, @solana/web3.js, @coral-xyz/anchor | Published (npm, 656 tests) |
| Kit SDK | TypeScript, @solana/kit (zero web3.js) | Built (199 tests) |
| MCP Server | `@modelcontextprotocol/sdk`, TypeScript (49 tools, 3 resources) | Built (355 tests) |
| Agent integrations | MCP server (framework-agnostic, 49 tools) | Built (see MCP Server row) |
| DeFi integrations | Jupiter V6, Flash Trade (spot + perps + limit/trigger orders) | Built |
| Stablecoin identity | USDC/USDT amount = USD (no oracles) | Built |
| Custody | Crossmint, Privy, Turnkey TEE adapters | Built |
| Platform | Solana Actions provisioning client | Built (17 tests) |
| Actions Server | Hono + Vercel serverless (8 routes) | Deployed (agent-middleware.vercel.app, 61 tests) |
| Dashboard | Next.js 14, Tailwind, shadcn/ui | Separate repo |
| RPC | Helius (dev: free tier, prod: Professional) | Active |
| CI/CD | GitHub Actions (3 parallel jobs) | Active |
| Security | Certora formal verification, Trident fuzz, Sec3 X-Ray static analysis | Active |
| Deployment | Anchor CLI → devnet (live) → mainnet-beta (post-audit) | Devnet |

---

## Future Considerations

### Fleet Management

For orchestrator platforms managing many agents (e.g., DeFi Risk Guardian, SIDEX), a fleet provisioning API could batch-create vaults and apply templated policies. The current design already supports multiple vaults per owner (seeds: `[b"vault", owner, vault_id]`), so fleet management is an SDK/tooling concern, not an on-chain change. Defer until there is concrete demand from platform customers.

**Key architectural principle (from senior developer feedback analysis):** Sigil is an "agent constraint" product, not an "agent autonomy" product. The owner/agent separation is the core security guarantee — owners define boundaries, agents operate within them, and the program enforces the boundary. This framing informs all design decisions: features that weaken owner control or blur the owner/agent boundary should be rejected.

### Programmatic Configuration Path

For CI/CD pipelines and orchestrator platforms, a non-interactive configuration path (config file or env-var-based setup) would complement the onboarding flow. Planned for MCP Phase 4 rebuild using the `seal()` API.

### Features Identified from Competitive Analysis

Features seen in competitors that Sigil should evaluate for future phases:

| Feature | Competitor(s) | Priority | Notes |
|---------|--------------|----------|-------|
| **Lifetime spending limits** | CloakedAgent, AgentWallet.fun | High | Simple on-chain addition: `lifetime_spending_cap_usd` on PolicyConfig. Low effort, high value for institutional use. |
| **Agent expiration timestamps** | CloakedAgent | High | `agent_expires_at: i64` on AgentVault. Auto-revoke after timestamp. Prevents forgotten active agents. |
| **KYT/OFAC sanctions screening** | Coinbase | Medium | Off-chain pre-flight check via commercial API (Chainalysis, Elliptic). Not on-chain — compliance layer above the vault. |
| **Hooks / extensibility system** | Squads v5 | Medium | Pre/post CPI hooks to external programs. Would enable third-party policy modules. Complex architecture change. |
| **ZK privacy mode** | CloakedAgent | Low | Privacy-preserving transactions via ZK proofs. Significant R&D effort. Monitor CloakedAgent's adoption. |
| **Token2022 support** | x402/svm | Medium | Token2022 extensions (transfer fees, interest-bearing, transfer hooks) need testing in the x402 payment path. |
| **AP2 Intent Mandate compatibility** | Google UCP | High | AP2 mandates map cleanly to PolicyConfig. Implementing AP2 format adapter enables Google ecosystem participation (20+ partners). |
| **Server-side paywall** | x402 ecosystem | High | `@usesigil/paywall` Express/Hono middleware for receiving x402 payments. Enables API monetization. |
| **Multi-language SDKs** | GLAM | Low | Python, Go SDKs. Defer until TypeScript SDK is mature and there's demand. |
| **14+ protocol integrations** | GLAM | Medium | GLAM covers Drift, Kamino, Marinade, Sanctum, CCTP. Sigil has Jupiter + Flash Trade. Drift is highest priority gap (see Phase F.1). |
