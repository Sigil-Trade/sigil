# Phalnx SDK Implementation Plan — Persona Gap Resolution

> **Version:** 1.4 (semantic audit) | **Date:** 2026-03-26
> **Source:** 6-persona usability audit (Marcus/Developer, Elena/Agent Builder, Jake/Protocol Integrator, David/Treasury, Sarah/Risk Manager, Rook/Auditor). Note: Jake's perps-specific needs (leverage verification, position tracking) are on-chain architectural concerns addressed in ON-CHAIN-IMPLEMENTATION-PLAN, not SDK surface area. This plan covers Jake's npm/DX needs only.
> **Scope:** 24 steps across P0 (blocking), P1 (usability), P1.5 (council security + audit pre-flights), P2 (design)
> **Constraint:** No feature changesets created by this plan -- project is not live. Exception: Step 1c creates a throwaway test changeset for pipeline verification only (delete after confirming).
> **Prerequisite:** All work happens on `feat/wrap-architecture` or a child branch.
> **Audit v1.1:** 8 fixes from plan quality audit. **v1.2:** 13 fixes from deep verification (3C/3H/3M/4L). **v1.3:** 9 fixes from adversarial second-pass (3 compile-blockers, 2 runtime, 4 doc errors). **v1.4:** 4 fixes from final adversarial audit (1 undefined function, 1 false-positive demotion per Council 3-1, 1 missing import, 1 missing interface field). Total: 34 corrections across 4 audit rounds. See appendix.
> **Effort estimate (revised):** P0 = 3-5 days, P1+P1.5 = 4-6 days, P2 = 1-2 days. Total = 8.5-13 days.

---

## Status Key

- [ ] Not started
- [x] Complete
- [~] In progress

---

## Build Verification Gate (Run After Each Priority Tier)

After completing all steps in a priority tier (P0, P1, P2), run this verification before proceeding:

```bash
pnpm -r run build                                    # All packages compile
pnpm --filter @phalnx/kit test                       # 802 tests pass (source: scripts/test-counts.json)
pnpm --filter @phalnx/kit test:experimental          # Experimental tests pass
```

If any step changes type signatures (Steps 6, 8, 9, 10), the build gate catches regressions immediately. Do NOT defer this to the end — catch breakage at the tier boundary.

---

## Build Verification Gate (Run After Each Priority Tier)

After completing all steps in a priority tier (P0, P1, P2), run this verification before proceeding:

```bash
pnpm -r run build                                    # All packages compile
pnpm --filter @phalnx/kit test                       # 812+ tests pass
pnpm --filter @phalnx/kit test:experimental          # Experimental tests pass
```

If any step changes type signatures (Steps 6, 8, 9, 10), the build gate catches regressions immediately. Do NOT defer this to the end — catch breakage at the tier boundary.

---

## P0 -- Blocking Adoption (Must Ship First)

These four items prevent every persona from using the SDK at all. Nothing in P1/P2 matters until P0 ships.

---

### Step 1: npm Publishing Pipeline Verification

- [ ] **1a.** Verify OIDC Trusted Publishing is configured for all 7 packages on npmjs.com
- [ ] **1b.** Verify `pnpm -r run build` succeeds for all packages (CI does this, but confirm locally)
- [ ] **1c.** Create a test changeset, push to `main`, confirm Version Packages PR opens
- [ ] **1d.** Merge Version Packages PR, confirm packages appear on npmjs.com with provenance

**WHAT:** Validate the existing CI pipeline (`release.yml`) end-to-end. No code changes -- this is operational verification.

**WHERE:**
- `.github/workflows/release.yml` (already written, dual-job check+release with OIDC)
- `.changeset/config.json` (already configured: `access: "public"`, `baseBranch: "main"`)
- npmjs.com package settings for each `@phalnx/*` package

**WHY:** Every persona (Marcus, Elena, Jake, David, Sarah, Rook) reported "can't npm install." The release pipeline exists in CI but has never been triggered on a real merge to `main`. The changeset config, OIDC permissions, and dual-job workflow are all in place -- the gap is that no changeset has been consumed.

**HOW:**
The pipeline is already built:
1. `release.yml` runs on push to `main`, checks for `.changeset/*.md` files or unpublished version bumps
2. If changesets exist: `changesets/action` opens a Version Packages PR (bumps versions, generates CHANGELOG)
3. If no changesets but versions are ahead of npm: publishes with `pnpm changeset publish` + OIDC provenance
4. Each package needs Trusted Publishing configured on npmjs.com: repo `Kaleb-Rupe/phalnx`, workflow `release.yml`, environment `production`

**Packages to publish (7):**

| Package | Path | Version | Peer Dependencies |
|---------|------|---------|-------------------|
| `@phalnx/core` | `sdk/core` | 0.1.5 | none |
| `@phalnx/kit` | `sdk/kit` | 0.1.0 | `@solana/kit ^6.2.0` |
| `@phalnx/platform` | `sdk/platform` | 0.1.4 | none |
| `@phalnx/custody-crossmint` | `sdk/custody/crossmint` | 0.1.4 | none |
| `@phalnx/custody-privy` | `sdk/custody/privy` | 0.1.0 | none |
| `@phalnx/custody-turnkey` | `sdk/custody/turnkey` | 0.1.0 | `@solana/web3.js ^1.95.0` |
| `@phalnx/plugin-solana-agent-kit` | `packages/plugin-solana-agent-kit` | 0.1.0 | `@phalnx/kit`, `solana-agent-kit >=2.0.0` |

**Acceptance criteria:** `npm view @phalnx/kit` returns valid package metadata with provenance attestation.

---

### Step 2: README + Getting Started Guide for @phalnx/kit

- [x] **2a.** Create `sdk/kit/README.md` with install, quickstart, API overview, architecture diagram
- [x] **2b.** Include 30-line code example: createVault -> wrap Jupiter swap -> executeAndConfirm -> getPnL
- [x] **2c.** Document all public exports organized by category (matching `index.ts` section headers)
- [x] **2d.** Link to full docs, examples directory, and API reference

**WHAT:** Create a README that takes a developer from zero to a wrapped Jupiter swap in under 10 minutes.

**WHERE:** `sdk/kit/README.md` (new file -- currently missing)

**WHY:** Marcus (Developer persona) said "I'd spend 2-3 hours reading source code to understand the integration path." Elena (Agent Builder) said this is her "give-up threshold." The SDK has 533 lines of exports in `index.ts` across 35 section headers. Without a README, the only way to discover the API is reading source.

**HOW:**

```
# @phalnx/kit

Kit-native TypeScript SDK for Phalnx — on-chain spending limits and
permission policies for AI agent wallets on Solana.

## Install

npm install @phalnx/kit @solana/kit

## Quickstart

[30-line example showing full flow]

## API Overview

### Core (wrap + execute)
- `PhalnxClient` — stateful client, recommended for production
- `wrap()` — stateless function for single-use wrapping
- `createVault()` — provision an on-chain vault
- `buildOwnerTransaction()` — owner-side tx builder (deposit, freeze, policy)

### State Resolution
- `resolveVaultState()` — fetch complete vault state in one call
- `resolveVaultBudget()` — per-agent budget with remaining headroom

### Analytics
- Security: `getSecurityPosture()`, `getAuditTrail()`
- Spending: `getSpendingVelocity()`, `getSpendingBreakdown()`
- Agents: `getAgentProfile()`, `getAgentLeaderboard()`
- Portfolio: `getPortfolioOverview()`, `getCrossVaultAgentRanking()`

### Safety
- `simulateBeforeSend()` — pre-flight simulation with drain detection
- `shield()` — client-side policy enforcement
- `toAgentError()` — structured error translation for AI agents

[... etc for each section in index.ts ...]

## Architecture

Phalnx wraps arbitrary DeFi instructions with security:
[validate_and_authorize, ...defiInstructions, finalize_session]

All succeed or all revert atomically. The SDK handles instruction
composition, ATA rewriting, ALT compression, and pre-flight checks.

## Testing

import { createMockRpc, createMockVaultState } from "@phalnx/kit/testing"
```

The quickstart example must demonstrate the COMPLETE flow:

```typescript
import { PhalnxClient, createVault, buildOwnerTransaction } from "@phalnx/kit";
import { createSolanaRpc, generateKeyPairSigner, address } from "@solana/kit";

// 1. Create vault (owner operation)
const rpc = createSolanaRpc("https://api.devnet.solana.com");
const vaultResult = await createVault({
  rpc, network: "devnet", owner, agent,
  dailySpendingCapUsd: 500_000_000n, // $500
});
const ownerTx = await buildOwnerTransaction({
  rpc, network: "devnet", owner,
  instructions: [vaultResult.initializeVaultIx, vaultResult.registerAgentIx],
});
// ... sign and send ownerTx with wallet adapter ...

// 2. Wrap a Jupiter swap (agent operation)
const client = new PhalnxClient({
  rpc, vault: vaultResult.vaultAddress, agent, network: "devnet",
});
const jupiterInstructions = /* from Jupiter /swap-instructions API */;
const { signature } = await client.executeAndConfirm(jupiterInstructions, {
  tokenMint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  amount: 100_000_000n, // $100 in USDC base units (6 decimals)
  actionType: ActionType.Swap,
  protocolAltAddresses: jupiterResponse.addressLookupTableAddresses,
});

// 3. Check P&L
const pnl = await client.getPnL();
```

**Acceptance criteria:** A developer can copy-paste the quickstart and modify only their keypairs and RPC URL to get a working integration.

---

### Step 3: Jupiter Integration Example

- [x] **3a.** Create `sdk/kit/examples/jupiter-swap.ts`
- [x] **3b.** Show complete flow: fetch Jupiter quote -> get swap-instructions -> extract ALTs -> wrap -> execute
- [x] **3c.** Include error handling and drain detection
- [x] **3d.** Add inline comments explaining every non-obvious step

**WHAT:** A runnable example file that demonstrates the #1 integration path: Jupiter swap via Phalnx.

**WHERE:** `sdk/kit/examples/jupiter-swap.ts` (new file -- `examples/` directory does not exist)

**WHY:** Marcus (Developer) identified Jupiter as THE critical integration path. The SDK's `wrap()` takes Kit `Instruction[]` but Jupiter's API returns a different format. The conversion path (Jupiter response -> Kit Instruction -> wrap) has zero documentation. Marcus: "Where's the type bridge?"

**HOW:**

```typescript
// sdk/kit/examples/jupiter-swap.ts
//
// Complete example: Wrap a Jupiter V6 swap with Phalnx security.
// Prerequisites: deployed vault, funded with USDC, agent registered.

import {
  PhalnxClient,
  ActionType,
  toAgentError,
  simulateBeforeSend,
  USDC_MINT_DEVNET,
} from "@phalnx/kit";
import { address, createSolanaRpc } from "@solana/kit";
import type { Address, Instruction } from "@solana/kit";

// ---- Configuration ----
const VAULT = address("YOUR_VAULT_ADDRESS");
const RPC_URL = "https://api.devnet.solana.com";
const INPUT_MINT = USDC_MINT_DEVNET;
const OUTPUT_MINT = address("So11111111111111111111111111111111111111112"); // SOL
const AMOUNT_LAMPORTS = 10_000_000; // $10 USDC

async function main() {
  const rpc = createSolanaRpc(RPC_URL);
  const agent = /* your agent TransactionSigner */;

  // Step 1: Get Jupiter quote
  const quoteResponse = await fetch(
    `https://quote-api.jup.ag/v6/quote?` +
    `inputMint=${INPUT_MINT}&outputMint=${OUTPUT_MINT}` +
    `&amount=${AMOUNT_LAMPORTS}&slippageBps=50`
  ).then(r => r.json());

  // Step 2: Get swap instructions (NOT /swap — we need raw instructions)
  //
  // CRITICAL: Use /swap-instructions, not /swap.
  // /swap returns a serialized transaction (unusable with wrap).
  // /swap-instructions returns individual instructions we can compose.
  const swapInstructionsResponse = await fetch(
    "https://quote-api.jup.ag/v6/swap-instructions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: agent.address,
        // Do NOT set wrapAndUnwrapSol — Phalnx handles token accounts
      }),
    }
  ).then(r => r.json());

  // Step 3: Convert Jupiter instructions to Kit format
  //
  // Jupiter returns base64-encoded instructions. Convert to Kit Instruction[].
  // wrap() will: strip ComputeBudget/System ixs, rewrite agent ATAs to vault ATAs,
  // and sandwich with validate_and_authorize + finalize_session.
  const jupiterInstructions: Instruction[] = [
    ...deserializeJupiterIxs(swapInstructionsResponse.setupInstructions ?? []),
    deserializeJupiterIx(swapInstructionsResponse.swapInstruction),
    ...(swapInstructionsResponse.cleanupInstruction
      ? [deserializeJupiterIx(swapInstructionsResponse.cleanupInstruction)]
      : []),
  ];

  // Step 4: Extract ALT addresses from Jupiter response
  //
  // Jupiter routes use address lookup tables that rotate per-route.
  // Always pass fresh values — never cache these.
  const protocolAltAddresses: Address[] = (
    swapInstructionsResponse.addressLookupTableAddresses ?? []
  ).map((a: string) => address(a));

  // Step 5: Wrap and execute
  const client = new PhalnxClient({
    rpc,
    vault: VAULT,
    agent,
    network: "devnet",
  });

  try {
    const { signature, wrapResult } = await client.executeAndConfirm(
      jupiterInstructions,
      {
        tokenMint: INPUT_MINT,
        amount: BigInt(AMOUNT_LAMPORTS), // USDC base units (6 decimals = USD)
        actionType: ActionType.Swap,
        protocolAltAddresses,
      }
    );

    console.log(`Swap executed: ${signature}`);
    console.log(`Warnings: ${wrapResult.warnings.join(", ") || "none"}`);

    // Step 6: Check vault P&L
    const pnl = await client.getPnL();
    console.log(`Vault P&L: ${pnl.pnl} (${pnl.pnlPercent}%)`);
  } catch (err) {
    // Structured error for AI agent consumption
    const agentError = toAgentError(err);
    console.error(`[${agentError.category}] ${agentError.message}`);
    console.error(`Retryable: ${agentError.retryable}`);
    for (const action of agentError.recovery_actions) {
      console.error(`  Recovery: ${action.description}`);
    }
  }
}

// ---- Jupiter instruction deserialization helpers ----
// (These would be in a shared utility in production)

function deserializeJupiterIx(ix: {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}): Instruction {
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({
      address: address(a.pubkey),
      role: a.isWritable
        ? a.isSigner ? 3 /* WRITABLE_SIGNER */ : 2 /* WRITABLE */
        : a.isSigner ? 1 /* READONLY_SIGNER */ : 0 /* READONLY */,
    })),
    data: new Uint8Array(atob(ix.data).split("").map((c) => c.charCodeAt(0))),
    // NOTE: Use Uint8Array (ESM-safe), not Buffer.from (Node-only).
    // @solana/kit uses Uint8Array natively. In Node, Buffer.from works but
    // is not portable to browser/edge environments.
  };
}

function deserializeJupiterIxs(
  ixs: Array<Parameters<typeof deserializeJupiterIx>[0]>
): Instruction[] {
  return ixs.map(deserializeJupiterIx);
}
```

Key design decisions in this example:
- Uses `/swap-instructions` not `/swap` (the most common Jupiter integration mistake)
- Shows the `AccountRole` numeric mapping explicitly (Kit uses numeric roles, not boolean flags)
- Demonstrates `protocolAltAddresses` passthrough (critical for tx size)
- Includes `toAgentError()` error handling (bridges wrap errors to AI agent consumption)

**Acceptance criteria:** Example compiles with `tsc --noEmit`. A developer can adapt it by changing only `VAULT`, `RPC_URL`, and agent signer.

---

### Step 4: `createAndSendVault()` Convenience for Vault Creation

- [x] **4a.** Add `createAndSendVault()` to `sdk/kit/src/create-vault.ts`
- [x] **4b.** Composes createVault instructions -> buildOwnerTransaction -> signAndEncode -> sendAndConfirmTransaction
- [x] **4c.** Returns `CreateAndSendVaultResult` with vault address, signature, and all PDAs
- [x] **4d.** Add tests in `sdk/kit/tests/create-vault.test.ts` (NEW file — does not exist yet) (NEW file — does not exist yet)

**WHAT:** A self-contained function that goes from options to confirmed on-chain vault in one call.

**WHERE:** `sdk/kit/src/create-vault.ts` (extend existing file)

**WHY:** Marcus and Elena both identified the gap between `createVault()` (returns raw instructions) and a confirmed transaction as the #1 DX wall. Currently requires 8 manual steps:
1. Call `createVault()` to get instructions
2. Call `buildOwnerTransaction()` with those instructions
3. Extract the compiled transaction
4. Call `signAndEncode()` with the owner signer
5. Call `sendAndConfirmTransaction()` with the encoded bytes
6. Handle errors
7. Return the vault address

Option A (export `sendKitTransaction()` from testing) was rejected because testing utilities import `node:fs` and `@solana/web3.js`, breaking browser bundlers. The `@phalnx/kit/testing` subpath export exists specifically to isolate these.

Option B (self-contained `createAndSendVault()`) matches the `PhalnxClient.executeAndConfirm()` pattern and keeps the main import path browser-safe.

**HOW:**

```typescript
// Added to sdk/kit/src/create-vault.ts

export interface CreateAndSendVaultOptions extends CreateVaultOptions {
  /** Priority fee in microLamports per CU. Default: 0. */
  priorityFeeMicroLamports?: number;
  /** Override compute units. Default: CU_VAULT_CREATION (400,000). */
  computeUnits?: number;
  /** Confirmation options. */
  confirmOptions?: SendAndConfirmOptions;
}

export interface CreateAndSendVaultResult extends CreateVaultResult {
  /** Transaction signature. */
  signature: string;
}

export async function createAndSendVault(
  options: CreateAndSendVaultOptions,
): Promise<CreateAndSendVaultResult> {
  // 1. Build instructions
  const result = await createVault(options);

  // 2. Compose into owner transaction
  const ownerTx = await buildOwnerTransaction({
    rpc: options.rpc,
    owner: options.owner,
    instructions: [result.initializeVaultIx, result.registerAgentIx],
    network: options.network,
    computeUnits: options.computeUnits,
    priorityFeeMicroLamports: options.priorityFeeMicroLamports,
  });

  // 3. Sign and send
  const encoded = await signAndEncode(options.owner, ownerTx.transaction);
  const signature = await sendAndConfirmTransaction(
    options.rpc,
    encoded,
    options.confirmOptions,
  );

  return { ...result, signature };
}
```

New imports needed: `buildOwnerTransaction` from `./owner-transaction.js`, `signAndEncode`/`sendAndConfirmTransaction` from `./rpc-helpers.js`.

Also export from `index.ts`:
```typescript
export { createVault, createAndSendVault } from "./create-vault.js";
export type { CreateVaultOptions, CreateVaultResult, CreateAndSendVaultOptions, CreateAndSendVaultResult } from "./create-vault.js";
```

**Acceptance criteria:** `await createAndSendVault({ rpc, network: "devnet", owner, agent })` returns a confirmed vault address in one call.

---

## P1 -- Limits Usability

These items do not prevent adoption but create friction, confusion, or force workarounds.

---

### Step 5: WrapParams JSDoc Documentation

- [x] **5a.** Add JSDoc to `amount` field explaining unit semantics
- [x] **5b.** Add JSDoc to `tokenMint` field explaining vault-relative meaning
- [x] **5c.** Add JSDoc to `actionType` field with variant reference
- [x] **5d.** Add JSDoc to `outputStablecoinAccount` explaining non-stablecoin flow

**WHAT:** Add precise JSDoc to the `WrapParams` interface fields that have non-obvious semantics.

**WHERE:** `sdk/kit/src/wrap.ts`, lines 75-102 (`WrapParams` interface)

**WHY:** Marcus (Developer) asked "what unit? USD base units? Token base units? Lamports?" The `amount` field accepts `bigint` with no documentation of its semantics, which change based on whether `tokenMint` is a stablecoin. This is the kind of ambiguity that causes silent financial errors.

**HOW:**

```typescript
export interface WrapParams {
  /** On-chain vault address (PDA). */
  vault: Address;
  /** Agent signer -- must be registered in the vault's agent list. */
  agent: TransactionSigner;
  /** DeFi instructions to wrap. ComputeBudget and System instructions are stripped automatically. */
  instructions: Instruction[];
  /** RPC client for state resolution and blockhash fetching. */
  rpc: Rpc<SolanaRpcApi>;
  /** Network identifier. Accepts "devnet" or "mainnet" (normalized to "mainnet-beta" internally). */
  network: "devnet" | "mainnet";
  /**
   * The token mint being spent FROM the vault.
   *
   * For swaps: the input mint (what leaves the vault).
   * For transfers: the transferred token's mint.
   *
   * The SDK uses this to derive the vault's ATA and rewrite agent ATAs
   * in the DeFi instructions to point at the vault's token account.
   */
  tokenMint: Address;
  /**
   * Amount in the token's native base units.
   *
   * - Stablecoin input (USDC/USDT): base units = USD with 6 decimals.
   *   Example: $100 USDC = 100_000_000n (100 * 10^6).
   *
   * - Non-stablecoin input (SOL, BONK, etc.): raw token base units.
   *   Example: 1 SOL = 1_000_000_000n (10^9 lamports).
   *   Non-stablecoin amounts are NOT cap-checked (by design) --
   *   finalize_session measures actual stablecoin balance delta instead.
   *
   * For spending actions, must be > 0.
   * For non-spending actions (close, withdraw, etc.), must be 0.
   */
  amount: bigint;
  /**
   * DeFi action type. Determines permission check and spending classification.
   * Defaults to `ActionType.Swap` if omitted.
   *
   * 9 spending actions: Swap, OpenPosition, IncreasePosition, Deposit,
   *   Transfer, AddCollateral, PlaceLimitOrder, SwapAndOpenPosition, CreateEscrow.
   *
   * 12 non-spending actions: ClosePosition, DecreasePosition, Withdraw,
   *   RemoveCollateral, PlaceTriggerOrder, EditTriggerOrder, CancelTriggerOrder,
   *   EditLimitOrder, CancelLimitOrder, CloseAndSwapPosition, SettleEscrow, RefundEscrow.
   *
   * Escrow actions (Create/Settle/Refund) use standalone instructions, not wrap().
   */
  actionType?: ActionType;
  // ... remaining fields already documented or obvious
}
```

**Acceptance criteria:** Hovering over any `WrapParams` field in an IDE shows documentation that answers "what unit?" and "what does this mean?" without reading source.

---

### Step 6: Network Type Normalization

- [x] **6a.** Export `normalizeNetwork()` from `sdk/kit/src/types.ts`
- [x] **6b.** Accept `"mainnet"` in all public functions that currently require `"mainnet-beta"`
- [x] **6c.** Add overload to `validateNetwork()` that accepts the short form
- [x] **6d.** Add tests for normalization edge cases

**WHAT:** Eliminate the foot-gun where `PhalnxClient` accepts `"mainnet"` but standalone functions require `"mainnet-beta"`.

**WHERE:**
- `sdk/kit/src/types.ts` (add export, widen `Network` type)
- `sdk/kit/src/wrap.ts` (already has internal `normalizeNetwork()` -- remove, use shared one)
- `sdk/kit/src/owner-transaction.ts` (same)

**WHY:** Marcus identified this as a foot-gun. The type `Network = "devnet" | "mainnet-beta"` is used by state-resolver, analytics, and all pure functions. But `PhalnxClient`, `wrap()`, and `buildOwnerTransaction()` accept `"devnet" | "mainnet"`. The internal `normalizeNetwork()` exists in two files (wrap.ts:123, owner-transaction.ts:78) but is not exported. A developer who reads types.ts sees `Network` requires `"mainnet-beta"`, then passes it to `PhalnxClient` which rejects it.

**HOW:**

In `sdk/kit/src/types.ts`:

```typescript
/** Solana network identifier. Canonical form uses "mainnet-beta". */
export type Network = "devnet" | "mainnet-beta";

/** Short-form network accepted by public APIs. Normalized internally. */
export type NetworkInput = "devnet" | "mainnet" | "mainnet-beta";

/** Convert short-form network to canonical Network type.
 *  "mainnet" -> "mainnet-beta", all others pass through. */
export function normalizeNetwork(network: NetworkInput): Network {
  return network === "mainnet" ? "mainnet-beta" : network as Network;
}
```

Then update `validateNetwork()` to accept `NetworkInput`:

```typescript
export function validateNetwork(network: string): asserts network is Network {
  const normalized = network === "mainnet" ? "mainnet-beta" : network;
  if (normalized !== "devnet" && normalized !== "mainnet-beta") {
    throw new Error(`Invalid network: "${network}". Must be "devnet", "mainnet", or "mainnet-beta".`);
  }
}
```

Remove the duplicate `normalizeNetwork()` from `wrap.ts` (line 123) and `owner-transaction.ts` (line 78). Import from `types.js` instead.

**IMPORTANT (audit fix):** Also update `sdk/kit/src/index.ts` to export `normalizeNetwork` and `NetworkInput` from the types block. The plan modifies `types.ts` but the acceptance criteria requires these to appear in `@phalnx/kit` exports — that means `index.ts` must be updated too.

**SCOPE CLARIFICATION (v1.3 fix):** Step 6 does NOT change the canonical `Network` type or any of the 11 functions
that accept it. Instead it:
1. Exports `normalizeNetwork()` and `NetworkInput` from types.ts
2. Removes duplicate `normalizeNetwork()` from wrap.ts and owner-transaction.ts (they import from types.js instead)
3. Leaves `resolveVaultState()`, `isStablecoinMint()`, etc. accepting `Network` (the canonical type)

Callers pass `"mainnet"` to `PhalnxClient` or `wrap()` (which accept `"devnet" | "mainnet"` and normalize internally).
For standalone functions accepting `Network`, callers normalize first: `resolveVaultState(rpc, vault, agent, undefined, normalizeNetwork("mainnet"))`.
This is the existing pattern — Step 6 just formalizes and exports it.

**Acceptance criteria:** `normalizeNetwork("mainnet") === "mainnet-beta"`. `normalizeNetwork` and `NetworkInput` appear in `@phalnx/kit` exports. `pnpm --filter @phalnx/kit build` succeeds. Duplicate `normalizeNetwork` removed from wrap.ts and owner-transaction.ts.

---

### Step 7: `getAuditTrail()` Enhancement

- [x] **7a.** Add `category` filter parameter to `getAuditTrail()`
- [x] **7b.** Add `txSignature` population via optional enrichment callback (see v1.4 note below)
- [x] **7c.** Add `getAuditTrailSummary()` for high-level counts
- [x] **7d.** Add tests
- [x] **7e.** (v1.4) Handle 10 events missing `timestamp` field — use `executes_at`/`applied_at` fallbacks
- [x] **7f.** (v1.4) Handle 7+ events missing `owner`/`agent` — use `settled_by`/`refunded_by`/vault fallbacks

**WHAT:** Enhance the existing `getAuditTrail()` with filtering and summary capabilities.

**WHERE:** `sdk/kit/src/security-analytics.ts` (line 410, existing function)

**WHY:** Rook (Auditor) and David (Treasury) both need audit trail filtering. The function exists (line 410-430) but:
- No category filtering -- callers must filter the returned array manually
- `txSignature` is always empty string (`""`) -- the function receives `DecodedPhalnxEvent[]` which lacks tx context
- No summary view -- auditors need "5 policy changes, 2 emergencies" at a glance

The implementation was found to already exist with correct event categorization (22 event types mapped to 5 categories). The gap is in filtering and metadata.

**HOW:**

```typescript
// Enhanced signature
export function getAuditTrail(
  events: DecodedPhalnxEvent[],
  options?: {
    /** Filter to specific categories. If omitted, returns all. */
    categories?: AuditEntry["category"][];
    /** Filter to events after this Unix timestamp. */
    since?: number;
    /** Filter to events by a specific actor address. */
    actor?: Address;
  },
): AuditEntry[] {
  const trail: AuditEntry[] = [];

  for (const e of events) {
    const category = AUDIT_EVENTS[e.name];
    if (!category) continue;

    // Category filter
    if (options?.categories && !options.categories.includes(category)) continue;

    const f = e.fields ?? {};

    // v1.4 fix: 10 of 22 events have NO `timestamp` field.
    // PolicyChangeQueued/Applied use `executes_at`/`applied_at`.
    // All 3 Escrow events, AgentPermissionsUpdated, and 3 Constraints queue/apply/cancel
    // have NO temporal field at all. Fall back through alternatives, then 0.
    const timestamp = Number(
      (f.timestamp as bigint) ?? (f.executes_at as bigint) ?? (f.applied_at as bigint) ?? 0n,
    );

    // Time filter — NOTE: timestamp = 0 for ~7 events with no temporal field.
    // These events will always pass a `since` filter (0 < any positive timestamp).
    // Callers using `since` should be aware that some events lack timing data.
    if (options?.since && timestamp > 0 && timestamp < options.since) continue;

    // v1.4 fix: 7+ events have neither `owner` nor `agent` field.
    // Escrow events use `settled_by`/`refunded_by`. Policy/Constraints queue events
    // have only `vault`. VaultCreated has `owner`. Fall back through alternatives.
    const actor = ((f.owner ?? f.agent ?? f.settled_by ?? f.refunded_by ?? f.vault ?? "unknown") as string) as Address;

    // Actor filter
    if (options?.actor && actor !== options.actor) continue;

    trail.push({
      timestamp,
      // v1.4 fix: DecodedPhalnxEvent has NO txSignature field (type is {name, data, fields}).
      // The type cast always returns undefined → "". To populate txSignature, callers must
      // enrich events from the transaction envelope before passing to getAuditTrail().
      // Step 7b should add an optional `enrichTxSignature?: (event: DecodedPhalnxEvent) => string`
      // callback, or accept `Array<DecodedPhalnxEvent & { txSignature?: string }>` as input.
      txSignature: (e as { txSignature?: string }).txSignature ?? "",
      category,
      action: e.name,
      actor,
      details: f,
      description: describeEvent(e),
    });
  }

  return trail;
}

// New summary function
export interface AuditTrailSummary {
  totalEntries: number;
  byCategory: Record<AuditEntry["category"], number>;
  latestTimestamp: number;
  uniqueActors: Address[];
}

export function getAuditTrailSummary(trail: AuditEntry[]): AuditTrailSummary {
  const byCategory: Record<string, number> = {
    policy_change: 0,
    agent_change: 0,
    emergency: 0,
    escrow: 0,
    constraint_change: 0,
  };
  const actors = new Set<string>();
  let latest = 0;

  for (const entry of trail) {
    byCategory[entry.category]++;
    actors.add(entry.actor);
    if (entry.timestamp > latest) latest = entry.timestamp;
  }

  return {
    totalEntries: trail.length,
    byCategory: byCategory as Record<AuditEntry["category"], number>,
    latestTimestamp: latest,
    uniqueActors: Array.from(actors) as Address[],
  };
}
```

Add exports to `index.ts`:
```typescript
export { getSecurityPosture, evaluateAlertConditions, getAuditTrail, getAuditTrailSummary } from "./security-analytics.js";
export type { SecurityPosture, SecurityCheck, Alert, AuditEntry, AuditTrailSummary } from "./security-analytics.js";
```

**Acceptance criteria:** `getAuditTrail(events, { categories: ["emergency"] })` returns only emergency events. `getAuditTrailSummary()` returns per-category counts.

---

### Step 8: 4 Missing Security Posture Checks

- [x] **8a.** Add "timelock-short" check: timelock < 3600 (1 hour) -> WARNING
- [x] **8b.** Add "fee-rate-edge" check: developerFeeRate at max (500) or 0 -> INFO
- [x] **8c.** Add "stale-constraints" check: constraint references programs not in allowlist -> WARNING
- [x] **8d.** Add "permission-concentration" check: single agent has >15 of 21 bits -> WARNING
- [x] **8e.** Add tests for all 4 new checks

**WHAT:** Expand the 13-point security checklist to 17 points.

**WHERE:** `sdk/kit/src/security-analytics.ts`, `getSecurityPosture()` function (line 65-208)

**WHY:** Rook (Auditor) found these gaps during the 13-point checklist review. The existing checks catch severe misconfiguration (no cap, full permissions, system program fee destination) but miss nuanced risks:
- A 1-second timelock technically "passes" the timelock check but provides zero protection
- A developer fee rate at max (500 = 5 BPS) could indicate a compromised vault setup
- Constraints referencing programs outside the allowlist are dead rules that create false confidence
- An agent with 16 of 21 permission bits is effectively unrestricted (only missing 5 niche actions)

**HOW:**

Add after line 200 (the `recent-activity` check), before the closing of the `checks` array:

```typescript
    // ---- New checks (Step 8) ----
    {
      id: "timelock-meaningful",
      label: "Timelock is at least 1 hour",
      passed: policy.timelockDuration === 0n || policy.timelockDuration >= 3600n,
      severity: "warning",
      detail:
        "A timelock under 1 hour may not provide enough reaction time if the owner key is compromised. " +
        "A zero timelock (disabled) is caught by the 'timelock-enabled' check above.",
      remediation:
        policy.timelockDuration > 0n && policy.timelockDuration < 3600n
          ? `Current timelock is ${Number(policy.timelockDuration)}s. Increase to at least 3600s (1 hour).`
          : null,
    },
    {
      // v1.4 fix: Three semantic problems corrected:
      // 1. Zero fee rate is VALID (owner chooses no revenue) — was wrongly penalized
      // 2. On-chain uses `<= MAX_DEVELOPER_FEE_RATE` (queue_policy_update.rs:86) —
      //    SDK was using `<` which rejects on-chain-valid rate=500
      // 3. Split concern: "is it set?" (INFO) vs "is it valid?" (separate — already on-chain enforced)
      id: "fee-rate-reasonable",
      label: "Developer fee rate is at or below maximum",
      passed: policy.developerFeeRate <= MAX_DEVELOPER_FEE_RATE,
      severity: "info",
      detail:
        "Developer fee rate must be at or below 500 (5 BPS = 0.05%). " +
        "A zero rate is valid (no developer revenue). A rate at the maximum is valid but should be intentional.",
      remediation:
        policy.developerFeeRate > MAX_DEVELOPER_FEE_RATE
          ? `Fee rate ${policy.developerFeeRate} exceeds maximum ${MAX_DEVELOPER_FEE_RATE}. This should not be possible on-chain.`
          : policy.developerFeeRate === MAX_DEVELOPER_FEE_RATE
            ? "Developer fee rate is at the maximum (5 BPS). Verify this is intentional."
            : null,
    },
    {
      id: "constraints-protocol-aligned",
      label: "Constraint programs are in allowlist",
      passed: (() => {
        if (!constraints || policy.protocolMode !== PROTOCOL_MODE_ALLOWLIST) return true;
        const allowedSet = new Set(policy.protocols.map(String));
        for (const entry of constraints.entries) {
          if (entry.programId && !allowedSet.has(String(entry.programId))) return false;
        }
        return true;
      })(),
      severity: "warning",
      detail:
        "Instruction constraints reference program addresses not in the protocol allowlist. " +
        "These constraints will never trigger because the protocol is already blocked.",
      remediation: "Update the allowlist to include constrained programs, or remove stale constraints.",
    },
    {
      id: "no-permission-concentration",
      label: "No agent has more than 15 permissions",
      passed: !vault.agents.some((a) => countBits(a.permissions) > 15),
      severity: "warning",
      detail:
        "An agent with more than 15 of 21 permission bits is effectively unrestricted. " +
        "Use least-privilege — grant only the actions the agent's strategy requires.",
      remediation: "Review agent permissions and restrict to only necessary action types.",
    },
```

Also need to add `MAX_DEVELOPER_FEE_RATE` to the existing types.js import and define a local `countBits` helper:

```typescript
// Update existing import on line 19 of security-analytics.ts:
import { FULL_PERMISSIONS, PROTOCOL_MODE_ALLOWLIST, EPOCH_DURATION, MAX_DEVELOPER_FEE_RATE } from "./types.js";

// NOTE (v1.3 fix): countBits() exists in event-analytics.ts:343 but is NOT exported.
// Define locally rather than creating a cross-module dependency for a 4-line function.
// Do NOT import from event-analytics.ts — it would create a circular dependency risk.
function countBits(n: bigint): number {
  let count = 0;
  let v = n;
  while (v > 0n) { count += Number(v & 1n); v >>= 1n; }
  return count;
}
```

**Acceptance criteria:** `getSecurityPosture(state).checks.length === 17`. Each new check has meaningful `remediation` text when it fails.

**IMPORTANT (audit fix):** Existing test `security-analytics.test.ts` asserts `checks.length === 13`. This assertion MUST be updated to 17 when implementing Step 8, or the test will fail. Search for `lengthOf(13)` or `length(13)` in the test file and update to 17.

**IMPORTANT (audit fix):** Existing test `security-analytics.test.ts` asserts `checks.length === 13`. This assertion MUST be updated to 17 when implementing Step 8, or the test will fail. Search for `lengthOf(13)` or `length(13)` in the test file and update to 17.

---

### Step 9: `stringsToPermissions()` Inverse Function

- [x] **9a.** Add `stringsToPermissions()` to `sdk/kit/src/types.ts`
- [x] **9b.** Export from `index.ts`
- [x] **9c.** Add tests for round-trip: `stringsToPermissions(permissionsToStrings(x)) === x`
- [x] **9d.** Validate inputs: throw on unknown action type strings

**WHAT:** The inverse of `permissionsToStrings()` -- convert human-readable action names to a bitmask.

**WHERE:** `sdk/kit/src/types.ts` (alongside existing `permissionsToStrings`, line 173)

**WHY:** Marcus said "I have to use raw bitmask math to set permissions." The SDK exports `permissionsToStrings(bigint): string[]` (line 173) and `PermissionBuilder` (line 198) but no `stringsToPermissions(string[]): bigint`. The PermissionBuilder requires chaining `.add()` calls. A simple `stringsToPermissions(["swap", "deposit"])` is the natural complement that every developer expects.

**HOW:**

```typescript
/**
 * Convert an array of action type strings to a permission bitmask.
 * Inverse of permissionsToStrings().
 *
 * @throws Error if any string is not a recognized action type.
 *
 * @example
 * stringsToPermissions(["swap", "deposit"]) // => 33n (bit 0 + bit 5)
 * stringsToPermissions(permissionsToStrings(PERPS_FULL)) === PERPS_FULL // true
 */
export function stringsToPermissions(strings: string[]): bigint {
  let result = 0n;
  for (const s of strings) {
    const bit = ACTION_PERMISSION_MAP[s];
    if (bit === undefined) {
      const valid = Object.keys(ACTION_PERMISSION_MAP).join(", ");
      throw new Error(
        `Unknown action type: "${s}". Valid types: ${valid}`,
      );
    }
    result |= bit;
  }
  return result;
}
```

Add to `index.ts` exports:
```typescript
export {
  // ... existing
  permissionsToStrings,
  stringsToPermissions,  // NEW
  // ...
} from "./types.js";
```

**Acceptance criteria:** `stringsToPermissions(["swap"]) === 1n`. Round-trip identity holds for all preset constants.

---

### Step 10: SDK-Level Error Categories in wrap()

- [x] **10a.** Add `wrapToAgentError()` helper that converts any `Error` from `wrap()` into `AgentError`
- [x] **10b.** Categorize known wrap() error patterns (vault not active, agent not registered, cap exceeded, etc.)
- [x] **10c.** Apply `wrapToAgentError()` in `PhalnxClient.wrap()` and `PhalnxClient.executeAndConfirm()`
- [x] **10d.** Add tests for each error category mapping

**WHAT:** Bridge the gap between `wrap()` throwing plain `Error` objects and `toAgentError()` which only handles on-chain error codes.

**WHERE:**
- `sdk/kit/src/agent-errors.ts` (add `wrapToAgentError()` function and SDK error patterns)
- `sdk/kit/src/wrap.ts` (apply in PhalnxClient methods)

**WHY:** Marcus said "there's no bridge between wrap() errors and toAgentError()." Currently:
- `wrap()` throws `new Error("Vault is not active ...")` -- plain string, no category, no recovery actions
- `toAgentError()` handles numeric on-chain codes (6000-6069) but not SDK-layer errors
- An AI agent catching a wrap() error gets zero structured metadata

The fix was determined by analyzing all `throw new Error(...)` sites in wrap.ts (16 distinct throw sites, mapped to 9 regex patterns + 1 fallback). The remaining 7 sites are config validation errors that map to the fallback `UNKNOWN` category.

**CRITICAL: `wrapToAgentError()` must return an object that is ALSO an `Error` instance.** The returned AgentError must extend Error (class, not just interface) so that `instanceof Error` checks in consumer code continue to work. Throwing a plain object breaks `try { } catch (e) { if (e instanceof Error) { ... } }` patterns. Implementation: create a `PhalnxSdkError extends Error implements AgentError` class.

**HOW:**

In `sdk/kit/src/agent-errors.ts`, add:

```typescript
// ---------------------------------------------------------------------------
// SDK-layer error patterns (wrap() and friends)
// ---------------------------------------------------------------------------

interface SdkErrorPattern {
  pattern: RegExp;
  category: ErrorCategory;
  retryable: boolean;
  recovery_actions: RecoveryAction[];
}

const SDK_ERROR_PATTERNS: SdkErrorPattern[] = [
  {
    pattern: /Vault is not active/,
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      { action: "check_vault_status", description: "Verify vault status. It may be frozen or closed." },
      { action: "reactivate_vault", description: "If frozen, ask the vault owner to reactivate.", tool: "reactivateVault" },
    ],
  },
  {
    pattern: /Agent .+ is not registered/,
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      { action: "register_agent", description: "Register this agent in the vault.", tool: "registerAgent" },
    ],
  },
  {
    pattern: /Agent .+ is paused/,
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      { action: "unpause_agent", description: "Ask the vault owner to unpause this agent.", tool: "unpauseAgent" },
    ],
  },
  {
    pattern: /lacks permission for action/,
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      { action: "update_permissions", description: "Request permission for this action type from the vault owner." },
    ],
  },
  {
    pattern: /Protocol .+ is not allowed/,
    category: "PROTOCOL_NOT_SUPPORTED",
    retryable: false,
    recovery_actions: [
      { action: "add_protocol", description: "Add this protocol to the vault's allowlist." },
    ],
  },
  // NOTE: Cap exceeded is NOT a thrown error in wrap(). It pushes a WARNING to
  // result.warnings[] because the on-chain program is the real enforcer. The SDK
  // cap check is advisory only ("transaction may be rejected on-chain"). Do NOT
  // add a regex pattern here for cap exceeded — it would be dead code.
  // See wrap.ts:292-298 for the warning push.
  // If consumers need to detect cap warnings, check WrapResult.warnings.length > 0.
  {
    pattern: /Transaction size .+ exceeds/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      { action: "add_alts", description: "Pass protocolAltAddresses from your DeFi API response." },
      { action: "reduce_instructions", description: "Reduce instruction count or split across multiple transactions." },
    ],
  },
  {
    pattern: /Position limit reached/,
    category: "POLICY_VIOLATION",
    retryable: true,
    recovery_actions: [
      { action: "close_position", description: "Close an existing position before opening a new one." },
    ],
  },
  {
    pattern: /Spending action .+ requires amount > 0/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      { action: "fix_amount", description: "Set amount to the transaction value in token base units." },
    ],
  },
  // v1.3 fix: Two actionable errors that were falling through to UNKNOWN
  {
    pattern: /Non-spending action .+ requires amount === 0/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      { action: "set_zero_amount", description: "Non-spending actions (close, withdraw, etc.) require amount = 0n." },
    ],
  },
  {
    pattern: /No target protocol/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      { action: "add_instructions", description: "Include DeFi instructions in the wrap call, or set targetProtocol explicitly." },
    ],
  },
  {
    pattern: /Escrow action/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      { action: "use_escrow_api", description: "Use createEscrow/settleEscrow/refundEscrow instead of wrap()." },
    ],
  },
];

/**
 * Error class that is BOTH an Error instance AND an AgentError.
 * Critical: must extend Error so `instanceof Error` checks work in consumer code.
 */
export class PhalnxSdkError extends Error implements AgentError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly recovery_actions: RecoveryAction[];
  readonly context: Record<string, unknown>;

  constructor(agentError: AgentError) {
    super(agentError.message);
    this.name = "PhalnxSdkError";
    this.code = agentError.code;
    this.category = agentError.category;
    this.retryable = agentError.retryable;
    this.recovery_actions = agentError.recovery_actions;
    this.context = agentError.context ?? {};
  }
}

/**
 * Convert any error thrown by wrap() or PhalnxClient methods into a structured AgentError.
 * Returns a PhalnxSdkError (extends Error) so instanceof Error checks still work.
 *
 * Falls back to toAgentError() for on-chain errors (numeric codes),
 * then pattern-matches SDK error messages, then returns a generic FATAL.
 */
export function wrapToAgentError(err: unknown): PhalnxSdkError {
  // Try on-chain error extraction first
  const onChain = toAgentError(err);
  if (onChain.code !== "UNKNOWN") return new PhalnxSdkError(onChain);

  // Pattern-match SDK errors
  const message = err instanceof Error ? err.message : String(err);
  for (const p of SDK_ERROR_PATTERNS) {
    if (p.pattern.test(message)) {
      return new PhalnxSdkError({
        code: `SDK_${p.category}`,
        message,
        category: p.category,
        retryable: p.retryable,
        recovery_actions: p.recovery_actions,
        context: {},
      });
    }
  }

  // Fallback
  return new PhalnxSdkError({
    code: "UNKNOWN",
    message,
    category: "FATAL",
    retryable: false,
    recovery_actions: [],
    context: {},
  });
}
```

Export `wrapToAgentError` AND `PhalnxSdkError` from `index.ts` (v1.4 fix: consumers need `instanceof PhalnxSdkError` for type-narrowing in catch blocks). In `wrap.ts`, update `PhalnxClient.executeAndConfirm()`:

```typescript
async executeAndConfirm(/* ... */): Promise<ExecuteResult> {
  try {
    const result = await this.wrap(instructions, opts);
    const encoded = await signAndEncode(this.agent, result.transaction);
    const signature = await sendAndConfirmTransaction(this.rpc, encoded, opts.confirmOptions);
    return { signature, wrapResult: result };
  } catch (err) {
    throw wrapToAgentError(err); // re-throw as structured AgentError
  }
}
```

**Acceptance criteria:** Catching a `PhalnxClient.executeAndConfirm()` error yields an `AgentError` with `category`, `retryable`, and `recovery_actions` -- not a plain Error.

---

### Step 11: Cross-Vault Agent Ranking

- [x] **11a.** Verify `getCrossVaultAgentRanking()` exists and handles the David persona use case
- [x] **11b.** Add `getAgentLeaderboardAcrossVaults()` convenience wrapper if needed
- [x] **11c.** Add tests for multi-vault, multi-agent scenarios

**WHAT:** Verify and potentially extend cross-vault agent comparison capability.

**WHERE:** `sdk/kit/src/portfolio-analytics.ts` (line 173, `getCrossVaultAgentRanking()`)

**WHY:** David (Treasury) needs to compare 5 bots across 3 vaults. The investigation revealed that `getCrossVaultAgentRanking()` ALREADY EXISTS (line 173-223) and does exactly this: it takes a `PortfolioOverview`, iterates all vaults' agent budgets, collects lifetime spend from overlays, and returns a ranked list sorted by 24h spend.

However, the current function requires a `PortfolioOverview` object (which requires RPC calls via `getPortfolioOverview()`). David may already have resolved vault states but not gone through the portfolio pipeline.

**HOW:**

Add a convenience overload in `portfolio-analytics.ts`.

**IMPORT REQUIRED (v1.3 fix):** The function uses `bytesToAddress(e.agent)` to convert raw overlay bytes to Kit Address.
`bytesToAddress` is exported from `state-resolver.ts:155`. Update the existing import:
```typescript
// Change line 15 from:
import type { ResolvedVaultState } from "./state-resolver.js";
// To:
import { bytesToAddress, type ResolvedVaultState } from "./state-resolver.js";
```

```typescript
/**
 * Rank agents across multiple pre-resolved vault states.
 * Convenience wrapper when you have ResolvedVaultState[] but not a full PortfolioOverview.
 *
 * For the full portfolio pipeline, use getPortfolioOverview() + getCrossVaultAgentRanking().
 */
export function getAgentLeaderboardAcrossVaults(
  vaultStates: Array<{ address: Address; state: ResolvedVaultState }>,
): CrossVaultAgentRanking[] {
  const allAgents: CrossVaultAgentRanking[] = [];

  for (const { address: vaultAddress, state } of vaultStates) {
    for (const [agentAddr, budget] of state.allAgentBudgets) {
      const agentEntry = state.vault.agents.find((a) => a.pubkey === agentAddr);
      if (!agentEntry) continue;

      let lifetimeSpend = 0n;
      if (state.overlay) {
        const slotIdx = state.overlay.entries.findIndex((e) => {
          try { return bytesToAddress(e.agent) === agentAddr; } catch { return false; }
        });
        if (slotIdx >= 0 && slotIdx < state.overlay.lifetimeSpend.length) {
          lifetimeSpend = state.overlay.lifetimeSpend[slotIdx];
        }
      }

      allAgents.push({
        agent: agentAddr,
        vaultAddress,
        vaultId: state.vault.vaultId,
        spend24h: budget.spent24h,
        lifetimeSpend,
        capUtilization:
          budget.cap > 0n ? Number((budget.spent24h * 10000n) / budget.cap) / 100 : 0,
        paused: agentEntry.paused,
        rank: 0,
      });
    }
  }

  allAgents.sort((a, b) => (b.spend24h > a.spend24h ? 1 : b.spend24h < a.spend24h ? -1 : 0));
  allAgents.forEach((a, i) => { a.rank = i + 1; });

  return allAgents;
}
```

Export from `index.ts`:
```typescript
export {
  getPortfolioOverview,
  aggregatePortfolio,
  getCrossVaultAgentRanking,
  getAgentLeaderboardAcrossVaults,  // NEW
  getPortfolioTimeSeries,
} from "./portfolio-analytics.js";
```

**Acceptance criteria:** `getAgentLeaderboardAcrossVaults([{ address: v1, state: s1 }, { address: v2, state: s2 }])` returns agents from both vaults, ranked.

---

### Step 12: Constraint Content Inspection

- [x] **12a.** Add `inspectConstraints()` to `sdk/kit/src/inspector.ts`
- [x] **12b.** Returns human-readable summary of each constraint entry
- [x] **12c.** Export from `index.ts`
- [x] **12d.** Add tests

**WHAT:** Human-readable inspection of the InstructionConstraints PDA contents.

**WHERE:** `sdk/kit/src/inspector.ts` (extend existing file)

**WHY:** Rook (Auditor) can read the raw constraints PDA via `resolveVaultState()` but gets opaque byte arrays and numeric operators. There is no function to convert `ConstraintEntry[]` into a summary like "Program X: account[2] must equal ADDRESS, data[4..8] must be <= VALUE". The existing `analyzeInstructions()` in inspector.ts handles instruction-level analysis (token transfers, dangerous ops) but not constraint-level analysis.

**HOW:**

```typescript
// Added to sdk/kit/src/inspector.ts

import type { ConstraintEntry } from "./generated/types/constraintEntry.js";
import { resolveProtocolName } from "./protocol-names.js";

export interface ConstraintSummary {
  /** 0-based index in the constraints array. */
  index: number;
  /** Protocol program address this constraint targets. */
  program: Address;
  /** Human-readable protocol name (e.g. "Jupiter V6") or shortened address. */
  programName: string;
  /** Number of data constraints (byte-level rules). */
  dataConstraintCount: number;
  /** Number of account constraints (address-level rules). */
  accountConstraintCount: number;
  /** Human-readable description of each rule. */
  rules: string[];
}

const OPERATOR_NAMES: Record<number, string> = {
  0: "==",
  1: "!=",
  2: "<",
  3: "<=",
  4: ">",
  5: ">=",
  6: "contains",
};

/**
 * Inspect an InstructionConstraints account and return a human-readable
 * summary of each constraint entry.
 *
 * @param entries - The constraint entries from the InstructionConstraints PDA.
 *   Obtain via: `(await resolveVaultState(rpc, vault, agent)).constraints?.entries`
 */
export function inspectConstraints(
  entries: ConstraintEntry[],
): ConstraintSummary[] {
  return entries
    .map((entry, index) => {
      const program = entry.programId; // v1.3 fix: field is programId, not program
      const programName = resolveProtocolName(program) ?? formatShortAddress(program);
      const rules: string[] = [];

      // Data constraints
      // NOTE (audit fix): Do NOT use Buffer.from() — not browser-safe.
      // Step 3 explicitly warns against this. Use portable hex conversion.
      for (const dc of entry.dataConstraints ?? []) {
        const op = OPERATOR_NAMES[dc.operator as number] ?? `op(${dc.operator})`;
        const bytes = dc.value instanceof Uint8Array ? dc.value : new Uint8Array(dc.value);
        const valueHex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
        rules.push(
          `data[${dc.offset}..${dc.offset + dc.length}] ${op} 0x${valueHex}`,
        );
      }

      // Account constraints
      for (const ac of entry.accountConstraints ?? []) {
        const op = OPERATOR_NAMES[ac.operator as number] ?? `op(${ac.operator})`;
        rules.push(
          `account[${ac.accountIndex}] ${op} ${ac.expectedAddress}`,
        );
      }

      return {
        index,
        program,
        programName,
        dataConstraintCount: entry.dataConstraints?.length ?? 0,
        accountConstraintCount: entry.accountConstraints?.length ?? 0,
        rules,
      };
    })
    .filter((s) => s.rules.length > 0);
}

function formatShortAddress(addr: Address): string {
  const s = String(addr);
  return s.length > 8 ? `${s.slice(0, 4)}...${s.slice(-4)}` : s;
}
```

Export from `index.ts`:
```typescript
export { analyzeInstructions, inspectConstraints } from "./inspector.js";
export type {
  InspectableInstruction, TokenTransferInfo, InstructionAnalysis,
  DangerousTokenOperation, ConstraintSummary,  // NEW
} from "./inspector.js";
```

**Acceptance criteria:** `inspectConstraints(state.constraints.entries)` returns human-readable rules like `data[0..4] == 0xe517cb98` and `account[2] == JUP6Lk...`.

---

## P2 -- Nice to Have

These items enhance the SDK for advanced use cases but are not required for initial adoption.

---

### Step 13: Per-Agent P&L (Architectural Design Only)

- [ ] **13a.** Document the fundamental constraint: on-chain finalize_session records vault-level delta, not per-agent
- [ ] **13b.** Design SDK-side attribution: parse SessionFinalized events, attribute delta to acting agent
- [ ] **13c.** Document accuracy limitations (concurrent agents = ambiguous attribution)
- [ ] **13d.** Write spec for `getAgentPnL()` function signature

**WHAT:** Architectural design for per-agent profit/loss tracking.

**WHERE:** Documentation only (this plan). Implementation deferred to after P0/P1 ship.

**WHY:** David (Treasury) wants per-bot P&L. The fundamental constraint is that on-chain `finalize_session` measures vault-level stablecoin balance delta and attributes it to the vault, not the agent. The `AgentSpendOverlay` tracks per-agent spending (outflows) but not per-agent returns (inflows from swaps, position closes, etc.).

**Design:**

The SDK can approximate per-agent P&L by parsing `SessionFinalized` events:
```
Per-agent P&L = sum of (stablecoin_delta) for all sessions where agent = X
```

This is accurate when:
- Only one agent operates at a time (no concurrent sessions)
- External deposits/withdrawals happen between sessions (not during)

This is approximate when:
- Multiple agents operate concurrently (deltas interleave)
- Owner deposits during an active session (inflates apparent return)

**Function signature (future):**
```typescript
export function getAgentPnL(
  events: DecodedPhalnxEvent[],
  agentAddress: Address,
): { totalPnl: bigint; sessionCount: number; avgPnlPerSession: bigint }
```

**Acceptance criteria:** Design document exists. No code shipped. Decision on accuracy tradeoffs recorded.

---

### Step 14: Program Hash Verification

- [ ] **14a.** Design `verifyProgramHash()` that fetches deployed program ELF hash via RPC
- [ ] **14b.** Maintain expected hash constants per version per network
- [ ] **14c.** Document the trust model (who publishes hashes, where are they stored)

**WHAT:** Verify that the deployed Phalnx program matches an expected build hash.

**WHERE:** New file `sdk/kit/src/program-verify.ts` (design only, no implementation)

**WHY:** Rook (Auditor) needs to confirm the deployed program matches the audited source. Solana programs can be upgraded by the authority. Without hash verification, there is no SDK-level way to detect a rogue upgrade.

**Design:**
```typescript
export async function verifyProgramHash(
  rpc: Rpc<SolanaRpcApi>,
  network: Network,
): Promise<{ verified: boolean; expectedHash: string; actualHash: string; version: string }>
```

Uses `rpc.getAccountInfo(programAddress)` to fetch the ELF, hashes it with SHA-256, and compares against a known-good hash shipped in the SDK. The known-good hash would be updated each SDK release that corresponds to a program upgrade.

**Acceptance criteria:** Design recorded. Implementation deferred until program is frozen post-audit.

---

### Step 15: Evidence Chain-of-Custody

- [ ] **15a.** Design audit evidence export format (JSON bundle: vault state + events + signatures)
- [ ] **15b.** Document what constitutes a complete evidence package for a compliance audit
- [ ] **15c.** Spec `exportAuditBundle()` function

**WHAT:** Export a self-contained evidence bundle for external audit.

**WHERE:** Design only. Depends on getAuditTrail() (Step 7) shipping first.

**WHY:** Rook (Auditor) needs to provide evidence to external auditors. Currently audit data is scattered across on-chain state, parsed events, and security posture checks. A single exportable bundle would standardize what "audited" means.

**Design:**
```typescript
export interface AuditBundle {
  version: "1.0";
  exportedAt: string; // ISO 8601
  vaultAddress: Address;
  network: Network;
  vaultState: ResolvedVaultState;
  securityPosture: SecurityPosture;
  auditTrail: AuditEntry[];
  programHash: string;
  sdkVersion: string;
}
```

**Acceptance criteria:** Design recorded. Implementation after Steps 7, 8, 14.

---

### Step 16: Failed Transaction Visibility (PROMOTED from P2 to P1)

> **Audit promotion rationale:** Step 10 adds structured error translation via `wrapToAgentError()`.
> Without Step 16's `onError` callback, consumers have no way to observe those structured errors
> without wrapping every `executeAndConfirm()` call in their own try/catch. The onError hook is
> ~5 lines of code in PhalnxClient and directly enables Step 10's value. Ships alongside Step 10.

- [x] **16a.** Add `FailedTransactionRecord` type to agent-errors.ts
- [x] **16b.** Add `onError` callback to PhalnxClient for telemetry/logging
- [x] **16c.** Document how to persist failed transactions for post-mortem

**WHAT:** Make failed wrap/execute attempts visible and analyzable.

**WHERE:** Design + minimal implementation in `sdk/kit/src/wrap.ts`

**WHY:** Sarah (Risk Manager) and Marcus (Developer) both need visibility into failures. Currently, a failed `executeAndConfirm()` throws an error that is lost unless the caller catches and logs it. There is no built-in telemetry, retry history, or failure catalog.

**Design:**
```typescript
export interface PhalnxClientConfig {
  // ... existing fields
  /** Callback invoked on any error during wrap or execute. For telemetry/logging. */
  onError?: (error: AgentError, context: { action: string; tokenMint: Address; amount: bigint }) => void;
}
```

This is a minimal hook -- the caller decides where to send errors (console, Datadog, Sentry, etc.). The SDK does not prescribe a telemetry backend.

**Acceptance criteria:** `onError` callback fires with structured `AgentError` on every failed `executeAndConfirm()`.

---

### Step 17: Polling/Streaming Pattern Documentation

- [ ] **17a.** Document recommended polling pattern for vault state (30s interval, stale detection)
- [ ] **17b.** Document WebSocket subscription pattern using Helius/Triton
- [ ] **17c.** Add example: `pollVaultState()` wrapper with exponential backoff

**WHAT:** Documentation and example code for real-time vault monitoring.

**WHERE:** `sdk/kit/README.md` (section in README) + `sdk/kit/examples/poll-vault.ts`

**WHY:** Elena (Agent Builder) and David (Treasury) need to monitor vault state changes. The SDK provides `resolveVaultState()` for one-shot reads but no guidance on polling frequency, stale detection, or WebSocket alternatives. `PhalnxClient` has `maxCacheAgeMs` (30s default) but this is not documented.

**Design:**

Document three patterns:
1. **Polling (simple):** Call `resolveVaultState()` every 30s. Use `resolvedAtTimestamp` for stale detection.
2. **PhalnxClient cache (recommended):** `client.wrap()` auto-resolves with 30s cache. No manual polling needed for wrap flows.
3. **WebSocket (advanced):** Subscribe to vault PDA account changes via `onAccountChange`. Parse events from transaction logs.

```typescript
// sdk/kit/examples/poll-vault.ts
async function pollVaultState(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  agent: Address,
  network: Network,
  onUpdate: (state: ResolvedVaultState) => void,
  intervalMs = 30_000,
): Promise<() => void> {
  let running = true;
  const poll = async () => {
    while (running) {
      try {
        const state = await resolveVaultState(rpc, vault, agent, undefined, network);
        onUpdate(state);
      } catch (err) {
        console.error("Poll failed:", err);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  };
  poll(); // fire-and-forget
  return () => { running = false; }; // cancel handle
}
```

**Acceptance criteria:** README documents all three patterns. Example compiles.

---

## Dependency Graph (Revised — audit fix v1.2)

```
P0 (must ship first):
  Step 1 (npm publish)         -- no code deps, operational (may take 1-2 days)
  Step 2 (README)              -- depends on Step 3 existing for link
  Step 3 (Jupiter example)     -- independent
  Step 4 (createAndSendVault)  -- depends on existing buildOwnerTransaction

  [P] Steps 1, 3, 4 can start in parallel (Step 1 is operational, 3+4 are code).
  Step 2 starts after Step 3 (needs example to link to).

P1 (parallelize by FILE, not just step):
  FILE: security-analytics.ts  -- Steps 7 → 8 → 18 → 20 (SEQUENTIAL, same file)
  FILE: wrap.ts                -- Steps 5 → 19 → 23 → 24 (SEQUENTIAL, same file)
  FILE: types.ts               -- Steps 6 + 9 (parallel, different functions)
  FILE: agent-errors.ts        -- Step 10 → 16 (SEQUENTIAL, 16 depends on 10)
  FILE: portfolio-analytics.ts -- Step 11 (independent)
  FILE: inspector.ts           -- Step 12 (independent)
  FILE: wrap.ts (continued)    -- Step 21 (AFTER Steps 19, 23, 24)

  [P] types.ts cluster (6+9), portfolio (11), inspector (12) can all parallelize.
  [P] security-analytics chain and wrap.ts chain run in parallel with each other.
  [P] agent-errors chain (10→16) runs in parallel with all above.

P2 (design first, implement later):
  Step 13 (per-agent P&L)      -- design only
  Step 14 (program hash)       -- design only
  Step 15 (evidence bundle)    -- depends on Steps 7, 8, 14
  Step 17 (polling docs)       -- depends on Step 2
  Step 22 (trust boundaries)   -- documentation only, independent

CUMULATIVE CHECK COUNT (security-analytics.ts):
  Base: 13 → +4 (Step 8) = 17 → +2 (Step 18) = 19 → +1 (Step 20) = 20
```

---

## Estimated Effort

| Priority | Steps | Estimated Effort | Parallelizable |
|----------|-------|------------------|----------------|
| P0 | 1-4 | 3-5 days | Steps 1, 3, 4 parallel; Step 2 after Step 3. npm OIDC cycle may take 1-2 days alone. |
| P1+P1.5 | 5-12, 16, 18-24 | 4-6 days | Organized by FILE: security-analytics chain (7→8→18→20), wrap.ts chain (5→19→23→24), types cluster (6+9), errors (10→16), remaining (11, 12, 21, 22) |
| P2 | 13-15, 17 | 1-2 days | All design docs, parallel |
| **Total** | **24** | **8.5-13 days** | |

---

## Implementation Order (Revised — audit fix v1.2)

> **Key change:** Steps 18-24 (council findings + audit pre-flights) are now integrated
> into Phases B-C based on file-level dependencies. Steps that modify the same file
> MUST be sequential. The old plan treated Steps 18-24 as an appendix.

**Phase A (Day 1-3):** P0 blocking items — more parallel than v1.1

```
  ┌─ Step 1: npm pipeline verification (operational, may take 2 days alone)
  │    (Does NOT block Steps 2-4 — they're code, not publishing)
  ├─ Step 3: Jupiter example (independent, new file)
  ├─ Step 4: createAndSendVault() (create-vault.ts + NEW create-vault.test.ts)
  └─ Step 2: README (start after Step 3, references it)
```

**Phase B (Day 3-6):** P1 + P1.5 — organized by FILE, not priority tier

```
  Agent 1 — types.ts cluster:
    Steps 6 (normalizeNetwork) + 9 (stringsToPermissions) — parallel, different functions

  Agent 2 — security-analytics.ts chain (SEQUENTIAL, same file):
    Step 7 (audit trail filters) → Step 8 (+4 checks, 13→17)
    → Step 18 (+2 checks, 17→19) → Step 20 (+1 check, 19→20)

  Agent 3 — wrap.ts chain (SEQUENTIAL, same file):
    Step 5 (WrapParams JSDoc) → Step 19 (ATA rejection)
    → Step 23 (SPL blocking) → Step 24 (DeFi ix count)

  Agent 4 — errors + remaining:
    Step 10 (wrapToAgentError in agent-errors.ts)
    → Step 16 (onError callback in wrap.ts — wait for Agent 3 to finish wrap.ts)
    → Steps 11 + 12 (parallel: portfolio-analytics.ts + inspector.ts)

  AFTER Agents 3+4 complete:
    Step 21 (price reasonableness — touches wrap.ts, needs Steps 19/23/24 done)
```

Build verification gate: `pnpm -r run build && pnpm --filter @phalnx/kit test`

**Phase C (Day 7-8):** P2 design docs + documentation
- Steps 13-15, 17 (design documents, no code — all parallel)
- Step 22 (trust boundaries doc in docs/ARCHITECTURE.md — parallel with above)

Build verification gate: `pnpm -r run build` (docs shouldn't break build, but verify)

---

## Test Strategy (Revised — audit fix v1.2)

Each code step includes tests. Test files follow existing convention.

**CRITICAL:** `security-analytics.test.ts` assertions for `checks.length` must update cumulatively:
- After Step 8: update to `checks.length === 17`
- After Step 18: update to `checks.length === 19`
- After Step 20: update to `checks.length === 20`

| Step | Test File | Test Count (est.) | Notes |
|------|-----------|-------------------|-------|
| 4 | `sdk/kit/tests/create-vault.test.ts` (NEW) | 4-6 | New file — does not exist yet |
| 6 | `sdk/kit/tests/types.test.ts` (extend) | 3-4 | |
| 7 | `sdk/kit/tests/security-analytics.test.ts` (extend) | 4-6 | |
| 8 | `sdk/kit/tests/security-analytics.test.ts` (extend) | 4-8 | Update checks.length to 17 |
| 9 | `sdk/kit/tests/types.test.ts` (extend) | 3-4 | |
| 10 | `sdk/kit/tests/error-categories.test.ts` (extend) | 6-10 | |
| 11 | `sdk/kit/tests/portfolio-analytics.test.ts` (extend) | 3-4 | |
| 12 | `sdk/kit/tests/inspector.test.ts` (extend) | 3-4 | |
| 18 | `sdk/kit/tests/security-analytics.test.ts` (extend) | 2-3 | Update checks.length to 19 |
| 19 | `sdk/kit/tests/wrap.test.ts` (extend) | 2-3 | |
| 20 | `sdk/kit/tests/security-analytics.test.ts` (extend) | 2-3 | Update checks.length to 20 |
| 21 | `sdk/kit/tests/wrap.test.ts` (extend) | 3-4 | Mock Jupiter Price API |
| 23 | `sdk/kit/tests/wrap.test.ts` (extend) | 2 | |
| 24 | `sdk/kit/tests/wrap.test.ts` (extend) | 2 | |

All tests use the existing mock infrastructure (`@phalnx/kit/testing`). No RPC calls. No devnet dependency.

---

## Audit Corrections (v1.0 → v1.1, 2026-03-25)

8 fixes applied from plan quality audit. Each fix prevents an implementation bug.

| # | Fix | Severity | What Would Have Gone Wrong |
|---|-----|----------|---------------------------|
| 1 | **Removed dead cap-exceeded regex pattern** | CRITICAL | `wrap()` pushes cap exceeded as a WARNING to `result.warnings[]`, not a thrown error. The regex `/exceeds remaining daily cap/` would never match. Implementer would write dead code. |
| 2 | **Renamed `wrapError` → `wrapToAgentError`** | MEDIUM | Name collision ambiguity with existing `toAgentError()`. "wrapError" could mean "wrap an error" (verb) or "error from wrap" (noun). `wrapToAgentError` matches the `toAgentError` naming convention. |
| 3 | **Added `PhalnxSdkError extends Error` class** | HIGH | The original plan returned plain AgentError objects (interfaces). `instanceof Error` checks in consumer code would fail. `PhalnxSdkError extends Error implements AgentError` ensures both `instanceof Error` and structured `AgentError` properties work. |
| 4 | **Added `index.ts` export update for Step 6** | MEDIUM | Plan modified `types.ts` to add `normalizeNetwork` but didn't update `index.ts` to export it. Acceptance criteria required it in `@phalnx/kit` exports — would have been unreachable. |
| 5 | **Added test assertion update note for Step 8** | MEDIUM | Existing `security-analytics.test.ts` asserts `checks.length === 13`. Adding 4 checks to reach 17 would break this assertion. Implementer must update the test count. |
| 6 | **Promoted Step 16 from P2 to P1** | MEDIUM | `onError` callback enables Step 10's `wrapToAgentError()` value. Without the hook, consumers must wrap every `executeAndConfirm()` in their own try/catch to observe structured errors. The callback is ~5 lines of code. |
| 7 | **Added build verification gate** | LOW | No step verified `pnpm -r run build` passes after type-changing steps (6, 8, 9, 10). Type regressions would only be caught at npm publish time. Gate catches them at tier boundary. |
| 8 | **Revised effort estimate: P0 3-5 days, total 7-11 days** | LOW | npm OIDC Trusted Publishing configuration requires external service setup + merge-to-main cycle. `Buffer.from()` in Jupiter example needs `Uint8Array` for browser-safe ESM. Step 10 has 16 throw sites (not 10). |

---

## On-Chain Security Council Audit — SDK Findings (2026-03-25)

> **Source:** 4-member council debate (Architect, Engineer, Security/Pentester, Researcher) — 3 rounds, 12 agent invocations.
> **On-chain verdict:** 8/10 security rating. **Zero program changes required.** All actionable findings are SDK-layer.
> **Full transcript:** Available in conversation history. Council members: Serena Blackwood (Architect), Marcus Webb (Engineer), Rook Blackburn (Security), Ava Chen (Researcher).

### Final On-Chain Severity Table (Post-Debate)

| # | Finding | Final Severity | Status | Exploitable? |
|---|---------|---------------|--------|-------------|
| 1 | Pre-validate front-running | **WITHDRAWN** | PDA ownership eliminates — vault PDA is sole authority, no external signer can set delegates | No |
| 2 | Delegation CPI to rogue destination | **LOW** | Jupiter routing + spending cap = bounded blast radius. Agent can make bad trades within cap — threat model working as designed | Bounded |
| 3 | Leverage amplification bypass | **MEDIUM** | `leverage_bps` is advisory (agent-declared). No fund-loss path, but governance gap — vault reports 2x when actual is 50x | No direct loss |
| 4 | Non-stablecoin uncapped outflow | **INFO** | By-design: no oracles = can't value non-stablecoins. Vault gains stablecoins on non-stablecoin swaps. With Jupiter allowlist, AMM math prevents bad pricing | By-design |
| 5 | Fee-on-transfer token drain | **LOW** | Stablecoin-only mint whitelist (USDC/USDT) mitigates entirely | No |
| 6 | SpendTracker epoch boundary | **LOW** | 600s granularity, no exploit path found | No |
| 7 | Emergency freeze timing | **INFO** | Operational concern, not code-level | No |

### Council Consensus (Unanimous)

- Outcome-based spending enforcement is architecturally sound — defeats parameter spoofing
- CPI guard + session init + PDA ownership eliminates pre-validate attacks structurally
- SPL Token discriminator coverage is complete (3/4/12 + Token-2022 26)
- Instruction scan (unbounded, both paths) is correct
- Generic constraints layering (allowlist → constraints → strict_mode) composes properly
- Non-stablecoin → non-stablecoin swaps are **blocked on-chain** (must route through stablecoin)
- With `protocol_mode = ALLOWLIST` + Jupiter only, non-stablecoin drain is effectively impossible

### SDK Action Items From Council

These should be implemented as part of the existing P1 tier (Steps 7-8 cluster in `security-analytics.ts`).

---

### Step 18: Discriminator Staleness Detection in `getSecurityPosture()`

- [x] **18a.** Add check #14: "Constraint discriminators are current" — compare constraint entry discriminators against known protocol discriminator tables
- [x] **18b.** Add check #15: "Constraint entries cover all allowlisted protocols" — if protocols are in allowlist but have no constraint entries, flag as warning
- [x] **18c.** Surface staleness warnings in `SecurityPosture` result with remediation text

**WHAT:** Detect when `InstructionConstraints` entries reference stale discriminators after a protocol upgrade (e.g., Jupiter V6 → V7). With `strict_mode = OFF`, stale constraints silently stop matching, allowing unconstrained instructions through.

**WHERE:** `sdk/kit/src/security-analytics.ts` — extend `getSecurityPosture()` (currently 13 checks → 15)

**WHY:** Council finding: constraint brittleness to program upgrades is operational risk. When Jupiter upgrades instruction layouts, constraints break silently. SDK-level detection is the only viable mitigation (on-chain can't self-detect staleness).

**HOW:**
```typescript
// Check 14: Constraint staleness
{
  id: "constraints-current",
  label: "Constraint discriminators are current",
  passed: !constraints || verifyDiscriminatorCurrency(constraints),
  severity: "warning",
  detail: "Stale constraints may not match current protocol instruction formats.",
  remediation: "Review and update InstructionConstraints entries when protocols upgrade.",
},
// Check 15: Allowlist coverage
{
  id: "constraints-cover-allowlist",
  label: "All allowlisted protocols have constraint entries",
  passed: !constraints || policy.protocolMode !== PROTOCOL_MODE_ALLOWLIST
    || policy.protocols.every(p => constraints.entries.some(e => e.programId === p)),
  severity: "info",
  detail: "Protocols on the allowlist without constraint entries rely solely on spending caps for protection.",
  remediation: "Add InstructionConstraints entries for all allowlisted protocols.",
},
```

**Acceptance criteria:** `getSecurityPosture()` returns 15 checks. Tests updated from `checks.length === 13` to `checks.length === 15`.

**Effort:** ~1 hour. Extends existing function, no new files.

---

### Step 19: Non-Canonical ATA Rejection in `wrap()`

- [x] **19a.** Before building the transaction, derive the canonical ATA for the output stablecoin mint
- [x] **19b.** If the passed `outputStablecoinAccount` doesn't match the canonical ATA, throw with clear error message
- [x] **19c.** Add tests for canonical vs. non-canonical ATA detection

**WHAT:** Reject non-canonical token accounts for `output_stablecoin_account` before submitting the transaction. The on-chain program only checks `owner == vault_key` and `mint == stablecoin_mint` but doesn't verify canonical ATA derivation.

**WHERE:** `sdk/kit/src/wrap.ts` — in the `wrap()` function, before transaction construction

**WHY:** Council finding (LOW): a non-canonical ATA could be passed, leading to inconsistent balance tracking between validate snapshot and finalize verification. SDK-level rejection eliminates the edge case entirely.

**HOW:**
```typescript
import { getAssociatedTokenAddress } from '@solana/kit';

// In wrap(), before building transaction:
if (outputStablecoinAccount) {
  const canonicalAta = await getAssociatedTokenAddress(
    outputMint, vaultAddress
  );
  if (outputStablecoinAccount !== canonicalAta) {
    throw new Error(
      `Non-canonical ATA detected. Expected ${canonicalAta}, got ${outputStablecoinAccount}. ` +
      `Use the vault's canonical ATA for balance tracking consistency.`
    );
  }
}
```

**Acceptance criteria:** `wrap()` throws on non-canonical ATA input. 2-3 new tests.

**Effort:** ~30 minutes.

---

### Step 20: Protocol Mode ALL Warning in `wrap()` and `getSecurityPosture()`

- [x] **20a.** In `wrap()`: if vault policy has `protocol_mode = ALL` and no constraints configured, emit a warning in `result.warnings[]`
- [x] **20b.** In `getSecurityPosture()`: add check #16 — "Protocol mode is not ALL without constraints" (severity: critical)
- [x] **20c.** Add tests for both warning paths

**WHAT:** Surface explicit warnings when a vault is configured with `protocol_mode = ALL` (any program callable) without `InstructionConstraints`. This configuration means agents can call ANY Solana program with ANY instruction data — the only guardrails are spending caps and SPL transfer blocking.

**WHERE:**
- `sdk/kit/src/wrap.ts` — warning in `wrap()` result
- `sdk/kit/src/security-analytics.ts` — check #16 in `getSecurityPosture()`

**WHY:** Council finding (HIGH by-design): Mode ALL is intentional (matches OpenZeppelin DEFAULT_ADMIN_ROLE pattern) but vault owners who set it without understanding implications are at risk. The SDK should make the risk explicit.

**HOW:**
```typescript
// In getSecurityPosture():
{
  id: "mode-all-unguarded",
  label: "Protocol mode ALL has constraint protection",
  passed: policy.protocolMode !== PROTOCOL_MODE_ALL || (constraints?.strictMode === true),
  severity: "critical",
  detail: "Protocol mode ALL allows agents to call any program. Without strict-mode constraints, agents have unrestricted program access.",
  remediation: "Switch to Allowlist mode, or enable InstructionConstraints with strict_mode=true to restrict allowed instructions.",
},
```

**Acceptance criteria:** `getSecurityPosture()` returns 16 checks. `wrap()` emits warning when mode=ALL + no constraints. Tests updated.

**Effort:** ~45 minutes.

---

### Step 21: Pre-Submission Simulation for Non-Stablecoin Value Reasonableness

- [ ] **21a.** In `wrap()` or `executeAndConfirm()`, when input token is non-stablecoin: simulate the transaction and parse expected stablecoin output
- [ ] **21b.** Fetch spot price from Jupiter Price API (off-chain, no oracle)
- [ ] **21c.** If simulated output < 80% of input value at spot price, emit warning in `result.warnings[]`
- [ ] **21d.** Add optional `minOutputAmount` parameter to `wrap()` for explicit minimum enforcement

**WHAT:** Off-chain price reasonableness check for non-stablecoin input swaps. The on-chain program can't value non-stablecoins (no oracles), but the SDK can consult Jupiter Price API before submission.

**WHERE:** `sdk/kit/src/wrap.ts` — in `executeAndConfirm()` or as a pre-flight check

**WHY:** Council finding: non-stablecoin input path has no outflow cap (by-design, no oracles). SDK-level simulation with off-chain price data closes the gap without introducing oracle risk on-chain. The TEE layer provides the hard enforcement; this is the SDK-level soft warning.

**HOW:**
```typescript
// In executeAndConfirm(), before sending:
if (!isStablecoinMint(inputMint)) {
  const simResult = await rpc.simulateTransaction(signedTx);
  const expectedOutput = parseSimulatedStablecoinDelta(simResult, outputMint, vaultAddress);
  const spotPrice = await fetchJupiterPrice(inputMint); // Jupiter Price API
  const inputValueUsd = inputAmount * spotPrice / 10 ** inputDecimals;
  const outputValueUsd = Number(expectedOutput) / 1_000_000;

  if (outputValueUsd < inputValueUsd * 0.80) {
    result.warnings.push(
      `Non-stablecoin swap output ($${outputValueUsd.toFixed(2)}) is less than 80% of ` +
      `input value ($${inputValueUsd.toFixed(2)} at spot). Possible value leakage.`
    );
  }
}
```

**Acceptance criteria:** `executeAndConfirm()` emits warning on unreasonable non-stablecoin swaps. `minOutputAmount` parameter available for hard enforcement. 3-4 new tests with mocked price API.

**Effort:** ~2-3 hours. Requires Jupiter Price API integration (simple fetch).

---

### Step 22: Trust Boundaries + Verification Architecture Documentation (Council + AUDIT-FIX-PLAN F-3, F-4)

- [ ] **22a.** Add "Trust Boundaries" section to `docs/ARCHITECTURE.md`
- [ ] **22b.** Document: leverage enforcement is advisory (on-chain checks declared value, not actual instruction data)
- [ ] **22c.** Document: non-stablecoin outflow is uncapped by-design (no oracles = can't value)
- [ ] **22d.** Document: enforcement layers (on-chain guardrails → SDK simulation → TEE verification → monitoring)
- [ ] **22e.** Document: non-stablecoin → non-stablecoin swaps are blocked (must route through stablecoin)
- [ ] **22f.** (F-3) Document two-tier instruction verification model in `docs/ARCHITECTURE.md` (~35 lines):
  - Tier 1 (all programs): SPL/Token-2022 transfer blocking, protocol allowlist, generic constraints
  - Tier 2 (5 recognized programs only): ProtocolMismatch check, defi_ix_count limit, Jupiter slippage
  - The 5 recognized: JUPITER_PROGRAM, FLASH_TRADE_PROGRAM, JUPITER_LEND_PROGRAM, JUPITER_EARN_PROGRAM, JUPITER_BORROW_PROGRAM
  - Explain that outcome-based spending in finalize_session is the primary defense; Tier 2 is defense-in-depth
  - Vault owners using unrecognized protocols should configure InstructionConstraints for equivalent protection
- [ ] **22g.** (F-4) Document Jupiter verifier decision in `docs/ARCHITECTURE.md` (~20 lines):
  - Why `integrations/jupiter.rs` (788 lines, 127 swap variants) is kept
  - Slippage is the primary MEV attack vector on swaps
  - Generic constraints can't dynamically locate slippage across variable-length route plans
  - Maintenance burden: table must update when Jupiter adds variants
  - Long-term: replaceable if Jupiter standardizes slippage field location

**WHAT:** Comprehensive security architecture documentation covering trust boundaries (council), verification tiers (F-3), and Jupiter verifier rationale (F-4).

**WHERE:** `docs/ARCHITECTURE.md` — three new sections (~90 lines total)

**WHY:** Council unanimous recommendation + AUDIT-FIX-PLAN F-3/F-4. Vault owners and auditors must understand the full verification model.

**Effort:** ~1.5 hours. Documentation only.

---

### Step 23: SDK Pre-Flight — Token-2022 and SPL Transfer Blocking (from AUDIT-FIX-PLAN F-5)

- [x] **23a.** In `wrap()`, after infrastructure stripping (~line 260), scan input instructions for top-level SPL Token and Token-2022 Transfer/Approve discriminators
- [x] **23b.** Throw descriptive errors for disc 3 (Transfer), 4 (Approve), 12 (TransferChecked), and Token-2022 disc 26 (TransferCheckedWithFee)
- [x] **23c.** Add 2 tests in `sdk/kit/tests/wrap.test.ts`

**WHAT:** SDK-side mirror of the on-chain instruction scan's SPL blocking. Catches invalid transactions before submission, giving developers clear errors instead of opaque on-chain rejections.

**WHERE:** `sdk/kit/src/wrap.ts` (~line 260, after infrastructure stripping)

**WHY:** AUDIT-FIX-PLAN F-5. On-chain is the real enforcement, but SDK pre-flight gives better DX. A developer accidentally including a top-level SPL Transfer gets a clear TypeScript error instead of `UnauthorizedTokenTransfer` from the program.

**HOW:**
```typescript
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

for (const ix of params.instructions) {
  if (
    (ix.programAddress === TOKEN_PROGRAM || ix.programAddress === TOKEN_2022_PROGRAM) &&
    ix.data.length > 0
  ) {
    const disc = ix.data[0];
    if (disc === 4) throw new Error("Top-level SPL Token Approve not allowed in wrapped transactions. DeFi programs handle approvals via CPI.");
    if (disc === 3 || disc === 12 || (ix.programAddress === TOKEN_2022_PROGRAM && disc === 26))
      throw new Error("Top-level SPL Token Transfer not allowed in wrapped transactions. Use the Transfer ActionType instead.");
  }
}
```

**Acceptance criteria:** `wrap()` throws on SPL Transfer/Approve in input instructions. 2 new tests pass.

**Effort:** ~30 minutes.

---

### Step 24: SDK Pre-Flight — DeFi Instruction Count Enforcement (from AUDIT-FIX-PLAN F-6)

- [x] **24a.** Add `RECOGNIZED_DEFI_PROGRAMS` constant to `sdk/kit/src/types.ts` (5 program IDs)
- [x] **24b.** In `wrap()`, after protocol allowlist check (~line 289), count recognized DeFi instructions
- [x] **24c.** Enforce: stablecoin input ≤ 1 recognized DeFi ix, non-stablecoin input == 1 recognized DeFi ix
- [x] **24d.** Add 2 tests in `sdk/kit/tests/wrap.test.ts`

**WHAT:** SDK-side mirror of the on-chain `defi_ix_count` enforcement. Prevents multi-DeFi-instruction attacks (round-trip fee avoidance, split-swap manipulation) at the SDK layer.

**WHERE:** `sdk/kit/src/types.ts` (new constant), `sdk/kit/src/wrap.ts` (~line 289)

**WHY:** AUDIT-FIX-PLAN F-6. On-chain enforces this at lines 347-354 of `validate_and_authorize.rs`. SDK pre-flight catches it earlier with a clear error.

**HOW:**
```typescript
// types.ts
export const RECOGNIZED_DEFI_PROGRAMS: ReadonlySet<string> = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // Jupiter V6
  "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn",   // Flash Trade
  "JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu",   // Jupiter Lend
  "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",    // Jupiter Earn
  "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi",   // Jupiter Borrow
]);

// wrap.ts
if (spending) {
  const defiCount = defiInstructions.filter(ix =>
    RECOGNIZED_DEFI_PROGRAMS.has(ix.programAddress)
  ).length;
  const isStablecoinInput = isStablecoinMint(params.tokenMint, net);
  if (isStablecoinInput && defiCount > 1)
    throw new Error("At most 1 recognized DeFi instruction for stablecoin input (prevents round-trip fee avoidance).");
  if (!isStablecoinInput && defiCount !== 1)
    throw new Error("Exactly 1 recognized DeFi instruction required for non-stablecoin input.");
}
```

**Acceptance criteria:** `wrap()` throws on multi-DeFi-instruction transactions. `RECOGNIZED_DEFI_PROGRAMS` exported from `@phalnx/kit`. 2 new tests pass. Constant must stay in sync with on-chain recognized programs.

**Effort:** ~30 minutes.

---

### Revised Effort Estimate (with Council Findings + Audit Fixes)

| Tier | Steps | Effort |
|------|-------|--------|
| P0 (blocking) | Steps 1-4 | 3-5 days |
| P1 (usability) | Steps 5-12 + 16 | 3-4 days |
| P1.5 (council security) | Steps 18-22 | 1-1.5 days |
| P1.5 (audit pre-flight) | Steps 23-24 | 0.5 days |
| P2 (design docs) | Steps 13-17 (excl. 16) | 1-2 days |
| **Total** | **24 steps** | **8.5-13 days** |

### Implementation Order for Council Steps

Steps 18-20 cluster in `security-analytics.ts` — implement together with existing Step 7-8 work.
Step 19 touches `wrap.ts` — implement with Step 4 (same file).
Step 21 is the most complex — implement after Steps 18-20 are stable.
Step 22 is documentation — can be done anytime.

**Per-step verification commands** (run after each step):
```bash
# After any step:
pnpm --filter @phalnx/kit test                  # All 802+ tests pass
pnpm --filter @phalnx/kit run build              # TypeScript compiles

# After security-analytics steps (7, 8, 18, 20):
pnpm --filter @phalnx/kit test -- --grep "security"

# After wrap.ts steps (5, 19, 23, 24):
pnpm --filter @phalnx/kit test -- --grep "wrap"

# After types.ts steps (6, 9):
pnpm --filter @phalnx/kit test -- --grep "types"
```

---

## Audit Corrections (v1.0 → v1.1, 2026-03-25)

8 fixes applied from plan quality audit. Each fix prevents an implementation bug.

| # | Fix | Severity | What Would Have Gone Wrong |
|---|-----|----------|---------------------------|
| 1 | **Removed dead cap-exceeded regex pattern** | CRITICAL | `wrap()` pushes cap exceeded as a WARNING to `result.warnings[]`, not a thrown error. The regex `/exceeds remaining daily cap/` would never match. Implementer would write dead code. |
| 2 | **Renamed `wrapToAgentError` → `wrapToAgentError`** | MEDIUM | Name collision ambiguity with existing `toAgentError()`. "wrapToAgentError" could mean "wrap an error" (verb) or "error from wrap" (noun). `wrapToAgentError` matches the `toAgentError` naming convention. |
| 3 | **Added `PhalnxSdkError extends Error` class** | HIGH | The original plan returned plain AgentError objects (interfaces). `instanceof Error` checks in consumer code would fail. `PhalnxSdkError extends Error implements AgentError` ensures both `instanceof Error` and structured `AgentError` properties work. |
| 4 | **Added `index.ts` export update for Step 6** | MEDIUM | Plan modified `types.ts` to add `normalizeNetwork` but didn't update `index.ts` to export it. Acceptance criteria required it in `@phalnx/kit` exports — would have been unreachable. |
| 5 | **Added test assertion update note for Step 8** | MEDIUM | Existing `security-analytics.test.ts` asserts `checks.length === 13`. Adding 4 checks to reach 17 would break this assertion. Implementer must update the test count. |
| 6 | **Promoted Step 16 from P2 to P1** | MEDIUM | `onError` callback enables Step 10's `wrapToAgentError()` value. Without the hook, consumers must wrap every `executeAndConfirm()` in their own try/catch to observe structured errors. The callback is ~5 lines of code. |
| 7 | **Added build verification gate** | LOW | No step verified `pnpm -r run build` passes after type-changing steps (6, 8, 9, 10). Type regressions would only be caught at npm publish time. Gate catches them at tier boundary. |
| 8 | **Revised effort estimate: P0 3-5 days, total 7-11 days** | LOW | npm OIDC Trusted Publishing configuration requires external service setup + merge-to-main cycle. `Buffer.from()` in Jupiter example needs `Uint8Array` for browser-safe ESM. Step 10 has 16 throw sites (not 10). |

---

## On-Chain Security Council Audit — SDK Findings (2026-03-25)

> **Source:** 4-member council debate (Architect, Engineer, Security/Pentester, Researcher) — 3 rounds, 12 agent invocations.
> **On-chain verdict:** 8/10 security rating. **Zero program changes required.** All actionable findings are SDK-layer.
> **Full transcript:** Available in conversation history. Council members: Serena Blackwood (Architect), Marcus Webb (Engineer), Rook Blackburn (Security), Ava Chen (Researcher).

### Final On-Chain Severity Table (Post-Debate)

| # | Finding | Final Severity | Status | Exploitable? |
|---|---------|---------------|--------|-------------|
| 1 | Pre-validate front-running | **WITHDRAWN** | PDA ownership eliminates — vault PDA is sole authority, no external signer can set delegates | No |
| 2 | Delegation CPI to rogue destination | **LOW** | Jupiter routing + spending cap = bounded blast radius. Agent can make bad trades within cap — threat model working as designed | Bounded |
| 3 | Leverage amplification bypass | **MEDIUM** | `leverage_bps` is advisory (agent-declared). No fund-loss path, but governance gap — vault reports 2x when actual is 50x | No direct loss |
| 4 | Non-stablecoin uncapped outflow | **INFO** | By-design: no oracles = can't value non-stablecoins. Vault gains stablecoins on non-stablecoin swaps. With Jupiter allowlist, AMM math prevents bad pricing | By-design |
| 5 | Fee-on-transfer token drain | **LOW** | Stablecoin-only mint whitelist (USDC/USDT) mitigates entirely | No |
| 6 | SpendTracker epoch boundary | **LOW** | 600s granularity, no exploit path found | No |
| 7 | Emergency freeze timing | **INFO** | Operational concern, not code-level | No |

### Council Consensus (Unanimous)

- Outcome-based spending enforcement is architecturally sound — defeats parameter spoofing
- CPI guard + session init + PDA ownership eliminates pre-validate attacks structurally
- SPL Token discriminator coverage is complete (3/4/12 + Token-2022 26)
- Instruction scan (unbounded, both paths) is correct
- Generic constraints layering (allowlist → constraints → strict_mode) composes properly
- Non-stablecoin → non-stablecoin swaps are **blocked on-chain** (must route through stablecoin)
- With `protocol_mode = ALLOWLIST` + Jupiter only, non-stablecoin drain is effectively impossible

### SDK Action Items From Council

These should be implemented as part of the existing P1 tier (Steps 7-8 cluster in `security-analytics.ts`).

---

### Step 18: Discriminator Staleness Detection in `getSecurityPosture()`

- [x] **18a.** Add check #14: "Constraint discriminators are current" — compare constraint entry discriminators against known protocol discriminator tables
- [x] **18b.** Add check #15: "Constraint entries cover all allowlisted protocols" — if protocols are in allowlist but have no constraint entries, flag as warning
- [x] **18c.** Surface staleness warnings in `SecurityPosture` result with remediation text

**WHAT:** Detect when `InstructionConstraints` entries reference stale discriminators after a protocol upgrade (e.g., Jupiter V6 → V7). With `strict_mode = OFF`, stale constraints silently stop matching, allowing unconstrained instructions through.

**WHERE:** `sdk/kit/src/security-analytics.ts` — extend `getSecurityPosture()` (after Step 8: 17 checks → 19)

**WHY:** Council finding: constraint brittleness to program upgrades is operational risk. When Jupiter upgrades instruction layouts, constraints break silently. SDK-level detection is the only viable mitigation (on-chain can't self-detect staleness).

**HOW:**
```typescript
// v1.4 fix: verifyDiscriminatorCurrency was undefined. Defined inline.
// Checks that constraint entries have non-empty data constraints (i.e.,
// they actually restrict discriminator bytes, not just match by program ID).
// A constraint with zero data constraints is effectively a no-op — it
// matches ANY instruction from the program, providing no security value.
function hasSubstantiveConstraints(constraints: InstructionConstraints): boolean {
  return constraints.entries.every(
    (e) => e.dataConstraints.length > 0 || e.accountConstraints.length > 0,
  );
}

// Checks 18-19 (after Step 8's 4 additions bring total to 17):
// Check 18: Constraint staleness
{
  id: "constraints-current",
  label: "Constraint entries have substantive rules",
  passed: !constraints || hasSubstantiveConstraints(constraints),
  severity: "warning",
  detail: "Stale constraints may not match current protocol instruction formats.",
  remediation: "Review and update InstructionConstraints entries when protocols upgrade.",
},
// Check 19: Allowlist coverage
{
  id: "constraints-cover-allowlist",
  label: "All allowlisted protocols have constraint entries",
  passed: !constraints || policy.protocolMode !== PROTOCOL_MODE_ALLOWLIST
    || policy.protocols.every(p => constraints.entries.some(e => e.programId === p)),
  severity: "info",
  detail: "Protocols on the allowlist without constraint entries rely solely on spending caps for protection.",
  remediation: "Add InstructionConstraints entries for all allowlisted protocols.",
},
```

**Acceptance criteria:** `getSecurityPosture()` returns 19 checks (17 from Step 8 + 2 here). Tests updated to `checks.length === 19`.

**ORDERING DEPENDENCY (audit fix):** Step 18 MUST execute AFTER Step 8. Step 8 adds 4 checks (13→17). Step 18 adds 2 more (17→19). The check numbers here are #18 and #19, NOT #14 and #15 as originally written — they're cumulative with Step 8's additions.

**Effort:** ~1 hour. Extends existing function, no new files.

---

### Step 19: Non-Canonical ATA Warning in `wrap()` (Demoted from Throw — v1.4 Council 3-1)

- [x] **19a.** Before building the transaction, derive the canonical ATA for the output stablecoin mint
- [x] **19b.** If the passed `outputStablecoinAccount` doesn't match, push a WARNING (not throw)
- [x] **19c.** Add tests for canonical vs. non-canonical ATA detection

**WHAT:** Warn (not reject) on non-canonical token accounts for `output_stablecoin_account`. The on-chain program only checks `owner == vault_key` and `mint == stablecoin_mint` — it does NOT require canonical ATA derivation. Making the SDK STRICTER than on-chain causes false positives for legitimate PDA-based token accounts.

**WHERE:** `sdk/kit/src/wrap.ts` — in the `wrap()` function, before transaction construction

**WHY (v1.4 Council decision):** Original plan threw on non-canonical ATA. Adversarial audit found this is STRICTLY TIGHTER than on-chain, creating false positive risk. Council vote 3-1: Architect, Engineer, Researcher said warn (no Solana DeFi SDK rejects non-canonical ATAs at client level); Security said throw with opt-out. Compromise: **warn by default**, reserve `strictAtaValidation?: boolean` opt-in for future if needed. On-chain owner+mint check is the real enforcement boundary.

**HOW:**
```typescript
// NOTE (audit fix): @solana/kit does NOT export getAssociatedTokenAddress.
// The SDK already uses getProgramDerivedAddress for ATA derivation
// (see x402/transfer-builder.ts:29-44). Use the same pattern here.
import { getProgramDerivedAddress, getAddressEncoder } from '@solana/kit';

const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

async function deriveCanonicalAta(owner: Address, mint: Address): Promise<Address> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM_ADDRESS,
    seeds: [encoder.encode(owner), encoder.encode(TOKEN_PROGRAM_ADDRESS), encoder.encode(mint)],
  });
  return ata;
}

// In wrap(), before building transaction (v1.4: WARNING, not throw):
if (outputStablecoinAccount) {
  const canonicalAta = await deriveCanonicalAta(vaultAddress, outputMint);
  if (outputStablecoinAccount !== canonicalAta) {
    warnings.push(
      `Non-canonical ATA detected for outputStablecoinAccount. Expected ${canonicalAta}, ` +
      `got ${outputStablecoinAccount}. On-chain accepts this (owner+mint check only) but ` +
      `balance tracking may be inconsistent. Use the vault's canonical ATA if possible.`
    );
  }
}
```

**Acceptance criteria:** `wrap()` pushes a warning (not throw) on non-canonical ATA. `result.warnings` includes the ATA message. 2-3 new tests verify warning presence, NOT error.

**Effort:** ~30 minutes.

---

### Step 20: Protocol Mode ALL Warning in `wrap()` and `getSecurityPosture()`

- [x] **20a.** In `wrap()`: AFTER the protocol allowlist check (~line 280-284, the `isProtocolAllowed` block), add: if vault policy has `protocol_mode = ALL` and no constraints configured, push a warning to `warnings[]`. Insert BEFORE transaction composition (Step 10 area), AFTER pre-flight checks.
- [x] **20b.** In `getSecurityPosture()`: add check #20 — "Protocol mode is not ALL without constraints" (severity: critical)
- [x] **20c.** Add tests for both warning paths

**WHAT:** Surface explicit warnings when a vault is configured with `protocol_mode = ALL` (any program callable) without `InstructionConstraints`. This configuration means agents can call ANY Solana program with ANY instruction data — the only guardrails are spending caps and SPL transfer blocking.

**WHERE:**
- `sdk/kit/src/wrap.ts` — warning in `wrap()` result
- `sdk/kit/src/security-analytics.ts` — check #20 in `getSecurityPosture()`

**IMPORT NOTE (v1.4 fix):** `wrap.ts` does NOT currently import `PROTOCOL_MODE_ALL` from `types.js`. Add it to the existing imports block (line 52-62) alongside other type constants:
```typescript
import { ..., PROTOCOL_MODE_ALL } from "./types.js";
```

**WHY:** Council finding (HIGH by-design): Mode ALL is intentional (matches OpenZeppelin DEFAULT_ADMIN_ROLE pattern) but vault owners who set it without understanding implications are at risk. The SDK should make the risk explicit.

**HOW:**
```typescript
// In getSecurityPosture():
{
  id: "mode-all-unguarded",
  label: "Protocol mode ALL has constraint protection",
  passed: policy.protocolMode !== PROTOCOL_MODE_ALL || (constraints?.strictMode === true),
  severity: "critical",
  detail: "Protocol mode ALL allows agents to call any program. Without strict-mode constraints, agents have unrestricted program access.",
  remediation: "Switch to Allowlist mode, or enable InstructionConstraints with strict_mode=true to restrict allowed instructions.",
},
```

**Acceptance criteria:** `getSecurityPosture()` returns 20 checks (19 from Steps 8+18, plus 1 here). `wrap()` emits warning when mode=ALL + no constraints. Tests updated to `checks.length === 20`.

**ORDERING DEPENDENCY (audit fix):** Step 20 MUST execute AFTER Steps 8 AND 18. Cumulative check count: 13 (base) + 4 (Step 8) + 2 (Step 18) + 1 (Step 20) = 20 total.

**Effort:** ~45 minutes.

---

### Step 21: Pre-Submission Simulation for Non-Stablecoin Value Reasonableness

- [ ] **21a.** In `wrap()` or `executeAndConfirm()`, when input token is non-stablecoin: simulate the transaction and parse expected stablecoin output
- [ ] **21b.** Fetch spot price from Jupiter Price API (off-chain, no oracle)
- [ ] **21c.** If simulated output < 80% of input value at spot price, emit warning in `result.warnings[]`
- [ ] **21d.** Add optional `minOutputAmount` parameter to `wrap()` for explicit minimum enforcement

**WHAT:** Off-chain price reasonableness check for non-stablecoin input swaps. The on-chain program can't value non-stablecoins (no oracles), but the SDK can consult Jupiter Price API before submission.

**WHERE:** `sdk/kit/src/wrap.ts` — in `executeAndConfirm()` or as a pre-flight check

**WHY:** Council finding: non-stablecoin input path has no outflow cap (by-design, no oracles). SDK-level simulation with off-chain price data closes the gap without introducing oracle risk on-chain. The TEE layer provides the hard enforcement; this is the SDK-level soft warning.

**HOW:**
```typescript
// In executeAndConfirm(), before sending:
if (!isStablecoinMint(inputMint)) {
  const simResult = await rpc.simulateTransaction(signedTx);
  const expectedOutput = parseSimulatedStablecoinDelta(simResult, outputMint, vaultAddress);
  const spotPrice = await fetchJupiterPrice(inputMint); // Jupiter Price API
  const inputValueUsd = inputAmount * spotPrice / 10 ** inputDecimals;
  const outputValueUsd = Number(expectedOutput) / 1_000_000;

  if (outputValueUsd < inputValueUsd * 0.80) {
    result.warnings.push(
      `Non-stablecoin swap output ($${outputValueUsd.toFixed(2)}) is less than 80% of ` +
      `input value ($${inputValueUsd.toFixed(2)} at spot). Possible value leakage.`
    );
  }
}
```

**FAILURE MODE SPECIFICATION (audit fix):**
- Jupiter Price API down/timeout (3s max): skip price check, emit no warning. Transaction proceeds.
- Jupiter Price API returns unexpected format: skip price check, emit no warning.
- Price check is BEST-EFFORT, NEVER BLOCKING. The on-chain program is the real enforcer.
- Price check is OPT-IN via `enablePriceCheck?: boolean` in WrapParams AND ClientWrapOpts (default: false).
- **IMPORTANT (v1.4 fix):** `ClientWrapOpts` is a SEPARATE interface from `WrapParams` (wrap.ts:497-511). Add `enablePriceCheck` and `minOutputAmount` to BOTH interfaces, otherwise `PhalnxClient` users (the recommended API) cannot opt in.
  Rationale: adding an external HTTP fetch to every transaction path is a breaking change in
  latency and failure modes. Consumers must explicitly opt in.
- A compromised Jupiter response could suppress warnings (return inflated price making output
  look reasonable). This is acceptable because the TEE layer is the hard enforcement — SDK
  price check is advisory only.

**Acceptance criteria:** `executeAndConfirm()` emits warning on unreasonable non-stablecoin swaps WHEN `enablePriceCheck: true` is set. Default behavior unchanged. `minOutputAmount` parameter available for hard enforcement. 3-4 new tests with mocked price API.

**Effort:** ~2-3 hours. Requires Jupiter Price API integration (simple fetch).

---

### Step 22: Trust Boundaries + Verification Architecture Documentation (Council + AUDIT-FIX-PLAN F-3, F-4)

- [ ] **22a.** Add "Trust Boundaries" section to `docs/ARCHITECTURE.md`
- [ ] **22b.** Document: leverage enforcement is advisory (on-chain checks declared value, not actual instruction data)
- [ ] **22c.** Document: non-stablecoin outflow is uncapped by-design (no oracles = can't value)
- [ ] **22d.** Document: enforcement layers (on-chain guardrails → SDK simulation → TEE verification → monitoring)
- [ ] **22e.** Document: non-stablecoin → non-stablecoin swaps are blocked (must route through stablecoin)
- [ ] **22f.** (F-3) Document two-tier instruction verification model in `docs/ARCHITECTURE.md` (~35 lines):
  - Tier 1 (all programs): SPL/Token-2022 transfer blocking, protocol allowlist, generic constraints
  - Tier 2 (5 recognized programs only): ProtocolMismatch check, defi_ix_count limit, Jupiter slippage
  - The 5 recognized: JUPITER_PROGRAM, FLASH_TRADE_PROGRAM, JUPITER_LEND_PROGRAM, JUPITER_EARN_PROGRAM, JUPITER_BORROW_PROGRAM
  - Explain that outcome-based spending in finalize_session is the primary defense; Tier 2 is defense-in-depth
  - Vault owners using unrecognized protocols should configure InstructionConstraints for equivalent protection
- [ ] **22g.** (F-4) Document Jupiter verifier decision in `docs/ARCHITECTURE.md` (~20 lines):
  - Why `integrations/jupiter.rs` (788 lines, 127 swap variants) is kept
  - Slippage is the primary MEV attack vector on swaps
  - Generic constraints can't dynamically locate slippage across variable-length route plans
  - Maintenance burden: table must update when Jupiter adds variants
  - Long-term: replaceable if Jupiter standardizes slippage field location

**WHAT:** Comprehensive security architecture documentation covering trust boundaries (council), verification tiers (F-3), and Jupiter verifier rationale (F-4).

**WHERE:** `docs/ARCHITECTURE.md` — three new sections (~90 lines total)

**WHY:** Council unanimous recommendation + AUDIT-FIX-PLAN F-3/F-4. Vault owners and auditors must understand the full verification model.

**Effort:** ~1.5 hours. Documentation only.

---

### Step 23: SDK Pre-Flight — Token-2022 and SPL Transfer Blocking (from AUDIT-FIX-PLAN F-5)

- [x] **23a.** In `wrap()`, after infrastructure stripping (~line 260), scan input instructions for top-level SPL Token and Token-2022 Transfer/Approve discriminators
- [x] **23b.** Throw descriptive errors for disc 3 (Transfer), 4 (Approve), 12 (TransferChecked), and Token-2022 disc 26 (TransferCheckedWithFee)
- [x] **23c.** Add 2 tests in `sdk/kit/tests/wrap.test.ts`

**WHAT:** SDK-side mirror of the on-chain instruction scan's SPL blocking. Catches invalid transactions before submission, giving developers clear errors instead of opaque on-chain rejections.

**WHERE:** `sdk/kit/src/wrap.ts` (~line 260, after infrastructure stripping)

**WHY:** AUDIT-FIX-PLAN F-5. On-chain is the real enforcement, but SDK pre-flight gives better DX. A developer accidentally including a top-level SPL Transfer gets a clear TypeScript error instead of `UnauthorizedTokenTransfer` from the program.

**HOW:**
```typescript
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

for (const ix of params.instructions) {
  if (
    (ix.programAddress === TOKEN_PROGRAM || ix.programAddress === TOKEN_2022_PROGRAM) &&
    ix.data.length > 0
  ) {
    const disc = ix.data[0];
    if (disc === 4) throw new Error("Top-level SPL Token Approve not allowed in wrapped transactions. DeFi programs handle approvals via CPI.");
    if (disc === 3 || disc === 12 || (ix.programAddress === TOKEN_2022_PROGRAM && disc === 26))
      throw new Error("Top-level SPL Token Transfer not allowed in wrapped transactions. Use the Transfer ActionType instead.");
  }
}
```

**Acceptance criteria:** `wrap()` throws on SPL Transfer/Approve in input instructions. 2 new tests pass.

**Effort:** ~30 minutes.

---

### Step 24: SDK Pre-Flight — DeFi Instruction Count Enforcement (from AUDIT-FIX-PLAN F-6)

- [x] **24a.** Add `RECOGNIZED_DEFI_PROGRAMS` constant to `sdk/kit/src/types.ts` (5 program IDs)
- [x] **24b.** In `wrap()`, after protocol allowlist check (~line 289), count recognized DeFi instructions
- [x] **24c.** Enforce: stablecoin input ≤ 1 recognized DeFi ix, non-stablecoin input == 1 recognized DeFi ix
- [x] **24d.** Add 2 tests in `sdk/kit/tests/wrap.test.ts`

**WHAT:** SDK-side mirror of the on-chain `defi_ix_count` enforcement. Prevents multi-DeFi-instruction attacks (round-trip fee avoidance, split-swap manipulation) at the SDK layer.

**WHERE:** `sdk/kit/src/types.ts` (new constant), `sdk/kit/src/wrap.ts` (~line 289)

**WHY:** AUDIT-FIX-PLAN F-6. On-chain enforces this at lines 347-354 of `validate_and_authorize.rs`. SDK pre-flight catches it earlier with a clear error.

**HOW:**
```typescript
// types.ts
// v1.4 fix: Use ReadonlySet<Address> (not string) to match codebase convention.
// All address constants in types.ts use `as Address` casts.
export const RECOGNIZED_DEFI_PROGRAMS: ReadonlySet<Address> = new Set<Address>([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // Jupiter V6
  "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn",   // Flash Trade
  "JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu",   // Jupiter Lend
  "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",    // Jupiter Earn
  "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi",   // Jupiter Borrow
]);

// wrap.ts
if (spending) {
  const defiCount = defiInstructions.filter(ix =>
    RECOGNIZED_DEFI_PROGRAMS.has(ix.programAddress)
  ).length;
  const isStablecoinInput = isStablecoinMint(params.tokenMint, net);
  if (isStablecoinInput && defiCount > 1)
    throw new Error("At most 1 recognized DeFi instruction for stablecoin input (prevents round-trip fee avoidance).");
  if (!isStablecoinInput && defiCount !== 1)
    throw new Error("Exactly 1 recognized DeFi instruction required for non-stablecoin input.");
}
```

**Acceptance criteria:** `wrap()` throws on multi-DeFi-instruction transactions. `RECOGNIZED_DEFI_PROGRAMS` exported from `@phalnx/kit`. 2 new tests pass. Constant must stay in sync with on-chain recognized programs.

**Effort:** ~30 minutes.

---

### Revised Effort Estimate (with Council Findings + Audit Fixes)

| Tier | Steps | Effort |
|------|-------|--------|
| P0 (blocking) | Steps 1-4 | 3-5 days |
| P1 (usability) | Steps 5-12 + 16 | 3-4 days |
| P1.5 (council security) | Steps 18-22 | 1-1.5 days |
| P1.5 (audit pre-flight) | Steps 23-24 | 0.5 days |
| P2 (design docs) | Steps 13-17 (excl. 16) | 1-2 days |
| **Total** | **24 steps** | **8.5-13 days** |

### Implementation Order for Council Steps (Superseded)

> **NOTE:** This section is superseded by the "Implementation Order (Revised — audit fix v1.2)"
> section above, which integrates Steps 18-24 into the Phase B/C timeline based on file-level
> dependencies. The original text below is preserved for audit trail only.

Steps 18-20 cluster in `security-analytics.ts` — implement together with existing Step 7-8 work.
Step 19 touches `wrap.ts` — implement with Steps 5, 23, 24 (same file, NOT Step 4 which is create-vault.ts).
Step 21 is the most complex — implement after Steps 19, 23, 24 are stable.
Step 22 is documentation — can be done anytime.

---

## Files Modified / Files Created (audit fix v1.2)

Summary of all file changes across 24 steps for implementer reference.

### Files Modified (existing)

| File | Steps | Changes |
|------|-------|---------|
| `sdk/kit/src/wrap.ts` | 5, 16, 19, 20, 21, 23, 24 | JSDoc, onError callback, ATA rejection, warnings, SPL blocking, DeFi count |
| `sdk/kit/src/security-analytics.ts` | 7, 8, 18, 20 | Audit trail filters, +7 security checks (13→20), mode ALL warning |
| `sdk/kit/src/types.ts` | 6, 9, 24 | normalizeNetwork export, stringsToPermissions, RECOGNIZED_DEFI_PROGRAMS |
| `sdk/kit/src/agent-errors.ts` | 10 | PhalnxSdkError class, wrapToAgentError(), SDK_ERROR_PATTERNS |
| `sdk/kit/src/create-vault.ts` | 4 | createAndSendVault() convenience function |
| `sdk/kit/src/portfolio-analytics.ts` | 11 | getAgentLeaderboardAcrossVaults() |
| `sdk/kit/src/inspector.ts` | 12 | inspectConstraints(), ConstraintSummary type |
| `sdk/kit/src/index.ts` | 4, 6, 7, 8, 9, 10, 11, 12 | Export additions for all new functions/types |
| `sdk/kit/tests/security-analytics.test.ts` | 7, 8, 18, 20 | Update checks.length (13→17→19→20), new check tests |
| `docs/ARCHITECTURE.md` | 22 | Trust boundaries, verification tiers, Jupiter verifier rationale |

### Files Created (new)

| File | Step | Purpose |
|------|------|---------|
| `sdk/kit/README.md` | 2 | Getting started guide, API overview, quickstart |
| `sdk/kit/examples/jupiter-swap.ts` | 3 | Runnable Jupiter integration example |
| `sdk/kit/examples/poll-vault.ts` | 17 | Polling pattern example |
| `sdk/kit/tests/create-vault.test.ts` | 4 | Tests for createAndSendVault() |

### Files NOT Modified (verify before touching)

These files are referenced but NOT changed by this plan:
- `sdk/kit/src/owner-transaction.ts` — normalizeNetwork at line 78 will be REMOVED (Step 6 moves it to types.ts)
- `sdk/kit/src/rpc-helpers.ts` — used by Step 4 but not modified
- `programs/phalnx/src/` — NO on-chain changes in this plan

---

## Audit Corrections v1.2 (2026-03-25)

13 fixes applied from deep audit. Each fix prevents an implementation bug or ordering conflict.

| # | Fix | Severity | What Would Have Gone Wrong |
|---|-----|----------|---------------------------|
| 9 | **Check count conflict: Steps 8/18/20 calculated independently from base 13** | CRITICAL | Step 8 claims 17, Step 18 claims 15, Step 20 claims 16 — all wrong except Step 8. Cumulative: 13→17→19→20. Implementer would get assertion failures on every step after Step 8. |
| 10 | **Steps 18-24 not integrated into Phase timeline** | CRITICAL | Implementation Order only covered Phases A-C (Steps 1-17). Steps 18-24 were an appendix with no Phase assignment. Implementer would skip or mis-order them. |
| 11 | **Step 19 imports non-existent `getAssociatedTokenAddress` from @solana/kit** | CRITICAL | @solana/kit uses `getProgramDerivedAddress` for ATA derivation (see x402/transfer-builder.ts:33). Plan import would fail at compile time. |
| 12 | **Step 12 uses `Buffer.from()` — contradicts browser-safety rule** | HIGH | Plan Step 3 warns against Buffer.from (Node-only). Step 12's inspectConstraints() used it. Would break browser/edge bundlers. Fixed to portable Uint8Array hex conversion. |
| 13 | **Dependency graph not updated after Step 16 promotion** | HIGH | Step 16 promoted to P1 (audit fix #6) but dependency graph still listed it under P2. Contradictory instructions. |
| 14 | **Step 21 Jupiter Price API failure mode unspecified** | HIGH | Plan added HTTP fetch to transaction path with no timeout, no opt-in, no failure mode. Could make every swap depend on external API. Fixed: opt-in, 3s timeout, best-effort. |
| 15 | **Step 4 references non-existent test file** | MEDIUM | `create-vault.test.ts` doesn't exist. Plan didn't note it as NEW. Implementer might search for existing file to extend. |
| 16 | **Section header count: 37→35** | LOW | Minor factual error, doesn't affect implementation. |
| 17 | **Step 19 in council order said "implement with Step 4"** | MEDIUM | Step 19 touches wrap.ts, not create-vault.ts. Step 4 is in create-vault.ts. Wrong file clustering. Fixed: Step 19 clusters with Steps 5/23/24 (all wrap.ts). |
| 18 | **Files Modified/Created summary table added** | LOW | WRAP-ARCHITECTURE-PLAN has these; SDK plan didn't. Added for implementer reference. |
| 19 | **Revised Implementation Order with file-level dependency chains** | LOW | Old order organized by step number. New order organized by file (the actual constraint). |
| 20 | **Step 20 check ID said "#16" — should be "#20"** | MEDIUM | Cumulative numbering: 13 base + 4 (Step 8) + 2 (Step 18) + 1 (Step 20) = check #20, not #16. |
| 21 | **owner-transaction.ts normalizeNetwork removal not called out** | LOW | Step 6 moves normalizeNetwork to types.ts but plan didn't note that owner-transaction.ts:78 must be updated to import from types.js. |

---

## Audit Corrections v1.3 (2026-03-26)

9 fixes from adversarial second-pass audit. 3 would have caused compile failures, 2 runtime failures.

| # | Fix | Severity | What Would Have Gone Wrong |
|---|-----|----------|---------------------------|
| 22 | **Step 8 Check 3: `entry.program` → `entry.programId`** | COMPILE BLOCKER | ConstraintEntry type (constraintEntry.ts:33) has `programId`, not `program`. TypeScript: `Property 'program' does not exist on type 'ConstraintEntry'`. Two occurrences in the loop. |
| 23 | **Step 12: `entry.program` → `entry.programId` (same bug)** | COMPILE BLOCKER | Same field name error in inspectConstraints(). Line `const program = entry.program as Address` would fail. |
| 24 | **Step 6: Acceptance criteria impossible** | COMPILE BLOCKER | `resolveVaultState(rpc, vault, agent, undefined, "mainnet")` fails TypeScript because `"mainnet"` ∉ `Network` type. 11 functions accept `Network`, not `NetworkInput`. Fixed: acceptance criteria now tests `normalizeNetwork()` directly. Scope clarified: Step 6 exports the normalizer, does NOT widen `Network`. |
| 25 | **Step 8 Check 4: `countBits()` is private** | RUNTIME FAILURE | Function exists in event-analytics.ts:343 but is NOT exported. security-analytics.ts can't call it. Fixed: define locally (4 lines) to avoid cross-module dependency. |
| 26 | **Step 11: `bytesToAddress` import missing** | RUNTIME FAILURE | portfolio-analytics.ts imports only `type ResolvedVaultState` from state-resolver.ts. The proposed code calls `bytesToAddress(e.agent)` which needs a value import. Fixed: added explicit import instruction. |
| 27 | **Step 10: 2 missing error regex patterns** | SILENT FAILURE | `Non-spending action ... requires amount === 0` (wrap.ts:255) and `No target protocol` (wrap.ts:271) are actionable developer errors that fell through to `code: "UNKNOWN"` — AI agents would lose recovery guidance. Added patterns. |
| 28 | **Package table: 2 peer deps wrong** | DOC ERROR | `@phalnx/custody-turnkey` has `@solana/web3.js ^1.95.0` peer dep. `@phalnx/plugin-solana-agent-kit` has `@phalnx/kit` + `solana-agent-kit >=2.0.0`. Plan said "none" for both. Consumers would install without required peers. |
| 29 | **Build gate test count: 812+ → 802** | DOC ERROR | `scripts/test-counts.json` shows 802 kit tests. "812+" conflated the 802 primary + 9 devnet tests (different suite). Build gate would fail on false expectation. |
| 30 | **Changeset constraint contradicts Step 1c** | DOC ERROR | Header said "No changesets created by this plan" but Step 1c requires creating a test changeset. Fixed: constraint now says "No feature changesets" with Step 1c exception noted. |

---

## Audit Corrections v1.4 (2026-03-26)

4 fixes from adversarial fourth-pass audit. Focused on SDK-vs-on-chain disagreement, undefined functions, missing imports, and missing interface fields.

| # | Finding | Severity | Evidence |
|---|---------|----------|----------|
| 31 | **Step 18: `verifyDiscriminatorCurrency()` undefined** | CRITICAL | Function referenced in code block but never defined anywhere. Replaced with inline `hasSubstantiveConstraints()` that checks entries have non-empty data/account constraints. |
| 32 | **Step 19: SDK strictly tighter than on-chain (false positive risk)** | MEDIUM | On-chain only checks owner+mint for `output_stablecoin_account`, NOT canonical ATA derivation. SDK rejection of non-canonical ATAs blocks legitimate PDA-based token accounts. Council vote 3-1: demoted from throw to `warnings.push()`. |
| 33 | **Step 20: Missing `PROTOCOL_MODE_ALL` import in wrap.ts** | MEDIUM | Plan added warning check using `PROTOCOL_MODE_ALL` but didn't note the constant must be imported from `types.js`. Added explicit import instruction. |
| 34 | **Step 21: `enablePriceCheck` not in `ClientWrapOpts`** | MEDIUM | Plan added field to `WrapParams` but not to `ClientWrapOpts` (separate interface). PhalnxClient users (the recommended API) would have no way to opt in. Fixed: both interfaces now mentioned. |

Additional fixes applied inline (not numbered): `PhalnxSdkError` export added to Step 10, `RECOGNIZED_DEFI_PROGRAMS` changed from `ReadonlySet<string>` to `ReadonlySet<Address>`, Step 20 insertion point specified as "after protocol allowlist check."

---

## Audit Corrections v1.5 (2026-03-26)

6 fixes from semantic third-pass audit. Focused on business logic correctness and event field availability — a different failure class than v1.2 (structural), v1.3 (type), and v1.4 (adversarial).

| # | Fix | Severity | What Would Have Gone Wrong |
|---|-----|----------|---------------------------|
| 35 | **Step 7: 10 of 22 events have no `timestamp` field** | CRITICAL | `Number((f.timestamp as bigint) ?? 0n)` silently produces `0` for PolicyChangeQueued/Applied/Cancelled, all 3 Escrow events, AgentPermissionsUpdated, 3 Constraints queue/apply/cancel. Fixed: fallback chain through `executes_at`, `applied_at`, then 0. Time filter skips events with timestamp=0. |
| 36 | **Step 7: 7+ events have neither `owner` nor `agent` field** | CRITICAL | `(f.owner ?? f.agent ?? "unknown")` produces "unknown" for all policy queue/apply/cancel, all escrow, all constraint queue/apply/cancel events. Fixed: fallback chain through `settled_by`, `refunded_by`, `vault`. |
| 37 | **Step 7b: `txSignature` always empty — DecodedPhalnxEvent has no such field** | HIGH | `DecodedPhalnxEvent` type (events.ts:192) is `{name, data, fields}` — no txSignature. Type cast always undefined → "". Fixed: added note that tx signature must come from transaction envelope, not event decoder. Step 7b needs enrichment callback or extended input type. |
| 38 | **Step 8 Check 2: fee-rate boundary uses `<` but on-chain uses `<=`** | HIGH | On-chain `queue_policy_update.rs:86` validates `fee_rate <= MAX_DEVELOPER_FEE_RATE`. SDK used `< MAX_DEVELOPER_FEE_RATE`, rejecting on-chain-valid rate=500. Also: `> 0` wrongly penalized zero-fee vaults (legitimate — owner chooses no revenue). Fixed: `<= MAX_DEVELOPER_FEE_RATE` with zero allowed. |
| 39 | **Jake persona scope mismatch** | MEDIUM | Plan header lists Jake as persona but NO SDK steps address his needs (leverage verification, position tracking). These are on-chain concerns in ON-CHAIN-IMPLEMENTATION-PLAN. Fixed: scope note added to header. |
| 40 | **Steps 23/24 on-chain consistency — VERIFIED CLEAN** | NONE | SPL discriminators (3,4,12,26) and DeFi count logic (≤1/==1) match on-chain exactly. Infrastructure stripping matches. No blocked discriminators missed. Verified against validate_and_authorize.rs lines 275-357. |
