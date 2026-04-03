# On-Chain Feature Inventory for SDK + MCP

Exhaustive audit of all Sigil on-chain Rust code mapped to SDK + MCP layer features. Use as a completeness checklist.

**Source:** 29 instructions, 9 PDA types, 31 events, 70 errors, 28 constants across `programs/sigil/src/`

---

## 1. INSTRUCTION FEATURES (29 Instructions)

### Vault Lifecycle (6)

| # | On-Chain Instruction | SDK Feature | MCP Tool | Parameters |
|---|---------------------|-------------|----------|------------|
| 1 | `initialize_vault` | Build + send vault creation TX | `createVault` | vault_id, daily_cap, max_tx_size, protocol_mode, protocols[], max_leverage_bps, max_positions, dev_fee_rate, max_slippage_bps, timelock_duration, allowed_destinations[], protocol_caps[] |
| 2 | `deposit_funds` | Build deposit TX (owner→vault ATA, init_if_needed) | `deposit` | amount, mint |
| 3 | `withdraw_funds` | Build withdraw TX (vault ATA→owner, PDA signer) | `withdraw` | amount, mint |
| 4 | `close_vault` | Build close TX (closes vault+policy+tracker+overlay+pending_policy) | `closeVault` | Requires: open_positions==0, active_escrows==0, constraints closed, pending_policy handled via remaining_accounts |
| 5 | `freeze_vault` | Build freeze TX (Active→Frozen, agents preserved) | `freezeVault` | (none) |
| 6 | `reactivate_vault` | Build reactivate TX (Frozen→Active, optional new agent) | `reactivateVault` | new_agent?, new_agent_permissions? |

### Agent Management (5)

| # | On-Chain Instruction | SDK Feature | MCP Tool | Parameters |
|---|---------------------|-------------|----------|------------|
| 7 | `register_agent` | Build register TX + claim overlay slot | `registerAgent` | agent pubkey, permissions (21-bit bitmask), spending_limit_usd (0=unlimited) |
| 8 | `revoke_agent` | Build revoke TX + release overlay slot + auto-freeze if last | `revokeAgent` | agent_to_remove pubkey |
| 9 | `pause_agent` | Build pause TX (blocks execution, preserves config) | `pauseAgent` | agent_to_pause pubkey |
| 10 | `unpause_agent` | Build unpause TX (restores execution) | `unpauseAgent` | agent_to_unpause pubkey |
| 11 | `update_agent_permissions` | Build permission update TX (blocked by timelock) | `updateAgentPermissions` | agent, new_permissions, spending_limit_usd |

### Policy Management (4)

| # | On-Chain Instruction | SDK Feature | MCP Tool | Parameters |
|---|---------------------|-------------|----------|------------|
| 12 | `update_policy` | Build direct policy update TX (requires timelock==0) | `updatePolicy` | All 14 Option fields: daily_cap, max_tx, protocol_mode, protocols, max_leverage, can_open_positions, max_positions, dev_fee, max_slippage, timelock_duration, allowed_destinations, session_expiry_slots, has_protocol_caps, protocol_caps |
| 13 | `queue_policy_update` | Build queue TX (requires timelock>0, inits PendingPolicyUpdate PDA) | `queuePolicyUpdate` | Same 14 Option fields + executes_at computed |
| 14 | `apply_pending_policy` | Build apply TX (requires timelock expired) | `applyPendingPolicy` | (none — reads from PendingPolicyUpdate PDA) |
| 15 | `cancel_pending_policy` | Build cancel TX (closes PendingPolicyUpdate, returns rent) | `cancelPendingPolicy` | (none) |

### Core Session Flow (3)

| # | On-Chain Instruction | SDK Feature | MCP Tool | Parameters |
|---|---------------------|-------------|----------|------------|
| 16 | `validate_and_authorize` | Build authorize TX (init SessionAuthority PDA, cap checks, fee collection, delegation, instruction scan) | Internal to composed TX | action_type (21 variants), token_mint, amount, target_protocol, leverage_bps? |
| 17 | `finalize_session` | Build finalize TX (revoke delegation, close session, deferred cap check for non-stablecoin, position count update) | Internal to composed TX | success: bool |
| 18 | `agent_transfer` | Build standalone transfer TX (stablecoin-only, destination allowlist, caps+fees) | `agentTransfer` | amount (stablecoin) |

### Escrow (4)

| # | On-Chain Instruction | SDK Feature | MCP Tool | Parameters |
|---|---------------------|-------------|----------|------------|
| 19 | `create_escrow` | Build escrow creation TX (stablecoin-only, cap-checked, fees upfront) | `createEscrow` | escrow_id, amount, expires_at, condition_hash[32] |
| 20 | `settle_escrow` | Build settle TX (dest agent claims before expiry, condition proof) | `settleEscrow` | proof: Vec<u8> (preimage for SHA-256) |
| 21 | `refund_escrow` | Build refund TX (source agent/owner after expiry, cap NOT reversed) | `refundEscrow` | (none — agent or owner signer) |
| 22 | `close_settled_escrow` | Build close TX (owner reclaims rent from settled/refunded) | `closeSettledEscrow` | escrow_id |

### Instruction Constraints (6)

| # | On-Chain Instruction | SDK Feature | MCP Tool | Parameters |
|---|---------------------|-------------|----------|------------|
| 23 | `create_instruction_constraints` | Build constraints creation TX | `createConstraints` | entries[]: {program_id, data_constraints[max 8], account_constraints[max 5]}, strict_mode |
| 24 | `update_instruction_constraints` | Build constraints update TX (blocked by timelock) | `updateConstraints` | entries[], strict_mode |
| 25 | `close_instruction_constraints` | Build constraints close TX (blocked by timelock, closes pending too) | `closeConstraints` | (none) |
| 26 | `queue_constraints_update` | Build queue TX (requires timelock>0) | `queueConstraintsUpdate` | entries[], strict_mode |
| 27 | `apply_constraints_update` | Build apply TX (requires timelock expired) | `applyConstraintsUpdate` | (none) |
| 28 | `cancel_constraints_update` | Build cancel TX | `cancelConstraintsUpdate` | (none) |

### Utility (1)

| # | On-Chain Instruction | SDK Feature | MCP Tool | Parameters |
|---|---------------------|-------------|----------|------------|
| 29 | `sync_positions` | Build sync TX (owner corrects open_positions counter) | `syncPositions` | actual_positions: u8 |

---

## 2. ACCOUNT QUERY FEATURES (9 PDA Types)

### AgentVault (634 bytes) — Seeds: `[vault, owner, vault_id]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getVaultPDA(owner, vault_id)` |
| **Fetch account** | `fetchVault(address)` / `fetchVaultByAddress(address)` |
| **Read owner** | vault.owner (Pubkey) |
| **Read vault_id** | vault.vault_id (u64) |
| **Read status** | vault.status → Active/Frozen/Closed |
| **Read agents list** | vault.agents[] → array of AgentEntry (pubkey, permissions, spending_limit_usd, paused) |
| **Read agent count** | vault.agents.length (0-10) |
| **Check if agent exists** | vault.is_agent(pubkey) → bool |
| **Check agent permission** | vault.has_permission(pubkey, actionType) → bool via 21-bit bitmask |
| **Check if agent paused** | vault.is_agent_paused(pubkey) → bool |
| **Read fee_destination** | vault.fee_destination (immutable Pubkey) |
| **Read open_positions** | vault.open_positions (u8) |
| **Read active_escrow_count** | vault.active_escrow_count (u8) |
| **Read total_transactions** | vault.total_transactions (u64) |
| **Read total_volume** | vault.total_volume (u64, 6 decimals) |
| **Read total_fees_collected** | vault.total_fees_collected (u64, developer fees only) |
| **Is vault active** | vault.status == Active |

### PolicyConfig (817 bytes) — Seeds: `[policy, vault]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getPolicyPDA(vault)` |
| **Fetch account** | `fetchPolicy(vault)` / `fetchPolicyByAddress(address)` |
| **Read daily cap** | policy.daily_spending_cap_usd (u64, 6 decimals) |
| **Read max TX size** | policy.max_transaction_size_usd (u64, 6 decimals) |
| **Read protocol mode** | policy.protocol_mode → ALL(0)/ALLOWLIST(1)/DENYLIST(2) |
| **Read protocols** | policy.protocols[] (max 10 Pubkeys) |
| **Check protocol allowed** | policy.is_protocol_allowed(program_id) → bool |
| **Read max leverage** | policy.max_leverage_bps (u16; 0=disallowed) |
| **Check leverage in limit** | policy.is_leverage_within_limit(bps) → bool |
| **Read can_open_positions** | policy.can_open_positions (bool) |
| **Read max_concurrent_positions** | policy.max_concurrent_positions (u8) |
| **Read developer fee rate** | policy.developer_fee_rate (u16, max 500 = 5BPS) |
| **Read max slippage** | policy.max_slippage_bps (u16, max 5000 = 50%) |
| **Read timelock duration** | policy.timelock_duration (u64 seconds) |
| **Read allowed destinations** | policy.allowed_destinations[] (max 10 Pubkeys) |
| **Check destination allowed** | policy.is_destination_allowed(owner) → bool |
| **Read has_constraints** | policy.has_constraints (bool) |
| **Read has_pending_policy** | policy.has_pending_policy (bool) |
| **Read has_protocol_caps** | policy.has_protocol_caps (bool) |
| **Read protocol_caps** | policy.protocol_caps[] (index-aligned with protocols) |
| **Get protocol cap** | policy.get_protocol_cap(protocol) → Option<u64> |
| **Read session_expiry_slots** | policy.session_expiry_slots (u64; 0=default 20) |
| **Effective expiry** | policy.effective_session_expiry_slots() → u64 |

### SpendTracker (2,840 bytes, zero-copy) — Seeds: `[tracker, vault]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getTrackerPDA(vault)` |
| **Fetch account** | `fetchTracker(vault)` / `fetchTrackerByAddress(address)` |
| **Rolling 24h spend** | tracker.get_rolling_24h_usd(clock) → u64 (sum of 144 10-min buckets) |
| **Per-protocol spend** | tracker.get_protocol_spend(clock, protocol_id) → u64 |
| **Raw epoch buckets** | tracker.buckets[144] → {epoch_id, usd_amount} per bucket |
| **Protocol counters** | tracker.protocol_counters[10] → {protocol, window_start, window_spend} |
| **Remaining cap** | daily_cap - rolling_24h = remaining capacity |
| **Remaining protocol cap** | protocol_cap - protocol_spend = remaining protocol capacity |
| **Cap utilization %** | (rolling_24h / daily_cap) * 100 |

### SessionAuthority (268 bytes) — Seeds: `[session, vault, agent, token_mint]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getSessionPDA(vault, agent, token_mint)` |
| **Fetch account** | `fetchSession(vault, agent, token_mint)` |
| **Read authorized** | session.authorized (bool) |
| **Read authorized_amount** | session.authorized_amount (u64) |
| **Read action_type** | session.action_type (ActionType enum) |
| **Read target protocol** | session.authorized_protocol (Pubkey) |
| **Read token** | session.authorized_token (Pubkey) |
| **Read expiry** | session.expires_at_slot (u64) |
| **Check expired** | session.is_expired(current_slot) → bool |
| **Check valid** | session.is_valid(current_slot) → bool |
| **Read delegated** | session.delegated (bool) |
| **Read delegation_token_account** | session.delegation_token_account (Pubkey) |
| **Read fees** | session.protocol_fee + session.developer_fee (u64 each) |
| **Read output_mint** | session.output_mint (for non-stablecoin swaps) |
| **Read balance_before** | session.stablecoin_balance_before (snapshot for deferred cap check) |

### PendingPolicyUpdate — Seeds: `[pending_policy, vault]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getPendingPolicyPDA(vault)` |
| **Fetch account** | `fetchPendingPolicy(vault)` |
| **Read queued_at** | pending.queued_at (i64 unix timestamp) |
| **Read executes_at** | pending.executes_at (i64 unix timestamp) |
| **Check ready** | pending.is_ready(current_timestamp) → bool |
| **Time remaining** | executes_at - now = seconds until applicable |
| **Read all queued changes** | All 16 Option<> fields showing what will change |

### EscrowDeposit (170 bytes) — Seeds: `[escrow, source_vault, dest_vault, escrow_id]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getEscrowPDA(source_vault, dest_vault, escrow_id)` |
| **Fetch account** | `fetchEscrow(source, dest, escrow_id)` / `fetchEscrowByAddress(address)` |
| **Read source vault** | escrow.source_vault (Pubkey) |
| **Read dest vault** | escrow.destination_vault (Pubkey) |
| **Read amount** | escrow.amount (u64, NET after fees) |
| **Read token_mint** | escrow.token_mint (Pubkey) |
| **Read status** | escrow.status → Active/Settled/Refunded |
| **Read created_at** | escrow.created_at (i64) |
| **Read expires_at** | escrow.expires_at (i64) |
| **Check expired** | clock.unix_timestamp >= escrow.expires_at |
| **Read condition_hash** | escrow.condition_hash[32] (0s = unconditional) |
| **Is conditional** | condition_hash != [0u8;32] |

### InstructionConstraints (8,318 bytes) — Seeds: `[constraints, vault]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getConstraintsPDA(vault)` |
| **Fetch account** | `fetchConstraints(vault)` |
| **Read entries** | constraints.entries[] (max 16 ConstraintEntry) |
| **Read strict_mode** | constraints.strict_mode (bool) |
| **Per-entry details** | entry.program_id, entry.data_constraints[], entry.account_constraints[] |
| **Data constraint details** | {offset, operator (7 types), value[max 32 bytes]} |
| **Account constraint details** | {index, expected Pubkey} |
| **Operator types** | Eq, Ne, Gte, Lte, GteSigned, LteSigned, Bitmask |

### PendingConstraintsUpdate (8,334 bytes) — Seeds: `[pending_constraints, vault]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getPendingConstraintsPDA(vault)` |
| **Fetch account** | `fetchPendingConstraints(vault)` |
| **Read queued changes** | pending.entries[], pending.strict_mode |
| **Read timing** | pending.queued_at, pending.executes_at |
| **Check ready** | pending.is_ready(current_timestamp) |

### AgentSpendOverlay (2,528 bytes, zero-copy) — Seeds: `[agent_spend, vault, 0x00]`

| Feature | What SDK/MCP Should Expose |
|---------|---------------------------|
| **Derive PDA** | `getAgentOverlayPDA(vault)` |
| **Fetch account** | `fetchAgentOverlay(vault)` |
| **Per-agent rolling 24h spend** | overlay.get_agent_rolling_24h_usd(clock, slot_idx) → u64 |
| **Find agent slot** | overlay.find_agent_slot(agent) → Option<usize> |
| **Raw hourly contributions** | entry.contributions[24] (hourly buckets per agent) |
| **Agent remaining capacity** | agent_limit - agent_rolling = remaining |
| **Slot availability** | How many of 10 slots are claimed |

---

## 3. EVENT FEATURES (31 Events)

Every event emitted on-chain should be parseable and optionally subscribable.

| # | Event | Key Fields | SDK/MCP Feature |
|---|-------|-----------|-----------------|
| 1 | `VaultCreated` | vault, owner, vault_id, timestamp | Parse from TX logs, filter by owner |
| 2 | `FundsDeposited` | vault, token_mint, amount, timestamp | Parse deposit history |
| 3 | `FundsWithdrawn` | vault, token_mint, amount, destination, timestamp | Parse withdrawal history |
| 4 | `AgentRegistered` | vault, agent, permissions, spending_limit_usd, timestamp | Track agent changes |
| 5 | `AgentRevoked` | vault, agent, remaining_agents, timestamp | Track agent removals |
| 6 | `AgentPausedEvent` | vault, agent, timestamp | Track pause actions |
| 7 | `AgentUnpausedEvent` | vault, agent, timestamp | Track unpause actions |
| 8 | `AgentPermissionsUpdated` | vault, agent, old_permissions, new_permissions | Track permission changes |
| 9 | `AgentSpendLimitChecked` | vault, agent, agent_rolling_spend, spending_limit_usd, amount, timestamp | Per-agent spend monitoring |
| 10 | `PolicyUpdated` | vault, daily_cap, max_tx, protocol_mode, protocols_count, max_leverage, dev_fee, max_slippage, timestamp | Track policy changes |
| 11 | `PolicyChangeQueued` | vault, executes_at | Track pending timelocks |
| 12 | `PolicyChangeApplied` | vault, applied_at | Track timelock completions |
| 13 | `PolicyChangeCancelled` | vault | Track cancellations |
| 14 | `ActionAuthorized` | vault, agent, action_type, token_mint, amount, usd_amount, protocol, rolling_spend_usd_after, daily_cap_usd, delegated, timestamp | **Core audit trail** — every authorized action |
| 15 | `SessionFinalized` | vault, agent, success, is_expired, timestamp | Track session outcomes |
| 16 | `DelegationRevoked` | vault, token_account, timestamp | Track delegation lifecycle |
| 17 | `FeesCollected` | vault, token_mint, protocol_fee, developer_fee, rates, amounts, treasury, destination, cumulative, timestamp | **Fee analytics** |
| 18 | `AgentTransferExecuted` | vault, destination, amount, mint | Track transfers |
| 19 | `PositionsSynced` | vault, old_count, new_count, timestamp | Track position corrections |
| 20 | `EscrowCreated` | source_vault, dest_vault, escrow_id, amount, token_mint, expires_at, condition_hash | Track escrow lifecycle |
| 21 | `EscrowSettled` | source_vault, dest_vault, escrow_id, amount, settled_by | Track settlements |
| 22 | `EscrowRefunded` | source_vault, dest_vault, escrow_id, amount, refunded_by | Track refunds |
| 23 | `InstructionConstraintsCreated` | vault, entries_count, strict_mode, timestamp | Track constraint changes |
| 24 | `InstructionConstraintsUpdated` | vault, entries_count, strict_mode, timestamp | Track constraint updates |
| 25 | `InstructionConstraintsClosed` | vault, timestamp | Track constraint removal |
| 26 | `ConstraintsChangeQueued` | vault, executes_at | Track pending constraint timelocks |
| 27 | `ConstraintsChangeApplied` | vault, applied_at | Track constraint timelock completions |
| 28 | `ConstraintsChangeCancelled` | vault | Track cancellations |
| 29 | `VaultFrozen` | vault, owner, agents_preserved, timestamp | Track emergency freezes |
| 30 | `VaultClosed` | vault, owner, timestamp | Track vault closures |
| 31 | (implicit) | N/A — close_settled_escrow emits no event | Consider adding for completeness |

---

## 4. CONSTANTS & CONFIG FEATURES

All on-chain constants that SDK/MCP should expose as readable config.

| Constant | Value | SDK/MCP Feature |
|----------|-------|-----------------|
| `MAX_AGENTS_PER_VAULT` | 10 | Validation before register_agent |
| `FULL_PERMISSIONS` | (1<<21)-1 = 2,097,151 | Permission bitmask builder |
| `MAX_ALLOWED_PROTOCOLS` | 10 | Validation before update_policy |
| `MAX_ALLOWED_DESTINATIONS` | 10 | Validation before update_policy |
| `SESSION_EXPIRY_SLOTS` | 20 (~8 seconds) | Session timing info |
| `PROTOCOL_FEE_RATE` | 200 (2 BPS) | Fee calculation/preview |
| `MAX_DEVELOPER_FEE_RATE` | 500 (5 BPS) | Validation before policy set |
| `FEE_RATE_DENOMINATOR` | 1,000,000 | Fee calculation |
| `MAX_SLIPPAGE_BPS` | 5000 (50%) | Validation before policy set |
| `MAX_ESCROW_DURATION` | 2,592,000s (30 days) | Validation before escrow creation |
| `USD_DECIMALS` | 6 | USD conversion |
| `EPOCH_DURATION` | 600s (10 min) | SpendTracker bucket timing |
| `NUM_EPOCHS` | 144 (24h) | SpendTracker window size |
| `OVERLAY_EPOCH_DURATION` | 3600s (1 hour) | Per-agent overlay bucket timing |
| `OVERLAY_NUM_EPOCHS` | 24 (24h) | Per-agent overlay window |
| `USDC_MINT` | (feature-gated devnet/mainnet) | Stablecoin validation |
| `USDT_MINT` | (feature-gated devnet/mainnet) | Stablecoin validation |
| `PROTOCOL_TREASURY` | (feature-gated) | Fee routing |
| `JUPITER_PROGRAM` | JUP6... | Protocol identification |
| `FLASH_TRADE_PROGRAM` | FLASH6... | Protocol identification |
| `JUPITER_LEND_PROGRAM` | JLend... | Protocol identification |
| `JUPITER_EARN_PROGRAM` | jup3Y... | Protocol identification |
| `JUPITER_BORROW_PROGRAM` | jupr8... | Protocol identification |
| `FINALIZE_SESSION_DISCRIMINATOR` | [34,148,144,47,37,130,206,161] | TX composition validation |
| `MAX_CONSTRAINT_ENTRIES` | 16 | Constraint validation |
| `MAX_DATA_CONSTRAINTS_PER_ENTRY` | 8 | Constraint validation |
| `MAX_CONSTRAINT_VALUE_LEN` | 32 | Constraint validation |
| `MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY` | 5 | Constraint validation |

---

## 5. PERMISSION SYSTEM FEATURES (21 ActionTypes)

Each ActionType maps to a permission bit. SDK/MCP should provide:

| Bit | ActionType | Spending? | Position Effect | SDK Feature |
|-----|-----------|-----------|-----------------|-------------|
| 0 | Swap | Yes | None | Permission builder + compose swap |
| 1 | OpenPosition | Yes | Increment | Permission builder + compose perp open |
| 2 | ClosePosition | No | Decrement | Permission builder + compose perp close |
| 3 | IncreasePosition | Yes | None | Permission builder + compose perp increase |
| 4 | DecreasePosition | No | None | Permission builder + compose perp decrease |
| 5 | Deposit | Yes | None | Permission builder + compose lend deposit |
| 6 | Withdraw | No | None | Permission builder + compose lend withdraw |
| 7 | Transfer | Yes | None | Permission builder + agent_transfer |
| 8 | AddCollateral | Yes | None | Permission builder + compose add collateral |
| 9 | RemoveCollateral | No | None | Permission builder + compose remove collateral |
| 10 | PlaceTriggerOrder | No | None | Permission builder + compose trigger order |
| 11 | EditTriggerOrder | No | None | Permission builder + compose edit trigger |
| 12 | CancelTriggerOrder | No | None | Permission builder + compose cancel trigger |
| 13 | PlaceLimitOrder | Yes | Increment | Permission builder + compose limit order |
| 14 | EditLimitOrder | No | None | Permission builder + compose edit limit |
| 15 | CancelLimitOrder | No | Decrement | Permission builder + compose cancel limit |
| 16 | SwapAndOpenPosition | Yes | Increment | Permission builder + compose swap+open |
| 17 | CloseAndSwapPosition | No | Decrement | Permission builder + compose close+swap |
| 18 | CreateEscrow | Yes (standalone) | N/A | Permission builder + create_escrow |
| 19 | SettleEscrow | No | N/A | Permission builder + settle_escrow |
| 20 | RefundEscrow | No | N/A | Permission builder + refund_escrow |

**SDK convenience features needed:**
- `PermissionBuilder` class — chainable `.allow(Swap).allow(OpenPosition).build()`
- Preset bitmasks: `FULL_PERMISSIONS`, `SWAP_ONLY`, `PERPS_ONLY`, `TRANSFER_ONLY`, `ESCROW_ONLY`
- `hasPermission(bitmask, actionType)` — check single permission
- `listPermissions(bitmask)` → string[] of granted action names
- `isSpending(actionType)` → bool
- `positionEffect(actionType)` → Increment/Decrement/None

---

## 6. SPENDING CAP SYSTEM FEATURES (4 Levels)

| Level | On-Chain Enforcement | SDK/MCP Feature |
|-------|---------------------|-----------------|
| **Single TX** | `usd_amount <= max_transaction_size_usd` | Pre-check before submit, show limit |
| **Rolling 24h vault-wide** | `rolling_24h + usd_amount <= daily_spending_cap_usd` | Query remaining cap, show utilization % |
| **Rolling 24h per-agent** | `agent_rolling + usd_amount <= agent.spending_limit_usd` | Query per-agent remaining, show utilization |
| **Rolling 24h per-protocol** | `protocol_rolling + usd_amount <= protocol_cap` | Query per-protocol remaining, show utilization |

**SDK/MCP features for cap system:**
- `checkSpending(vault)` → {rolling_24h, daily_cap, remaining, pct_used, per_protocol: {protocol, spend, cap, remaining}[]}
- `checkAgentSpending(vault, agent)` → {agent_rolling, limit, remaining, pct_used}
- `preflightCapCheck(vault, agent, amount, protocol)` → {would_pass, reason_if_not}
- `stablecoinToUsd(amount, decimals)` → u64 (mirrors on-chain conversion)
- `ceilFee(amount, rate)` → u64 (mirrors on-chain ceiling fee)

---

## 7. FEE SYSTEM FEATURES

| Fee Type | Rate | SDK/MCP Feature |
|----------|------|-----------------|
| **Protocol fee** | Fixed 200/1,000,000 (2 BPS = 0.02%) | Calculate preview, show in UI |
| **Developer fee** | Configurable 0-500/1,000,000 (0-5 BPS) | Calculate preview, show in UI |
| **Ceiling calculation** | `ceil(amount * rate / 1,000,000)` | `previewFees(amount, dev_fee_rate)` → {protocol_fee, developer_fee, net_amount} |
| **Fee collection timing** | Upfront at authorize (non-bypassable) | Show fees before confirming action |
| **Fee destination** | vault.fee_destination (immutable) | Display in vault info |
| **Protocol treasury** | Feature-gated constant | Display in fee breakdown |
| **Cumulative tracking** | vault.total_fees_collected | Display historical fee total |

---

## 8. TIMELOCK SYSTEM FEATURES

| Feature | On-Chain Behavior | SDK/MCP Feature |
|---------|------------------|-----------------|
| **Timelock = 0** | Direct update_policy / update_constraints / update_agent_permissions allowed | Show "instant" mode |
| **Timelock > 0** | Must use queue→apply flow; direct updates blocked | Show "timelocked" mode |
| **Queue** | Creates PendingPolicyUpdate/PendingConstraintsUpdate PDA with executes_at | Show pending changes + countdown |
| **Apply** | Requires clock >= executes_at | Show "ready to apply" / time remaining |
| **Cancel** | Always available, closes pending PDA | Allow cancel at any time |
| **update_agent_permissions** | Blocked entirely if timelock > 0 (must revoke+re-register) | Show warning, guide to workaround |

---

## 9. ESCROW SYSTEM FEATURES

| Feature | On-Chain Behavior | SDK/MCP Feature |
|---------|------------------|-----------------|
| **Create** | Agent creates, stablecoin-only, cap-checked, fees upfront, max 30 days | Build + preview fees + validate cap |
| **Settle** | Dest agent claims before expiry, SHA-256 proof if conditional | Build + proof generation/verification |
| **Refund** | Source agent/owner after expiry, cap NOT reversed | Build + check expiry status |
| **Close** | Owner reclaims rent from settled/refunded | Build + validate status |
| **Conditional** | condition_hash != [0;32] → require SHA-256(proof) == hash | Hash generation helper, proof verification |
| **Status tracking** | Active → Settled or Active → Refunded | Query status, show countdown to expiry |
| **Vault counter** | active_escrow_count incremented/decremented | Block close_vault if > 0 |

---

## 10. CONSTRAINT SYSTEM FEATURES (7 Operators)

| Feature | On-Chain Behavior | SDK/MCP Feature |
|---------|------------------|-----------------|
| **Eq** | Exact byte match at offset | Build constraint: "byte at offset X must equal Y" |
| **Ne** | Not equal | Build constraint: "byte at offset X must NOT equal Y" |
| **Gte** | >= (unsigned LE integer) | Build constraint: "value at offset must be >= threshold" |
| **Lte** | <= (unsigned LE integer) | Build constraint: "value at offset must be <= threshold" |
| **GteSigned** | >= (signed LE, two's complement) | Build constraint: "signed value at offset >= threshold" |
| **LteSigned** | <= (signed LE, two's complement) | Build constraint: "signed value at offset <= threshold" |
| **Bitmask** | (actual & mask) == mask | Build constraint: "bits at offset must include mask" |
| **Account constraints** | ix_accounts[index].pubkey == expected | Build constraint: "account at position X must be Y" |
| **Strict mode** | Reject programs without matching entries | Configure strict/permissive mode |
| **OR logic** | Multiple entries for same program → any match passes | Build multi-rule constraints |
| **AND logic** | Multiple constraints within entry → all must pass | Compose compound rules |
| **Max config** | 16 entries, 8 data constraints each, 5 account constraints each | Validate before submit |

---

## 11. PROTOCOL INTEGRATION FEATURES

### Jupiter V6 (On-chain: slippage verifier)

| Feature | SDK/MCP Feature |
|---------|-----------------|
| Slippage verification (127 swap variants) | `composeJupiterSwap()` — fetches quote, builds validate→swap→finalize |
| Shared accounts route | Handled internally by compose |
| Exact-out route | Handled internally by compose |
| Variable-length swap parsing (WhirlpoolV2, MeteoraDlmmV2, DefiTuna) | Transparent to SDK user |
| **Quote fetching** | `fetchJupiterQuote(inputMint, outputMint, amount, slippage)` |
| **Swap instruction building** | `fetchJupiterSwapInstructions(quote)` |
| **Token pricing** | `getJupiterPrices(mints[])` / `getTokenPriceUsd(mint)` |
| **Token search** | `searchJupiterTokens(query)` / `getTrendingTokens()` |
| **Suspicious token check** | `isTokenSuspicious(mint)` |
| **Lend/Earn** | `composeJupiterLendDeposit()` / `composeJupiterLendWithdraw()` |
| **Trigger orders** | `createJupiterTriggerOrder()` / `cancelJupiterTriggerOrder()` / `getJupiterTriggerOrders()` |
| **Recurring orders** | `createJupiterRecurringOrder()` / `cancelJupiterRecurringOrder()` / `getJupiterRecurringOrders()` |
| **Portfolio** | `getJupiterPortfolio(owner)` |

### Flash Trade (On-chain: generic constraints)

| Feature | SDK/MCP Feature |
|---------|-----------------|
| Open position | `composeFlashTradeOpen()` |
| Close position | `composeFlashTradeClose()` |
| Increase position | `composeFlashTradeIncrease()` |
| Decrease position | `composeFlashTradeDecrease()` |
| Add collateral | `composeFlashTradeAddCollateral()` |
| Remove collateral | `composeFlashTradeRemoveCollateral()` |
| Place trigger order | `composeFlashTradePlaceTriggerOrder()` |
| Edit trigger order | `composeFlashTradeEditTriggerOrder()` |
| Cancel trigger order | `composeFlashTradeCancelTriggerOrder()` |
| Place limit order | `composeFlashTradePlaceLimitOrder()` |
| Edit limit order | `composeFlashTradeEditLimitOrder()` |
| Cancel limit order | `composeFlashTradeCancelLimitOrder()` |
| Swap and open | `composeFlashTradeSwapAndOpen()` |
| Close and swap | `composeFlashTradeCloseAndSwap()` |

### Drift (On-chain: generic constraints)

| Feature | SDK/MCP Feature |
|---------|-----------------|
| Deposit | `composeDriftDeposit()` |
| Withdraw | `composeDriftWithdraw()` |
| Place perp order | `composeDriftPlacePerpOrder()` |
| Place spot order | `composeDriftPlaceSpotOrder()` |
| Cancel order | `composeDriftCancelOrder()` |
| Modify order | `composeDriftModifyOrder()` |
| Settle PnL | `composeDriftSettlePnl()` |

### Kamino (On-chain: generic constraints)

| Feature | SDK/MCP Feature |
|---------|-----------------|
| Deposit (lending) | `composeKaminoDeposit()` |
| Borrow | `composeKaminoBorrow()` |
| Repay | `composeKaminoRepay()` |
| Withdraw | `composeKaminoWithdraw()` |

### Squads V4 (On-chain: generic constraints)

| Feature | SDK/MCP Feature |
|---------|-----------------|
| Create multisig | `createSquadsMultisig()` |
| Propose vault action | `proposeVaultAction()` / `proposeInitializeVault()` / `proposeUpdatePolicy()` |
| Approve proposal | `approveProposal()` |
| Reject proposal | `rejectProposal()` |
| Execute transaction | `executeVaultTransaction()` |
| Status check | `fetchMultisigInfo()` / `fetchProposalInfo()` |

---

## 12. COMPOSITE WORKFLOW FEATURES

These aren't single instructions but combinations that the SDK must orchestrate atomically.

| Workflow | On-Chain TX Shape | SDK Feature |
|----------|------------------|-------------|
| **Permitted DeFi action** | `[validate_and_authorize, <DeFi IX>, finalize_session]` | `composePermittedAction()` / `composePermittedTransaction()` |
| **Permitted swap** | `[validate(Swap), Jupiter swap IX, finalize]` | `composePermittedSwap()` / `composeJupiterSwap()` |
| **Non-stablecoin swap** | `[validate(Swap, non-stable input), Jupiter swap(→stablecoin), finalize(deferred cap check)]` | SDK handles balance snapshot + deferred validation |
| **Multi-instruction DeFi** | `[validate, DeFi IX 1, DeFi IX 2, ..., finalize]` | SDK composes with scan validation |
| **Escrow with conditions** | `[create_escrow(condition_hash)]` → later `[settle_escrow(proof)]` | SDK provides hash helper + proof builder |
| **Timelock policy change** | `[queue_policy_update]` → wait → `[apply_pending_policy]` | SDK provides status checker + auto-apply |
| **Emergency response** | `[freeze_vault]` → investigate → `[reactivate_vault(new_agent)]` | SDK provides emergency workflow |
| **Vault teardown** | `[close_constraints?]` → `[close_settled_escrows?]` → `[close_vault]` | SDK validates prerequisites before close |
| **Agent lifecycle** | `[register]` → `[pause]` → `[unpause]` → `[update_permissions]` → `[revoke]` | SDK provides full agent management |
| **Dry-run policy evaluation** | N/A (off-chain only) | `dryRunPolicy(intent)` → simulates cap/permission/protocol checks without TX |
| **Pre-send simulation** | N/A (off-chain only) | `simulateBeforeSend()` → detect drain attempts, size overflow |
| **Shielded signer** | N/A (SDK wrapping) | `createShieldedSigner()` → wraps any TransactionSigner with pre-sign policy gate |

---

## 13. ERROR HANDLING FEATURES (72 Codes)

All 72 on-chain errors (6000-6071) should be:
- **Parseable** from transaction logs → `parseOnChainError(logs)` → structured error
- **Mapped** to human-readable messages with actionable suggestions (for AI agents)
- **Pre-checkable** where possible → `precheckError(intent)` → catches errors before TX submission
- **Categorized** by domain: vault, agent, policy, session, escrow, constraint, spending, protocol

| Code | Name | Domain |
|------|------|--------|
| 6000 | VaultNotActive | Vault |
| 6001 | UnauthorizedAgent | Agent |
| 6002 | UnauthorizedOwner | Agent |
| 6003 | UnsupportedToken | Token |
| 6004 | ProtocolNotAllowed | Protocol |
| 6005 | TransactionTooLarge | Spending |
| 6006 | SpendingCapExceeded | Spending |
| 6007 | LeverageTooHigh | Policy |
| 6008 | TooManyPositions | Position |
| 6009 | PositionOpeningDisallowed | Position |
| 6010 | SessionNotAuthorized | Session |
| 6011 | InvalidSession | Session |
| 6012 | OpenPositionsExist | Vault |
| 6013 | TooManyAllowedProtocols | Policy |
| 6014 | AgentAlreadyRegistered | Agent |
| 6015 | NoAgentRegistered | Agent |
| 6016 | VaultNotFrozen | Vault |
| 6017 | VaultAlreadyClosed | Vault |
| 6018 | InsufficientBalance | Vault |
| 6019 | DeveloperFeeTooHigh | Fee |
| 6020 | InvalidFeeDestination | Fee |
| 6021 | InvalidProtocolTreasury | Fee |
| 6022 | InvalidAgentKey | Agent |
| 6023 | AgentIsOwner | Agent |
| 6024 | Overflow | Math |
| 6025 | InvalidTokenAccount | Token |
| 6026 | TimelockNotExpired | Timelock |
| 6027 | TimelockActive | Timelock |
| 6028 | NoTimelockConfigured | Timelock |
| 6029 | DestinationNotAllowed | Transfer |
| 6030 | TooManyDestinations | Policy |
| 6031 | InvalidProtocolMode | Policy |
| 6032 | InvalidNonSpendingAmount | Session |
| 6033 | NoPositionsToClose | Position |
| 6034 | CpiCallNotAllowed | Security |
| 6035 | MissingFinalizeInstruction | Security |
| 6036 | NonTrackedSwapMustReturnStablecoin | Stablecoin |
| 6037 | SwapSlippageExceeded | Protocol |
| 6038 | InvalidJupiterInstruction | Protocol |
| 6039 | UnauthorizedTokenTransfer | Security |
| 6040 | SlippageBpsTooHigh | Policy |
| 6041 | ProtocolMismatch | Security |
| 6042 | TooManyDeFiInstructions | Security |
| 6043 | MaxAgentsReached | Agent |
| 6044 | InsufficientPermissions | Agent |
| 6045 | InvalidPermissions | Agent |
| 6046 | EscrowNotActive | Escrow |
| 6047 | EscrowExpired | Escrow |
| 6048 | EscrowNotExpired | Escrow |
| 6049 | InvalidEscrowVault | Escrow |
| 6050 | EscrowConditionsNotMet | Escrow |
| 6051 | EscrowDurationExceeded | Escrow |
| 6052 | InvalidConstraintConfig | Constraint |
| 6053 | ConstraintViolated | Constraint |
| 6054 | InvalidConstraintsPda | Constraint |
| 6055 | InvalidPendingConstraintsPda | Constraint |
| 6056 | AgentSpendLimitExceeded | Spending |
| 6057 | OverlaySlotExhausted | Agent |
| 6058 | AgentSlotNotFound | Agent |
| 6059 | UnauthorizedTokenApproval | Security |
| 6060 | InvalidSessionExpiry | Policy |
| 6061 | UnconstrainedProgramBlocked | Constraint |
| 6062 | ProtocolCapExceeded | Spending |
| 6063 | ProtocolCapsMismatch | Policy |
| 6064 | ActiveEscrowsExist | Vault |
| 6065 | ConstraintsNotClosed | Vault |
| 6066 | PendingPolicyExists | Vault |
| 6067 | AgentPaused | Agent |
| 6068 | AgentAlreadyPaused | Agent |
| 6069 | AgentNotPaused | Agent |

---

## 14. STABLECOIN ARCHITECTURE FEATURES

| Feature | SDK/MCP Feature |
|---------|-----------------|
| `isStablecoinMint(pubkey)` | Check if USDC/USDT |
| Stablecoin input path | Direct USD conversion, immediate cap check + fees |
| Non-stablecoin input path | Balance snapshot → DeFi action → finalize verifies stablecoin increase |
| Non-stable→non-stable rejection | Must route through stablecoin pair |
| USD conversion | `stablecoinToUsd(amount, decimals)` → u64 (amount / 10^decimals * 10^6) |
| Token resolution | `resolveToken(symbol)` → {mint, decimals, isStablecoin} |
| Base unit conversion | `toBaseUnits(amount, decimals)` / `fromBaseUnits(amount, decimals)` |

---

## 15. EMERGENCY CONTROL FEATURES

| Feature | Who Can Do It | SDK/MCP Feature |
|---------|--------------|-----------------|
| **Freeze vault** | Owner only | Instantly blocks all agent operations, preserves agents |
| **Pause agent** | Owner only | Blocks single agent, preserves config |
| **Unpause agent** | Owner only | Restores single agent |
| **Reactivate vault** | Owner only | Unfreezes, optionally registers new agent |
| **Revoke agent** | Owner only | Removes agent, auto-freezes if last |
| **Session expiry** | Permissionless | Anyone can call finalize_session after 20 slots |
| **Escrow refund** | Owner or source agent | Reclaims funds after expiry |
