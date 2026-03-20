# Phalnx Wrap Architecture — Implementation Plan v5 (Nuclear)

> **Version:** 5.2 | **Date:** 2026-03-20
> **Approach:** SDK-first — nail the SDK layer, then website, then MCP
> **Supersedes:** v5.1 (included MCP rebuild inline — now extracted to `MCP-REBUILD-PLAN.md`)
> **Key change in v5.2:** MCP Phase extracted to separate file. Focus is SDK → Website → MCP. Phases renumbered. Status updated to reflect completed work.
> **User decisions:** Nuclear delete, outcome-based spending, fees in validate (solvency) + caps in finalize (truth), MCP deferred until SDK + website ready

---

## What This Plan Does

1. `wrap()` takes ANY pre-built DeFi instructions and sandwiches them with Phalnx security
2. **Outcome-based spending detection** — measures actual stablecoin balance delta to determine spending. No trust in agent declarations.
3. Fresh MCP server with ~15 tools (vault management + phalnx_wrap + queries)
4. ~210K lines deleted (SDK + old SDK + MCP + actions-server + CLI scaffolding + dead tests)

**3-Layer Defense:**
```
Layer 1: SDK Quick-Reject  — mirrors on-chain checks, saves RPC costs
Layer 2: Phalnx Pre-Auth   — permissions, protocol allowlist, constraints, delegation, fee collection
Layer 3: Outcome Verify    — stablecoin balance delta measures actual spending, caps enforced on reality, spend recorded
```

---

## What Gets Deleted (~210K lines)

| Item | Location | Lines | Files |
|------|----------|-------|-------|
| Generated protocol Codama | `sdk/kit/src/generated/protocols/` | 108,700 | 373 |
| ALL integrations | `sdk/kit/src/integrations/` | 3,441 | 14 |
| Analytics module | `sdk/kit/src/analytics/` | 1,968 | 17 |
| Constraints module | `sdk/kit/src/constraints/` | 1,709 | 9 |
| Intent system + client + compat | 7 files in `sdk/kit/src/` | 3,202 | 7 |
| Old SDK entirely | `sdk/typescript/` | 57,241 | ~138 |
| Entire MCP package src | `packages/mcp/src/` | 12,499 | 102 |
| MCP tests | `packages/mcp/tests/` | 9,276 | ~84 |
| Kit dead tests | 20 files in `sdk/kit/tests/` | 9,373 | 20 |
| Actions server | `apps/actions-server/` | ~1,000 | ~10 |
| CLI scaffolding | `packages/phalnx/` | ~1,078 | ~10 |
| **Total** | | **~210,000** | **~785** |

## What Gets Kept (~28K lines)

| Item | Location | Lines | Files |
|------|----------|-------|-------|
| Generated Phalnx client | `sdk/kit/src/generated/` (excl protocols/) | 17,836 | 89 |
| Core SDK modules | 21 files in `sdk/kit/src/` | 7,351 | 21 |
| TEE attestation | `sdk/kit/src/tee/` | 1,313 | 9 |
| x402 payments | `sdk/kit/src/x402/` | 1,402 | 12 |
| On-chain program | `programs/phalnx/src/` | 7,821 | 52 |
| @phalnx/core | `sdk/core/src/` | 891 | 6 |
| Custody adapters | `sdk/custody/` | ~1,482 | ~15 |
| ~~Actions server~~ | Deleted | 0 | 0 |
| Kit surviving tests | `sdk/kit/tests/` | ~7,933 | 27 |
| On-chain tests | `tests/` | 31,680 | 17 |
| **Total kept** | | **~75,000** | |

## What Gets Created

| File | Location | Purpose |
|------|----------|---------|
| `wrap.ts` | `sdk/kit/src/` | Core wrap() function — outcome-based, no discriminator inference |
| `create-vault.ts` | `sdk/kit/src/` | Simplified vault creation (no constraint compilation) |
| `packages/mcp/` | Entire package rebuilt | 15 fresh tools against @phalnx/kit |

---

## Phase 0: Nuclear SDK Cleanup (Days 1-2)

### Step 0.1 — Delete all protocol-specific directories

```bash
rm -rf sdk/kit/src/generated/protocols/
rm -rf sdk/kit/src/integrations/
rm -rf sdk/kit/src/analytics/
rm -rf sdk/kit/src/constraints/
```

**Removes:** 115,818 lines across 413 files.

**NOTE:** `WRAP-DISCRIMINATOR-TABLES.md` contains Flash Trade discriminator bytes (useful for InstructionConstraints byte configs, not for spending classification).

**Verification:** `ls sdk/kit/src/` should show NO `integrations/`, `analytics/`, or `constraints/` directories. `ls sdk/kit/src/generated/` should show NO `protocols/` directory.

### Step 0.2 — Delete intent system + dead files

```bash
rm sdk/kit/src/intent-engine.ts
rm sdk/kit/src/intents.ts
rm sdk/kit/src/intent-validator.ts
rm sdk/kit/src/intent-storage.ts
rm sdk/kit/src/intent-drift.ts
rm sdk/kit/src/client.ts
rm sdk/kit/src/compat.ts
```

**Removes:** 3,202 lines across 7 files.

### Step 0.3 — Fix 3 broken imports in keep files

**File 1: `shield.ts` line 38**
```
Current: import { ACTION_TYPE_MAP, type IntentAction } from "./intents.js";
Fix: Remove line 38. Delete checkIntentCorrespondence() function. Remove intentContext from ShieldedSignerOptions.
```

**File 2: `protocol-resolver.ts` line 18**
```
Current: import type { ProtocolRegistry } from "./integrations/protocol-registry.js";
Fix: Remove import. Refactor resolveProtocol() and isProtocolAllowed() to take allowedProtocols: Address[] instead of ProtocolRegistry. Simplify ProtocolTier enum to { KNOWN = 1, DEFAULT = 2, NOT_ALLOWED = 3 }.
```

**File 3: `harden.ts` lines 29, 31**
```
Current: import type { ProtocolRuleConfig } from "./constraints/types.js";
         import type { ConstraintBuilder } from "./constraints/builder.js";
Fix: Remove both imports. Remove constraint compilation code from harden(). Vault creation no longer auto-creates constraints — that's a separate owner action via MCP constraint tools (rebuilt in Phase 3).
```

### Step 0.4 — Fix `as any` casts (16 total across 7 files)

| File | Count | Lines | Fix |
|------|-------|-------|-----|
| `rpc-helpers.ts` | 4 | :94,:99,:109,:112 | Type RPC calls with proper generics |
| `composer.ts` | 2 | :102,:107 | Explicit type annotation on txMessage |
| `transaction-executor.ts` | 2 | :208,:214 | Type signer correctly against Kit API |
| `simulation.ts` | 2 | :365,:370 | Type simulation RPC call |
| `alt-loader.ts` | 1 | :67 | Fix fetchAddressesForLookupTables arg types |
| `shield.ts` | 1 | :857 | Fix signer interface cast |

**x402 casts (4 additional):** `x402/shielded-fetch.ts` has 4 `as any` casts at lines :233, :236, :245, :256. Fix compile/sign/encode types.

**Total `as any` after x402: 16 across 7 files.**

Also: Remove stale comments:
- `transaction-executor.ts` lines 4-7: references "IntentEngine" orchestration
- `resolve-accounts.ts` line 5: "All 8 PDA types" → should be "All 9 PDA types"
- `policies.ts` line 4: "Port of sdk/typescript/src/wrapper/policies.ts" — remove provenance comment
- `shield.ts` lines 7-13: "Kit differences from web3.js version" — remove migration comments
- `inspector.ts` lines 9-15: web3.js migration comments

### Step 0.5 — Resolve SpendingSummary duplication

`SpendingSummary` defined in both `policies.ts:63` and `shield.ts:72`. Shield version is superset. Delete policies.ts version.

### Step 0.5b — Fix wrong program IDs in surviving files

Pre-existing bugs that survive the cleanup:

| File | Line | Current (WRONG) | Correct |
|------|------|----------------|---------|
| `sdk/core/src/registry.ts` | 31 | `KLend2g3cP87ber8LQVCZFzRSVDMZDnySKFHpagfJgbk` | `KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM` |
| `sdk/kit/src/priority-fees.ts` | 16 | `KLend2g3cP87ber8p1S4JQoTnbs78GDYAHB6h4WjSD9` | `KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM` |
| `sdk/kit/src/priority-fees.ts` | 15 | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBNtSVAwMHjZi1` | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` |

### Step 0.6 — Rewrite index.ts

Delete all exports for removed modules. The new index.ts exports ONLY:

```typescript
// Generated Phalnx client (29 ix, 9 accounts, 70 errors, 35+ types)
export * from "./generated/index.js";

// Constants, permissions, ActionType
export { /* 30+ constants */ } from "./types.js";
export type { Network, PositionEffect } from "./types.js";

// State + PDAs
export { resolveVaultState, getRolling24hUsd, getAgentRolling24hUsd, getProtocolSpend, bytesToAddress } from "./state-resolver.js";
export { getVaultPDA, getPolicyPDA, getTrackerPDA, getSessionPDA, getPendingPolicyPDA, getEscrowPDA, getAgentOverlayPDA, getConstraintsPDA, getPendingConstraintsPDA, resolveAccounts } from "./resolve-accounts.js";

// ALT
export { PHALNX_ALT_DEVNET, PHALNX_ALT_MAINNET, getPhalnxAltAddress } from "./alt-config.js";
export { AltCache, mergeAltAddresses } from "./alt-loader.js";

// Transaction
export { composePhalnxTransaction, validateTransactionSize, measureTransactionSize } from "./composer.js";
export { TransactionExecutor } from "./transaction-executor.js";
export { BlockhashCache, sendAndConfirmTransaction } from "./rpc-helpers.js";

// Events + simulation + tokens
export { parsePhalnxEvents, filterEvents, getEventNames } from "./events.js";
export { simulateBeforeSend, detectDrainAttempt, adjustCU } from "./simulation.js";
export { resolveToken, toBaseUnits, fromBaseUnits } from "./tokens.js";

// Priority fees
export { estimateComposedCU, PriorityFeeEstimator } from "./priority-fees.js";

// Policy + protocol
export { resolvePolicies, toCoreAnalysis, DEFAULT_POLICIES, parseSpendLimit } from "./policies.js";
export { ProtocolTier, resolveProtocol, isProtocolAllowed } from "./protocol-resolver.js";

// Inspector
export { analyzeInstructions } from "./inspector.js";

// Agent errors
export { ON_CHAIN_ERROR_MAP, toAgentError, protocolEscalationError, parseOnChainErrorCode, isAgentError } from "./agent-errors.js";

// Shield (internal after Phase 2, exported during transition)
export { ShieldState, ShieldDeniedError, evaluateInstructions, shield, createShieldedSigner } from "./shield.js";

// Vault creation (renamed in Phase 2)
export { harden, withVault, mapPoliciesToVaultParams, findNextVaultId } from "./harden.js";

// VelocityTracker
export { VelocityTracker } from "./velocity-tracker.js";

// TEE
export { /* all TEE exports */ } from "./tee/index.js";

// Custody
export { custodyAdapterToTransactionSigner } from "./custody-adapter.js";

// x402
export { /* all x402 exports */ } from "./x402/index.js";
```

### Step 0.7 — Delete dead test files (20 files, 9,373 lines)

```bash
# Original 18 intent/handler tests
rm sdk/kit/tests/intent-engine.test.ts      # 996
rm sdk/kit/tests/intents.test.ts             # 975
rm sdk/kit/tests/flash-compose.test.ts       # 969
rm sdk/kit/tests/intent-drift.test.ts        # 556
rm sdk/kit/tests/batch1-misc.test.ts         # 536
rm sdk/kit/tests/kamino-api.test.ts          # 325
rm sdk/kit/tests/e2e-execute.test.ts         # 273
rm sdk/kit/tests/kamino-handler.test.ts      # 264
rm sdk/kit/tests/client.test.ts              # 241
rm sdk/kit/tests/drift-compose.test.ts       # 232
rm sdk/kit/tests/jupiter-handler.test.ts     # 202
rm sdk/kit/tests/intent-storage.test.ts      # 195
rm sdk/kit/tests/protocol-resolver.test.ts   # 173
rm sdk/kit/tests/protocol-registry.test.ts   # 158
rm sdk/kit/tests/t2-handlers.test.ts         # 137
rm sdk/kit/tests/compat.test.ts              # 131
rm sdk/kit/tests/frozen-registry.test.ts     # 93
rm sdk/kit/tests/jupiter-api.test.ts         # 63

# Nuclear additions: constraints + analytics tests
rm sdk/kit/tests/constraints.test.ts         # 1,840
rm sdk/kit/tests/analytics.test.ts           # 1,014
```

**REPAIR 2 test files:**
- `shield-presign.test.ts` (653 lines): Replace `IntentAction` type import with local type alias
- `devnet/lifecycle.test.ts` (179 lines): Replace `PhalnxKitClient` with direct Codama calls

**SURVIVE (27 files — 23 untouched + 2 repaired + 2 helpers, ~7,933 lines):** agent-errors, alt-integration, alt-loader, composer, custody-adapter, events, harden, inspector, policies, priority-fees, resolve-accounts, rpc-helpers, shield, simulation, state-resolver, tee-attestation, tee, tokens, transaction-executor, types, velocity-tracker, x402, devnet/composed-tx, helpers/devnet-setup (365 lines), helpers/mock-rpc (75 lines)

### Step 0.8 — Delete old SDK entirely

```bash
rm -rf sdk/typescript/
```

**Removes:** 57,241 lines. No migration needed because we're also deleting the MCP that depends on it.

Update `packages/mcp/package.json` won't exist after Step 0.9.

### Step 0.9 — Delete entire MCP package

```bash
rm -rf packages/mcp/
```

**Removes:** 12,499 lines (src) + 9,276 lines (tests) = 21,775 lines.

Will be rebuilt from scratch in Phase 3.

### Step 0.9b — Delete actions-server + CLI scaffolding (rebuild later)

```bash
rm -rf apps/actions-server/
rm -rf packages/phalnx/
```

**Removes:** ~2,078 lines total.
- Actions-server (~1,000 lines): All build-tx files use Anchor patterns. Deleted.
- CLI scaffolding (~1,078 lines): Templates generate broken code. Deleted.

### Step 0.9c — Fix custody package.json references

`sdk/custody/crossmint/package.json` and `sdk/custody/privy/package.json` both list `@phalnx/sdk` as peerDependency + devDependency. The actual source files do NOT import from `@phalnx/sdk` (only JSDoc comments reference it). Fix: remove the dependency entries from both package.json files.

### Step 0.9d — Verify workspace config still works

```bash
pnpm install
```

The `pnpm-workspace.yaml` uses glob patterns (`sdk/*`, `packages/*`, `apps/*`) that still match surviving packages. After deleting `packages/mcp/`, `packages/phalnx/`, and `apps/actions-server/`, verify pnpm install succeeds without errors. If any root `package.json` scripts reference deleted packages, remove them.

### Step 0.10 — Run surviving tests

```bash
pnpm --filter @phalnx/kit test
```

Fix any remaining breakage. Expected: 27 test files pass (23 untouched + 2 repaired + 2 helpers, ~7,933 lines).

**WIP commit:** `[WIP 0/4] refactor(kit): nuclear cleanup — delete 207K lines of protocol-specific code + old SDK + MCP`

---

## Phase 1: Outcome-Based Spending Detection (Days 2-4) — Parallel with Phase 0

**The core change:** Stop trusting the agent's spending classification. Measure the vault's actual stablecoin balance delta in `finalize_session`. Caps and spend recording use the measured reality, not declared intent.

**Design: Hybrid** — Fees stay in validate (solvency guarantee). Caps move to finalize (outcome truth). Stablecoin snapshot taken AFTER fee collection for simplicity.

### Step 1.1 — Modify validate_and_authorize.rs

**Remove from stablecoin-input spending path (lines 198-277):**
- Per-transaction USD limit check (lines 205-209)
- Rolling 24h cap check (lines 211-221)
- Per-agent cap check via overlay (lines 223-252)
- Per-protocol cap check (lines 254-266)
- Spend recording: `tracker.record_spend()` and `tracker.record_protocol_spend()` (lines 268-277)

All of these move to `finalize_session`.

**KEEP in validate:** Fee calculation (lines 280-284) + fee CPI transfers (lines 558-650). Delegation = `amount - protocol_fee - developer_fee` (unchanged). This guarantees vault retains enough balance for fees.

**CHANGE: Always snapshot stablecoin balance for ALL spending actions, AFTER fee collection:**

The snapshot goes at session creation (lines 653-670), which is AFTER the fee CPI block (lines 558-650). This means the snapshot already excludes collected fees. Finalize computes `actual_spend = snapshot - current` with NO fee subtraction — the delta IS the pure DeFi spend.

```rust
// Snapshot AFTER fee collection — fees already deducted from vault balance.
// For stablecoin input: vault_token_account IS the stablecoin ATA (post-fee balance)
// For non-stablecoin input: output_stablecoin_account IS the stablecoin ATA (unaffected by fees on different token)
let stablecoin_balance_before = if is_stablecoin_input {
    ctx.accounts.vault_token_account.amount  // already reduced by fees
} else {
    let stablecoin_acct = ctx.accounts.output_stablecoin_account.as_ref()
        .ok_or(error!(PhalnxError::InvalidTokenAccount))?;
    require!(stablecoin_acct.owner == vault_key, PhalnxError::InvalidTokenAccount);
    require!(is_stablecoin_mint(&stablecoin_acct.mint), PhalnxError::TokenNotRegistered);
    stablecoin_acct.amount
};
```

**Why AFTER fees:** Taking the snapshot after fee deduction means the delta between snapshot and finalize-time balance is purely the DeFi execution effect. No fee arithmetic in finalize. Example: vault=1000, fees=5 → snapshot=995 → DeFi spends 900 → current=95 → actual_spend=995-95=900 ✓

**CHANGE: Extend `defi_ix_count == 1` to ALL spending (prevents round-trip fee avoidance):**

Current (line 427-431): `if !is_stablecoin_input { require!(defi_ix_count == 1, ...); }`

Change to: `if is_spending { require!(defi_ix_count == 1, PhalnxError::TooManyDeFiInstructions); }`

This prevents an agent from including USDC→SOL + SOL→USDC in one transaction to produce near-zero net delta while moving significant volume.

**KEEP everything else:** CPI guard, permissions, protocol allowlist, instruction scan (SPL blocking, constraints, Jupiter slippage), position checks, delegation mechanism.

### Step 1.2 — Modify finalize_session.rs

**Replace the non-stablecoin-specific balance check (lines 177-278) with universal outcome check:**

```rust
// Outcome-based spending verification — ALL spending transactions
if session_action_type.is_spending() && success && !is_expired {
    let stablecoin_current = if session_output_mint != Pubkey::default() {
        // Non-stablecoin input: read output stablecoin account
        let acct = ctx.accounts.output_stablecoin_account.as_ref()
            .ok_or(error!(PhalnxError::InvalidTokenAccount))?;
        require!(acct.owner == vault_key, PhalnxError::InvalidTokenAccount);
        require!(is_stablecoin_mint(&acct.mint), PhalnxError::TokenNotRegistered);
        acct.amount
    } else {
        // Stablecoin input: read vault token account (same account that was snapshotted)
        let acct = ctx.accounts.vault_token_account.as_ref()
            .ok_or(error!(PhalnxError::InvalidTokenAccount))?;
        acct.amount
    };

    // Compute actual DeFi spending from balance delta.
    // Snapshot was taken AFTER fee collection in validate, so this delta
    // is purely the DeFi execution effect — no fee arithmetic needed.
    let actual_spend = session_balance_before.saturating_sub(stablecoin_current);

    if actual_spend > 0 {

        // Per-transaction limit (actual_spend is in stablecoin base units = USD at 6 decimals)
        require!(actual_spend <= policy.max_transaction_size_usd, PhalnxError::TransactionTooLarge);

        // Rolling 24h cap
        let mut tracker = ctx.accounts.tracker.load_mut()?;
        let rolling_usd = tracker.get_rolling_24h_usd(&clock);
        let new_total = rolling_usd.checked_add(actual_spend).ok_or(PhalnxError::Overflow)?;
        require!(new_total <= policy.daily_spending_cap_usd, PhalnxError::DailyCapExceeded);

        // Per-agent cap (same pattern as current validate code)
        let agent_entry = vault.get_agent(&session_agent)
            .ok_or(error!(PhalnxError::UnauthorizedAgent))?;
        let mut overlay = ctx.accounts.agent_spend_overlay.load_mut()?;
        if let Some(agent_slot) = overlay.find_agent_slot(&session_agent) {
            if agent_entry.spending_limit_usd > 0 {
                let agent_rolling = overlay.get_agent_rolling_24h_usd(&clock, agent_slot);
                let new_agent = agent_rolling.checked_add(actual_spend).ok_or(PhalnxError::Overflow)?;
                require!(new_agent <= agent_entry.spending_limit_usd, PhalnxError::AgentSpendLimitExceeded);
            }
            overlay.record_agent_contribution(&clock, agent_slot, actual_spend)?;
        }
        drop(overlay);

        // Per-protocol cap
        if let Some(proto_cap) = policy.get_protocol_cap(&session_authorized_protocol) {
            if proto_cap > 0 {
                let proto_spend = tracker.get_protocol_spend(&clock, &session_authorized_protocol);
                let new_proto = proto_spend.checked_add(actual_spend).ok_or(PhalnxError::Overflow)?;
                require!(new_proto <= proto_cap, PhalnxError::ProtocolCapExceeded);
            }
        }

        // Record actual spend
        tracker.record_spend(&clock, actual_spend)?;
        if policy.has_protocol_caps {
            tracker.record_protocol_spend(&clock, &session_authorized_protocol, actual_spend)?;
        }
        drop(tracker);
    }

    // Update vault volume with ACTUAL spend (not declared)
    if actual_spend > 0 {
        vault.total_volume = vault.total_volume
            .checked_add(actual_spend).ok_or(PhalnxError::Overflow)?;
    }
}
```

**Cap exceeded behavior:** If any cap check fails, `finalize_session` returns an error → entire atomic TX reverts (including validate + DeFi instruction + fee collection). Vault balance unchanged. Same end-user behavior as current pre-check, but based on reality.

### Step 1.3 — No SessionAuthority changes

`protocol_fee` and `developer_fee` fields STAY in SessionAuthority (used for event emission in finalize, not for spending math). Snapshot taken after fee collection means `actual_spend = snapshot - current` with no fee arithmetic. No size change (244 bytes).

### Step 1.4 — No new error codes, no new instructions

Existing error codes fire from finalize instead of validate: `TransactionTooLarge`, `DailyCapExceeded`, `AgentSpendLimitExceeded`, `ProtocolCapExceeded`. Same codes, different emission point. Total error count stays at 70. Instruction count stays at 29.

### Step 1.5 — Build, test

```bash
anchor build --no-idl
git checkout -- target/idl/ target/types/
npx ts-mocha -p ./tsconfig.json -t 300000 tests/phalnx.ts
```

Existing tests may need assertion updates (cap errors come from finalize instead of validate, but the TX still reverts the same way). No account size changes → no test structural breakage.

**6 new LiteSVM tests:**
1. Stablecoin swap: cap enforced in finalize on actual delta (not declared amount)
2. Non-stablecoin swap: outcome verification (unified path, same as current but now shared code)
3. Full-balance spend: delegation = amount - fees, DeFi uses delegation, fees collected from remainder
4. Round-trip prevention: 2 DeFi instructions in spending TX → TooManyDeFiInstructions
5. Cap exceeded after execution: entire TX reverts atomically
6. Non-spending declaration: no delegation → DeFi can't move tokens → delta = 0 → correct

**WIP commit:** `[WIP 1/4] refactor(program): outcome-based spending detection — caps on actual stablecoin delta`

---

## Phase 2: Core wrap() Implementation (Days 4-7)

### Step 2.1 — ActionType inference (permissions only, NOT spending classification)

Under outcome-based spending detection, `inferActionType()` is ONLY needed for the permission bitmask check in `validate_and_authorize` ("does this agent have permission to do swaps?"). It does NOT determine spending classification — that's measured by balance delta.

The simplest approach: `wrap()` accepts an optional `actionType` parameter. If not provided, default to `ActionType.Swap` (the broadest permission — if the agent has Swap permission, this works for any protocol). The agent or SDK provides the correct ActionType when permission granularity matters (e.g., agent only has ClosePosition permission).

No `action-type-inference.ts` file needed for spending classification. If we later want automatic permission inference from discriminators, it can be added as a future enhancement.

### Step 2.2 — Create wrap.ts

```typescript
export interface WrapParams {
  vault: Address;
  agent: TransactionSigner;
  instructions: Instruction[];
  rpc: Rpc<SolanaRpcApi>;
  network: "devnet" | "mainnet";
  tokenMint: Address;
  amount: bigint;
  // Optional
  actionType?: ActionType;
  targetProtocol?: Address;
  leverageBps?: number;
  computeUnits?: number;
  priorityFeeMicroLamports?: number;
  outputStablecoinAccount?: Address;
  cachedAccounts?: { vault?: DecodedAgentVault; policy?: DecodedPolicyConfig };
}

export interface WrapResult {
  transaction: CompiledTransaction;
  actionType: ActionType;
  warnings: string[];
  txSizeBytes: number;
}
```

**10-step implementation:**
1. Fetch vault on-chain (use cachedAccounts if provided) → verify active
2. Fetch policy on-chain (use cachedAccounts if provided)
3. Sync Shield from on-chain state
4. Strip infrastructure instructions (ComputeBudget, SystemProgram)
5. Determine targetProtocol from first DeFi instruction programAddress
6. Use provided `actionType` or default to `ActionType.Swap` (broadest permission)
7. Pre-flight checks: permissions, position limits (cap check is advisory — real enforcement in finalize)
8. Build validate_and_authorize instruction
9. Build finalize_session instruction
10. Compose sandwich `[ComputeBudget, validate, ...defi, finalize]` → compile to versioned TX with ALTs → measure size → return

**Note:** Cap headroom pre-check is advisory only (saves SOL on reverted TXs). The real enforcement is in finalize on the actual balance delta. The SDK can optionally simulate and feed to `detectDrainAttempt()` as defense-in-depth.

### Step 2.3 — Create create-vault.ts (simplified from harden.ts)

Rename `harden.ts` → `create-vault.ts`. Remove constraint compilation code (broken imports removed in Phase 0). Simplified: creates vault + registers agent + sets policy + returns Shield context.

```typescript
export async function createVault(options: CreateVaultOptions): Promise<CreateVaultResult> {
  // 1. Build initializeVault instruction
  // 2. Build registerAgent instruction
  // 3. Send transaction
  // 4. Create Shield context (internal)
  // 5. Return { address, vaultId, policyAddress, shield }
}
```

Constraints are set separately by the owner via on-chain constraint instructions (rebuilt in Phase 3 MCP).

### Step 2.4 — Update index.ts with new exports

```typescript
export { createVault, type CreateVaultOptions, type CreateVaultResult } from "./create-vault.js";
export { wrap, type WrapParams, type WrapResult } from "./wrap.js";
```

Remove harden/withVault exports. Make shield() internal (not exported). No `action-type-inference.ts` export — ActionType is passed directly by the caller or defaults to Swap.

### Step 2.5 — Tests

```bash
pnpm --filter @phalnx/kit test
```

6 new tests: wrap() with known/unknown protocol, wrap() default ActionType.Swap, vault not found, paused agent, cap exceeded (advisory), createVault returns shield.

**WIP commit:** `[WIP 2/4] feat(kit): wrap(), createVault`

---

## Phase 3: MCP Rebuild — DEFERRED

> **Extracted to `MCP-REBUILD-PLAN.md`.** MCP will be built after the SDK is battle-tested and the website/dashboard is polished.
> **Sequence:** SDK → Website → MCP.
> **Rationale:** MCP is an SDK consumer. Building it on a moving SDK means rework. The website provides visual validation of vault state before automating with MCP tools.

---

## Phase 3: Devnet E2E Validation — THE GATE

### Step 3.1 — Deploy devnet ALT — DONE (2026-03-20)

ALT deployed at `BtRLCMVamw9c3R8UDwgYBCFur5YVkqACmakVh9xi2aTw` with 5 entries (USDC, USDT, treasury, Instructions sysvar, Clock sysvar). `PHALNX_ALT_DEVNET` updated in `sdk/kit/src/alt-config.ts`.

### Step 3.2 — Redeploy program to devnet — DONE (2026-03-20)

Program redeployed at `4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL` with outcome-based spending detection (Phase 1 Rust changes). Treasury USDC ATA created.

### Step 3.3 — Devnet E2E tests

DONE:
- [x] `createVault()` provisions vault on devnet, reads back Active status
- [x] `wrap()` builds composed TX against live vault

REMAINING:
- [ ] `wrap()` + real Jupiter swap (mainnet-only API — need Surfpool mainnet fork or manual instruction)
- [ ] Round-trip prevention — 2 DeFi instructions in spending TX → TooManyDeFiInstructions
- [ ] Cap exceeded after execution — verify TX reverts atomically
- [ ] Constraint builder (create constraints → agent violates → rejected)

### Step 3.4 — Full test suite

```bash
anchor build --no-idl && git checkout -- target/idl/ target/types/
npx ts-mocha -p ./tsconfig.json -t 300000 tests/*.ts
pnpm --filter @phalnx/kit test
node scripts/update-test-counts.js
```

### Step 3.5 — Update documentation

| Doc | Action |
|-----|--------|
| `docs/PROJECT.md` | Add outcome-based spending detection. |
| `docs/SECURITY.md` | Add INV-9 (outcome-based spending). Error codes unchanged (70). |
| `docs/PROTOCOL-INTEGRATION-GUIDE.md` | Rewrite for wrap() model. |
| `docs/DEPLOYMENT.md` | Add Turnkey signing policy configuration. No account size changes. |
| `CLAUDE.md` | No size or error count changes. Update architecture description. |

### Step 3.6 — Rename plan

```bash
mv WRAP-ARCHITECTURE-PLAN.md WRAP-ARCHITECTURE-PLAN-v3-archived.md
mv WRAP-ARCHITECTURE-PLAN-v4.md WRAP-ARCHITECTURE-PLAN-v4-archived.md
mv WRAP-ARCHITECTURE-PLAN-v5.md WRAP-ARCHITECTURE-PLAN.md
```

**Final commit:** `feat: wrap() architecture — protocol-agnostic security middleware for AI agents`

---

## Phase Summary

Each phase ends with a **mandatory test gate**. Do not proceed to the next phase until all tests pass. No exceptions.

| Phase | What | Status | Gate |
|-------|------|--------|------|
| 0 | Cleanup: delete ~210K lines, fix imports, fix casts | **DONE** | 549 Kit tests pass, 0 failures |
| 1 | On-chain: outcome-based spending detection | **DONE** | `anchor build --no-idl` succeeds, LiteSVM tests pass |
| 2 | SDK: wrap(), createVault() | **DONE** | 16 new tests (13 wrap + 3 createVault), devnet E2E passing |
| 3 | Devnet E2E: ALT, program redeploy, real transactions | **IN PROGRESS** | ALT deployed, program redeployed, basic E2E passing. Remaining: real swap E2E, cap enforcement, constraints |
| — | **Website/Dashboard** | NOT STARTED | Visual vault management, spending dashboard |
| — | **MCP rebuild** (see `MCP-REBUILD-PLAN.md`) | DEFERRED | Blocked on SDK + Website completion |

**Sequence:** SDK (Phases 0-3) → Website → MCP

**Phase transitions are hard stops.** After completing each phase:
1. Run the gate tests
2. Fix any failures
3. WIP commit
4. Only then start the next phase

---

## Codama — What We Use It For

**Codama generates the Phalnx client** — the 89 files (17,836 lines) in `sdk/kit/src/generated/` that provide typed instruction builders, account decoders, error types, and event parsing for OUR program. This is what `wrap()` uses to call `getValidateAndAuthorizeInstructionAsync()` and `getFinalizeSessionInstructionAsync()`. Without it, we'd hand-write 29 instruction builders, 9 account decoders, 70 error types, and 43 type definitions. **Codama stays for this purpose.**

**Discriminators are NOT needed for spending classification.** Under outcome-based spending detection, the program measures stablecoin balance delta. No discriminator table, no inference map, no `action_type_verification.rs`. Spending is math, not classification.

**Discriminators are still useful for:** InstructionConstraints (byte-level parameter validation at offset 0 = discriminator check), and optionally for permission-bit verification in the future (ensuring the instruction matches the declared ActionType for the permission check). But these are optional protocol-specific enhancements, not core spending security.

| Purpose | Needs Codama? |
|---------|--------------|
| Phalnx typed instruction builders (our program) | **Yes** |
| Phalnx account decoders (read vault state) | **Yes** |
| Phalnx error types + event parsing | **Yes** |
| Spending classification | **No** — outcome-based (balance delta) |
| InstructionConstraints (optional) | **No** — raw byte config |

---

## Turnkey Signing Policy (Critical Security Configuration)

The on-chain vault PDA owns the tokens, so agents can't move funds without going through `validate_and_authorize`. But the custody layer adds a second enforcement boundary: **Turnkey signing policies should be configured to only allow signing transactions that contain a `validate_and_authorize` instruction from the Phalnx program (`4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`) as the first non-compute-budget instruction.**

Turnkey evaluates this policy BEFORE signing. If the transaction doesn't match the policy, Turnkey refuses to sign. This prevents a compromised or manipulated agent from requesting the TEE wallet to sign a raw DeFi transaction that bypasses the Phalnx sandwich.

**Defense-in-depth stack:**
1. **On-chain (hard):** Tokens in vault PDA account, not agent wallet. Agent only gets temporary delegation via SPL Approve during validate → revoked in finalize.
2. **Instruction scan (hard):** validate_and_authorize blocks top-level SPL Transfer/Approve between validate and finalize — agent can't redirect delegation.
3. **Custody policy (Turnkey):** Signing policy rejects transactions without Phalnx sandwich — agent can't sign bypass transactions.
4. **TEE attestation:** Agent binary is attested. Signing key never leaves enclave. Agent physically cannot extract key to sign externally.

**Implementation:** During Phase 4 devnet setup, configure the Turnkey organization policy. Document the exact policy JSON in `docs/DEPLOYMENT.md`. This is a one-time configuration per Turnkey organization, not a per-vault setting.

---

## Security Rules

1. **Outcome-based spending.** Stablecoin balance delta determines actual spending. No trust in agent declarations.
2. **Fees in validate, caps in finalize.** Fee collection guarantees solvency. Cap enforcement uses measured reality.
3. **Single DeFi instruction per spending TX.** Prevents round-trip fee avoidance (USDC→SOL→USDC).
4. **PROTOCOL_MODE_ALL is insecure.** Document. Recommend ALLOWLIST.
5. **On-chain is the security boundary.** SDK is UX optimization only.
6. **Both scan paths.** Changes to spending scan MUST be mirrored in non-spending scan.
7. **Build → IDL restore → test.** Every Rust change.
8. **WIP commit per phase.** Never accumulate >1 phase uncommitted.
9. **Check before overwriting.** `git diff <file>` before editing.
10. **Sandwich order.** `[ComputeBudget, PriorityFee?, Validate, ...DeFi, Finalize]`.
11. **Check SIZE after field changes.** Recalculate and verify under 10,240 bytes.
12. **No new Rust crate dependencies.**
13. **Delegation is the primary gate.** Non-spending = no delegation = no token movement. Outcome check is defense-in-depth.

## Known Limitations & Edge Cases

| Edge Case | Behavior | Notes |
|-----------|----------|-------|
| 20-instruction scan limit | Over-rejects if finalize is beyond 20 | Safe direction. Not exploitable under TX size limits. |
| Session rent on TX failure | Safe — Solana atomicity reverts init | By design. |
| Flash Trade increaseSize leverage | Declared leverage_bps is sole gate | Cannot verify from instruction data alone. |
| protocol_mode = ALL | Theft possible via custom programs | Recommend ALLOWLIST. |
| Non-stablecoin→non-stablecoin | REJECTED | By design — stablecoin-only USD tracking. |
| Non-spending tokenMint | Pass any valid mint (e.g., USDC) for session PDA derivation | Required even for non-spending ops. |
| Non-stablecoin input swap | Must provide `outputStablecoinAccount` in WrapParams | finalize measures stablecoin balance delta. |
| amount not provided for spending | wrap() throws with helpful error | "Spending action requires amount > 0" |
| Cap exceeded after execution | Entire TX reverts atomically (including fees) | Same UX as pre-check — TX fails, vault unchanged. |
| Agent under-declares amount | Gets less delegation, spends less. Cap records actual delta. | Self-limiting — agent hurts itself. |
| Agent over-declares amount | Gets more delegation (up to vault balance - fees). Cap records actual delta. | Delegation is capped by vault balance. Actual spend tracked. |
| Full-balance spend attempt | delegation = amount - fees. DeFi can't consume fee reserve. | Solvency guaranteed. |
| Round-trip in single TX | Blocked: `defi_ix_count == 1` for all spending | Prevents USDC→SOL→USDC net-zero delta. |

## Canonical Spending Classification (from state/mod.rs)

**Note:** Under outcome-based spending detection, `is_spending` controls DELEGATION (spending = agent gets delegation, non-spending = no delegation) and PERMISSION authorization. It does NOT determine fees or cap consumption — those are computed from the actual stablecoin balance delta in finalize_session.

| ActionType | is_spending | position_effect | permission_bit |
|------------|-------------|-----------------|----------------|
| Swap | SPENDING | None | 0 |
| OpenPosition | SPENDING | Increment | 1 |
| ClosePosition | non-spending | Decrement | 2 |
| IncreasePosition | SPENDING | None | 3 |
| DecreasePosition | non-spending | None | 4 |
| Deposit | SPENDING | None | 5 |
| Withdraw | non-spending | None | 6 |
| Transfer | SPENDING | None | 7 |
| AddCollateral | SPENDING | None | 8 |
| RemoveCollateral | non-spending | None | 9 |
| PlaceTriggerOrder | non-spending | None | 10 |
| EditTriggerOrder | non-spending | None | 11 |
| CancelTriggerOrder | non-spending | None | 12 |
| PlaceLimitOrder | SPENDING | Increment | 13 |
| EditLimitOrder | non-spending | None | 14 |
| CancelLimitOrder | non-spending | Decrement | 15 |
| SwapAndOpenPosition | SPENDING | Increment | 16 |
| CloseAndSwapPosition | non-spending | Decrement | 17 |
| CreateEscrow | SPENDING | None | 18 |
| SettleEscrow | non-spending | None | 19 |
| RefundEscrow | non-spending | None | 20 |

## File Reading Order for Implementing Agent

1. This plan
2. `programs/phalnx/src/instructions/validate_and_authorize.rs` (lines 198-284 = cap checks to move, lines 280-284 = fee calc to keep, lines 558-650 = fee transfers to keep, lines 653-670 = session creation + snapshot)
3. `programs/phalnx/src/instructions/finalize_session.rs` (lines 178-278 = existing non-stablecoin balance check to generalize)
4. `programs/phalnx/src/state/mod.rs` (ActionType, is_spending, stablecoin_to_usd, constants)
5. `programs/phalnx/src/state/vault.rs`
6. `programs/phalnx/src/state/policy.rs`
7. `programs/phalnx/src/instructions/agent_transfer.rs`
8. `programs/phalnx/src/instructions/create_escrow.rs`
9. `programs/phalnx/src/state/constraints.rs`
10. `sdk/kit/src/composer.ts`
11. `sdk/kit/src/shield.ts`
12. `sdk/kit/src/protocol-resolver.ts`
13. `sdk/kit/src/harden.ts`
14. `sdk/kit/src/index.ts`
15. `WRAP-DISCRIMINATOR-TABLES.md` (reference only — for InstructionConstraints byte configs)
