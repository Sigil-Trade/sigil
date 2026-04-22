# Sigil Security Specification

> Formal specification for external auditors. Covers the on-chain Anchor program
> (`4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`), its invariants, access
> control model, PDA derivation paths, error catalog, and trust assumptions.
>
> Program: `programs/sigil/` — Anchor 0.32.1, Rust 1.89.0
> 36 instruction handlers, 12 PDA account types, 81 error codes, 37 events.
>
> Cross-reference: See `docs/ARCHITECTURE.md` for account model,
> `docs/RFC-ACTIONTYPE-ELIMINATION.md` for the capability model migration,
> and `sdk/kit/src/agent-errors.ts` for error mappings.

---

## 1. Security Model Overview

Sigil is a permissioned middleware for AI agent wallets on Solana. It sits between an AI agent's signing key and DeFi protocols, enforcing spending limits, token/protocol whitelists, and audit logging via PDA-controlled vaults.

### Owner/Agent Separation

| Role      | Capabilities                                                                                                                 | Cannot                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Owner** | Create vault, set policy, register/revoke agent, deposit/withdraw, close vault, queue/apply/cancel timelocked policy changes | Execute DeFi actions                                       |
| **Agent** | Execute DeFi actions (within policy), transfer to allowed destinations                                                       | Modify policy, withdraw to owner, revoke self, close vault |

The owner holds full authority. The agent is an execute-only key that can only operate within the policy constraints set by the owner.

### Architecture

Sigil bundles three layers of protection:

1. **Client-side policy engine** (`@usesigil/kit`) — Software policy enforcement, fast deny before transactions hit the network.
2. **On-chain vault** (`@usesigil/kit` + TEE custody) — TEE key custody (Crossmint/Turnkey) + on-chain PDA vaults with cryptographic guarantees. Cannot be bypassed by compromised software. Production.

This document covers the on-chain vault component.

### Instruction Composition Pattern

The program uses multi-instruction atomic transactions instead of CPI wrapping to avoid Solana's 4-level CPI depth limit:

```
Transaction = [SetComputeBudget, validate_and_authorize, DeFi_instruction, finalize_session]
```

All instructions succeed or all revert atomically. Token delegation (SPL `approve`/`revoke` CPI) enables the DeFi instruction to spend from the vault's PDA-owned token account.

---

## 2. Invariants

The following properties must hold at all times:

### INV-1: Checked Arithmetic

All arithmetic on `u64`/`u128`/`i128` uses `.checked_add()`, `.checked_sub()`, `.checked_mul()`, `.checked_div()`. Overflow returns `SigilError::Overflow` (error 6025). No raw `+`, `-`, `*`, `/` on numeric types. Source: `programs/sigil/src/errors.rs`.

### INV-2: Bounded Data Structures

No unbounded `Vec<T>` in on-chain accounts. All vectors and arrays have compile-time maximums:

- `protocols`: max 10 (`MAX_ALLOWED_PROTOCOLS`)
- `allowed_destinations`: max 10 (`MAX_ALLOWED_DESTINATIONS`)
- `agents`: max 10 (`MAX_AGENTS_PER_VAULT`)
- `constraint_entries`: max 64 (`MAX_CONSTRAINT_ENTRIES`), each with max 8 data constraints + 5 account constraints. Source: `state/constraints.rs:7`.
- `SpendTracker.buckets`: fixed 144-element array of `EpochBucket` (zero-copy, 10-minute epochs, 24h rolling window)
- `SpendTracker.protocol_counters`: fixed 10-element array of `ProtocolSpendCounter`
- `AgentSpendOverlay.entries`: fixed 10-element array of `AgentContributionEntry` (24 hourly epochs per entry)

### INV-3: Owner-Only Admin

Only the vault owner can call: `deposit_funds`, `register_agent`, `revoke_agent`, `withdraw_funds`, `close_vault`, `reactivate_vault`, `queue_policy_update`, `apply_pending_policy`, `cancel_pending_policy`, `create_instruction_constraints`, `queue_constraints_update`, `apply_constraints_update`, `cancel_constraints_update`, `queue_close_constraints`, `apply_close_constraints`, `cancel_close_constraints`, `allocate_constraints_pda`, `allocate_pending_constraints_pda`, `extend_pda`, `create_post_assertions`, `close_post_assertions`, `freeze_vault`, `pause_agent`, `unpause_agent`, `queue_agent_permissions_update`, `apply_agent_permissions_update`, `cancel_agent_permissions_update`. Enforced by Anchor `has_one = owner` and PDA seed re-derivation.

Source: `programs/sigil/src/lib.rs`.

### INV-4: Immutable Fee Destination

`AgentVault.fee_destination` is written only in `initialize_vault` and never modified by any other instruction. This prevents a compromised owner key from redirecting developer fees.

### INV-5: Session Expiry (20 Slots)

`SessionAuthority.expires_at_slot = current_slot + SESSION_EXPIRY_SLOTS` (20 slots ≈ 8 seconds). Expired sessions:

- Cannot be finalized as successful (forced to `success = false`)
- Can be cleaned up by anyone (permissionless crank)
- Rent is always returned to the session's original agent

### INV-6: Spending Caps Are Aggregate-Only

The `daily_spending_cap_usd` is an aggregate rolling 24-hour cap across all tokens — stablecoin amounts are treated as 1:1 USD (USDC/USDT amount / 10^6 = USD). No oracles. There are no per-token caps in V2 — all enforcement is done at the aggregate USD level using epoch-bucketed tracking.

### INV-7: Multi-Agent Vaults with 2-Bit Capability Model

`AgentVault.agents` stores up to 10 `AgentEntry` structs (pubkey + 1-byte capability + 8-byte spending_limit_usd + 1-byte paused + 7 reserved bytes = 49 bytes per entry). `register_agent` fails with `MaxAgentsReached` (error 6046) if 10 agents are already registered, or `AgentAlreadyRegistered` (error 6014) if the same pubkey is already registered.

Each agent has a 2-bit capability field:

- `CAPABILITY_DISABLED (0)` — Agent entry exists but all actions blocked.
- `CAPABILITY_OBSERVER (1)` — Non-spending actions only (amount == 0).
- `CAPABILITY_OPERATOR (2)` — Full access including spending actions (amount > 0). Also `FULL_CAPABILITY`.

The former 21-bit `permissions: u64` bitmask controlling `ActionType` variants has been replaced. The `ActionType` enum is entirely eliminated. Spending classification at runtime uses `amount > 0` in `validate_and_authorize`. The `ConstraintEntryZC.is_spending` field (1=Spending, 2=NonSpending) in the matched constraint entry is stored in the session and reported in events. Per-agent spending limits are tracked via `AgentSpendOverlay` zero-copy PDAs (10 agent slots, 24 hourly epochs, no shards).

Source: `state/vault.rs:4-8` (capability constants), `state/mod.rs:31-32` (FULL_CAPABILITY), `state/mod.rs:255-259` (ActionType elimination note), `instructions/validate_and_authorize.rs:135` (is_spending = amount > 0), `docs/RFC-ACTIONTYPE-ELIMINATION.md`.

### INV-8: Timelocked Policy Changes (Mandatory)

The timelock is **mandatory** at vault creation. `initialize_vault` requires `timelock_duration >= MIN_TIMELOCK_DURATION` (1,800 seconds = 30 minutes), enforced with `SigilError::TimelockTooShort` (error 6072). There is no zero-timelock path. All policy, constraint, constraint-closure, and agent-permissions changes are queued (creating a pending PDA) and apply only after `timelock_duration` seconds elapse. The `queue_*` instructions enforce the 1,800-second minimum on any timelock update.

Source: `state/mod.rs:62` (MIN_TIMELOCK_DURATION = 1800), `instructions/initialize_vault.rs:101` (require! enforcement), `instructions/queue_policy_update.rs:105` (queue path enforcement).

### INV-9: Outcome-Based Spending Enforcement

Spending caps are enforced in `finalize_session` based on **actual stablecoin balance delta**, not declared intent. `validate_and_authorize` snapshots the vault's stablecoin balance before fees/DeFi execution. `finalize_session` measures the current balance and computes `actual_spend = total_decrease - fees_collected`. Only when `actual_spend > 0` are caps checked (daily rolling cap, per-agent cap, per-protocol cap, per-transaction max). This prevents agents from under-declaring amounts to bypass caps — the program measures reality, not promises. Standalone instructions (`agentTransfer`, `createEscrow`) retain inline cap checks since they move tokens directly.

---

## 3. PDA Derivation Paths

All PDAs use canonical bump (highest valid bump found by `findProgramAddressSync`). Bump is stored on-chain and re-verified via Anchor `seeds` + `bump` constraints.

| Account                         | Seeds                                                                        | Bump Storage               | Size (bytes) |
| ------------------------------- | ---------------------------------------------------------------------------- | -------------------------- | ------------ |
| `AgentVault`                    | `[b"vault", owner.key(), vault_id.to_le_bytes()]`                            | `vault.bump`               | 635          |
| `PolicyConfig`                  | `[b"policy", vault.key()]`                                                   | `policy.bump`              | 826          |
| `SpendTracker`                  | `[b"tracker", vault.key()]`                                                  | `tracker.bump`             | 2,840        |
| `SessionAuthority`              | `[b"session", vault.key(), agent.key(), token_mint.as_ref()]`                | `session.bump`             | 339          |
| `PendingPolicyUpdate`           | `[b"pending_policy", vault.key()]`                                           | `pending_policy.bump`      | 845          |
| `EscrowDeposit`                 | `[b"escrow", source_vault.key(), dest_vault.key(), escrow_id.to_le_bytes()]` | `escrow.bump`              | 170          |
| `InstructionConstraints`        | `[b"constraints", vault.key()]`                                              | `constraints.bump`         | 35,888       |
| `PendingConstraintsUpdate`      | `[b"pending_constraints", vault.key()]`                                      | `pending_constraints.bump` | 35,904       |
| `AgentSpendOverlay`             | `[b"agent_spend", vault.key(), &[0u8]]`                                      | `overlay.bump`             | 2,528        |
| `PostExecutionAssertions`       | `[b"post_assertions", vault.key()]`                                          | `pea.bump`                 | 352          |
| `PendingAgentPermissionsUpdate` | `[b"pending_agent_perms", vault.key(), agent.as_ref()]`                      | `pending.bump`             | 105          |
| `PendingCloseConstraints`       | `[b"pending_close_constraints", vault.key()]`                                | `pcc.bump`                 | 57           |

Sources: seeds verified in instruction handlers. Sizes from `pub const SIZE` in each state module.

### Session PDA Design

Session seeds include vault, agent, and token_mint keys (4 seeds). The `init` constraint prevents double-authorization — only one session can exist per vault+agent+token_mint triple at a time.

### EscrowDeposit PDA Design

Escrow seeds include source vault, destination vault, and escrow_id (4 seeds). This scopes each escrow to its vault pair and prevents ID collisions across unrelated vaults.

### PendingAgentPermissionsUpdate PDA Design

The per-agent PDA (seeds include agent pubkey) allows concurrent pending updates for different agents in the same vault. Only one pending update per agent at a time (`PendingAgentPermsExists`, error 6074).

### Vault PDA Design

Vault seeds include `vault_id` (a `u64`) to allow one owner to create multiple independent vaults, each with its own policy, tracker, and agent roster.

---

## 4. Access Control Matrix

| Instruction                        | Required Signer           | Additional Constraints                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize_vault`                 | `owner` (payer)           | PDA seeds enforce owner ownership. `fee_destination ≠ Pubkey::default()`. `developer_fee_rate ≤ 500`. `timelock_duration ≥ 1800`. Bounded vectors.                                                                                                                                                                                                                |
| `deposit_funds`                    | `owner`                   | `has_one = owner` on vault. Token transfer CPI from owner ATA to vault ATA.                                                                                                                                                                                                                                                                                       |
| `register_agent`                   | `owner`                   | `has_one = owner`. `agent ≠ Pubkey::default()`. `agent ≠ owner`. Max 10 agents. `capability` must be 0, 1, or 2.                                                                                                                                                                                                                                                  |
| `validate_and_authorize`           | `agent`                   | `vault.is_agent(agent)`. Agent not paused. Capability sufficient (`amount > 0` requires OPERATOR). `expected_policy_version` matches. `vault.is_active()`. CPI guard. Protocol allowed. USD caps. Leverage check. Position count check. Instruction scan. Finalize guard. Session PDA `init` prevents double-auth. Generic constraint check if `has_constraints`. |
| `finalize_session`                 | `payer` (any for expired) | Non-expired: `payer == session.agent`. Session closed (rent to agent). Post-assertion check if `has_post_assertions`.                                                                                                                                                                                                                                             |
| `revoke_agent`                     | `owner`                   | `has_one = owner`. `vault.status ≠ Closed`. Removes agent from Vec. Releases overlay slot.                                                                                                                                                                                                                                                                        |
| `reactivate_vault`                 | `owner`                   | `has_one = owner`. `vault.status == Frozen`. Optional new agent + capability.                                                                                                                                                                                                                                                                                     |
| `withdraw_funds`                   | `owner`                   | `has_one = owner`. `vault.status ≠ Closed`. `amount ≤ vault_token_account.amount`.                                                                                                                                                                                                                                                                                |
| `close_vault`                      | `owner`                   | `has_one = owner`. Active escrows == 0. Active sessions == 0. Instruction constraints closed. Pending policy resolved. Closes vault + policy + tracker + overlay PDAs.                                                                                                                                                                                            |
| `queue_policy_update`              | `owner`                   | `has_one = owner`. `vault.status ≠ Closed`. New `timelock_duration ≥ 1800` if changing. Bounded vectors. Creates PendingPolicyUpdate PDA.                                                                                                                                                                                                                         |
| `apply_pending_policy`             | `owner`                   | `has_one = owner`. `pending_policy.is_ready(now)`. Closes PendingPolicyUpdate PDA. Bumps `policy_version`.                                                                                                                                                                                                                                                        |
| `cancel_pending_policy`            | `owner`                   | `has_one = owner`. Closes PendingPolicyUpdate PDA.                                                                                                                                                                                                                                                                                                                |
| `allocate_constraints_pda`         | `owner`                   | `has_one = owner`. Allocates InstructionConstraints PDA at 10,240 bytes. Must be followed by `extend_pda` + `create_instruction_constraints`.                                                                                                                                                                                                                     |
| `allocate_pending_constraints_pda` | `owner`                   | `has_one = owner`. Allocates PendingConstraintsUpdate PDA at 10,240 bytes. Must be followed by `extend_pda` + `queue_constraints_update`.                                                                                                                                                                                                                         |
| `extend_pda`                       | `owner`                   | `has_one = owner`. Grows a program-owned PDA by up to 10,240 bytes per call to reach full SIZE.                                                                                                                                                                                                                                                                   |
| `create_instruction_constraints`   | `owner`                   | `has_one = owner`. PDA pre-allocated at full SIZE. Max 64 entries. Validates discriminator anchor (A5 invariant), Bitmask non-zero (A3), is_spending 1 or 2. Sets `policy.has_constraints = true`. Bumps `policy_version`.                                                                                                                                        |
| `queue_constraints_update`         | `owner`                   | `has_one = owner`. PDA pre-allocated. Creates PendingConstraintsUpdate PDA.                                                                                                                                                                                                                                                                                       |
| `apply_constraints_update`         | `owner`                   | `has_one = owner`. Timelock expired. Merges entries. Closes pending PDA. Bumps `policy_version`.                                                                                                                                                                                                                                                                  |
| `cancel_constraints_update`        | `owner`                   | `has_one = owner`. Closes PendingConstraintsUpdate PDA.                                                                                                                                                                                                                                                                                                           |
| `queue_close_constraints`          | `owner`                   | `has_one = owner`. Creates PendingCloseConstraints PDA. Fails if already queued (`PendingCloseConstraintsExists`).                                                                                                                                                                                                                                                |
| `apply_close_constraints`          | `owner`                   | `has_one = owner`. Timelock expired. Closes InstructionConstraints PDA. Sets `policy.has_constraints = false`. Closes PendingCloseConstraints PDA. Bumps `policy_version`.                                                                                                                                                                                        |
| `cancel_close_constraints`         | `owner`                   | `has_one = owner`. Closes PendingCloseConstraints PDA.                                                                                                                                                                                                                                                                                                            |
| `create_post_assertions`           | `owner`                   | `has_one = owner`. Max 4 assertion entries. Validates modes (0-3), operators (0-6), CrossFieldLte constraints. Sets `policy.has_post_assertions`.                                                                                                                                                                                                                 |
| `close_post_assertions`            | `owner`                   | `has_one = owner`. Closes PostExecutionAssertions PDA. Clears `policy.has_post_assertions`.                                                                                                                                                                                                                                                                       |
| `agent_transfer`                   | `agent`                   | `vault.is_agent(agent)`. Agent not paused. `vault.is_active()`. Stablecoin-only (USDC/USDT). Destination in allowed list. USD caps enforced. Fees deducted inline. `expected_policy_version` check.                                                                                                                                                               |
| `queue_agent_permissions_update`   | `owner`                   | `has_one = owner`. Agent must exist in vault. Creates PendingAgentPermissionsUpdate PDA (per-agent). Fails if already queued (`PendingAgentPermsExists`).                                                                                                                                                                                                         |
| `apply_agent_permissions_update`   | `owner`                   | `has_one = owner`. Timelock expired. Applies new capability + spending limit. Closes PendingAgentPermissionsUpdate PDA.                                                                                                                                                                                                                                           |
| `cancel_agent_permissions_update`  | `owner`                   | `has_one = owner`. Closes PendingAgentPermissionsUpdate PDA.                                                                                                                                                                                                                                                                                                      |
| `create_escrow`                    | `agent`                   | `vault.is_agent(agent)`. Agent not paused. OPERATOR capability (spending action). Spending caps + fees apply. Max duration 30 days.                                                                                                                                                                                                                               |
| `settle_escrow`                    | `dest_owner/agent`        | Escrow status == Active. Not expired. SHA-256 proof verified (if condition_hash set).                                                                                                                                                                                                                                                                             |
| `refund_escrow`                    | `source_owner`            | Escrow status == Active. Expired (`now >= expires_at`). Cap NOT reversed (prevents cap-washing).                                                                                                                                                                                                                                                                  |
| `close_settled_escrow`             | `source_owner`            | Escrow status == Settled or Refunded. Closes PDA, reclaims rent.                                                                                                                                                                                                                                                                                                  |
| `freeze_vault`                     | `owner`                   | `has_one = owner`. `vault.status ≠ Closed`. Sets status to Frozen. Preserves all agent entries (use `reactivate_vault` to unfreeze). Emits `VaultFrozen`.                                                                                                                                                                                                         |
| `pause_agent`                      | `owner`                   | `has_one = owner`. Agent must exist and not already be paused (`AgentAlreadyPaused`). Sets `agent.paused = true`. Emits `AgentPausedEvent`.                                                                                                                                                                                                                       |
| `unpause_agent`                    | `owner`                   | `has_one = owner`. Agent must exist and be paused (`AgentNotPaused`). Sets `agent.paused = false`. Emits `AgentUnpausedEvent`.                                                                                                                                                                                                                                    |

---

## 5. Error Code Catalog

81 error codes (6000–6080) using Anchor's `#[error_code]`. See `docs/ERROR-CODES.md` for the full table with categories. Source of truth: `programs/sigil/src/errors.rs`.

**New categories beyond original 70 codes:**

- Timelock (new): TimelockTooShort, PolicyVersionMismatch
- Pending state (new): PendingAgentPermsExists, PendingCloseConstraintsExists, ActiveSessionsExist
- Post-assertions (new): PostAssertionFailed, InvalidPostAssertionIndex, SnapshotNotCaptured, UnauthorizedPreValidateInstruction
- Constraints (new): ConstraintIndexOutOfBounds, InvalidConstraintOperator, ConstraintsVaultMismatch, ConstraintEntryCountExceeded, BlockedSplOpcode

---

## 6. Event Catalog

37 events using Anchor's `#[event]` attribute, emitted via `emit!()`. Source of truth: `programs/sigil/src/events.rs`.

**Core vault lifecycle:** VaultCreated, FundsDeposited, AgentRegistered, AgentSpendLimitChecked, ActionAuthorized, SessionFinalized, DelegationRevoked, AgentRevoked, VaultReactivated, FundsWithdrawn, FeesCollected, VaultClosed, AgentTransferExecuted.

**Policy timelock:** PolicyChangeQueued, PolicyChangeApplied, PolicyChangeCancelled.

**Constraints lifecycle:** InstructionConstraintsCreated, ConstraintsChangeQueued, ConstraintsChangeApplied, ConstraintsChangeCancelled.

**PDA lifecycle:** PdaAllocated, PdaExtended.

**Constraint closure:** CloseConstraintsQueued, CloseConstraintsApplied, CloseConstraintsCancelled.

**Escrow:** EscrowCreated, EscrowSettled, EscrowRefunded.

**Emergency response:** VaultFrozen, AgentPausedEvent, AgentUnpausedEvent.

**Agent permissions (queued):** AgentPermissionsChangeQueued, AgentPermissionsChangeApplied, AgentPermissionsChangeCancelled.

**Post-assertions:** PostAssertionsCreated, PostAssertionsClosed, PostAssertionChecked.

**Removed events (no longer emitted):** PolicyUpdated (replaced by PolicyChangeApplied), AgentPermissionsUpdated (replaced by AgentPermissionsChangeApplied), InstructionConstraintsUpdated (replaced by ConstraintsChangeApplied), InstructionConstraintsClosed (replaced by CloseConstraintsApplied).

---

## 7. Constants

| Constant                         | Value             | Description                                                                                                       |
| -------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `MAX_ALLOWED_PROTOCOLS`          | 10                | Maximum protocols in policy                                                                                       |
| `MAX_ALLOWED_DESTINATIONS`       | 10                | Maximum destinations for agent transfers                                                                          |
| `MAX_AGENTS_PER_VAULT`           | 10                | Maximum agents per vault                                                                                          |
| `MAX_CONSTRAINT_ENTRIES`         | 64                | Maximum constraint entries in InstructionConstraints PDA. Source: `state/constraints.rs:7`.                       |
| `MAX_OVERLAY_ENTRIES`            | 10                | Agent slots in AgentSpendOverlay. Source: `state/agent_spend_overlay.rs:19`.                                      |
| `OVERLAY_NUM_EPOCHS`             | 24                | Hourly epochs in per-agent overlay rolling window. Source: `state/agent_spend_overlay.rs:11`.                     |
| `NUM_BUCKETS`                    | 144               | SpendTracker epoch bucket count                                                                                   |
| `EPOCH_SECONDS`                  | 600               | SpendTracker epoch duration (10 minutes)                                                                          |
| `ROLLING_WINDOW_SECONDS`         | 86,400            | 24-hour rolling window                                                                                            |
| `SESSION_EXPIRY_SLOTS`           | 20                | ~8 seconds at 400ms/slot                                                                                          |
| `MIN_TIMELOCK_DURATION`          | 1,800             | Minimum timelock in seconds (30 min). Mandatory at vault creation. Source: `state/mod.rs:62`.                     |
| `FEE_RATE_DENOMINATOR`           | 1,000,000         | Fee divisor. `ceil_fee()` uses ceiling division: `ceil(amount * rate / 1_000_000)`. Source: `state/mod.rs:71-79`. |
| `PROTOCOL_FEE_RATE`              | 200               | 0.02% = 2 BPS (hardcoded)                                                                                         |
| `MAX_DEVELOPER_FEE_RATE`         | 500               | 0.05% = 5 BPS (maximum)                                                                                           |
| `USD_DECIMALS`                   | 6                 | USD uses 6 decimal places ($1 = 1,000,000)                                                                        |
| `USD_BASE`                       | 1,000,000         | 10^6 multiplier                                                                                                   |
| `FULL_CAPABILITY`                | 2                 | `CAPABILITY_OPERATOR` — full access. Source: `state/mod.rs:32`.                                                   |
| `CAPABILITY_DISABLED`            | 0                 | Agent disabled. Source: `state/vault.rs:6`.                                                                       |
| `CAPABILITY_OBSERVER`            | 1                 | Non-spending actions only. Source: `state/vault.rs:7`.                                                            |
| `CAPABILITY_OPERATOR`            | 2                 | Full access including spending. Source: `state/vault.rs:8`.                                                       |
| `MAX_SLIPPAGE_BPS`               | 5,000             | 50% hard cap on slippage tolerance                                                                                |
| `MAX_ESCROW_DURATION`            | 2,592,000         | 30 days in seconds                                                                                                |
| `USDC_MINT`                      | (feature-flagged) | Hardcoded USDC mint address (devnet/mainnet)                                                                      |
| `USDT_MINT`                      | (feature-flagged) | Hardcoded USDT mint address (devnet/mainnet)                                                                      |
| `JUPITER_PROGRAM`                | (hardcoded)       | Jupiter V6 program ID                                                                                             |
| `FLASH_TRADE_PROGRAM`            | (hardcoded)       | Flash Trade program ID                                                                                            |
| `JUPITER_LEND_PROGRAM`           | (hardcoded)       | Jupiter Lend program ID                                                                                           |
| `JUPITER_EARN_PROGRAM`           | (hardcoded)       | Jupiter Earn program ID                                                                                           |
| `JUPITER_BORROW_PROGRAM`         | (hardcoded)       | Jupiter Borrow program ID                                                                                         |
| `FINALIZE_SESSION_DISCRIMINATOR` | (computed)        | 8-byte discriminator for finalize_session check                                                                   |

**Removed constants:** `FULL_PERMISSIONS` (`(1u64 << 21) - 1`) — eliminated with ActionType enum. `AGENT_OVERLAY_ENTRIES_PER_SHARD` — sharding removed; single overlay with 10 slots. `NUM_TREASURY_SHARDS` — no shards.

### Protocol Treasury

|                   | Address                                        |
| ----------------- | ---------------------------------------------- |
| Protocol Treasury | `ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT` |

---

## 8. Known Limitations & Trust Assumptions

### 8.1 Upgrade Authority

The program retains upgrade authority. The deployer keypair can upgrade the program binary. Before mainnet, this MUST be transferred to a Squads V4 multisig with a non-zero timelock — see [Pre-Mainnet Upgrade Authority Migration](#pre-mainnet-upgrade-authority-migration) below. The upgrade authority can change any program logic, including bypassing all security controls.

#### Pre-Mainnet Upgrade Authority Migration

**Status:** Required before mainnet deploy. Tracked in `docs/DEPLOYMENT.md` §5 (Pre-Mainnet Checklist).

**Plan:**

1. **Squads V4 multisig.** Create a Squads V4 multisig where the multisig vault PDA becomes the program's upgrade authority. Pattern verified across Drift, MarginFi, Kamino, Squads itself, and Jupiter — all five mature Solana protocols use Squads V4 for program upgrade authority.

2. **Signer composition.** Recommended 2-of-3 or 3-of-5. Avoid going wider — every additional signer expands the social-engineering attack surface. (Drift's compromised 2-of-5 was breached via per-signer phishing.)

3. **Non-zero timelock — ≥24 hours, mandatory.**

   > **Drift Protocol lost $285M on April 1, 2026** because their Squads multisig had **zero timelock**. The migration that removed the timelock was performed six days earlier (March 26) "for operational improvement." With no delay window, attackers who compromised signing devices could pre-sign upgrade transactions and apply them immediately. The timelock is what gives the team observable time to notice an unauthorized proposal and intervene.
   >
   > Sources: [Chainalysis: Lessons from the Drift hack](https://www.chainalysis.com/blog/lessons-from-the-drift-hack/) · [BlockSec: Drift multisig governance compromise](https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation)

   Sigil's mainnet timelock MUST be ≥24h. No exceptions, no "operational improvement" overrides. The friction IS the safety mechanism.

4. **CI never holds mainnet upgrade authority.** Universal pattern across all 5 protocols. CI builds the bytecode, verifies it (`solana-verify`), uploads to a buffer account, and files a Squads multisig proposal. Humans review the proposal in the Squads UI and sign. The on-chain `solana program deploy` step happens server-side via Squads' executor — CI does not run it.

5. **Separate multisigs per surface.** Kamino's pattern: distinct Squads multisigs for KFarms, KLend, KamMS, and KLend Staging. Sigil should split similarly:
   - Program upgrade authority (mainnet program account)
   - ALT authority (per [`MEMORY/alt-authority-migration.md`](../MEMORY/alt-authority-migration.md))
   - Fee destination (rare changes; conservative review)
   - Future: per-environment staging multisig

6. **Action: `mrgnlabs/squads-program-upgrade@v0.3.1` (or fork).** Battle-tested by MarginFi. **Don't comment out the proposal step like MarginFi did** — that turns the action into a buffer-uploader that humans must remember to follow up on. Keep the full flow: build → buffer upload → proposal creation → notify signers.

7. **Pre-mainnet rehearsal.** Test the full multisig upgrade flow on devnet using the staging program (`STAGSigi…`) as the target. Practice signer rotation. Practice rejecting a malicious proposal. Document signer recovery procedures for lost or compromised devices.

### 8.2 Stablecoin Trust

The program trusts USDC and USDT as 1:1 USD pegs. Stablecoin amount / 10^6 = USD value. If a stablecoin depegs, the program will overcount or undercount USD spend relative to actual USD value. Hardcoded mint addresses (feature-flagged for devnet/mainnet) prevent spoofed stablecoins from being treated as USD. Non-stablecoin swaps require a stablecoin output — the stablecoin leg is the measured USD spend.

### 8.3 TEE Trust

Production deployments include TEE-backed signing (via Crossmint/Turnkey). The TEE provider's infrastructure is trusted for key custody. A compromised TEE provider could sign arbitrary transactions. The on-chain vault provides defense even against TEE compromise by enforcing spending limits at the blockchain level.

### 8.4 Client-Side Enforcement

The client-side wrapper SDK is purely client-side and is intended for development and testing only. A compromised or modified client can bypass all client-side controls. The wrapper is NOT a security boundary against adversaries. For any deployment with real funds, use the on-chain vault with TEE custody.

### 8.5 Session Window

Sessions expire after 20 slots (~8 seconds). During this window, the agent has a token delegation (`approve`) on the vault's token account. A compromised agent could drain the delegated amount within this window. The delegation amount equals the authorized transaction amount minus fees (not the full vault balance).

### 8.6 Permissionless Session Cleanup

Expired sessions can be finalized by anyone (permissionless crank). This is by design — it prevents denial-of-service where a crashed agent leaves sessions open. The expired session is always treated as failed (no fees collected, no stats updated).

### 8.7 Fee Destination Immutability

`fee_destination` is set once at vault creation and never modified. This prevents fee redirection attacks but also means the developer must create a new vault to change fee destination. Protocol fees always go to `PROTOCOL_TREASURY`.

### 8.8 Epoch Bucket Granularity

SpendTracker uses 144 epoch buckets (10 minutes each) for the 24-hour rolling window. The oldest bucket may include spend from up to 10 minutes before the window boundary, introducing a worst-case ~$0.000001 rounding error via proportional boundary correction. This is negligible for practical cap enforcement. Per-protocol counters use a simpler window model that resets entirely at expiry — see §8.12.

### 8.9 No Reentrancy Risk

The program does not perform CPI calls to untrusted programs. All CPI calls are to the SPL Token program (`approve`, `revoke`, `transfer`). The instruction composition pattern means DeFi protocol calls are separate instructions in the same transaction, not CPIs.

### 8.10 Account Size Limits

`PolicyConfig` is 826 bytes at max capacity (10 protocols, 10 destinations, 10 protocol caps — includes `policy_version: u64` and `has_post_assertions: u8` fields). Source: `state/policy.rs:104-124`.

`SpendTracker` is a zero-copy account of 2,840 bytes (144 epoch buckets × 16 bytes + 10 protocol counters × 48 bytes + `last_write_epoch: i64` + bump + padding). Source: `state/tracker.rs:70`.

`AgentSpendOverlay` is a zero-copy account of 2,528 bytes (10 × 232-byte contribution entries + 80-byte `lifetime_spend` + 80-byte `lifetime_tx_count`). Source: `state/agent_spend_overlay.rs:82-89`.

`InstructionConstraints` is a zero-copy account of 35,888 bytes (64 entries × 560 bytes each). `PendingConstraintsUpdate` is 35,904 bytes. Both exceed Solana's 10,240-byte CPI allocation limit — they require pre-allocation via `allocate_constraints_pda`/`allocate_pending_constraints_pda` + multiple `extend_pda` calls. Source: `state/constraints.rs:177`, `state/pending_constraints.rs:42`.

`AgentVault` is 635 bytes. `SessionAuthority` is 339 bytes (includes `assertion_snapshots: [[u8;32];4]` = 128 bytes and `snapshot_lens: [u8;4]` for Phase B post-assertion delta modes). `PostExecutionAssertions` is 352 bytes.

All sizes are within Solana's 10MB account limit.

### 8.11 RPC Trust Boundary

The SDK trusts RPC account data for client-side precheck. A malicious RPC can suppress precheck rejections but CANNOT bypass on-chain enforcement. The on-chain program independently validates all spending caps, permissions, and constraints regardless of what the client-side precheck reported. For production deployments: use multiple independent RPC providers and configure `stalenessWarnThresholdSec` in Shield options to detect stale state.

### 8.12 Per-Protocol Cap Reset Behavior

Per-protocol spend counters (`SpendTracker.protocol_counters`) use a simple 24-hour window that resets entirely on expiry, rather than the proportional boundary correction used by the global rolling cap. At the window boundary, accumulated per-protocol spend resets to 0, creating a brief window where a determined agent could exceed the per-protocol cap. The global rolling cap (`get_rolling_24h_usd`) provides the primary enforcement and is not subject to this reset behavior. Source: `state/tracker.rs:get_protocol_spend()` documentation.

---

## 9. Audit Scope

### In Scope

- All 36 instruction handlers in `programs/sigil/src/instructions/`
- All 12 PDA account types in `programs/sigil/src/state/`
- DeFi integration verifiers in `programs/sigil/src/instructions/integrations/`
- Error definitions in `programs/sigil/src/errors.rs` (81 codes, 6000–6080)
- Event definitions in `programs/sigil/src/events.rs` (38 events)
- Program entrypoint in `programs/sigil/src/lib.rs`
- Capability model design rationale: `docs/RFC-ACTIONTYPE-ELIMINATION.md`

### Out of Scope

- Kit SDK (`sdk/kit/`) — off-chain code
- Custody adapters (`sdk/custody/`) — TEE provider integrations
- Plugins (`plugins/`) — framework integrations
- Dashboard (separate repo)

### Test Suites

- `tests/sigil.ts` — core on-chain tests
- `tests/jupiter-integration.ts` — composed transaction tests
- `tests/flash-trade-integration.ts` — Flash Trade integration tests
- `tests/security-exploits.ts` — exploit scenario tests
- `tests/escrow-integration.ts` — escrow lifecycle tests
- `tests/instruction-constraints.ts` — constraint enforcement tests
- `tests/jupiter-lend-integration.ts` — Jupiter Lend tests
- `tests/surfpool-integration.ts` — Surfnet integration tests

All LiteSVM tests use in-process Solana VM (no network calls). Additional devnet test suites in `tests/devnet-*.ts`.

---

## 10. Delegation Window Trust Model

This section documents the security properties of the session delegation lifecycle — the window during which an agent holds SPL Token delegation (approval) on a vault's token account.

### 10.1 SessionAuthority PDA Lifecycle

| Phase      | Instruction              | What Happens                                                                                                                                                                                                                      |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create** | `validate_and_authorize` | SessionAuthority PDA initialized via Anchor `init` constraint. Seeds: `[b"session", vault.key(), agent.key(), token_mint]`. Fields set: `authorized=true`, `expires_at_slot`, `delegated`, `authorized_amount`, balance snapshot. |
| **Active** | _(DeFi instruction)_     | Agent holds SPL delegation on vault token account. DeFi program spends via delegation. Session valid while `clock.slot <= expires_at_slot`.                                                                                       |
| **Close**  | `finalize_session`       | Delegation revoked via SPL `Revoke` CPI. Outcome-based spending verification. Session PDA closed (rent returned to agent).                                                                                                        |

**Key property:** The `init` constraint prevents double-authorization — only one session can exist per vault+agent+token_mint triple at a time.

Source: `validate_and_authorize.rs:51-64` (seeds), `validate_and_authorize.rs:577-594` (init), `finalize_session.rs:164-183` (revoke+close).

### 10.2 Delegation Amount (Bounded, Not Full Vault)

The agent receives delegation for exactly the authorized transaction amount minus fees:

```
delegation_amount = authorized_amount - protocol_fee - developer_fee
```

**Example:** For a 100 USDC transaction with 2 BPS protocol fee + 5 BPS developer fee:

- Protocol fee: `ceil(100_000_000 * 200 / 1_000_000)` = 20,000 (0.02 USDC)
- Developer fee: `ceil(100_000_000 * 500 / 1_000_000)` = 50,000 (0.05 USDC)
- **Delegation amount: 99,930,000** (99.93 USDC — strictly bounded)

Fees are collected **before** delegation via SPL `Transfer` CPI (vault PDA signs). The agent never has access to the fee portion.

Source: `validate_and_authorize.rs:483-574`.

### 10.3 Session Expiry (Timeout Guard)

| Parameter                        | Value                                                                       |
| -------------------------------- | --------------------------------------------------------------------------- |
| `SESSION_EXPIRY_SLOTS` (default) | 20 (~8 seconds)                                                             |
| Configurable range               | 10–450 slots (4–180 seconds), or 0 for default                              |
| Calculation                      | `expires_at_slot = current_slot + policy.effective_session_expiry_slots()`  |
| Expiry check                     | `is_expired = current_slot > expires_at_slot` (inclusive: valid while `<=`) |

**The 20-slot window is NOT for transaction atomicity** — Solana guarantees all instructions in a transaction execute in the same slot. The window is a **timeout guard** that:

1. Prevents indefinite delegation holding if an agent constructs but never submits finalize
2. Enables permissionless cleanup — anyone can call `finalize_session` on expired sessions
3. Forces prompt finalization within a deterministic window

**Expired session behavior:** Treated as failed. No caps updated, no stats recorded. Delegation revoked. Rent returned to original agent. Callable by any signer (permissionless crank).

Source: `state/mod.rs:34` (constant), `state/policy.rs:148-153` (effective), `update_policy.rs:110-116` (validation, error 6060 `InvalidSessionExpiry`), `state/session.rs:63-65` (expiry check), `finalize_session.rs:100-114` (permissionless crank logic).

### 10.4 Five Defense Layers

The delegation window is protected by five interlocking defense layers:

| Layer                       | Mechanism                                                                                                                                                                 | Location                                                                         | What It Catches                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **1. Instruction Scan**     | Pre-execution scan of all TX instructions. Blocks SPL Token disc 3,4,6,8,9,12,13,15 + Token-2022 disc 26. Requires finalize_session present. Protocol allowlist enforced. | `validate_and_authorize.rs:276-424`                                              | Direct token theft, unauthorized approvals, protocol switching |
| **2. Bounded Delegation**   | SPL `Approve` for exactly `amount - fees`. SPL Token program cryptographically enforces the limit.                                                                        | `validate_and_authorize.rs:563-574`                                              | Over-spending via DeFi instruction                             |
| **3. Outcome Verification** | `finalize_session` measures actual stablecoin balance delta. Spending caps enforced on measured reality, not declared intent.                                             | `finalize_session.rs:190-330`                                                    | Under-declaring amounts to bypass caps                         |
| **4. CPI Balance Audit**    | Verifies `actual_decrease <= session_authorized_amount`. Catches compromised DeFi programs that CPI burn/transfer via agent delegation.                                   | `finalize_session.rs:227-239` (error 6071 `UnexpectedBalanceDecrease`)           | Compromised whitelisted DeFi programs                          |
| **5. Post-Finalize Lock**   | After delegation revocation, unbounded scan requires all remaining instructions to be ComputeBudget or System only.                                                       | `finalize_session.rs:516-543` (error 6070 `UnauthorizedPostFinalizeInstruction`) | Future regressions in revocation ordering                      |

Additionally, both `validate_and_authorize` and `finalize_session` enforce a **CPI guard** via `get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT` (error 6034 `CpiCallNotAllowed`). This ensures neither instruction can be invoked via CPI from another program.

### 10.5 Attack Surface Analysis

| Attack Vector                              | Defense                                                           | Result        |
| ------------------------------------------ | ----------------------------------------------------------------- | ------------- |
| Agent inserts SPL Transfer instruction     | Layer 1: disc 3/12 blocked                                        | **Blocked**   |
| Agent approves another delegate            | Layer 1: disc 4/13 blocked                                        | **Blocked**   |
| Agent burns vault tokens                   | Layer 1: disc 8/15 blocked                                        | **Blocked**   |
| Agent over-spends via DeFi                 | Layer 2: SPL enforces delegation limit                            | **Blocked**   |
| Agent under-declares amount                | Layer 3: outcome verification measures reality                    | **Blocked**   |
| Compromised DeFi CPIs to burn vault tokens | Layer 4: CPI balance audit (actual_decrease <= authorized_amount) | **Blocked**   |
| Instructions after finalize                | Layer 5: post-finalize lock (ComputeBudget/System only)           | **Blocked**   |
| Agent skips finalize                       | Timeout: session expires after 20 slots, permissionless cleanup   | **Mitigated** |
| CPI invocation of validate/finalize        | CPI guard: stack height check                                     | **Blocked**   |

### 10.6 Residual Risks

1. **Whitelisted protocol risk:** A whitelisted DeFi program (e.g., Jupiter, Flash Trade) is trusted to behave correctly. If the program itself is compromised or malicious, it could execute arbitrary inner CPIs. **Mitigation:** Layer 4 (CPI balance audit) limits damage to the authorized amount; Layer 2 (bounded delegation) caps the maximum loss.

2. **Stablecoin depeg:** If USDC or USDT depegs, the 1:1 USD assumption breaks and caps may over- or under-count real USD value. **Mitigation:** None — this is an accepted trust assumption (see §8.2).

3. **MEV/sandwich attacks:** An attacker could sandwich the DeFi instruction to extract value via adverse pricing. **Mitigation:** Jupiter slippage verification (on-chain check, spending-only), but this is specific to Jupiter and does not cover all protocols. Generic constraint validation can enforce custom slippage limits for other protocols.

---

## 11. Token-2022 Defense-in-Depth

This section documents how the program handles SPL Token-2022 instructions and the defense-in-depth strategy for the CPI blind spot.

### 11.1 Token-2022 Program Reference

`TOKEN_2022_PROGRAM_ID` is defined as a constant in `state/mod.rs:205-208`. The program uses it exclusively for instruction discriminator checking in the pre-execution instruction scan.

### 11.2 Blocked Discriminator Table

| Disc | SPL Token Name    | Token-2022 Name          | Risk                                             | Blocked?              |
| ---- | ----------------- | ------------------------ | ------------------------------------------------ | --------------------- |
| 3    | `Transfer`        | `Transfer`               | Direct token theft from vault                    | Yes (both)            |
| 4    | `Approve`         | `Approve`                | Grant delegate authority to attacker             | Yes (both)            |
| 6    | `SetAuthority`    | `SetAuthority`           | Change token account owner/close authority       | Yes (both)            |
| 8    | `Burn`            | `Burn`                   | Destroy vault tokens via delegate burn authority | Yes (both)            |
| 9    | `CloseAccount`    | `CloseAccount`           | Destroy vault token account, reclaim rent        | Yes (both)            |
| 12   | `TransferChecked` | `TransferChecked`        | Token theft with mint validation                 | Yes (both)            |
| 13   | `ApproveChecked`  | `ApproveChecked`         | Grant delegate with amount verification          | Yes (both)            |
| 15   | `BurnChecked`     | `BurnChecked`            | Destroy tokens with decimal verification         | Yes (both)            |
| 26   | _(N/A)_           | `TransferCheckedWithFee` | Token-2022 transfer with fee extension           | Yes (Token-2022 only) |

**Error codes:** Disc 4, 13 → `UnauthorizedTokenApproval` (6059). All others → `UnauthorizedTokenTransfer` (6039).

Source: `validate_and_authorize.rs:276-299`.

### 11.3 The CPI Blind Spot

The instruction scan in `validate_and_authorize` uses `load_instruction_at_checked()` from the Instructions sysvar. This **only sees top-level instructions** in the transaction — it cannot inspect inner CPI calls made by whitelisted DeFi programs.

**Consequence:** If a whitelisted DeFi program (e.g., Jupiter) is compromised, it could make inner CPI calls to the SPL Token program to transfer or burn vault tokens using the agent's delegation. The instruction scan would not detect this.

### 11.4 Three-Layer CPI Mitigation

| Layer                                         | Mechanism                                                                                        | What It Catches                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Instruction Scan** (validate_and_authorize) | Blocks top-level SPL Token/Token-2022 instructions with dangerous discriminators                 | Agent-injected token operations                                                       |
| **CPI Balance Audit** (finalize_session)      | Measures actual vault balance decrease. Requires `actual_decrease <= session_authorized_amount`. | Compromised DeFi inner CPI that transfers/burns beyond authorized amount (error 6071) |
| **Delegation Revocation** (finalize_session)  | SPL `Revoke` CPI removes all delegation. Executed in same atomic transaction.                    | Prevents any post-finalize exploitation of remaining delegation                       |

**Combined guarantee:** Even if a compromised DeFi program makes inner CPI calls to the SPL Token program, the maximum damage is bounded by the delegation amount (Layer 2 from §10.4), and the CPI balance audit (this section, Layer 2) will catch any decrease beyond the authorized amount.

### 11.5 Token-2022 Extension Risks

| Extension                      | Disc | Risk Level                                                             | Status                                                                                         |
| ------------------------------ | ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **TransferFee**                | 26   | High — fee-on-transfer could cause balance accounting mismatches       | **Blocked** (disc 26 in Token-2022 scan)                                                       |
| **ConfidentialTransfer**       | 27   | Medium — masked amounts could hide actual transfer sizes               | Not blocked, but CPI balance audit catches balance decreases regardless of instruction details |
| **PermanentDelegate**          | N/A  | Low — only affects mint-level authority, not individual token accounts | Not applicable (Sigil vaults use standard USDC/USDT mints)                                     |
| **TransferHook**               | N/A  | Low — hook programs execute during transfers but cannot modify amounts | CPI balance audit verifies final balance regardless                                            |
| **GroupPointer / GroupMember** | N/A  | Informational — metadata extensions, no fund-flow impact               | No mitigation needed                                                                           |

### 11.6 Blocklist vs. Allowlist Trade-off

The program uses a **blocklist** approach (block known-dangerous discriminators) rather than an **allowlist** (only permit known-safe discriminators).

**Rationale — DeFi composability:**

- DeFi programs issue many different instruction types (Jupiter alone has 10+ discriminators for different route types)
- An allowlist would need to enumerate every legitimate DeFi instruction discriminator and update with each protocol upgrade
- The blocklist approach only needs to enumerate SPL Token program operations, which are stable and well-defined

**Risk acceptance:**

- Unknown or future SPL Token discriminators are not blocked
- Token-2022 may add new transfer-like discriminators in future versions
- **Mitigation:** The CPI balance audit (§11.4, Layer 2) provides protocol-agnostic protection — regardless of which instruction is used, the balance delta is verified

### 11.7 Stablecoin Mint Handling

`is_stablecoin_mint()` (`state/mod.rs:157-164`) checks only the mint pubkey against hardcoded USDC/USDT addresses. It does **not** check whether the mint is owned by the SPL Token program or the Token-2022 program. This is acceptable because:

1. USDC and USDT on Solana use the original SPL Token program, not Token-2022
2. The pubkey check is sufficient — a Token-2022 mint at a different address would not match
3. If Circle/Tether migrated to Token-2022 with the same mint address (impossible on Solana — different program = different account), the program would need updating

### 11.8 Residual Risks and Recommendations

1. **Future Token-2022 discriminators:** New transfer-like instructions added to Token-2022 would bypass the blocklist. **Recommendation:** Monitor Token-2022 releases and update the blocklist. The CPI balance audit provides defense-in-depth.

2. **ConfidentialTransfer (disc 27):** Not blocked because it's not currently used with USDC/USDT. If stablecoin issuers adopt confidential transfers, the instruction scan should add disc 27 to the blocklist. The CPI balance audit already catches balance decreases.

3. **Token-2022 mint spoofing:** An attacker cannot create a Token-2022 mint at the same address as USDC/USDT (pubkey collision is computationally infeasible). The hardcoded mint check is cryptographically secure.

---

## 12. Capability Model

This section documents the 2-bit capability field that replaced the former 21-bit `ActionType` permission bitmask.

### 12.1 Migration Summary

The `permissions: u64` field on `AgentEntry` (a 21-bit `ActionType` bitmask) has been replaced by `capability: u8`. The `ActionType` enum has been eliminated entirely. The byte layout of `AgentEntry` is preserved at 49 bytes (32 pubkey + 1 capability + 8 spending_limit_usd + 1 paused + 7 reserved) to maintain `AgentVault` account stability on existing deployments.

Source: `state/vault.rs:4-20`, `state/mod.rs:255-259`, `docs/RFC-ACTIONTYPE-ELIMINATION.md`.

### 12.2 Capability Levels

| Value | Constant              | Meaning                                                        |
| ----- | --------------------- | -------------------------------------------------------------- |
| 0     | `CAPABILITY_DISABLED` | Entry exists but agent is fully blocked.                       |
| 1     | `CAPABILITY_OBSERVER` | Non-spending actions only (`amount == 0`).                     |
| 2     | `CAPABILITY_OPERATOR` | Full access (spending + non-spending). Also `FULL_CAPABILITY`. |
| 3+    | Reserved              | Rejected at registration and update time.                      |

Source: `state/vault.rs:6-8`, `state/mod.rs:32`.

### 12.3 Enforcement in validate_and_authorize

Spending classification at runtime uses `is_spending = amount > 0`. The capability check immediately follows:

```
vault.has_capability(&agent, is_spending) → SigilError::InsufficientPermissions (error 6047) if fails
```

`has_capability` (`state/vault.rs:148-158`):

- `is_spending == true`: requires `agent.capability >= CAPABILITY_OPERATOR (2)`
- `is_spending == false`: requires `agent.capability >= CAPABILITY_OBSERVER (1)`
- `CAPABILITY_DISABLED (0)` fails both checks unconditionally.

### 12.4 ConstraintEntryZC.is_spending (Session Classification)

`ConstraintEntryZC.is_spending` (1=Spending, 2=NonSpending, 0=Unset rejected at creation) is configured by the vault owner at constraint creation time. When a DeFi instruction matches a constraint entry, the matched entry's `is_spending` value is stored in the `SessionAuthority` PDA and emitted in the `SessionFinalized` event. This replaces the old `ActionType.is_spending()` method.

Constraint entries with `is_spending == 0` are rejected at creation time. Source: `state/constraints.rs`.

### 12.5 Queued Agent Permissions Updates

Agent capability changes are timelock-gated: `queue_agent_permissions_update` → (wait `timelock_duration` seconds) → `apply_agent_permissions_update`. The direct `update_agent_permissions` instruction has been deleted. A per-agent `PendingAgentPermissionsUpdate` PDA (105 bytes, seeds `[b"pending_agent_perms", vault, agent]`) tracks the queued change. Only one pending update per agent is allowed at a time (`PendingAgentPermsExists`, error 6074).

Source: `state/pending_agent_perms.rs`, `instructions/queue_agent_permissions_update.rs`.

### 12.6 Constraint-Level Spending Classification vs. Capability

For auditors: spending classification has two distinct purposes in the program.

1. **Capability gate** (validate_and_authorize): `is_spending = amount > 0`. This determines whether the agent needs OPERATOR capability. It runs before constraint matching.

2. **Session/event classification** (ConstraintEntryZC.is_spending, matched entry): Stored in SessionAuthority and emitted in SessionFinalized. Enables off-chain analytics to distinguish spending vs non-spending actions. Does not affect on-chain cap enforcement (caps use the outcome-based balance delta from finalize_session).

These two mechanisms are complementary, not redundant.
