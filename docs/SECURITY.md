# Phalnx Security Specification

> Formal specification for external auditors. Covers the on-chain Anchor program
> (`4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`), its invariants, access
> control model, PDA derivation paths, error catalog, and trust assumptions.
>
> Program: `programs/phalnx/` — Anchor 0.32.1, Rust 1.89.0
> 29 instruction handlers, 9 PDA account types, 70 error codes, 31 events.
>
> Cross-reference: See `docs/ARCHITECTURE.md` for account model and `sdk/kit/src/agent-errors.ts` for error mappings.

---

## 1. Security Model Overview

Phalnx is a permissioned middleware for AI agent wallets on Solana. It sits between an AI agent's signing key and DeFi protocols, enforcing spending limits, token/protocol whitelists, and audit logging via PDA-controlled vaults.

### Owner/Agent Separation

| Role | Capabilities | Cannot |
|------|-------------|--------|
| **Owner** | Create vault, set policy, register/revoke agent, deposit/withdraw, close vault, queue/apply/cancel timelocked policy changes | Execute DeFi actions |
| **Agent** | Execute DeFi actions (within policy), transfer to allowed destinations | Modify policy, withdraw to owner, revoke self, close vault |

The owner holds full authority. The agent is an execute-only key that can only operate within the policy constraints set by the owner.

### Architecture

Phalnx bundles three layers of protection:

1. **Client-side policy engine** (`@phalnx/kit`) — Software policy enforcement, fast deny before transactions hit the network.
2. **On-chain vault** (`@phalnx/kit` + TEE custody) — TEE key custody (Crossmint/Turnkey) + on-chain PDA vaults with cryptographic guarantees. Cannot be bypassed by compromised software. Production.

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
All arithmetic on `u64`/`u128`/`i128` uses `.checked_add()`, `.checked_sub()`, `.checked_mul()`, `.checked_div()`. Overflow returns `PhalnxError::Overflow` (error 6025). No raw `+`, `-`, `*`, `/` on numeric types.

### INV-2: Bounded Data Structures
No unbounded `Vec<T>` in on-chain accounts. All vectors and arrays have compile-time maximums:
- `protocols`: max 10 (`MAX_ALLOWED_PROTOCOLS`)
- `allowed_destinations`: max 10 (`MAX_ALLOWED_DESTINATIONS`)
- `agents`: max 10 (`MAX_AGENTS_PER_VAULT`)
- `constraint_entries`: max 16, each with max 8 data constraints + 5 account constraints
- `SpendTracker.buckets`: fixed 144-element array of `EpochBucket` (zero-copy, 10-minute epochs, 24h rolling window)
- `SpendTracker.protocol_counters`: fixed 10-element array of `ProtocolSpendCounter`
- `AgentSpendOverlay.entries`: fixed 10-element array of `AgentContributionEntry`, no shards

### INV-3: Owner-Only Admin
Only the vault owner can: `update_policy`, `revoke_agent`, `withdraw_funds`, `close_vault`, `register_agent`, `reactivate_vault`, `queue_policy_update`, `apply_pending_policy`, `cancel_pending_policy`, `deposit_funds`, `sync_positions`, `update_agent_permissions`, `create_instruction_constraints`, `update_instruction_constraints`, `close_instruction_constraints`, `queue_constraints_update`, `apply_constraints_update`, `cancel_constraints_update`. Enforced by Anchor `has_one = owner` and PDA seed re-derivation.

### INV-4: Immutable Fee Destination
`AgentVault.fee_destination` is written only in `initialize_vault` and never modified by any other instruction. This prevents a compromised owner key from redirecting developer fees.

### INV-5: Session Expiry (20 Slots)
`SessionAuthority.expires_at_slot = current_slot + SESSION_EXPIRY_SLOTS` (20 slots ≈ 8 seconds). Expired sessions:
- Cannot be finalized as successful (forced to `success = false`)
- Can be cleaned up by anyone (permissionless crank)
- Rent is always returned to the session's original agent

### INV-6: Spending Caps Are Aggregate-Only
The `daily_spending_cap_usd` is an aggregate rolling 24-hour cap across all tokens — stablecoin amounts are treated as 1:1 USD (USDC/USDT amount / 10^6 = USD). No oracles. There are no per-token caps in V2 — all enforcement is done at the aggregate USD level using epoch-bucketed tracking.

### INV-7: Multi-Agent Vaults with Permission Bitmasks
`AgentVault.agents` stores up to 10 `AgentEntry` structs (pubkey + permissions bitmask + per-agent spending limit). `register_agent` fails with `MaxAgentsReached` (error 6046) if 10 agents are already registered, or `AgentAlreadyRegistered` (error 6014) if the same pubkey is already registered. Each agent has a 21-bit permission bitmask controlling which `ActionType` variants it can execute. Per-agent spending limits are tracked via `AgentSpendOverlay` zero-copy PDAs (10 agent slots, no shards).

### INV-8: Timelocked Policy Changes
When `PolicyConfig.timelock_duration > 0`, direct `update_policy` calls are blocked (`TimelockActive`, error 6027). Policy changes must go through `queue_policy_update` → (wait `timelock_duration` seconds) → `apply_pending_policy`. The owner can cancel at any time via `cancel_pending_policy`.

### INV-9: Outcome-Based Spending Enforcement
Spending caps are enforced in `finalize_session` based on **actual stablecoin balance delta**, not declared intent. `validate_and_authorize` snapshots the vault's stablecoin balance before fees/DeFi execution. `finalize_session` measures the current balance and computes `actual_spend = total_decrease - fees_collected`. Only when `actual_spend > 0` are caps checked (daily rolling cap, per-agent cap, per-protocol cap, per-transaction max). This prevents agents from under-declaring amounts to bypass caps — the program measures reality, not promises. Standalone instructions (`agentTransfer`, `createEscrow`) retain inline cap checks since they move tokens directly.

---

## 3. PDA Derivation Paths

All PDAs use canonical bump (highest valid bump found by `findProgramAddressSync`). Bump is stored on-chain and re-verified via Anchor `seeds` + `bump` constraints.

| Account | Seeds | Bump Storage |
|---------|-------|-------------|
| `AgentVault` | `[b"vault", owner.key(), vault_id.to_le_bytes()]` | `vault.bump` |
| `PolicyConfig` | `[b"policy", vault.key()]` | `policy.bump` |
| `SpendTracker` | `[b"tracker", vault.key()]` | `tracker.bump` |
| `SessionAuthority` | `[b"session", vault.key(), agent.key()]` | `session.bump` |
| `PendingPolicyUpdate` | `[b"pending_policy", vault.key()]` | `pending_policy.bump` |
| `EscrowDeposit` | `[b"escrow", source_vault.key(), escrow_id.to_le_bytes()]` | `escrow.bump` |
| `InstructionConstraints` | `[b"constraints", vault.key()]` | `constraints.bump` |
| `PendingConstraintsUpdate` | `[b"pending_constraints", vault.key()]` | `pending_constraints.bump` |
| `AgentSpendOverlay` | `[b"agent_spend", vault.key()]` | `overlay.bump` |

### Session PDA Design

Session seeds include vault and agent keys. The `init` constraint on session creation prevents double-authorization. One session at a time per vault-agent pair.

### Vault PDA Design

Vault seeds include `vault_id` (a `u64`) to allow one owner to create multiple independent vaults, each with its own policy, tracker, and agent.

---

## 4. Access Control Matrix

| Instruction | Required Signer | Additional Constraints |
|-------------|----------------|----------------------|
| `initialize_vault` | `owner` (payer) | PDA seeds enforce owner ownership. `fee_destination ≠ Pubkey::default()`. `developer_fee_rate ≤ 500`. Bounded vectors. |
| `deposit_funds` | `owner` | `has_one = owner` on vault. Token transfer CPI from owner ATA to vault ATA. |
| `register_agent` | `owner` | `has_one = owner`. `agent ≠ Pubkey::default()`. `agent ≠ owner`. Max 10 agents. `permissions` bitmask validated. |
| `update_policy` | `owner` | `has_one = owner`. `vault.status ≠ Closed`. `policy.timelock_duration == 0`. Bounded vectors. `developer_fee_rate ≤ 500`. |
| `validate_and_authorize` | `agent` | `vault.is_agent(agent)`. Agent permission bitmask checked for action type. Per-agent spending limit checked (if set). `vault.is_active()`. CPI guard rejects nested calls. Token is recognized stablecoin (USDC/USDT) or non-stablecoin with stablecoin output. Protocol allowed by policy (protocolMode). USD caps enforced. Leverage check. Position count check. Instruction scan verifies DeFi programs + blocks SPL Token transfers. Finalize guard verifies finalize_session follows. Session PDA `init` prevents double-auth. |
| `finalize_session` | `payer` (any for expired) | Non-expired: `payer == session.agent`. `session_rent_recipient == session.agent`. Session closed (rent to agent). |
| `revoke_agent` | `owner` | `has_one = owner`. `vault.status ≠ Closed`. Sets status to Frozen, clears agent key. |
| `reactivate_vault` | `owner` | `has_one = owner`. `vault.status == Frozen` (else `VaultNotFrozen`). `vault.agent ≠ default` after update (else `NoAgentRegistered`). |
| `withdraw_funds` | `owner` | `has_one = owner`. `vault.status ≠ Closed`. `amount ≤ vault_token_account.amount`. |
| `close_vault` | `owner` | `has_one = owner`. Closes vault + policy + tracker PDAs. Rent to owner. |
| `queue_policy_update` | `owner` | `has_one = owner`. `vault.status ≠ Closed`. `policy.timelock_duration > 0`. Bounded vectors. |
| `apply_pending_policy` | `owner` | `has_one = owner`. `pending_policy.is_ready(now)` (timelock expired). Closes PendingPolicyUpdate PDA. |
| `cancel_pending_policy` | `owner` | `has_one = owner`. Closes PendingPolicyUpdate PDA. |
| `agent_transfer` | `agent` | `vault.is_agent(agent)`. `vault.is_active()`. Stablecoin-only (USDC/USDT via is_stablecoin_mint check). Destination allowed. USD caps enforced. Fees deducted inline. Typed Mint account validation. |
| `sync_positions` | `owner` | `has_one = owner`. Corrects open_positions counter after keeper-executed orders. |
| `create_instruction_constraints` | `owner` | `has_one = owner`. Max 10 entries, each max 5 data constraints + 5 account constraints. Sets `policy.has_constraints = true`. |
| `update_instruction_constraints` | `owner` | `has_one = owner`. `policy.timelock_duration == 0`. Replaces constraint entries. |
| `close_instruction_constraints` | `owner` | `has_one = owner`. Closes PDA. Sets `policy.has_constraints = false`. |
| `queue_constraints_update` | `owner` | `has_one = owner`. `policy.timelock_duration > 0`. Creates PendingConstraintsUpdate PDA. |
| `apply_constraints_update` | `owner` | `has_one = owner`. Timelock expired. Merges entries. Closes pending PDA. |
| `cancel_constraints_update` | `owner` | `has_one = owner`. Closes PendingConstraintsUpdate PDA. |
| `update_agent_permissions` | `owner` | `has_one = owner`. Agent must exist in vault. Validates permissions bitmask. |
| `create_escrow` | `agent` | `vault.is_agent(agent)`. Agent permission check (CreateEscrow bit). Spending caps + fees apply. Max duration 30 days. |
| `settle_escrow` | `dest_owner/agent` | Escrow status == Active. Not expired. SHA-256 proof verified (if condition_hash set). |
| `refund_escrow` | `source_owner` | Escrow status == Active. Expired (`now >= expires_at`). |
| `close_settled_escrow` | `source_owner` | Escrow status == Settled or Refunded. Closes PDA, reclaims rent. |

---

## 5. Error Code Catalog

70 error codes (6000–6069) using Anchor's `#[error_code]`. See `docs/ERROR-CODES.md` for the full table with categories. Source of truth: `programs/phalnx/src/errors.rs`.

**Categories:** Vault state (7), Access control (2), Stablecoin (2), Policy (5), Spending (1), Session (2), Fee (3), Validation (6), Timelock (3), Security (5), Integration (4), Multi-agent (6), Escrow (6), Constraints (8), Arithmetic (1).

---

## 6. Event Catalog

31 events using Anchor's `#[event]` attribute, emitted via `emit!()`. See `docs/PROJECT.md` for the full table with all field listings. Source of truth: `programs/phalnx/src/events.rs`.

**Core events:** VaultCreated, FundsDeposited, AgentRegistered, AgentSpendLimitChecked, PolicyUpdated, ActionAuthorized, SessionFinalized, DelegationRevoked, AgentRevoked, VaultReactivated, FundsWithdrawn, FeesCollected, VaultClosed, AgentTransferExecuted, PositionsSynced.

**Policy timelock events:** PolicyChangeQueued, PolicyChangeApplied, PolicyChangeCancelled.

**Multi-agent events:** AgentPermissionsUpdated.

**Constraints events:** InstructionConstraintsCreated, InstructionConstraintsUpdated, InstructionConstraintsClosed, ConstraintsChangeQueued, ConstraintsChangeApplied, ConstraintsChangeCancelled.

**Escrow events:** EscrowCreated, EscrowSettled, EscrowRefunded.

---

## 7. Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_ALLOWED_PROTOCOLS` | 10 | Maximum protocols in policy |
| `MAX_ALLOWED_DESTINATIONS` | 10 | Maximum destinations for agent transfers |
| `NUM_BUCKETS` | 144 | SpendTracker epoch bucket count |
| `EPOCH_SECONDS` | 600 | SpendTracker epoch duration (10 minutes) |
| `ROLLING_WINDOW_SECONDS` | 86,400 | 24-hour rolling window |
| `SESSION_EXPIRY_SLOTS` | 20 | ~8 seconds at 400ms/slot |
| `FEE_RATE_DENOMINATOR` | 1,000,000 | Fee rate divisor |
| `PROTOCOL_FEE_RATE` | 200 | 0.02% = 2 BPS (hardcoded) |
| `MAX_DEVELOPER_FEE_RATE` | 500 | 0.05% = 5 BPS (maximum) |
| `USD_DECIMALS` | 6 | USD uses 6 decimal places ($1 = 1,000,000) |
| `USD_BASE` | 1,000,000 | 10^6 multiplier |
| `MAX_AGENTS_PER_VAULT` | 10 | Maximum agents per vault |
| `FULL_PERMISSIONS` | `(1u64 << 21) - 1` | All 21 permission bits set |
| `MAX_SLIPPAGE_BPS` | 5,000 | 50% hard cap on slippage tolerance |
| `MAX_ESCROW_DURATION` | 2,592,000 | 30 days in seconds |
| `AGENT_OVERLAY_ENTRIES_PER_SHARD` | 7 | Agents tracked per overlay shard |
| `NUM_TREASURY_SHARDS` | 1 | Treasury shard count |
| `USDC_MINT` | (feature-flagged) | Hardcoded USDC mint address (devnet/mainnet) |
| `USDT_MINT` | (feature-flagged) | Hardcoded USDT mint address (devnet/mainnet) |
| `JUPITER_PROGRAM` | (hardcoded) | Jupiter V6 program ID |
| `FLASH_TRADE_PROGRAM` | (hardcoded) | Flash Trade program ID |
| `JUPITER_LEND_PROGRAM` | (hardcoded) | Jupiter Lend program ID |
| `JUPITER_EARN_PROGRAM` | (hardcoded) | Jupiter Earn program ID |
| `JUPITER_BORROW_PROGRAM` | (hardcoded) | Jupiter Borrow program ID |
| `FINALIZE_SESSION_DISCRIMINATOR` | (computed) | 8-byte discriminator for finalize_session check |

### Protocol Treasury

| | Address |
|-|---------|
| Protocol Treasury | `ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT` |

---

## 8. Known Limitations & Trust Assumptions

### 8.1 Upgrade Authority

The program retains upgrade authority. The deployer keypair can upgrade the program binary. Before mainnet, this should be transferred to a multisig or renounced after the program is stable. The upgrade authority can change any program logic, including bypassing all security controls.

### 8.2 Stablecoin Trust

The program trusts USDC and USDT as 1:1 USD pegs. Stablecoin amount / 10^6 = USD value. If a stablecoin depegs, the program will overcount or undercount USD spend relative to actual USD value. Hardcoded mint addresses (feature-flagged for devnet/mainnet) prevent spoofed stablecoins from being treated as USD. Non-stablecoin swaps require a stablecoin output — the stablecoin leg is the measured USD spend.

### 8.3 TEE Trust

Production deployments include TEE-backed signing (via Crossmint/Turnkey). The TEE provider's infrastructure is trusted for key custody. A compromised TEE provider could sign arbitrary transactions. The on-chain vault provides defense even against TEE compromise by enforcing spending limits at the blockchain level.

### 8.4 Client-Side Enforcement

The client-side wrapper SDK is purely client-side and is intended for development and testing only. A compromised or modified client can bypass all client-side controls. The wrapper is NOT a security boundary against adversaries. For any deployment with real funds, use the on-chain vault with TEE custody.

### 8.5 Session Window

Sessions expire after 20 slots (~8 seconds). During this window, the agent has a token delegation (`approve`) on the vault's token account. A compromised agent could drain the delegated amount within this window. The delegation amount equals the authorized transaction amount (not the full vault balance).

### 8.6 Permissionless Session Cleanup

Expired sessions can be finalized by anyone (permissionless crank). This is by design — it prevents denial-of-service where a crashed agent leaves sessions open. The expired session is always treated as failed (no fees collected, no stats updated).

### 8.7 Fee Destination Immutability

`fee_destination` is set once at vault creation and never modified. This prevents fee redirection attacks but also means the developer must create a new vault to change fee destination. Protocol fees always go to `PROTOCOL_TREASURY`.

### 8.8 Epoch Bucket Granularity

SpendTracker uses 144 epoch buckets (10 minutes each) for the 24-hour rolling window. The oldest bucket may include spend from up to 10 minutes before the window boundary, introducing a worst-case ~$0.000001 rounding error via proportional boundary correction. This is negligible for practical cap enforcement.

### 8.9 No Reentrancy Risk

The program does not perform CPI calls to untrusted programs. All CPI calls are to the SPL Token program (`approve`, `revoke`, `transfer`). The instruction composition pattern means DeFi protocol calls are separate instructions in the same transaction, not CPIs.

### 8.10 Account Size Limits

`PolicyConfig` has a fixed maximum size of 817 bytes (10 protocols × 32 bytes + 10 destinations × 32 bytes + fields). `SpendTracker` is a zero-copy account of 2,840 bytes (144 epoch buckets + 10 protocol counters). `AgentSpendOverlay` is a zero-copy account of 2,528 bytes (10 agent slots, no shards). `InstructionConstraints` is up to 8,318 bytes (16 constraint entries). All sizes are within Solana's 10MB account limit.

### 8.11 RPC Trust Boundary

The SDK trusts RPC account data for client-side precheck. A malicious RPC can suppress precheck rejections but CANNOT bypass on-chain enforcement. The on-chain program independently validates all spending caps, permissions, and constraints regardless of what the client-side precheck reported. For production deployments: use multiple independent RPC providers and configure `stalenessWarnThresholdSec` in Shield options to detect stale state.

---

## 9. Audit Scope

### In Scope
- All 29 instruction handlers in `programs/phalnx/src/instructions/`
- All 9 PDA account types in `programs/phalnx/src/state/`
- DeFi integration verifiers in `programs/phalnx/src/instructions/integrations/`
- Error definitions in `programs/phalnx/src/errors.rs` (70 codes)
- Event definitions in `programs/phalnx/src/events.rs` (31 events)
- Program entrypoint in `programs/phalnx/src/lib.rs`

### Out of Scope
- Kit SDK (`sdk/kit/`) — off-chain code
- Custody adapters (`sdk/custody/`) — TEE provider integrations
- Plugins (`plugins/`) — framework integrations
- Dashboard (separate repo)

### Test Suites
- `tests/phalnx.ts` — core on-chain tests
- `tests/jupiter-integration.ts` — composed transaction tests
- `tests/flash-trade-integration.ts` — Flash Trade integration tests
- `tests/security-exploits.ts` — exploit scenario tests
- `tests/escrow-integration.ts` — escrow lifecycle tests
- `tests/instruction-constraints.ts` — constraint enforcement tests
- `tests/jupiter-lend-integration.ts` — Jupiter Lend tests
- `tests/surfpool-integration.ts` — Surfnet integration tests

All LiteSVM tests use in-process Solana VM (no network calls). Additional devnet test suites in `tests/devnet-*.ts`.
