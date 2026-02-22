# @agent-shield/solana

> **Deprecated:** This package is a compatibility shim. Use `@agent-shield/sdk` instead.
> All imports below work identically with `@agent-shield/sdk`.

On-chain guardrails for AI agents on Solana. One call to protect your agent.

`@agent-shield/solana` wraps any Solana wallet with transparent policy enforcement — client-side fast deny, TEE key custody, and on-chain vault enforcement bundled as one product. Every `signTransaction` call passes through a policy engine that checks spending caps, rate limits, and protocol allowlists before signing. If a policy is violated, the transaction is rejected with an actionable error.

## Installation

```bash
npm install @agent-shield/solana @solana/web3.js
```

Peer dependencies: `@solana/web3.js >=1.90.0`

Optional: `@agent-shield/sdk ^0.1.0` (needed for on-chain vault enforcement via `harden()` / `withVault()`)

## Quick Start

```typescript
import { withVault } from "@agent-shield/solana";

// One call = full protection (client-side + TEE + on-chain vault)
const result = await withVault(teeWallet, { maxSpend: "500 USDC/day" }, {
  connection,
});

// Use it like a normal wallet — policies enforced by Solana validators
const agent = new SolanaAgentKit(result.wallet, RPC_URL, config);
```

For devnet testing without TEE:
```typescript
const result = await withVault(wallet, { maxSpend: "500 USDC/day" }, {
  connection,
  unsafeSkipTeeCheck: true,
});
```

With no config, secure defaults are applied:
- 1,000 USDC/day, 1,000 USDT/day, 10 SOL/day spending caps
- Unknown programs blocked (only registered DeFi protocols allowed)
- 60 transactions/hour rate limit

## How It Works

```
┌───────────────────────────────────────────────────┐
│  Your Agent Code                                   │
│  agent.swap(USDC, SOL, 100)                       │
└──────────────┬────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────┐
│  withVault() — three layers, one call             │
│  1. Client-side fast deny (spending caps, rates)  │
│  2. TEE key custody (hardware enclave signing)    │
│  3. On-chain vault enforcement (PDA + policy)     │
│  If all pass → sign with inner wallet             │
│  If any fail → throw ShieldDeniedError            │
└──────────────┬────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────┐
│  Solana Validators                                │
│  Policy enforced cryptographically on-chain       │
└──────────────────────────────────────────────────┘
```

## API Reference

### `withVault(wallet, policies?, options): HardenResult`

The primary developer-facing function. One call = full protection.

```typescript
import { withVault } from "@agent-shield/solana";

// Simplest path: bring your TEE wallet
const result = await withVault(teeWallet, { maxSpend: "500 USDC/day" }, {
  connection,
});

// Devnet testing path
const result = await withVault(wallet, { maxSpend: "500 USDC/day" }, {
  connection,
  unsafeSkipTeeCheck: true,
});
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `wallet` | `WalletLike` | Any wallet with `publicKey` and `signTransaction` |
| `policies` | `ShieldPolicies` | Policy configuration (optional — defaults applied) |
| `options` | `HardenOptions` | Connection, owner wallet, TEE config |

**Returns:** `HardenResult` — contains `wallet` (ShieldedWallet with on-chain enforcement), `vaultAddress`, `policyAddress`.

### `harden(shieldedWallet, options): HardenResult`

For power users who need intermediate control. Adds on-chain vault enforcement to an existing shielded wallet.

```typescript
import { harden } from "@agent-shield/solana";

const result = await harden(shieldedWallet, {
  connection,
  unsafeSkipTeeCheck: true,
});
```

### `ShieldedWallet`

The shielded wallet extends `WalletLike` with management methods:

| Property/Method | Description |
|-----------------|-------------|
| `publicKey` | Same public key as the inner wallet |
| `innerWallet` | Reference to the underlying wallet |
| `shieldState` | Current spending tracker state |
| `isHardened` | Whether on-chain enforcement is active |
| `isPaused` | Whether policy enforcement is paused |
| `signTransaction(tx)` | Signs with policy enforcement |
| `signAllTransactions(txs)` | Signs batch with cumulative enforcement |
| `updatePolicies(policies)` | Update policies at runtime |
| `resetState()` | Clear all spending history |
| `pause()` | Temporarily disable enforcement |
| `resume()` | Re-enable enforcement |
| `getSpendingSummary()` | Get current spending relative to limits |

### `TeeWallet`

TEE-backed wallets are required for production use. Any wallet with a `provider` field is recognized:

```typescript
import { isTeeWallet, type TeeWallet } from "@agent-shield/solana";

// Check if a wallet is TEE-backed
if (isTeeWallet(wallet)) {
  console.log(`TEE provider: ${wallet.provider}`);
}
```

Compatible TEE providers: Crossmint, Turnkey, Privy.

### Policy Configuration (`ShieldPolicies`)

```typescript
const result = await withVault(wallet, {
  // Spending caps — human-readable strings or SpendLimit objects
  maxSpend: "500 USDC/day",                          // single limit
  maxSpend: ["500 USDC/day", "10 SOL/hour"],         // multiple limits
  maxSpend: { mint: USDC_MINT, amount: 500_000_000n, windowMs: 86_400_000 },

  // Single transaction size limit (base units)
  maxTransactionSize: 100_000_000n,

  // Protocol allowlist — only these + system programs are allowed
  allowedProtocols: [JUPITER_PROGRAM_ID],

  // Token allowlist — only these tokens can be transferred
  allowedTokens: [USDC_MINT, SOL_MINT],

  // Block unregistered programs (default: true)
  blockUnknownPrograms: true,

  // Rate limit
  rateLimit: { maxTransactions: 60, windowMs: 3_600_000 },

  // Custom policy check (runs after built-in checks)
  customCheck: (analysis) => ({ allowed: true }),
}, { connection, unsafeSkipTeeCheck: true });
```

**Supported spend limit formats:**

| Format | Example |
|--------|---------|
| String shorthand | `"500 USDC/day"` |
| Array of strings | `["500 USDC/day", "10 SOL/hour"]` |
| SpendLimit object | `{ mint: "EPjF...", amount: 500_000_000n }` |
| Array of objects | `[{ mint: "EPjF...", amount: 500_000_000n }]` |
| Empty (defaults) | `undefined` |

**Supported tokens:** USDC, USDT, USDS, SOL, wBTC, cbBTC, wETH, mSOL, jitoSOL, bSOL

**Supported time windows:** `/day` (24h), `/hour` (1h), `/hr` (1h), `/min` (1m), `/minute` (1m)

### Event Callbacks (`ShieldOptions`)

```typescript
import { withVault } from "@agent-shield/solana";

const result = await withVault(wallet, policies, {
  connection,
  unsafeSkipTeeCheck: true,
  shieldOptions: {
    onDenied: (error) => console.error("Denied:", error.violations),
    onApproved: (txHash) => console.log("Approved:", txHash),
    onPause: () => console.log("Enforcement paused"),
    onResume: () => console.log("Enforcement resumed"),
    onPolicyUpdate: (newPolicies) => console.log("Policies updated"),
  },
});
```

| Callback | Fires When |
|----------|------------|
| `onDenied` | Transaction rejected by policy engine |
| `onApproved` | Transaction signed successfully |
| `onPause` | `wallet.pause()` is called |
| `onResume` | `wallet.resume()` is called |
| `onPolicyUpdate` | `wallet.updatePolicies()` is called |

### Spending Summary

```typescript
const summary = result.wallet.getSpendingSummary();

// summary.tokens — per-token spending vs limits
for (const token of summary.tokens) {
  console.log(`${token.symbol}: ${token.spent} / ${token.limit} (${token.remaining} remaining)`);
}

// summary.rateLimit — transaction count vs limit
console.log(`Transactions: ${summary.rateLimit.count} / ${summary.rateLimit.limit}`);

// summary.isPaused — enforcement state
console.log(`Paused: ${summary.isPaused}`);
```

**`SpendingSummary` shape:**

```typescript
interface SpendingSummary {
  tokens: Array<{
    mint: string;
    symbol: string | undefined;
    spent: bigint;
    limit: bigint;
    remaining: bigint;
    windowMs: number;
  }>;
  rateLimit: {
    count: number;
    limit: number;
    remaining: number;
    windowMs: number;
  };
  isPaused: boolean;
}
```

### Runtime Management

```typescript
// Pause enforcement (transactions pass through without checks)
result.wallet.pause();

// Resume enforcement
result.wallet.resume();

// Update policies at runtime
result.wallet.updatePolicies({
  maxSpend: "1000 USDC/day",
  blockUnknownPrograms: false,
});

// Clear all spending history
result.wallet.resetState();
```

### Error Handling

```typescript
import { ShieldDeniedError, TeeRequiredError } from "@agent-shield/solana";

try {
  const result = await withVault(wallet, policies, { connection });
} catch (error) {
  if (error instanceof TeeRequiredError) {
    console.log("TEE wallet required for production use");
  }
}

try {
  await result.wallet.signTransaction(tx);
} catch (error) {
  if (error instanceof ShieldDeniedError) {
    for (const violation of error.violations) {
      console.log(violation.rule);       // "spending_cap"
      console.log(violation.message);    // "Spending cap exceeded for USDC: ..."
      console.log(violation.suggestion); // "Reduce amount to 300000000 or ..."
    }
  }
}
```

**Violation rules:**

| Rule | Description |
|------|-------------|
| `spending_cap` | Token spend exceeds rolling window cap |
| `transaction_size` | Single transaction exceeds max size |
| `unknown_program` | Transaction uses an unregistered program |
| `protocol_not_allowed` | Program not in explicit allowlist |
| `token_not_allowed` | Token mint not in explicit allowlist |
| `rate_limit` | Too many transactions in the time window |

### Wallet Compatibility (`WalletLike`)

`withVault()` works with any wallet that implements this minimal interface:

```typescript
interface WalletLike {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}
```

Compatible with:
- `@solana/web3.js` Keypair wallets
- `@solana/wallet-adapter` browser wallets (Phantom, Solflare, etc.)
- Crossmint TEE-backed wallets
- Turnkey TEE-backed wallets
- Privy embedded wallets
- Coinbase agentic wallets
- Any custom signing implementation

### Transaction Inspection

```typescript
import { analyzeTransaction, getNonSystemProgramIds } from "@agent-shield/solana";

// Analyze a transaction for policy evaluation
const analysis = analyzeTransaction(transaction, walletPublicKey);
// -> { programIds: [...], transfers: [...], estimatedValueLamports: 0n }

// Get non-system program IDs from a transaction
const programIds = getNonSystemProgramIds(transaction);
// -> ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]
```

### Protocol Registry

```typescript
import {
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  isKnownProtocol,
  getProtocolName,
  getTokenInfo,
} from "@agent-shield/solana";

isKnownProtocol("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"); // true
getProtocolName("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"); // "Jupiter V6"
getTokenInfo("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");   // { symbol: "USDC", decimals: 6 }
```

**Registered DeFi protocols:** Jupiter (V2-V6), Orca, Raydium (V4 + CPMM + CLMM), Meteora (DLMM + Pools), Flash Trade, Drift, Mango V4, Kamino, Marginfi, Solend, Marinade, Jito, Saber, OpenBook V2, and more.

## Integration Examples

### Solana Agent Kit

```typescript
import { withVault } from "@agent-shield/solana";
import { createAgentShieldPlugin } from "@agent-shield/plugin-solana-agent-kit";
import { SolanaAgentKit } from "solana-agent-kit";

const result = await withVault(teeWallet, { maxSpend: "500 USDC/day" }, {
  connection,
});
const plugin = createAgentShieldPlugin({ wallet: result.wallet });
const agent = new SolanaAgentKit(result.wallet, RPC_URL, { plugins: [plugin] });
```

### ElizaOS

```typescript
import { agentShieldPlugin } from "@agent-shield/plugin-elizaos";

const character = {
  name: "DeFi Agent",
  plugins: [agentShieldPlugin],
};
// Configure via env vars: SOLANA_WALLET_PRIVATE_KEY, AGENT_SHIELD_MAX_SPEND
```

### Custom Agent

```typescript
import { withVault, ShieldDeniedError } from "@agent-shield/solana";

const result = await withVault(teeWallet, {
  maxSpend: ["500 USDC/day", "10 SOL/day"],
  blockUnknownPrograms: true,
  rateLimit: { maxTransactions: 30, windowMs: 3_600_000 },
}, { connection });

async function agentLoop() {
  try {
    const tx = buildSwapTransaction();
    const signed = await result.wallet.signTransaction(tx);
    await connection.sendRawTransaction(signed.serialize());
  } catch (error) {
    if (error instanceof ShieldDeniedError) {
      console.log("Policy blocked:", error.violations[0].suggestion);
    }
  }
}
```

## Security Model

AgentShield provides three layers of protection in a single integration:

1. **Client-side policy checks** — fast deny before transactions hit the network
2. **TEE key custody** — agent private keys stored in hardware enclaves (Crossmint, Turnkey, Privy)
3. **On-chain vault enforcement** — PDA vaults with cryptographic policy guarantees enforced by Solana validators

All three layers are bundled into `withVault()`. TEE wallets are required for production use — pass `unsafeSkipTeeCheck: true` only for devnet testing.

## Related Packages

| Package | Description |
|---------|-------------|
| [`@agent-shield/core`](https://www.npmjs.com/package/@agent-shield/core) | Pure TypeScript policy engine (used internally) |
| [`@agent-shield/sdk`](https://www.npmjs.com/package/@agent-shield/sdk) | On-chain vault SDK (used internally by `harden()`) |
| [`@agent-shield/plugin-solana-agent-kit`](https://www.npmjs.com/package/@agent-shield/plugin-solana-agent-kit) | Solana Agent Kit integration |
| [`@agent-shield/plugin-elizaos`](https://www.npmjs.com/package/@agent-shield/plugin-elizaos) | ElizaOS integration |

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/agentshield/issues)

## License

Apache-2.0
