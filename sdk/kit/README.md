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
  rpc,                     // Rpc<SolanaRpcApi> from @solana/kit
  network: "devnet",
  owner: ownerSigner,      // TransactionSigner
  agent: agentSigner,      // TransactionSigner — separate key from owner
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
  spendingLimitUsd: 1_000_000_000n,        // $1,000 per agent
  dailySpendingCapUsd: 10_000_000_000n,    // $10,000 vault-wide
});
await createVault({
  rpc, network: "mainnet", owner, agent,
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
  rpc, network: "devnet",
  vault, agent: agentSigner,
  instructions: jupiterIxs,
  tokenMint: USDC_MINT_DEVNET,
  amount: 10_000_000n,                               // $10 in base units
  protocolAltAddresses: addressLookupTableAddresses, // rotate per-route
});
```

Any Jupiter-supported protocol flows through the same path; Sigil treats the instructions opaquely and enforces policy on the account touches Jupiter actually makes.

---

## Subpath imports

| Import | Use for |
|--------|---------|
| `@usesigil/kit` | Main API: `seal`, `SigilClient`, `createVault`, analytics, presets |
| `@usesigil/kit/errors` | The 49 `SIGIL_ERROR__*` code constants for `catch`-block narrowing |
| `@usesigil/kit/dashboard` | `OwnerClient` for vault management (reads + owner mutations) |
| `@usesigil/kit/x402` | HTTP 402 Payment Required helpers (`shieldedFetch`, payment parsing) |
| `@usesigil/kit/testing` | Mock RPCs and fixtures for unit tests |
| `@usesigil/kit/testing/devnet` | Devnet test harness (browser-incompatible — Node only) |

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
