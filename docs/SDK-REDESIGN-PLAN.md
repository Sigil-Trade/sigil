# Sigil SDK — Total Redesign Plan (v2)

**Date:** 2026-04-17
**Status:** Synthesis of all multi-track review findings + 4 architectural corrections
**Supersedes:** Original Sprint 1-4 plan in PRD.md

## Mental Model — How Sigil Actually Works

This must be in the README. Multiple persona reviewers got confused about the security model.

```
┌─────────────────────────────────────────────────────────────────┐
│  SDK (TypeScript) — convenient transaction builder              │
│  - createSigilClient + seal()                                    │
│  - createOwnerClient + reads/mutations                           │
│  - shield() — CLIENT-SIDE PRE-FLIGHT ADVISORY (catches early)   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ builds
┌─────────────────────────────────────────────────────────────────┐
│  Solana Transaction:                                             │
│  [validate_and_authorize]  ← reads PolicyConfig PDA              │
│  [DeFi instruction]        ← Jupiter/Drift/etc                   │
│  [finalize_session]        ← measures actual spend, updates SpendTracker │
└─────────────────────────────────────────────────────────────────┘
                              ↓ submits
┌─────────────────────────────────────────────────────────────────┐
│  ON-CHAIN PROGRAM (Anchor) — THE SECURITY BOUNDARY              │
│  - Enforces spending caps (rejects if over)                      │
│  - Enforces protocol allowlist (rejects if not allowed)          │
│  - Enforces agent permissions (rejects if no rights)             │
│  - Vault PDA holds funds; agent has NO direct authority          │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight:** A developer cannot bypass on-chain enforcement by skipping the SDK.
The agent has zero authority over vault funds — only the on-chain Sigil program can
authorize spending, and only after `validate_and_authorize` succeeds. The SDK is the
convenient way to construct transactions the on-chain program will accept.

## Subpath Structure (FINAL)

```
@usesigil/kit                  ← Root (~120 exports — pruned aggressively)
@usesigil/kit/dashboard        ← OwnerClient + reads + mutations + fromJSON
@usesigil/kit/x402             ← HTTP 402 payments
@usesigil/kit/errors           ← 47 error code constants + error class details
@usesigil/kit/testing          ← Browser-safe mocks
@usesigil/kit/testing/devnet   ← Node-only devnet helpers (already exists)
@usesigil/kit/react            ← NEW — TanStack Query hooks (Sprint 2)
```

**Removed from plan:**
- ❌ `/advanced` (council unanimous — hide internals via deeper paths if power users need them)
- ❌ `/mobile`, `/lite` (defer until real consumer demand)
- ❌ `/otel`, `/mocks`, `/analytics` (defer to later sprints)

## What's Hidden (DEEPER AUDIT — additions to original plan)

The original plan only flagged ~200 exports for hiding. After deeper review, **another
~100 exports should be hidden** because they're internal infrastructure that consumers
should never touch.

### Category 1: Internal RPC Plumbing (HIDE — was at root)

```typescript
// REMOVE from root barrel
BlockhashCache, getBlockhashCache       // Internal blockhash caching
AltCache, mergeAltAddresses             // Internal ALT loading
SIGIL_ALT_DEVNET, SIGIL_ALT_MAINNET     // Internal constants
getSigilAltAddress                      // Internal helper
signAndEncode                           // Internal tx signing
sendAndConfirmTransaction               // Internal RPC submission
composeSigilTransaction                 // Internal composition
validateTransactionSize                 // Internal size check
measureTransactionSize                  // Internal size check
toInstruction, bytesToAddress           // Internal converters
resolveAccounts                         // Internal account resolution
```

**Rationale:** These are called by `seal()` / `executeAndConfirm()` internally.
Consumers building custom clients would re-derive PDAs themselves anyway. Exposing
the internal cache classes (which are module-level singletons) is also a security
risk per Pentester F9 — a malicious package could poison the cache for the whole
process.

### Category 2: Policy Engine Internals (HIDE)

```typescript
// REMOVE from root barrel
evaluatePolicy, enforcePolicy           // Core policy engine internals
recordTransaction                       // Internal storage write
toCoreAnalysis                          // Internal converter
ShieldStorage, SpendEntry, TxEntry      // Internal storage abstractions
VelocityTracker, VelocityConfig         // Re-implementation of on-chain SpendTracker (TS mirror)
SpendStatus                             // Internal status type
```

**Rationale:** `shield()` uses these internally. Consumers should call `shield()`
directly, not orchestrate the policy engine themselves. `VelocityTracker` is a
client-side TypeScript mirror of the on-chain SpendTracker — useful for the SDK's
internal pre-flight, useless to a consumer who can just call `vault.budget()`.

### Category 3: TEE Internal Plumbing (HIDE — keep only verifier)

```typescript
// REMOVE from root barrel
AttestationCache, DEFAULT_CACHE_TTL_MS   // Internal cache
clearAttestationCache, deleteFromAttestationCache  // Internal mgmt
NitroPcrValues, TurnkeyAttestationBundle           // Internal types
WalletLike, AttestationConfig, AttestationLevel    // Internal abstractions
AttestationMetadata                                 // Internal type
custodyAdapterToTransactionSigner                   // Internal adapter

// KEEP
verifyTeeAttestation, verifyTurnkey                 // Public verification API
isTeeWallet                                         // Public predicate
TeeWallet, VerifiedTeeWallet, TeeProvider           // Public types
TeeAttestationError, AttestationCertChainError, AttestationPcrMismatchError  // Public errors
```

**Rationale:** Per D7 (Turnkey only), 99% of consumers will use `verifyTurnkey()`
directly. The cache management, PCR types, and adapter conversion are internal to
the verification flow.

### Category 4: Generated Codama Pollution (HIDE — was implicit via export *)

```typescript
// CURRENT (line 5 of index.ts):
export * from "./generated/index.js";    // Dumps ~200 symbols

// REPLACE WITH explicit re-exports:
export {
  SIGIL_PROGRAM_ADDRESS,
} from "./generated/programs/index.js";

// Account types only — for state inspection (consumers reading vault data)
export type {
  AgentVault, PolicyConfig, SpendTracker, SessionAuthority,
  EscrowDeposit, InstructionConstraints, AgentSpendOverlay,
  PendingPolicyUpdate, PendingConstraintsUpdate,
  PostExecutionAssertions, PendingCloseConstraints,
  PendingAgentPermissionsUpdate,
} from "./generated/accounts/index.js";

// Account decoders — for fetching from RPC
export {
  fetchAgentVault, safeFetchAgentVault,
  fetchPolicyConfig, safeFetchPolicyConfig,
  fetchSpendTracker, safeFetchSpendTracker,
  // ... 12 total
} from "./generated/accounts/index.js";
```

**Hidden by this change:** 37 instruction builders + 60+ event/struct types +
the 82 hex error constants in `generated/errors/sigil.ts`.

**For the 1% of power users who genuinely need raw instruction builders:** they can
import from the deep path `@usesigil/kit/dist/generated/instructions/registerAgent.js`.
We don't promote it. We don't break it. They opt in by going deep.

### Category 5: Redundant Vault Creation Paths (CONSOLIDATE)

```typescript
// CURRENT: 4 different functions for vault creation
createVault, createAndSendVault         // From create-vault.ts
inscribe, withVault                     // From inscribe.ts
mapPoliciesToVaultParams, findNextVaultId  // From inscribe.ts

// PROPOSAL: Keep 2, hide 4
KEEP: createVault (returns instructions, caller composes)
KEEP: createAndSendVault (one-shot)
HIDE: inscribe, withVault, mapPoliciesToVaultParams, findNextVaultId
```

**Rationale:** `inscribe()` and `withVault()` are alternative APIs that the README
doesn't even mention. They overlap with `createAndSendVault`. Pick one path. The
hidden ones move to deep paths if anyone needs them.

### Category 6: Internal Constants (HIDE — implementation details)

```typescript
// REMOVE from root barrel
EPOCH_DURATION, NUM_EPOCHS              // SpendTracker internal (10min × 144 epochs)
OVERLAY_EPOCH_DURATION, OVERLAY_NUM_EPOCHS  // AgentSpendOverlay internal
ROLLING_WINDOW_SECONDS                  // Internal calculation constant
PROTOCOL_TREASURY                       // Hardcoded address — consumers shouldn't send here directly
PROTOCOL_FEE_RATE, MAX_DEVELOPER_FEE_RATE  // Internal fee math
FEE_RATE_DENOMINATOR                    // Internal fee math denominator
ON_CHAIN_ERROR_MAP                      // Use toAgentError() instead
```

**Rationale:** These are all things the SDK uses internally. A consumer who needs
`PROTOCOL_FEE_RATE` is doing something they probably shouldn't (recomputing fees
that the on-chain program already calculates).

### Category 7: Duplicate / Overlap (CONSOLIDATE)

```typescript
// TransactionExecutor class overlaps with createSigilClient
// Both: build → sign → send → confirm with retry
// Pick one. Recommend: createSigilClient (factory pattern, viem-aligned).
HIDE: TransactionExecutor, ExecuteTransactionParams, ExecuteTransactionResult, TransactionExecutorOptions
```

### Category 8: Already Identified by Original Plan

```typescript
// From original Sprint 1 plan (still hide)
SigilClient (deprecated class)          // Use createSigilClient factory
ActionType (= never)                    // Footgun
SWAP_ONLY, PERPS_ONLY, TRANSFER_ONLY,
ESCROW_ONLY, PERPS_FULL                 // Legacy bitmasks
ACTION_PERMISSION_MAP, hasPermission,
permissionsToStrings, stringsToPermissions,
PermissionBuilder                       // Legacy permission helpers
47 SIGIL_ERROR__* constants             // Move to /errors subpath
```

## What STAYS at Root (the curated public API)

After all the hiding, root barrel exports only what 95%+ of developers need:

```typescript
// ─── Top-level Facade (Sprint 2) ─────────────────────────────────────
export class Sigil { ... }
export class SigilVault { ... }
export type SigilConfig, SigilPresets

// ─── Core Client (Sprint 1) ──────────────────────────────────────────
export { createSigilClient, seal, replaceAgentAtas } from "./seal.js";
export type { SigilClientApi, SigilClientConfig, SealParams, SealResult, ClientSealOpts, ExecuteResult };

// ─── Owner Operations ────────────────────────────────────────────────
export { createVault, createAndSendVault } from "./create-vault.js";
export type { CreateVaultOptions, CreateVaultResult, CreateAndSendVaultOptions, CreateAndSendVaultResult };

// Re-export from /dashboard for convenience (full surface in /dashboard subpath)
export { createOwnerClient } from "./dashboard/index.js";

// ─── Branded Types + Constructors ────────────────────────────────────
export { usd, capability, slot } from "./types.js";
export type { UsdBaseUnits, CapabilityTier, Slot, Network, NetworkInput, PositionEffect };
export { FULL_CAPABILITY, FULL_PERMISSIONS };

// ─── Program ID + Account Decoders ───────────────────────────────────
export { SIGIL_PROGRAM_ADDRESS };
// 12 account types + 12 decoders (fetchX, safeFetchX) — for state inspection
export { fetchAgentVault, safeFetchAgentVault, /* ... 11 more */ };
export type { AgentVault, PolicyConfig, /* ... 10 more */ };

// ─── Token Constants ─────────────────────────────────────────────────
export { USDC_MINT_DEVNET, USDC_MINT_MAINNET, USDT_MINT_DEVNET, USDT_MINT_MAINNET };
export { TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, ATA_PROGRAM_ADDRESS,
         COMPUTE_BUDGET_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS };
export { JUPITER_PROGRAM_ADDRESS };
export { isStablecoinMint };

// ─── Policy Configuration ────────────────────────────────────────────
export { PROTOCOL_MODE_ALL, PROTOCOL_MODE_ALLOWLIST, PROTOCOL_MODE_DENYLIST };
export { MAX_AGENTS_PER_VAULT, MAX_ALLOWED_PROTOCOLS, MAX_ESCROW_DURATION, MAX_SLIPPAGE_BPS };
export { SUPPORTED_PROTOCOLS };
export type { ProtocolMeta };
export { resolveProtocolName };

// ─── Vault Presets ───────────────────────────────────────────────────
export { VAULT_PRESETS, getPreset, listPresets, presetToCreateVaultFields };
export type { VaultPreset, PresetName };

// ─── State Resolution (high-level only) ──────────────────────────────
export { resolveVaultState, resolveVaultStateForOwner, resolveVaultBudget };
export { findVaultsByOwner, findEscrowsByVault, findSessionsByVault };
export type { ResolvedVaultState, ResolvedVaultStateForOwner, ResolvedBudget, VaultLocator };

// ─── Display Formatting ──────────────────────────────────────────────
export { formatUsd, formatUsdCompact, formatUsdSigned, formatPercent, formatPercentSigned,
         formatDuration, formatRelativeTime, formatTimeUntil, formatAddress,
         formatTokenAmount, formatTokenAmountCompact, toUsdNumber, fromUsdNumber };

// ─── Helpers (Sprint 1) ──────────────────────────────────────────────
export { initializeVaultAtas, parseUsd } from "./helpers/index.js";
// NOTE: parseJupiterSwapInstructions REMOVED — devs use @jup-ag/api directly

// ─── Errors (Sprint 1 — only base classes at root) ───────────────────
export { SigilKitError, SigilShieldError, SigilTeeError, SigilX402Error,
         SigilComposeError, SigilSdkDomainError, SigilRpcError };
export { ShieldDeniedError, ShieldConfigError };
export { TeeAttestationError, AttestationCertChainError, AttestationPcrMismatchError };
export { toAgentError, toSigilAgentError, isAgentError, categorizeError, parseOnChainErrorCode };
export type { AgentError, ErrorCategory, RecoveryAction, SigilErrorCategory };

// ─── Network Errors (typed predicates) ───────────────────────────────
export { isTransportError, redactCause, isAccountNotFoundError };
export { PROVIDER_DENIAL_NAMES, TRANSPORT_CODES };

// ─── Logger Interface (Sprint 1 — NEW) ───────────────────────────────
export type { SigilLogger };

// ─── Lifecycle Hooks (Sprint 2 — NEW) ────────────────────────────────
export type { SealHooks };

// ─── Plugin Contract (Sprint 2 — NEW) ────────────────────────────────
export type { SigilPolicyPlugin };
```

**Estimated final root export count: ~120** (down from 635).

## All 18 Decisions (Locked)

D1-D9: Original architecture decisions (D1 primary user is agents via MCP, D2 onboarding form,
D3 Turnkey invisible, D4 register agent bundled, D5 two signatures, D6 originally "safe defaults"
NOW REVISED, D7 Turnkey only source of truth, D8 dashboard auto-detect / MCP intent, D9 rate
limiting + 5-10min expiry)

D10: Defaults are REQUIRED parameters, not silent fallbacks
D11: 24h timelock minimum for production preset
D12: Aggregate agent cap guard (sum ≤ vault cap)
D13: Strict regex + BigInt for parseUsd (no parseFloat, no Number())
D14: quickstart() forces protocolMode=1 with Jupiter allowlist
D15: Onboarding link HMAC-signed + mandatory Turnkey regen + identicon + red diff vs safe defaults
D16: REVISED — drop "partial" framing, use `{ vault, funded: boolean | { error } }` instead
D17: initializeVaultAtas restricted to policy-allowed mints only
D18: SigilVault asserts network via getGenesisHash() per session

NEW from this redesign:
D19: Hide ~100 additional internal exports per Categories 1-8 above
D20: Drop `parseJupiterSwapInstructions()` from plan — point devs to `@jup-ag/api`
D21: Add `SigilLogger` interface at root (no-op default)
D22: Add `SealHooks` lifecycle interface (Sprint 2)
D23: Add `SigilPolicyPlugin` contract (Sprint 2)
D24: README must lead with "Mental Model" section explaining on-chain vs SDK boundary

## Sprint Plan (REVISED — Bottom-up)

### Sprint 1: Surface Fix + Logger + Safe Defaults (3-5 days)

**Was 1-2 days. Expanded because of D10-D18 + Category 1-8 hiding.**

**Goal:** Cut root barrel from 635 → ~120 exports. Replace silent defaults with required
params + presets. Add logger interface. Strict amount parser. Network assertion.

| # | File | Change |
|---|------|--------|
| 1 | `sdk/kit/src/index.ts` | Replace `export *` from generated; explicit re-exports of 12 account types + decoders + program ID only |
| 2 | `sdk/kit/src/index.ts` | Hide all Category 1-8 exports (RPC plumbing, policy internals, TEE internals, redundant vault paths, internal constants, duplicate executor) |
| 3 | `sdk/kit/src/types.ts` | Delete legacy bitmask exports (SWAP_ONLY etc, ACTION_PERMISSION_MAP, PermissionBuilder) |
| 4 | `sdk/kit/src/create-vault.ts` | Make `spendingLimitUsd` + `timelockDuration` REQUIRED (no defaults). Add aggregate cap guard. |
| 5 | `sdk/kit/src/presets.ts` | Add `Sigil.presets.development` (1800s timelock, $100/agent, $500/day) and `Sigil.presets.production` (86400s timelock, required explicit caps) |
| 6 | `sdk/kit/src/helpers/parse-usd.ts` | NEW — strict regex `^\$(\d{1,15})(\.\d{1,6})?$` + BigInt arithmetic. No parseFloat. |
| 7 | `sdk/kit/src/helpers/ata.ts` | NEW — `initializeVaultAtas(rpc, vault, mints)` restricted to policy-allowed mints |
| 8 | `sdk/kit/src/logger.ts` | NEW — `SigilLogger` interface (debug/info/warn/error). No-op default. Replace all `console.warn`/`console.error` in SDK. |
| 9 | `sdk/kit/src/seal.ts` | Inject logger into SigilClient. Add network genesis hash assertion (D18). |
| 10 | `sdk/kit/package.json` | Add `"./errors"` subpath. Remove `"./advanced"` (not needed). |
| 11 | `sdk/kit/src/errors/public.ts` | NEW — re-export 47 SIGIL_ERROR__* constants for /errors subpath |
| 12 | `sdk/kit/README.md` | Rewrite with Mental Model section, working quickstart, security boundary explanation. Point to `@jup-ag/api` for Jupiter. |
| 13 | `sdk/kit/tests/` | Add tests for parseUsd (matrix), initializeVaultAtas (policy restriction), createVault (required params), logger (no-op default + injection) |

### Sprint 2: Sigil Facade + SigilVault + Lifecycle Hooks + /react (5-7 days)

**Goal:** Add the high-level convenience layer. Wraps Sprint 1 primitives.

| # | File | Change |
|---|------|--------|
| 1 | `sdk/kit/src/sigil.ts` | NEW — `Sigil` facade. Methods: `quickstart()`, `fromVault()`, `discoverVaults()`, `presets`. |
| 2 | `sdk/kit/src/vault-handle.ts` | NEW — `SigilVault` class. Methods: `execute()`, `overview()`, `budget()`, `freeze()`, `fund()`. Returns `{ vault, funded: boolean | { error } }` from quickstart. |
| 3 | `sdk/kit/src/hooks.ts` | NEW — `SealHooks` interface + invocation in seal() (onBeforeBuild, onBeforeSign, onAfterSend, onError, onFinalize) |
| 4 | `sdk/kit/src/plugin.ts` | NEW — `SigilPolicyPlugin` contract + plugin runner in SigilClient |
| 5 | `sdk/kit/src/react/index.ts` | NEW — `useVaultState`, `useVaultBudget`, `useExecute`, `useOverview` (TanStack Query wrappers). React + @tanstack/react-query as peer deps. |
| 6 | `sdk/kit/package.json` | Add `"./react"` subpath. Add react + @tanstack/react-query as `peerDependencies` (optional). |
| 7 | `sdk/kit/README.md` | Add "Quickstart" with Sigil facade. Add "Hooks" section. Add "Plugins" section. |
| 8 | `sdk/kit/tests/` | Sigil facade tests, vault handle tests, hook invocation tests, plugin tests, react hook tests (with RTL) |

### Sprint 3: Dashboard Onboarding Page + WalletConnect (3-5 days)

**Goal:** Build `sigil.trade/onboard` page per D2 + D7 + D15.

| # | What |
|---|------|
| 1 | `sigil-dashboard/app/onboard/page.tsx` — accepts `?owner=&agent=&intent=&sig=` query params |
| 2 | HMAC validation middleware on link generation + verification (D15) |
| 3 | Mandatory "Generate Turnkey Wallet" button — agent param is suggestion-only (D7 + D15) |
| 4 | Agent identicon + full pubkey display (D15) |
| 5 | Vault detection: show "Add agent to vault X" if owner has one (D8 dashboard path) |
| 6 | Stepper UI for two-signature flow (D5) |
| 7 | Rate limiting middleware: per-agent + per-human (D9) |
| 8 | Link expiry tracking: 5-10min, single-use (D9) |
| 9 | Network genesis hash assertion (D18) — page connects to RPC, verifies genesis matches selected network |

### Sprint 4: MCP Gateway (1-2 weeks)

**Goal:** Wrap Sprints 1-3 with MCP tool surface for AI agents.

**Prerequisite:** Sprints 1-3 complete and stable.

| # | What |
|---|------|
| 1 | `packages/mcp/` scaffold with `@modelcontextprotocol/sdk` |
| 2 | `sigil_request_vault({ owner_pubkey })` → returns Sigil-hosted onboarding link |
| 3 | `sigil_execute({ vault, action, amount })` → builds + executes via Turnkey-signed seal |
| 4 | `sigil_status({ vault })` → vault overview |
| 5 | `sigil_budget({ vault })` → spending state |
| 6 | MCP resources: `sigil://vault/{id}/status`, `sigil://vault/{id}/spending` |
| 7 | Per-agent + per-human rate limiting on link generation (D9) |
| 8 | OpenTelemetry instrumentation via Sprint 2 SealHooks |

## What's Documented (Sprint 1 deliverable)

### README.md (full rewrite)
1. **Mental Model** — the on-chain vs SDK boundary diagram above
2. **Quickstart** — 6-line working example using `Sigil.quickstart()`
3. **Security Model** — explicit "what the SDK enforces vs what the program enforces"
4. **Vault Configuration** — explain dailyCap, agent limits, timelock, protocols
5. **Presets** — when to use development vs production
6. **Jupiter Integration** — point to `@jup-ag/api`, show example with seal()
7. **Error Handling** — toAgentError() pattern, recovery actions, retry semantics
8. **Hooks** — SealHooks for observability
9. **Plugins** — SigilPolicyPlugin contract
10. **React** — `@usesigil/kit/react` hooks for TanStack Query
11. **Testing** — `@usesigil/kit/testing` mocks

### CONTRIBUTING.md (NEW per Sasha persona)
1. Repo structure
2. Add a new protocol path (3 steps)
3. Add a new SDK helper path
4. Test requirements
5. PR review pipeline (per CLAUDE.md)

### Migration Guide (NEW)
- For consumers using deleted root exports → import paths to use instead
- For consumers using deprecated `SigilClient` → migrate to `createSigilClient`
- For consumers using `inscribe()` / `withVault()` → migrate to `createAndSendVault`

## Final Security Validation

The redesigned plan addresses all Pentester findings:

| Finding | Fix in Redesign |
|---------|-----------------|
| F1 (toBaseUnits parseFloat) | D13: strict regex + BigInt only. New `parseUsd` helper. |
| F2 (parseSpendLimit no upper bound) | Add `< 10^12` cap in policy validation. Sprint 1 task. |
| F3 ($100/agent × 10 = $1k) | D12: aggregate guard at addAgent. Sprint 1 task. |
| F4 (30min timelock) | D11: 24h minimum for production preset. Dev preset gets warning. |
| F5 (CRITICAL onboarding link) | D15: HMAC + mandatory regen + identicon + red diff. Sprint 3 task. |
| F6 (rate limiting insufficient) | D9 + CAPTCHA on agent re-request, audit log surfaced in dashboard. Sprint 3 task. |
| F7 (default protocolMode=0) | D14: quickstart enforces protocolMode=1. Sprint 1 task. |
| F8 (initializeVaultAtas arbitrary mints) | D17: restrict to policy-allowed mints. Sprint 1 task. |
| F9 (singleton cache pollution) | Caches HIDDEN from public API entirely (Category 1). Sprint 1 task. |
| F10 (network mismatch) | D18: SigilVault asserts genesis hash. Sprint 1 task. |

All silent failure findings:
- Discriminated union "partial" pattern → REJECTED per user Q1. Use `{ vault, funded }` instead.
- Required defaults → D10
- Strict parser → D13
- Result types for partial-success operations → applied to `initializeVaultAtas`

## Estimates

| Sprint | Effort | Status |
|--------|--------|--------|
| Sprint 1: Surface Fix + Logger + Defaults | 3-5 days | Ready |
| Sprint 2: Facade + Hooks + /react | 5-7 days | Plan ready |
| Sprint 3: Dashboard Onboarding | 3-5 days | Plan ready |
| Sprint 4: MCP Gateway | 1-2 weeks | Plan ready |
| **Total** | **3-5 weeks** | |

## Verified Answers (2026-04-17 addendum)

All 5 verification questions RESOLVED:

### V1: Dashboard not built yet — no consumers to check

The `sigil-dashboard/` project is scaffolded but the SDK integration is pending this
redesign. There are no existing consumers of `inscribe()`, `withVault()`, `VelocityTracker`,
`BlockhashCache`, or `AltCache` to break. **Greenfield — hide them aggressively.**

### V2: Constraint package is external private npm

- Repo: `Sigil-Trade/sigil-constraints` (private, created 2026-04-11)
- Published: `@sigil-trade/constraints@0.2.0` via GitHub Packages
- Purpose: "Byte-level instruction constraint compilation, assembly, and validation"
- **SDK does NOT depend on this.** The SDK exports the `ConstraintEntry` type (generated
  from IDL). The actual parser/compiler/decompiler is private IP, consumed only by
  the dashboard when building the constraint builder UI.

No integration changes needed in the SDK for this.

### V3: React subpath placement — FLAT `/react` (not nested under `/dashboard`)

Wagmi precedent: `@wagmi/core` + `@wagmi/react` + `@wagmi/vue` — framework-agnostic
core with flat framework subpaths.

**Final structure:**
- `@usesigil/kit/dashboard` — framework-agnostic OwnerClient (works in Node/Deno/browser)
- `@usesigil/kit/react` — React hooks that internally use `OwnerClient` + `SigilVault` +
  `Sigil` facade. Covers both dashboard and direct-agent-operation use cases.
- Future: `@usesigil/kit/vue`, `@usesigil/kit/svelte` if demand emerges

React hooks ship in Sprint 2 (depends on Sigil facade being built in Sprint 2).

### V4: Dashboard plans are extensive (docs exist)

Found and reviewed:
- `sigil-dashboard/DASHBOARD-PLAN.md` v4.2 (archived, superseded by MASTER-PLAN.md)
- `ADMIN-DASHBOARD-PLAN.md` (separate admin cockpit, different auth model)
- `ADMIN-DASHBOARD-IMPLEMENTATION-GUIDE.md`

**Two dashboards confirmed:**
1. **User dashboard** (`sigil-dashboard/`) — vault owner cockpit. Wallet connect →
   analytics + full vault control. Consumes `@usesigil/kit/dashboard` + `@usesigil/kit/react`.
2. **Admin dashboard** (`ADMIN-DASHBOARD-PLAN.md`) — protocol operator control center.
   Separate origin for security isolation. Also consumes the SDK.

The SDK design serves both. No architecture changes needed.

### V5: Turnkey — CONFIRMED optimal choice, but rationale needs updating

**The claim "only provider with TEE attestations" was inaccurate.** Privy and Crossmint
also attest. The correct claim:

> **"Turnkey is the only provider whose attestations are end-to-end verifiable via
> open-source enclave code (QuorumOS) + reproducible builds (StageX). With any other
> provider, the attestation chain terminates at the provider's word."**

Evidence (2026 research):
- Turnkey: QuorumOS open-sourced Jan 2025 (github.com/tkhq/qos), StageX reproducible
  builds, PCR0 independently recomputable from source. Launched "Verifiable Wallets" 2025.
- Privy: Has Nitro attestations + 2-of-2 share model, but closed-source enclave code,
  no reproducible builds. Trust chain ends at Privy.
- Crossmint: Intel TDX (different threat model, more published vulnerabilities than
  Nitro), open-source code but no reproducible build guarantee.
- Magic, Web3Auth, Particle, Para: HSM/MPC/sharding, no TEE attestation at all.

**Decision: D7 stands (Turnkey locked for agent wallet), but README and marketing must
use the precise framing.**

## Security Model Documentation (Sprint 1 README section)

Must include this verbatim:

> **Why Turnkey?**
>
> Sigil locks the agent wallet provider to Turnkey because Turnkey is the only TEE wallet
> provider whose attestations are end-to-end verifiable:
>
> 1. **Open-source enclave code** — QuorumOS ([github.com/tkhq/qos](https://github.com/tkhq/qos))
>    lets anyone audit what runs inside the enclave.
> 2. **Reproducible builds** — via StageX, PCR0 (the code measurement) can be
>    independently recomputed from source. You don't trust Turnkey — you verify.
> 3. **AWS Nitro Enclaves** — mature hardware-isolated execution with published
>    threat model.
>
> Privy, Crossmint, Magic, and other "embedded wallet" providers do not meet this bar
> — either because they don't attest at all, or because their attestations terminate at
> the provider's word (closed-source enclaves, no reproducible builds).
>
> For a product whose thesis is "AI agents you don't have to trust," the agent's key
> must be in an enclave YOU can verify. Sigil enforces this at the SDK level.
