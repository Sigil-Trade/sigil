# @usesigil/kit

Kit-native TypeScript SDK for **Sigil** — on-chain spending limits, permission policies, and audit trails for AI-agent wallets on Solana.

> **Sigil is a security wrapper, not a DeFi SDK.** Your agents keep using Jupiter, Flash Trade, Drift, or any Solana protocol. Sigil wraps the instructions they produce with a validate-and-authorize gate, enforces the policies the vault owner configured, and records the outcome — all without touching the underlying DeFi logic.

---

## Install

```bash
npm install @usesigil/kit @solana/kit
```

`@solana/kit ^6.2.0` is a peer dependency. Node >= 18.

---

## Mental model

Sigil separates **authority** (owner) from **execution** (agents), enforced at the Solana transaction boundary rather than only in application code.

```
┌──────────────────────────────────────────────────────────────────┐
│                       OWNER (human or DAO)                       │
│   - Creates vault, sets policy (caps / timelock / allowlist)     │
│   - Registers agent signing keys                                 │
│   - Withdraws funds, freezes vault, revokes agents               │
│   - Cannot be impersonated by any agent                          │
└──────────────────────────┬───────────────────────────────────────┘
                           │ owner-signed transactions
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    SIGIL ON-CHAIN PROGRAM                        │
│   ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐    │
│   │ AgentVault   │  │ PolicyConfig │  │ SpendTracker        │    │
│   │  (funds)     │  │  (limits)    │  │  (rolling 24 h)     │    │
│   └──────────────┘  └──────────────┘  └─────────────────────┘    │
│                                                                  │
│   Every spending tx is `[validate, <DeFi ix>, finalize]`.        │
│   The sandwich cannot be decomposed — all succeed or all revert. │
└──────────────────────────┬───────────────────────────────────────┘
                           │ validated tx
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│        DeFi protocols (Jupiter, Flash Trade, Drift, …)           │
│        Sigil does not touch this layer — no protocol SDK needed. │
└──────────────────────────────────────────────────────────────────┘
```

Nothing an agent does can bypass the on-chain gate. If the validate instruction rejects — cap exceeded, protocol not allowed, agent paused — the entire transaction reverts before any funds move.

---

## Quickstart

Provision a vault and execute your first agent-authorized swap:

```ts
import {
  createAndSendVault,
  SigilClient,
  SAFETY_PRESETS,
  parseUsd,
  createConsoleLogger,
} from "@usesigil/kit";

// 1. Owner provisions the vault on devnet.
const { vaultAddress } = await createAndSendVault({
  rpc, // Rpc<SolanaRpcApi> from @solana/kit
  network: "devnet",
  owner: ownerSigner, // TransactionSigner
  agent: agentSigner, // TransactionSigner — separate key from owner
  // Required safety posture (v0.9.0 — no silent defaults):
  ...SAFETY_PRESETS.development,
});

// 2. Agent opens an async client with genesis-hash verification.
const client = await SigilClient.create({
  rpc,
  vault: vaultAddress,
  agent: agentSigner,
  network: "devnet",
  logger: createConsoleLogger(), // opt in to structured warnings
});

// 3. Wrap arbitrary DeFi instructions from Jupiter, SAK, MCP, etc.
const jupiterInstructions = await buildJupiterSwap(/* your call */);
const { signature } = await client.executeAndConfirm(jupiterInstructions, {
  tokenMint: USDC_MINT_DEVNET,
  amount: parseUsd("$10"), // strict parser → 10_000_000n base units
});
```

The agent's signing key is never enough on its own — Sigil's validate instruction in the same transaction has to authorize the spend, and the finalize instruction has to record it. A leaked agent key cannot exceed the owner-configured daily cap or transfer to a non-allowed destination.

---

## Sigil Facade (v0.11.0)

The six-step quickstart above is fine, but v0.11.0 ships a single-call facade that wraps it. `Sigil.quickstart()` provisions the vault + returns a handle; `Sigil.fromVault()` binds a handle to an existing vault:

```ts
import {
  Sigil,
  SAFETY_PRESETS,
  parseUsd,
  USDC_MINT_DEVNET,
} from "@usesigil/kit";

// Provision + get a handle in one call.
const { vault, funded, signatures } = await Sigil.quickstart({
  rpc,
  network: "devnet",
  owner: ownerSigner,
  agent: agentSigner,
  ...SAFETY_PRESETS.development,
  initialFundingUsd: parseUsd("$100"), // optional — zero or omit to skip
  fundingMint: USDC_MINT_DEVNET, // defaults to USDC on target network
});

if (!funded.funded) {
  console.warn("Vault live but not funded:", funded.reason, funded.error);
}

// Use the handle directly — no separate SigilClient / OwnerClient to wire.
const result = await vault.execute(jupiterInstructions, {
  tokenMint: USDC_MINT_DEVNET,
  amount: parseUsd("$10"),
});

const overview = await vault.overview(); // owner-only — throws OWNER_REQUIRED without owner
const budget = await vault.budget(); // cheapest read — agent-only works
```

Bind a handle to an existing vault:

```ts
const vault = await Sigil.fromVault({
  rpc,
  network: "devnet",
  address: existingVaultAddress,
  agent: agentSigner,
  owner: ownerSigner, // optional — required by vault.freeze() / vault.fund() / vault.overview()
});
```

Enumerate an owner's vaults:

```ts
const vaults = await Sigil.discoverVaults(rpc, ownerAddress, "devnet");
```

Presets are reachable through the same namespace:

```ts
Sigil.presets.safety.development; // { timelockDuration: 1800, ... }
Sigil.presets.safety.production; // null caps — caller supplies
Sigil.presets.vault["perps-trader"]; // VAULT_PRESETS entry
Sigil.presets.applySafetyPreset("production", {
  spendingLimitUsd,
  dailySpendingCapUsd,
});
```

`Sigil` is a frozen namespace object — no instance state, no `new Sigil()`, tree-shakeable.

---

## Lifecycle hooks (v0.11.0)

`SealHooks` observe the transaction lifecycle. Pass hooks at client-config level (fire on every call) or per-call (compose on top of client-level hooks):

```ts
import type { SealHooks } from "@usesigil/kit";

const hooks: SealHooks = {
  onBeforeBuild(ctx, params) {
    // Runs before any RPC. Return { skipSeal: true, reason } to abort cleanly.
    if (isDryRunMode()) return { skipSeal: true, reason: "dry-run" };
  },
  onBeforeSign(ctx, tx) {
    // Observational — fires after build + size check, before signing.
  },
  onAfterSend(ctx, signature) {
    // Fires as soon as the signature is obtained — good for starting traces.
    startTrace(ctx.correlationId, signature);
  },
  onFinalize(ctx, result) {
    // Fires on the success path after confirmation.
    closeTrace(ctx.correlationId, result.signature);
  },
  onError(ctx, err) {
    // Fires in every failure path. Error is always rethrown after the hook.
  },
};

// Register at client level — fire on every vault.execute()
const vault = await Sigil.fromVault({ ..., hooks });

// Or per-call — composes with client-level hooks (client runs first, then per-call)
await vault.execute(instructions, { ..., hooks: perCallHooks });
```

**Semantics:**

- **Observe-only by default.** A hook that throws is caught, logged via the injected logger, and swallowed. Hook exceptions never corrupt `seal()`'s atomic-transaction guarantee.
- **`onBeforeBuild` is the only hook that may abort.** Returning `{ skipSeal: true, reason }` throws `SigilSdkDomainError(SIGIL_ERROR__SDK__HOOK_ABORTED)` before any RPC round-trip. Use for consent flows, feature flags, or dry-run mode.
- **`ctx.correlationId`** is stable across every hook for a single seal invocation — use it to correlate `onBeforeBuild` → `onAfterSend` → `onFinalize` in distributed traces.

---

## Policy plugins (v0.11.0)

`SigilPolicyPlugin` is the rejection surface — distinct from `SealHooks` which observe. Plugins run after state resolution; the first rejection short-circuits `seal()` with `SigilSdkDomainError(SIGIL_ERROR__SDK__PLUGIN_REJECTED)`:

```ts
import type { SigilPolicyPlugin } from "@usesigil/kit";

const maxAmountPlugin: SigilPolicyPlugin = {
  name: "max-amount-plugin",
  check(ctx) {
    if (ctx.amount > 1_000_000_000n) {
      return {
        allow: false,
        reason: "Amount exceeds $1,000 safety threshold",
      };
    }
    return { allow: true };
  },
};

const vault = await Sigil.fromVault({ ..., plugins: [maxAmountPlugin] });
// Calls to vault.execute() with amount > $1,000 throw PLUGIN_REJECTED.
```

Plugin semantics:

- **Enforce, not observe.** First `{ allow: false }` short-circuits the chain — downstream plugins don't run.
- **Async `check()` allowed** — plugins can call feature-flag servers or compliance APIs. A plugin that takes >1 second logs a warning (target is sub-second).
- **Plugin throws become hard rejects.** The runner catches them and treats the message as the rejection reason.
- **Plugin names must be unique per client.** Config validation at handle construction rejects duplicates.

---

## React hooks (v0.11.0, optional subpath)

Install React + TanStack Query as optional peer dependencies, then import from `@usesigil/kit/react`:

```bash
npm install react @tanstack/react-query
```

```tsx
import { useVaultBudget, useOverview, useExecute } from "@usesigil/kit/react";

function VaultDashboard({ vault }: { vault: SigilVault }) {
  const budget = useVaultBudget(vault); // { data, isLoading, error }
  const overview = useOverview(vault); // owner-only
  const execute = useExecute(vault); // { mutate, mutateAsync, isPending }

  if (budget.isLoading) return <div>Loading...</div>;
  return (
    <button
      onClick={() =>
        execute.mutate({
          instructions: myJupiterInstructions,
          opts: { tokenMint: USDC_MINT_DEVNET, amount: parseUsd("$10") },
        })
      }
      disabled={execute.isPending}
    >
      Swap $10
    </button>
  );
}
```

Query keys are namespaced under `"sigil"` so they never collide with the consumer app's TanStack cache. Cache invalidation is the consumer's responsibility — wrap `useExecute` with a custom `onSuccess` that invalidates the specific vault keys you want refetched.

Consumers who don't use React never install the peer deps and never see a warning.

---

## Security boundary

**What the on-chain program enforces:**

- Daily and per-transaction spending caps (`dailySpendingCapUsd`, `maxTransactionSizeUsd`)
- Per-agent spending limits (`spendingLimitUsd`)
- Protocol allowlist / denylist (`protocols`, `protocolMode`)
- Slippage tolerance on Jupiter swaps (`maxSlippageBps`)
- Session expiry, position counters, leverage limits
- Owner timelock on policy changes (`timelockDuration`)

**What the SDK enforces pre-submission:**

- Agent capability check (2-bit enum: Disabled / Observer / Operator)
- Genesis-hash assertion on `SigilClient.create()` — prevents cluster mismatch
- Strict USD parsing (`parseUsd`) — no `parseFloat` rounding
- Aggregate cap guard — sum of per-agent caps ≤ vault cap
- SPL token-operation detection — blocks non-whitelisted transfer patterns

**What the SDK does NOT attempt:**

- Key custody — bring your own `TransactionSigner` (Turnkey, Crossmint, Privy, or a local keypair)
- Transaction simulation outcome trust — simulation is a hint, not a guarantee; on-chain enforcement is the source of truth
- Replay prevention outside a session — agents must start a new session per transaction

If a piece of SDK logic is wrong, the worst a consumer loses is some UX clarity — the on-chain program still rejects the bad transaction. The boundary is deliberate.

---

## Configuration presets

### Use-case presets (`VAULT_PRESETS`)

Starting templates for specific agent roles. Each sets capability, allowlist, slippage, and caps appropriate for the use case:

- `jupiter-swap-bot` — Jupiter only, conservative caps ($500/day, $100/tx)
- `perps-trader` — Jupiter + Flash Trade, 10× leverage, $5,000/day
- `lending-optimizer` — Jupiter Lend + Kamino, 1% slippage, $2,000/day
- `full-access` — every protocol allowed, $10,000/day, 20× leverage

### Safety presets (`SAFETY_PRESETS`) — v0.9.0

Orthogonal to the use-case presets. Picks safe defaults for timelock and caps without prescribing a use case:

- `development` — 30-min timelock, $100/agent, $500/day. Safe for devnet / CI.
- `production` — 24-hour timelock, caps explicitly `null`. You must supply real values via `applySafetyPreset("production", { ... })` — the SDK will throw if you try to use an unfilled production preset with `createVault`.

Compose them:

```ts
import { createVault, VAULT_PRESETS, applySafetyPreset } from "@usesigil/kit";

const presetFields = VAULT_PRESETS["jupiter-swap-bot"];
const safety = applySafetyPreset("production", {
  spendingLimitUsd: 1_000_000_000n, // $1,000 per agent
  dailySpendingCapUsd: 10_000_000_000n, // $10,000 vault-wide
});
await createVault({
  rpc,
  network: "mainnet",
  owner,
  agent,
  ...presetFields,
  ...safety,
});
```

---

## Jupiter integration

`@usesigil/kit` does not wrap Jupiter. Use the official [`@jup-ag/api`](https://www.npmjs.com/package/@jup-ag/api) client to build swap instructions, then pipe the `Instruction[]` through `seal()`:

```ts
import { createJupiterApiClient } from "@jup-ag/api";
import { seal } from "@usesigil/kit";

const jupiter = createJupiterApiClient();
const { swapTransaction, addressLookupTableAddresses } = await jupiter.swapPost(
  { quoteResponse, userPublicKey: vault },
);

// Extract instructions from the serialized swapTransaction (helper omitted
// for brevity — decode with @solana/kit's `getCompiledTransactionMessageDecoder`
// then convert each CompiledInstruction to the Kit Instruction shape).
const jupiterIxs: Instruction[] = decodeSwapInstructions(swapTransaction);

const sealed = await seal({
  rpc,
  network: "devnet",
  vault,
  agent: agentSigner,
  instructions: jupiterIxs,
  tokenMint: USDC_MINT_DEVNET,
  amount: 10_000_000n, // $10 in base units
  protocolAltAddresses: addressLookupTableAddresses, // rotate per-route
});
```

Any Jupiter-supported protocol flows through the same path; Sigil treats the instructions opaquely and enforces policy on the account touches Jupiter actually makes.

---

## Subpath imports

| Import                         | Use for                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `@usesigil/kit`                | Main API: `seal`, `SigilClient`, `createVault`, analytics, presets   |
| `@usesigil/kit/errors`         | The 52 `SIGIL_ERROR__*` code constants for `catch`-block narrowing   |
| `@usesigil/kit/dashboard`      | `OwnerClient` for vault management (reads + owner mutations)         |
| `@usesigil/kit/x402`           | HTTP 402 Payment Required helpers (`shieldedFetch`, payment parsing) |
| `@usesigil/kit/react`          | TanStack Query hooks (v0.11.0) — optional React peer deps            |
| `@usesigil/kit/testing`        | Mock RPCs and fixtures for unit tests                                |
| `@usesigil/kit/testing/devnet` | Devnet test harness (browser-incompatible — Node only)               |

---

## v0.10 → v0.11 migration

v0.11.0 is additive. Existing v0.10.0 consumers do not need to change code to upgrade — `Sigil` facade, `SigilVault`, hooks, plugins, and the `/react` subpath all sit on top of the existing `createSigilClient` / `createOwnerClient` / `seal()` primitives.

Recommended migration path:

1. Replace bespoke `createAndSendVault` + `SigilClient.create` + `createOwnerClient` plumbing with `Sigil.quickstart()` / `Sigil.fromVault()` for new call sites.
2. Add lifecycle hooks to your existing `SigilClientConfig` or `SigilVault.execute()` options for telemetry.
3. Move React consumers off ad-hoc `useEffect` loops onto `@usesigil/kit/react` hooks.

v0.11.0 also added three new error codes to `/errors` (for a total of 52):

- `SIGIL_ERROR__SDK__HOOK_ABORTED` — onBeforeBuild returned `{ skipSeal: true }`
- `SIGIL_ERROR__SDK__PLUGIN_REJECTED` — a plugin returned `{ allow: false }`
- `SIGIL_ERROR__SDK__OWNER_REQUIRED` — an owner-only SigilVault method was called on an agent-only handle

---

## v0.8 → v0.9 migration

v0.9.0 is a breaking release. The headline changes:

1. **`createVault` now requires three fields** that previously had silent defaults: `spendingLimitUsd`, `dailySpendingCapUsd`, `timelockDuration`. Set them explicitly or spread `SAFETY_PRESETS.development` / `applySafetyPreset("production", {...})`.
2. **`SigilClient.create(config)` is the new preferred entry point** — it asserts the RPC's genesis hash matches the configured network. `new SigilClient(config)` is deprecated (removal in Sprint 2) and logs a warning.
3. **49 `SIGIL_ERROR__*` constants moved from the root barrel** to the `./errors` subpath. Update imports:
   ```diff
   - import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "@usesigil/kit";
   + import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "@usesigil/kit/errors";
   ```
4. **Root barrel lost ~325 exports** (Codama instruction builders, event/struct types, hex error constants). Consumers who imported generated internals should migrate to `seal()` / `createVault()` / `OwnerClient`. Account decoders stay at root.
5. **Structured logger replaces `console.warn`** inside the SDK. Pass `logger: createConsoleLogger()` to `SigilClient.create()` (or your preferred logger matching the `SigilLogger` interface) to receive diagnostic output.

See `CHANGELOG.md` and the upgrade checklist for every grep you need to run.

---

## License

Apache-2.0. Copyright 2024-2026 Kaleb Rupe.
