# Phalnx Wrap Architecture — Implementation Plan v5 (Nuclear)

> **Version:** 5.0 | **Date:** 2026-03-18
> **Approach:** Nuclear cleanup — delete ALL protocol-specific SDK code + entire MCP, rebuild MCP from scratch
> **Supersedes:** v4.1 (surgical migration approach)
> **Audit basis:** v4.1 comprehensive audit + code verification (zero findings on on-chain claims) + nuclear scope decision
> **Companion:** `WRAP-DISCRIMINATOR-TABLES.md` (discriminator bytes)
> **User decisions:** Nuclear delete, discriminators-only for on-chain, dynamic IDL onboarding in SDK

---

## What This Plan Does

1. `wrap()` takes ANY pre-built DeFi instructions and sandwiches them with Phalnx security
2. On-chain discriminator verification prevents spending classification bypass
3. Dynamic protocol onboarding — any Anchor IDL → discriminators computed on the fly
4. Fresh MCP server with ~16 tools (vault management + phalnx_wrap + queries + learn-protocol)
5. ~210K lines deleted (SDK + old SDK + MCP + actions-server + CLI scaffolding + dead tests)

**3-Layer Defense:**
```
Layer 1: SDK Quick-Reject  — mirrors on-chain checks, saves RPC costs
Layer 2: Phalnx On-Chain   — caps, permissions, discriminators, constraints
Layer 3: Finalize Session  — balance verification, spend tracking, delegation revocation
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
| `wrap.ts` | `sdk/kit/src/` | Core wrap() function |
| `action-type-inference.ts` | `sdk/kit/src/` | Discriminator → ActionType map |
| `create-vault.ts` | `sdk/kit/src/` | Simplified vault creation (no constraint compilation) |
| `action_type_verification.rs` | `programs/phalnx/src/instructions/integrations/` | On-chain discriminator verification |
| `packages/mcp/` | Entire package rebuilt | ~15-20 fresh tools against @phalnx/kit |

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

**PREREQUISITE:** Flash Trade discriminator bytes already extracted to `WRAP-DISCRIMINATOR-TABLES.md`. Verify file exists before deleting.

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

## Phase 1: On-Chain Program Changes (Days 2-3) — Parallel with Phase 0

Discriminator verification only. The spending cap is the primary protection — discriminators close the one bypass vector (misclassifying spending as non-spending).

### Step 1.1 — Discriminator verification module

**New file:** `programs/phalnx/src/instructions/integrations/action_type_verification.rs`

Copy Rust implementation from `WRAP-DISCRIMINATOR-TABLES.md`. 24 entries (4 Jupiter + 20 Flash Trade).

Short-data fix: `ix_data.len() < 8` on allowlisted program → reject non-spending declarations.

Add call in BOTH scan paths after protocol allowlist check.

**New error:** `ActionTypeMismatch` (6070). Total error count: 70 → 71.

**No account size changes.** AgentEntry stays at 49 bytes. AgentVault stays at 610 bytes. PolicyConfig stays at 817 bytes. No migration, no existing test breakage.
**Instruction count:** stays at 29.

### Step 1.2 — Build, update IDL, test

```bash
anchor build --no-idl
# Manually add error code 6070 (ActionTypeMismatch) to target/idl/phalnx.json
# Manually update target/types/phalnx.ts to match
npx ts-mocha -p ./tsconfig.json -t 300000 tests/phalnx.ts
```

**No existing test breakage** — no account sizes changed, no fields added.

**4 new LiteSVM tests:**
1. Jupiter swap with wrong ActionType → ActionTypeMismatch
2. Flash Trade openPosition declared as ClosePosition → ActionTypeMismatch
3. Unknown discriminator declared as non-spending → ActionTypeMismatch
4. Short instruction data (< 8 bytes) declared as non-spending → ActionTypeMismatch


**WIP commit:** `[WIP 1/4] feat(program): on-chain discriminator verification`

---

## Phase 2: Core wrap() Implementation (Days 4-7)

### Step 2.1 — Create action-type-inference.ts

**New file:** `sdk/kit/src/action-type-inference.ts`

Two parts:

**Part A — Static discriminator map:** 24 hardcoded entries from `WRAP-DISCRIMINATOR-TABLES.md` (4 Jupiter + 20 Flash Trade). These have verified spending/non-spending classifications.

**Part B — Dynamic discriminator computation:**

```typescript
import { createHash } from "crypto";

/** Compute Anchor discriminator from instruction name: sha256("global:<name>")[0..8] */
export function computeAnchorDiscriminator(instructionName: string): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(`global:${instructionName}`).digest().subarray(0, 8)
  );
}

/** Register a protocol from an IDL. All instructions default to spending (safe). */
export function registerProtocolFromIdl(
  programId: Address,
  idl: { instructions: { name: string }[] },
): DiscriminatorMapping[] {
  return idl.instructions.map(ix => ({
    programId,
    discriminator: computeAnchorDiscriminator(ix.name),
    actionType: ActionType.Swap,  // default: spending
    isSpending: true,             // safe default — owner can override
    confidence: "default" as const,
    instructionName: ix.name,
  }));
}
```

The runtime map starts with 24 static entries and grows as protocols are registered. `inferActionType()` checks the combined map. Unknown instructions still default to Swap (spending).

**Verified by stress test:** 14 protocols, 171 instructions, **100% discriminator computation success rate** (0 failures). Tested against real IDLs (Phalnx, Marinade, Phoenix, Zeta, GooseFx, Lifinity) and synthetic protocols.

Default: unknown → ActionType.Swap (spending).

### Step 2.2 — Update composer.ts

Add `assertionInstructions?: Instruction[]` to `ComposeTransactionParams`. Reserved slot between DeFi instructions and finalize.

### Step 2.3 — Create wrap.ts

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
  inferredActionType: ActionType;
  tier: "known" | "default";
  warnings: string[];
  txSizeBytes: number;
}
```

**12-step implementation:**
1. Fetch vault on-chain (use cachedAccounts if provided) → verify active
2. Fetch policy on-chain (use cachedAccounts if provided)
3. Sync Shield from on-chain state
4. Strip infrastructure instructions (ComputeBudget, SystemProgram)
5. Infer ActionType from first DeFi instruction discriminator
6. Determine targetProtocol from first DeFi instruction programAddress
7. Pre-flight checks: cap headroom, permissions, position limits
8. Build validate_and_authorize instruction
9. Build finalize_session instruction
10. Compose sandwich: `[ComputeBudget, validate, ...defi, finalize]`
11. Simulate with token flow extraction → feed to `detectDrainAttempt()`
    - Pass vault token account addresses in `simulateTransaction`'s `accounts` parameter
    - Parse post-simulation token account balances from response
    - Compare to pre-simulation balances (from step 1-2 vault state fetch)
    - Compute `BalanceDelta[]` for each token account
    - Feed deltas to `detectDrainAttempt()` — currently dead code because nothing produces balanceDeltas
    - ~30-40 lines added to `simulation.ts`: new `extractTokenFlows()` function
12. Compile to versioned TX with ALTs → measure size → return

### Step 2.4 — Create create-vault.ts (simplified from harden.ts)

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

### Step 2.5 — Update index.ts with new exports

```typescript
export { createVault, type CreateVaultOptions, type CreateVaultResult } from "./create-vault.js";
export { wrap, type WrapParams, type WrapResult } from "./wrap.js";
export { inferActionType } from "./action-type-inference.js";
```

Remove harden/withVault exports. Make shield() internal (not exported).

### Step 2.6 — Tests

```bash
pnpm --filter @phalnx/kit test
```

7 new tests: wrap() with known/unknown protocol, vault not found, paused agent, cap exceeded, inferActionType all 24 discriminators, createVault returns shield.

**WIP commit:** `[WIP 2/4] feat(kit): wrap(), action-type inference, createVault`

---

## Phase 3: Rebuild MCP From Scratch (Days 6-9)

### MCP Design: ~15-20 tools, zero legacy

### MCP Integration Model

Phalnx MCP is the **security layer**, not the instruction builder:

```
Agent Framework MCP (SAK, Jupiter, etc.)     Phalnx MCP
           │                                      │
           ├── "Swap 10 USDC for SOL"             │
           ├── calls Jupiter API                  │
           ├── gets swap instructions              │
           │                                      │
           └── passes instructions ───────────────┤
                                                  ├── phalnx_wrap()
                                                  ├── adds validate + finalize
                                                  ├── returns composed TX
                                                  └── agent signs + sends
```

The new MCP server imports ONLY from `@phalnx/kit`. Zero `@phalnx/sdk`. Zero `@solana/web3.js`. Zero `@coral-xyz/anchor`.

```
packages/mcp/
├── package.json          # deps: @modelcontextprotocol/sdk, @phalnx/kit, zod
├── src/
│   ├── index.ts          # Server setup, tool/resource registration
│   ├── config.ts         # RPC connection, signer setup
│   ├── errors.ts         # 71 error codes → human-readable (port from old, add 6070)
│   ├── utils.ts          # Address formatting, amount parsing
│   ├── tools/
│   │   ├── phalnx-wrap.ts       # THE tool — wrap pre-built instructions
│   │   ├── create-vault.ts      # Create vault + register agent + set policy
│   │   ├── check-vault.ts       # Read vault state
│   │   ├── check-spending.ts    # Read spending tracker
│   │   ├── freeze-vault.ts      # Emergency freeze
│   │   ├── reactivate-vault.ts  # Unfreeze
│   │   ├── update-policy.ts     # Modify caps, allowlist, leverage
│   │   ├── register-agent.ts    # Add agent to vault
│   │   ├── revoke-agent.ts      # Remove agent
│   │   ├── pause-agent.ts       # Manual pause
│   │   ├── unpause-agent.ts     # Manual unpause
│   │   ├── deposit.ts           # Owner deposits funds
│   │   ├── withdraw.ts          # Owner withdraws funds
│   │   ├── create-constraints.ts # Set instruction constraints
│   │   ├── check-constraints.ts  # Read constraints
│   │   ├── learn-protocol.ts    # Register protocol from IDL (dynamic onboarding)
│   │   └── index.ts
│   ├── resources/
│   │   ├── vault-state.ts       # shield://vault/{address}
│   │   ├── spending.ts          # shield://spending/{address}
│   │   ├── protocols.ts         # shield://protocols (registry)
│   │   └── index.ts
│   ├── prompts/
│   │   ├── setup-vault.ts       # Guided vault creation
│   │   ├── safe-swap.ts         # Pre-flight checklist
│   │   ├── emergency.ts         # Incident response
│   │   └── index.ts
│   └── data/
│       └── protocol-registry.json
└── tests/
    └── (new tests for each tool)
```

**16 tools** (phalnx-wrap + 12 vault management + create-constraints + check-constraints + learn-protocol)

### learn_protocol tool schema

```typescript
z.object({
  programId: z.string().describe("Program ID (base58)"),
  idl: z.object({
    instructions: z.array(z.object({
      name: z.string(),
      args: z.array(z.object({
        name: z.string(),
        type: z.any(),
      })).optional(),
    })),
  }).describe("Anchor IDL (instructions array at minimum)"),
})
```

Returns: discriminator map for all instructions (all default to spending). Owner marks specific discriminators as non-spending via a follow-up call. The AI agent provides the IDL from the protocol's MCP server, docs, or GitHub.

**Constraint builder note:** The constraints MODULE (sdk/kit/src/constraints/) is deleted in Phase 0. The MCP `create-constraints` tool uses the Codama-generated `getCreateInstructionConstraintsInstruction()` directly, accepting raw byte-level constraint config (program ID, discriminator bytes, field offsets, operators, values).
**3 resources** (vault state, spending, protocol registry)
**3 prompts** (setup, safe-swap, emergency)

### phalnx_wrap tool schema

```typescript
z.object({
  vault: z.string().describe("Vault PDA address (base58)"),
  instructions: z.array(z.object({
    programId: z.string(),
    accounts: z.array(z.object({
      pubkey: z.string(),
      isSigner: z.boolean(),
      isWritable: z.boolean(),
    })),
    data: z.string().describe("base64"),
  })),
  tokenMint: z.string(),
  amount: z.string().optional(),
  actionType: z.string().optional(),
  leverageBps: z.number().optional(),
})
```

### Protocol registry

```json
[
  { "name": "Jupiter V6", "programId": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "category": "swap" },
  { "name": "Flash Trade", "programId": "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn", "category": "perps" },
  { "name": "Kamino Lending", "programId": "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM", "category": "lending" },
  { "name": "Drift V2", "programId": "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", "category": "perps" },
  { "name": "Raydium AMM", "programId": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "category": "swap" },
  { "name": "Orca Whirlpool", "programId": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "category": "swap" },
  { "name": "Meteora DLMM", "programId": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "category": "swap" },
  { "name": "Marginfi V2", "programId": "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", "category": "lending" }
]
```

### Jupiter/token API helpers for MCP

The new MCP needs Jupiter price and token data. These functions existed in the old SDK but were deleted. Create them fresh in the MCP package (pure HTTP, zero blockchain deps):

```
packages/mcp/src/apis/
├── jupiter-price.ts    # getJupiterPrices() — ~40 lines, calls api.jup.ag/price/v2
├── jupiter-tokens.ts   # searchJupiterTokens(), getTrendingTokens(), isTokenSuspicious() — ~80 lines
└── jupiter-lend.ts     # getJupiterLendTokens() — ~50 lines, calls api.jup.ag/lend
```

These live in the MCP package, NOT in @phalnx/kit — they are distribution-layer concerns, not security SDK concerns.

### MCP structured error format

The phalnx_wrap tool should return structured errors for AI agent recovery:

```typescript
{
  error: {
    code: 6006,
    what: "Spending cap exceeded",
    why: "Rolling 24h spend is $450 of $500 cap. This $100 transaction would exceed.",
    remaining_usd: 50,
    alternatives: [
      "Reduce amount to $50 or less",
      "Wait for cap to roll off (oldest spend expires in 2h 15m)",
      "Ask vault owner to increase cap"
    ]
  }
}
```

**WIP commit:** `[WIP 3/4] feat(mcp): rebuild from scratch — 16 tools, 3 resources, 3 prompts, @phalnx/kit only`

---

## Phase 4: Devnet E2E Validation (Days 8-12) — THE GATE

### Step 4.1 — Deploy devnet ALT

Update `PHALNX_ALT_DEVNET` in `sdk/kit/src/alt-config.ts`.

### Step 4.2 — Redeploy program to devnet

Account sizes unchanged (610, 817). Program binary changes (new discriminator module). Old vaults still compatible.

### Step 4.3 — Devnet E2E tests

1. `wrap()` + Jupiter swap (quote API → extract instructions → wrap → sign → send → verify)
2. `wrap()` with unknown protocol (default to spending)
3. Discriminator mismatch — construct TX manually (bypass wrap()) with `actionType: ClosePosition` on a Jupiter swap instruction → on-chain rejects with `ActionTypeMismatch`. Tests on-chain layer directly.
4. learn_protocol — provide Kamino IDL via MCP tool → verify all 48 discriminators registered as spending
5. MCP `phalnx_wrap` tool end-to-end
6. Constraint builder (create constraints → agent violates → rejected)

### Step 4.4 — Full test suite

```bash
anchor build --no-idl && git checkout -- target/idl/ target/types/
npx ts-mocha -p ./tsconfig.json -t 300000 tests/*.ts
pnpm --filter @phalnx/kit test
pnpm --filter @phalnx/mcp test
node scripts/update-test-counts.js
```

### Step 4.5 — Update documentation

| Doc | Action |
|-----|--------|
| `docs/PROJECT.md` | Add discriminator verification. |
| `docs/SECURITY.md` | Add INV-9 (discriminator verification). Update error codes (71). |
| `docs/PROTOCOL-INTEGRATION-GUIDE.md` | Rewrite for wrap() model. |
| `docs/ERROR-CODES.md` | Add 6070 (ActionTypeMismatch). |
| `docs/DEPLOYMENT.md` | Add Turnkey signing policy configuration. No account size changes. |
| `CLAUDE.md` | Update error count (71). No size changes. |

### Step 4.6 — Rename plan

```bash
mv WRAP-ARCHITECTURE-PLAN.md WRAP-ARCHITECTURE-PLAN-v3-archived.md
mv WRAP-ARCHITECTURE-PLAN-v4.md WRAP-ARCHITECTURE-PLAN-v4-archived.md
mv WRAP-ARCHITECTURE-PLAN-v5.md WRAP-ARCHITECTURE-PLAN.md
```

**Final commit:** `feat: wrap() architecture — protocol-agnostic security middleware for AI agents`

---

## Phase Summary

Each phase ends with a **mandatory test gate**. Do not proceed to the next phase until all tests pass. No exceptions.

| Phase | What | Days | Gate |
|-------|------|------|------|
| 0 | Cleanup: delete ~210K lines, fix imports, fix casts | 2 | `pnpm --filter @phalnx/kit test` — 27 surviving test files pass. `pnpm install` succeeds. |
| 1 | On-chain: discriminator verification (1 new module, 1 new error code) | 2 | `anchor build --no-idl` succeeds. All existing LiteSVM tests pass. 4 new discriminator tests pass. `npx ts-mocha -p ./tsconfig.json -t 300000 tests/phalnx.ts` green. |
| 2 | SDK: wrap(), action-type inference, learn-protocol, createVault() | 4 | `pnpm --filter @phalnx/kit test` — all surviving + new wrap() tests pass. Manual test: `wrap()` a mock Jupiter instruction → produces valid composed TX. |
| 3 | MCP: rebuild from scratch — 16 tools, 3 resources, 3 prompts | 4 | `pnpm --filter @phalnx/mcp test` — all new MCP tests pass. Manual test: start MCP server, call `phalnx_wrap` tool → returns composed TX. |
| 4 | Devnet E2E: deploy ALT, redeploy program, real transactions | 3 | Real Jupiter swap wrapped with Phalnx on devnet executes successfully. Spending tracked. Events emitted. |
| **Total** | | **~12 working days** (Phase 0+1 parallel, all others sequential) | |

**Phase transitions are hard stops.** After completing each phase:
1. Run the gate tests
2. Fix any failures
3. WIP commit
4. Only then start the next phase

---

## Codama vs Discriminators — What We Use Each For

**Codama generates the Phalnx client** — the 89 files (17,836 lines) in `sdk/kit/src/generated/` that provide typed instruction builders, account decoders, error types, and event parsing for OUR program. This is what `wrap()` uses to call `getValidateAndAuthorizeInstructionAsync()` and `getFinalizeSessionInstructionAsync()`. Without it, we'd hand-write 29 instruction builders, 9 account decoders, 70 error types, and 43 type definitions. **Codama stays for this purpose.**

**Discriminators do NOT need Codama.** Anchor discriminators are simply `sha256("global:<instruction_name>")[0..8]`. Given an IDL with instruction names, computing discriminators is a 5-line function:

```typescript
import { createHash } from "crypto";
function getDiscriminator(instructionName: string): Uint8Array {
  return createHash("sha256").update(`global:${instructionName}`).digest().slice(0, 8);
}
```

The 24-entry static map in `action-type-inference.ts` is hardcoded byte arrays derived from this formula. The `learn-protocol` MCP tool and `registerProtocolFromIdl()` SDK function use the same formula to register any Anchor protocol dynamically.

**Caveat:** This formula only works for Anchor programs. Non-Anchor Solana programs can use any discriminator scheme. Most major DeFi protocols use Anchor.

| Purpose | Needs Codama? |
|---------|--------------|
| Phalnx typed instruction builders (our program) | **Yes** |
| Phalnx account decoders (read vault state) | **Yes** |
| Phalnx error types + event parsing | **Yes** |
| Discriminator bytes for known protocols (Jupiter, Flash Trade) | **No** — sha256 hash |
| Future dynamic IDL → discriminator extraction | **No** — sha256 hash + IDL names |

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

1. **Default to spending.** Unknown discriminator → Swap (spending). Both SDK and on-chain.
2. **Short data = spending.** ix_data < 8 bytes on allowlisted program → reject non-spending.
3. **PROTOCOL_MODE_ALL is insecure.** Document. Recommend ALLOWLIST.
4. **On-chain is the security boundary.** SDK is UX optimization only.
5. **Both scan paths.** Changes to spending scan MUST be mirrored in non-spending scan.
6. **Build → IDL restore → test.** Every Rust change.
7. **WIP commit per phase.** Never accumulate >1 phase uncommitted.
8. **Check before overwriting.** `git diff <file>` before editing.
9. **Monitor discriminator staleness.** Check protocol program hashes monthly.
10. **Sandwich order.** `[ComputeBudget, PriorityFee?, Validate, ...DeFi, Finalize]`.
11. **Check SIZE after field changes.** Recalculate and verify under 10,240 bytes.
12. **No new Rust crate dependencies.**

## Known Limitations & Edge Cases

| Edge Case | Behavior | Notes |
|-----------|----------|-------|
| 20-instruction scan limit | Over-rejects if finalize is beyond 20 | Safe direction. Not exploitable under TX size limits. |
| Session rent on TX failure | Safe — Solana atomicity reverts init | By design. |
| Flash Trade increaseSize leverage | Declared leverage_bps is sole gate | Cannot verify from instruction data alone. |
| protocol_mode = ALL | Theft possible via custom programs | Recommend ALLOWLIST. |
| Discriminator staleness | Legitimate TXs rejected (safe direction) | Monitor monthly. |
| Non-stablecoin→non-stablecoin | REJECTED | By design — stablecoin-only USD tracking. |
| Non-spending tokenMint | Pass any valid mint (e.g., USDC) for session PDA derivation | Required even for non-spending ops. |
| Non-stablecoin input swap | Must provide `outputStablecoinAccount` in WrapParams | finalize_session verifies stablecoin balance increased. |
| amount not provided for spending | wrap() throws with helpful error | "Spending action requires amount > 0" |

## Canonical Spending Classification (from state/mod.rs)

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
2. `WRAP-DISCRIMINATOR-TABLES.md`
3. `programs/phalnx/src/instructions/validate_and_authorize.rs`
4. `programs/phalnx/src/state/mod.rs`
5. `programs/phalnx/src/state/vault.rs`
6. `programs/phalnx/src/state/policy.rs`
7. `programs/phalnx/src/instructions/finalize_session.rs`
8. `programs/phalnx/src/instructions/agent_transfer.rs`
9. `programs/phalnx/src/instructions/create_escrow.rs`
10. `programs/phalnx/src/state/constraints.rs`
11. `sdk/kit/src/composer.ts`
12. `sdk/kit/src/shield.ts`
13. `sdk/kit/src/protocol-resolver.ts`
14. `sdk/kit/src/harden.ts`
15. `sdk/kit/src/index.ts`
