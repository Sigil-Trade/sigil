# @usesigil/kit

Kit-native TypeScript SDK for Sigil — on-chain spending limits and permission policies for AI agent wallets on Solana.

Sigil wraps arbitrary DeFi instructions with security guardrails. Your agents trade through Jupiter, Flash Trade, Drift, or any Solana protocol while vault policies enforce spending caps, permission bitmasks, and protocol allowlists.

## Install

```bash
npm install @usesigil/kit @solana/kit
```

`@solana/kit ^6.2.0` is a peer dependency. Node >= 18.

## Quickstart

```typescript
import {
  SigilClient,
  createAndSendVault,
  ActionType,
  toAgentError,
  formatUsd,
  USDC_MINT_DEVNET,
} from "@usesigil/kit";
import { address, createSolanaRpc } from "@solana/kit";

// 1. Create a vault (owner operation — run once)
const rpc = createSolanaRpc("https://api.devnet.solana.com");
const vault = await createAndSendVault({
  rpc,
  network: "devnet",
  owner,              // TransactionSigner (vault authority)
  agent,              // TransactionSigner (AI agent key)
  dailySpendingCapUsd: 500_000_000n,  // $500 in USDC base units
});
console.log(`Vault created: ${vault.vaultAddress}`);

// 2. Wrap a Jupiter swap (agent operation — per trade)
const client = new SigilClient({
  rpc,
  vault: vault.vaultAddress,
  agent,
  network: "devnet",
});

const jupiterInstructions = /* from Jupiter /swap-instructions API */;
const { signature } = await client.executeAndConfirm(jupiterInstructions, {
  tokenMint: USDC_MINT_DEVNET,
  amount: 100_000_000n,           // $100 USDC
  actionType: ActionType.Swap,
  protocolAltAddresses: jupiterResponse.addressLookupTableAddresses,
});

// 3. Check P&L
const pnl = await client.getPnL();
console.log(`P&L: ${formatUsd(pnl.pnl)}`);
```

See [`examples/jupiter-swap.ts`](./examples/jupiter-swap.ts) for a complete, runnable example with Jupiter API calls, instruction parsing, ALT extraction, and error handling.

## Architecture

```
Transaction = [validate_and_authorize, ...defiInstructions, finalize_session]
```

Sigil wraps arbitrary DeFi instructions from any source (Jupiter API, Solana Agent Kit, MCP servers) and sandwiches them with on-chain security checks. All instructions succeed or all revert atomically. The SDK handles instruction composition, ATA rewriting, ALT compression, and pre-flight validation.

## API Overview

### Core — Create vaults, wrap instructions, execute

| Export | Description |
|--------|-------------|
| `SigilClient` | Stateful client — holds vault/agent/network, manages caches. Recommended for production. |
| `wrap()` | Stateless wrapping function — takes DeFi instructions, returns a composed transaction. |
| `createVault()` | Build vault creation instructions (caller signs and sends). |
| `createAndSendVault()` | One-call vault creation — build, sign, send, confirm. |
| `buildOwnerTransaction()` | Compose owner-only transactions (policy updates, agent management). |
| `withVault()` | Policy-guided vault creation — policies in, wrapped client out. |

### State — Query vaults, budgets, spending

| Export | Description |
|--------|-------------|
| `resolveVaultState()` | Fetch complete vault state (accounts, policy, tracker, overlay, constraints). |
| `resolveVaultBudget()` | Per-agent budget: rolling 24h spend, cap, remaining headroom. |
| `getSpendingHistory()` | 144-epoch circular buffer to chart-ready time series. |
| `findVaultsByOwner()` | Enumerate all vaults owned by an address. |
| `resolveVaultStateForOwner()` | Vault state with pending policy/constraint updates for dashboards. |

### Analytics — Security checks, agent metrics, portfolio

| Export | Description |
|--------|-------------|
| `getSecurityPosture()` | 13-point security assessment with pass/fail, severity, remediation. |
| `getVaultHealth()` | Risk score, liquidity, utilization. |
| `getAgentProfile()` | Single agent stats — spend, tx count, errors. |
| `getAgentLeaderboard()` | Top agents by spend or profit. |
| `getPortfolioOverview()` | Cross-vault summary for multi-vault operators. |
| `getAuditTrail()` | Chronological audit log filtered by category, actor, or time range. |
| `getSpendingVelocity()` | Rate of spend over configurable time windows. |

7 analytics modules with 42 functions total — see source for the full list.

### Safety — Pre-flight checks, error handling

| Export | Description |
|--------|-------------|
| `shield()` | Client-side policy gate — evaluate instructions before signing. |
| `simulateBeforeSend()` | RPC simulation with error extraction. |
| `detectDrainAttempt()` | Heuristic drain detection from balance deltas. |
| `toAgentError()` | Convert any error to structured `AgentError` with category, retryable flag, and recovery actions. |

### Formatting — Display helpers (11 functions)

| Export | Description |
|--------|-------------|
| `formatUsd()` | `$1,234.56` with full precision |
| `formatUsdCompact()` | `$1.2M`, `$500K` |
| `formatPercent()` | `12.34%` |
| `formatDuration()` | `1d 2h 3m` |
| `formatAddress()` | `4ZeV...wrHL` |
| `formatTokenAmount()` | `1,000.000000 USDC` |

Plus: `formatUsdSigned`, `formatPercentSigned`, `formatRelativeTime`, `formatTimeUntil`, `formatTokenAmountCompact`.

### Presets — Vault templates

4 pre-configured vault templates for common use cases:

| Preset | Permissions | Daily Cap | Slippage |
|--------|------------|-----------|----------|
| `jupiter-swap-bot` | Swap only | $500 | 2% |
| `perps-trader` | Perps + Swap | $5,000 | 5% |
| `lending-optimizer` | Deposit/Withdraw | $2,000 | 1% |
| `full-access` | All 21 actions | $10,000 | 5% |

```typescript
import { getPreset, presetToCreateVaultFields } from "@usesigil/kit";

const preset = getPreset("jupiter-swap-bot");
const fields = presetToCreateVaultFields(preset);
```

### HTTP 402 Payments (x402)

Sigil supports the [x402 standard](https://www.x402.org/) for automatic HTTP 402 payment negotiation on Solana. Use `shieldedFetch()` to handle payment-required responses transparently — spending limits and vault policies are enforced on every payment.

```typescript
import { shieldedFetch, createShieldedFetch } from "@usesigil/kit/x402";

// One-shot: fetch a paywalled URL, auto-negotiate payment
const response = await shieldedFetch(url, {
  vault, agent, rpc, network: "devnet",
  maxPaymentUsd: 1_000_000n, // $1 max per request
});

if (response.x402?.paid) {
  console.log(`Paid ${response.x402.amount} to ${response.x402.payTo}`);
}

// Reusable: create a pre-configured fetch function
const fetch402 = createShieldedFetch({ vault, agent, rpc, network: "devnet" });
const res = await fetch402("https://api.example.com/premium-data");
```

The x402 subpath exports codec functions (header parsing), payment selectors, nonce tracking, amount validation, and 5 typed error classes (`X402ParseError`, `X402PaymentError`, `X402UnsupportedError`, `X402DestinationBlockedError`, `X402ReplayError`). See [INSTRUCTIONS.md](../docs/INSTRUCTIONS.md) for the full 12-step `shieldedFetch()` flow.

## Error Handling

All errors from `wrap()` and `executeAndConfirm()` convert to structured `AgentError`:

```typescript
import { toAgentError } from "@usesigil/kit";

try {
  await client.executeAndConfirm(instructions, opts);
} catch (err) {
  const e = toAgentError(err);
  console.log(e.category);          // "PERMISSION" | "SPENDING_CAP" | "INPUT_VALIDATION" | ...
  console.log(e.retryable);         // boolean
  console.log(e.recovery_actions);  // [{ action, description, tool? }]
}
```

10 error categories with recovery guidance. 71 on-chain error codes (6000-6070) mapped.

## Testing

```typescript
// Browser-safe mocks (no node:fs, no @solana/web3.js)
import { createMockRpc, createMockVaultState } from "@usesigil/kit/testing";

// Real devnet helpers (Node-only)
import { provisionVault, createDevnetRpc } from "@usesigil/kit/testing/devnet";
```

`@usesigil/kit/testing` provides mock factories for unit tests. `@usesigil/kit/testing/devnet` provides real devnet helpers (vault provisioning, funded agents, USDC airdrops). The devnet subpath imports `node:fs` and `@solana/web3.js` — keep it out of browser bundles.

## Examples

- [`examples/jupiter-swap.ts`](./examples/jupiter-swap.ts) — Complete Jupiter V6 swap via Sigil with error handling and P&L tracking

## Links

- [GitHub](https://github.com/Sigil-Trade/sigil)
- [npm](https://www.npmjs.com/package/@usesigil/kit)
- [Issues](https://github.com/Sigil-Trade/sigil/issues)

## License

Apache-2.0
