# On-Chain Feature Inventory

Complete inventory of everything shipped in the Sigil on-chain program (`programs/sigil/`). Written from source. Use as the definitive "what can the program do?" reference for protocol integrators and auditors.

**Sources of truth:**

- Instructions: `programs/sigil/src/lib.rs` (35 `pub fn` entries)
- Account sizes: `pub const SIZE` in each `programs/sigil/src/state/*.rs`
- Errors: `programs/sigil/src/errors.rs` (75 `#[msg(...)]` variants)
- Events: `programs/sigil/src/events.rs` (37 `#[event]` structs)
- Feature flags: `programs/sigil/Cargo.toml`

Cross-references (do not duplicate these here):

- Access control matrix and invariants → `docs/SECURITY.md`
- Account seed derivation and layout diagrams → `docs/ARCHITECTURE.md`
- Full 75-error table with messages → `docs/ERROR-CODES.md`
- ActionType elimination design → `docs/RFC-ACTIONTYPE-ELIMINATION.md`

---

## 1. Instructions (35)

### Vault Lifecycle (5)

| Instruction        | File                               | Purpose                                                          |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------- |
| `initialize_vault` | `instructions/initialize_vault.rs` | Create AgentVault + PolicyConfig + SpendTracker PDAs; owner-only |
| `freeze_vault`     | `instructions/freeze_vault.rs`     | Immediately freeze vault; preserves all agent entries            |
| `reactivate_vault` | `instructions/reactivate_vault.rs` | Unfreeze vault; optionally register a new agent in the same TX   |
| `close_vault`      | `instructions/close_vault.rs`      | Close vault and reclaim rent from all owned PDAs                 |

### Fund Management (2)

| Instruction      | File                             | Purpose                                            |
| ---------------- | -------------------------------- | -------------------------------------------------- |
| `deposit_funds`  | `instructions/deposit_funds.rs`  | Owner deposits SPL tokens into vault token account |
| `withdraw_funds` | `instructions/withdraw_funds.rs` | Owner withdraws tokens from vault to owner wallet  |

### Agent Execution (3)

| Instruction              | File                                     | Purpose                                                                                                                 |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `validate_and_authorize` | `instructions/validate_and_authorize.rs` | Pre-action: policy, capability, spend cap, slippage check; creates SessionAuthority PDA and captures Phase B2 snapshots |
| `finalize_session`       | `instructions/finalize_session.rs`       | Post-action: revoke delegation, record spend, evaluate post-assertions, close SessionAuthority PDA                      |
| `agent_transfer`         | `instructions/agent_transfer.rs`         | Agent-initiated stablecoin transfer to allowed destination; spend-capped                                                |

### Agent Management (7)

| Instruction                       | File                                              | Purpose                                                                                  |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `register_agent`                  | `instructions/register_agent.rs`                  | Register agent pubkey with capability level and per-agent spend limit (max 10 per vault) |
| `revoke_agent`                    | `instructions/revoke_agent.rs`                    | Remove agent; auto-freezes vault if last agent removed                                   |
| `pause_agent`                     | `instructions/pause_agent.rs`                     | Block all agent actions immediately; preserves configuration                             |
| `unpause_agent`                   | `instructions/unpause_agent.rs`                   | Restore a paused agent's execution rights                                                |
| `queue_agent_permissions_update`  | `instructions/queue_agent_permissions_update.rs`  | Timelock-queue a capability + spend-limit change for one agent                           |
| `apply_agent_permissions_update`  | `instructions/apply_agent_permissions_update.rs`  | Apply queued agent permissions update after timelock expires                             |
| `cancel_agent_permissions_update` | `instructions/cancel_agent_permissions_update.rs` | Cancel a queued agent permissions update                                                 |

Note: `update_agent_permissions` is deleted. All capability changes now require queue → apply.

### Policy (3)

| Instruction             | File                                    | Purpose                                                            |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `queue_policy_update`   | `instructions/queue_policy_update.rs`   | Timelock-queue a policy change (all 14 fields optional)            |
| `apply_pending_policy`  | `instructions/apply_pending_policy.rs`  | Apply queued policy after timelock expires; bumps `policy_version` |
| `cancel_pending_policy` | `instructions/cancel_pending_policy.rs` | Cancel a queued policy update; closes PendingPolicyUpdate PDA      |

Note: `update_policy` is deleted. All policy mutations require queue → apply.

### Constraints (7)

| Instruction                      | File                                             | Purpose                                                                                |
| -------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `create_instruction_constraints` | `instructions/create_instruction_constraints.rs` | Populate a pre-allocated InstructionConstraints PDA with entries and strict-mode flag  |
| `queue_constraints_update`       | `instructions/queue_constraints_update.rs`       | Timelock-queue a full constraints replacement                                          |
| `apply_constraints_update`       | `instructions/apply_constraints_update.rs`       | Apply queued constraints after timelock expires                                        |
| `cancel_constraints_update`      | `instructions/cancel_constraints_update.rs`      | Cancel a queued constraints update                                                     |
| `queue_close_constraints`        | `instructions/queue_close_constraints.rs`        | Timelock-queue closure of the InstructionConstraints PDA                               |
| `apply_close_constraints`        | `instructions/apply_close_constraints.rs`        | Close constraints PDA after timelock; clears `has_constraints`, bumps `policy_version` |
| `cancel_close_constraints`       | `instructions/cancel_close_constraints.rs`       | Cancel a queued constraint closure                                                     |

Note: `update_instruction_constraints` and `close_instruction_constraints` are deleted.

### PDA Allocation (3)

| Instruction                        | File                                               | Purpose                                                                                          |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `allocate_constraints_pda`         | `instructions/allocate_constraints_pda.rs`         | Allocate InstructionConstraints PDA at 10,240-byte CPI limit; must be extended before population |
| `allocate_pending_constraints_pda` | `instructions/allocate_pending_constraints_pda.rs` | Allocate PendingConstraintsUpdate PDA at 10,240-byte CPI limit                                   |
| `extend_pda`                       | `instructions/extend_pda.rs`                       | Grow a constraints PDA by up to 10,240 bytes per call toward full SIZE                           |

### Escrow (4)

| Instruction            | File                                   | Purpose                                                                                              |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `create_escrow`        | `instructions/create_escrow.rs`        | Agent-initiated stablecoin escrow between two vaults; fees deducted upfront, cap-checked at creation |
| `settle_escrow`        | `instructions/settle_escrow.rs`        | Destination agent claims funds before expiry; SHA-256 proof required for conditional escrows         |
| `refund_escrow`        | `instructions/refund_escrow.rs`        | Source agent or owner reclaims expired escrow; cap charge is NOT reversed (prevents cap-washing)     |
| `close_settled_escrow` | `instructions/close_settled_escrow.rs` | Owner closes settled or refunded EscrowDeposit PDA to reclaim rent                                   |

### Post-Execution Assertions (2)

| Instruction              | File                                     | Purpose                                                                       |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `create_post_assertions` | `instructions/create_post_assertions.rs` | Configure byte-level account state checks evaluated inside `finalize_session` |
| `close_post_assertions`  | `instructions/close_post_assertions.rs`  | Close PostExecutionAssertions PDA; returns rent to owner                      |

---

## 2. Account Types (12)

Seed derivation for all PDAs → `docs/ARCHITECTURE.md §Account Model`.

| Account                         | SIZE (bytes) | Source                                    | Purpose                                                                                           |
| ------------------------------- | ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AgentVault`                    | 635          | `state/vault.rs:SIZE`                     | Root vault state; owner, agents vec (≤10 × 49 bytes), lifecycle flags, P&L counters               |
| `PolicyConfig`                  | 826          | `state/policy.rs:SIZE`                    | Spending caps, protocol allow/deny list, leverage limits, slippage, timelock, `policy_version`    |
| `SpendTracker`                  | 2,840        | `state/tracker.rs:SIZE`                   | Zero-copy; 144-epoch circular spend buffer + per-protocol counters (≤10 protocols)                |
| `SessionAuthority`              | 377          | `state/session.rs:SIZE`                   | Per-session auth token; delegation state, fees, stablecoin snapshot, Phase B2 assertion snapshots |
| `AgentSpendOverlay`             | 2,528        | `state/agent_spend_overlay.rs:SIZE`       | Zero-copy; per-agent rolling spend + lifetime stats (≤10 slots)                                   |
| `PendingPolicyUpdate`           | 845          | `state/pending_policy.rs:SIZE`            | Queued policy diff; all fields `Option`; holds `executes_at` timestamp                            |
| `InstructionConstraints`        | 35,888       | `state/constraints.rs:SIZE`               | Zero-copy; up to 64 constraint entries (8 data + 5 account constraints each, 560 bytes/entry)     |
| `PendingConstraintsUpdate`      | 35,904       | `state/pending_constraints.rs:SIZE`       | Queued constraints replacement; same layout plus `executes_at` and `queued_at`                    |
| `PendingCloseConstraints`       | 57           | `state/pending_close_constraints.rs:SIZE` | Queued constraint closure; holds `executes_at` timestamp                                          |
| `PendingAgentPermissionsUpdate` | 105          | `state/pending_agent_perms.rs:SIZE`       | Per-agent queued capability + spend-limit change; seeds include agent pubkey                      |
| `EscrowDeposit`                 | 170          | `state/escrow.rs:SIZE`                    | Escrow state: amount, expiry, 32-byte condition hash, status enum                                 |
| `PostExecutionAssertions`       | 352          | `state/post_assertions.rs:SIZE`           | Zero-copy; up to 4 byte-level account assertions evaluated at finalize (76 bytes/entry)           |

---

## 3. Capability Model

The 21-bit `permissions: u64` ActionType bitmask has been eliminated. `AgentEntry.capability` is now a `u8` with three levels (defined in `state/vault.rs`):

- `CAPABILITY_DISABLED = 0` — agent cannot execute any actions
- `CAPABILITY_OBSERVER = 1` — non-spending actions only
- `CAPABILITY_OPERATOR = 2` — full spending and non-spending execution

The spending/non-spending distinction is derived from the matched `ConstraintEntry.is_spending` field at runtime rather than an action-type enum. Full design rationale → `docs/RFC-ACTIONTYPE-ELIMINATION.md`.

---

## 4. Constraint System

`MAX_CONSTRAINT_ENTRIES = 64` (defined in `state/constraints.rs`). Each entry holds:

- Up to 8 `DataConstraint` fields: byte-offset + length + operator + expected value, matched against instruction data
- Up to 5 `AccountConstraint` fields: key equality checks on instruction accounts
- `is_spending: u8` (1 = spending, 2 = non-spending) — determines which enforcement path applies
- `discriminator_format`: `Anchor8` (8-byte SHA-256 prefix) or `Spl1` (1-byte SPL Token enum index)

Seven `ConstraintOperator` values: `Eq`, `Ne`, `Gte`, `Lte`, `GteSigned`, `LteSigned`, `Bitmask`.

`strict_mode = true` blocks any instruction whose program has no matching entry (default-deny). The PDA reaches 35,888 bytes via the two-step allocate + extend sequence before `create_instruction_constraints`.

Three-tier enforcement model (Verified / Unverified / Unsafe) → `docs/SECURITY.md §12.4`.

---

## 5. Post-Execution Assertions (Phase B)

`MAX_POST_ASSERTION_ENTRIES = 4` (defined in `state/post_assertions.rs`). Assertions are evaluated inside `finalize_session` against account data bytes read from `remaining_accounts`.

Four `AssertionMode` values:

- `Absolute (0)` — compare current bytes against `expected_value` (Phase B1)
- `MaxDecrease (1)` — assert `(snapshot − current) ≤ expected_value`; passes if value increases (Phase B2)
- `MaxIncrease (2)` — assert `(current − snapshot) ≤ expected_value`; passes if value decreases (Phase B2)
- `NoChange (3)` — assert `current == snapshot` byte-for-byte (Phase B2)

Phase B3 adds `CrossFieldLte` via `cross_field_flags` bit 0: ratio enforcement `field_A × 10000 ≤ multiplier_bps × field_B` using u128 arithmetic. Requires `assertion_mode = Absolute`. Snapshots are captured in `validate_and_authorize` and stored in `SessionAuthority.assertion_snapshots[4]`.

Full design → `docs/RFC-ACTIONTYPE-ELIMINATION.md §Phase B`.

---

## 6. Event Emissions (38)

All structs defined in `programs/sigil/src/events.rs`. Every instruction emits at least one event.

**Vault lifecycle (6):** `VaultCreated`, `VaultReactivated`, `VaultFrozen`, `VaultClosed`, `FundsDeposited`, `FundsWithdrawn`

**Agent management (6):** `AgentRegistered`, `AgentRevoked`, `AgentPausedEvent`, `AgentUnpausedEvent`, `AgentSpendLimitChecked`, `AgentTransferExecuted`

**Session execution (4):** `ActionAuthorized`, `SessionFinalized`, `DelegationRevoked`, `FeesCollected`

**Policy changes (3):** `PolicyChangeQueued`, `PolicyChangeApplied`, `PolicyChangeCancelled`

**Constraints lifecycle (7):** `InstructionConstraintsCreated`, `ConstraintsChangeQueued`, `ConstraintsChangeApplied`, `ConstraintsChangeCancelled`, `CloseConstraintsQueued`, `CloseConstraintsApplied`, `CloseConstraintsCancelled`

**PDA allocation (2):** `PdaAllocated`, `PdaExtended`

**Agent permissions changes (3):** `AgentPermissionsChangeQueued`, `AgentPermissionsChangeApplied`, `AgentPermissionsChangeCancelled`

**Escrow (3):** `EscrowCreated`, `EscrowSettled`, `EscrowRefunded`

**Post-execution assertions (3):** `PostAssertionsCreated`, `PostAssertionsClosed`, `PostAssertionChecked`

Full field-level documentation → `docs/SECURITY.md §6`.

---

## 7. Error Code Ranges

75 error codes, `SigilError` enum in `programs/sigil/src/errors.rs`. Anchor maps enum index N to code 6000 + N, so the range is **6000–6074**.

Complete table with full error messages → `docs/ERROR-CODES.md`.

---

## 8. Build Features

From `programs/sigil/Cargo.toml`:

| Feature                                       | Effect                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `devnet` (default)                            | Activates devnet USDC/USDT mint constants                                    |
| `mainnet`                                     | Activates mainnet USDC/USDT mint constants; mutually exclusive with `devnet` |
| `devnet-testing`                              | Implies `devnet`; additional test-only helpers                               |
| `certora`                                     | Formal verification harness; implies `no-entrypoint`                         |
| `cpi`                                         | CPI-compatible build; implies `no-entrypoint`                                |
| `no-entrypoint` / `no-idl` / `no-log-ix-name` | Standard Anchor build flags                                                  |
| `idl-build`                                   | IDL generation; enables `anchor-lang/idl-build` and `anchor-spl/idl-build`   |

---

## 9. Deferred Work

Features scoped out for future releases → `docs/FUTURE.md`.
