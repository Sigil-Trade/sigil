# @phalnx/core

Pure TypeScript policy engine for AI agent spending controls. Zero blockchain dependencies.

`@phalnx/core` is the foundational policy engine that powers all Phalnx packages. It provides spending caps, rate limiting, protocol allowlists, and transaction analysis in a framework-agnostic, chain-agnostic core. Use it directly if you're building a custom integration, or let higher-level packages like `@phalnx/sdk` consume it automatically.

## Installation

```bash
npm install @phalnx/core
```

Zero dependencies. Works in Node.js, browsers, and edge runtimes.

## Features

- **Human-readable policy strings** — `"500 USDC/day"`, `"10 SOL/hour"`, `"0.5 wBTC/day"`
- **Rolling time windows** — 24h spending caps that slide, not calendar-day resets
- **Rate limiting** — configurable max transactions per time window
- **Protocol registry** — 30+ known Solana DeFi protocols pre-registered
- **Token registry** — 12+ common tokens with symbols and decimals
- **BigInt math** — precise token amounts, no floating point drift
- **Pluggable storage** — persist spending state to localStorage, databases, or custom backends
- **Actionable errors** — every policy violation includes a human-readable suggestion

## Quick Start

```typescript
import {
  resolvePolicies,
  evaluatePolicy,
  recordTransaction,
  ShieldState,
} from "@phalnx/core";

// 1. Define policies
const policies = resolvePolicies({
  maxSpend: "500 USDC/day",
  blockUnknownPrograms: true,
  rateLimit: { maxTransactions: 60, windowMs: 3_600_000 },
});

// 2. Create state tracker
const state = new ShieldState();

// 3. Evaluate a transaction analysis object
const violations = evaluatePolicy(transactionAnalysis, policies, state);

if (violations.length > 0) {
  console.error("Denied:", violations.map((v) => v.message).join(", "));
} else {
  recordTransaction(transactionAnalysis, state);
  console.log("Approved");
}
```

## API Reference

### Policy Configuration

#### `resolvePolicies(input?: ShieldPolicies): ResolvedPolicies`

Normalizes user-facing config into internal resolved format. Applies secure defaults for any missing fields.

```typescript
const policies = resolvePolicies({
  maxSpend: ["500 USDC/day", "10 SOL/hour"],
  maxTransactionSize: "100000000", // 100 USDC in base units
  allowedProtocols: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
  allowedTokens: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  blockUnknownPrograms: true,
  rateLimit: { maxTransactions: 60, windowMs: 3_600_000 },
});
```

#### `parseSpendLimit(input: string): SpendLimit`

Parses human-readable spending limit strings.

```typescript
parseSpendLimit("500 USDC/day");
// → { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: 500000000n, windowMs: 86400000 }

parseSpendLimit("10 SOL/hour");
// → { mint: "So1111...112", amount: 10000000000n, windowMs: 3600000 }
```

Supported tokens: USDC, USDT, USDS, SOL, wBTC, cbBTC, wETH, mSOL, jitoSOL, bSOL

Supported windows: `/day`, `/hour`, `/hr`, `/min`, `/minute`

#### `DEFAULT_POLICIES`

Secure defaults applied when no config is provided:

| Policy | Default |
|--------|---------|
| USDC spending cap | 1,000 USDC / 24h |
| USDT spending cap | 1,000 USDT / 24h |
| SOL spending cap | 10 SOL / 24h |
| Unknown programs | Blocked |
| Rate limit | 60 transactions / hour |

### Policy Evaluation

#### `evaluatePolicy(analysis, policies, state): PolicyViolation[]`

Returns an array of violations. Empty array = transaction is allowed.

```typescript
const violations = evaluatePolicy(analysis, policies, state);
if (violations.length === 0) {
  // Transaction passes all policy checks
}
```

#### `enforcePolicy(analysis, policies, state): void`

Throws `ShieldDeniedError` if any policies are violated. Use this for fail-fast enforcement.

```typescript
try {
  enforcePolicy(analysis, policies, state);
  // Proceed with signing
} catch (error) {
  if (error instanceof ShieldDeniedError) {
    console.error(error.violations);
  }
}
```

#### `recordTransaction(analysis, state): void`

Records outgoing token transfers and increments the transaction counter. Call this **after** a transaction is successfully signed.

### State Tracking

#### `new ShieldState(storage?: ShieldStorage)`

Maintains rolling spending and transaction counts in memory with optional persistence.

```typescript
// In-memory (default)
const state = new ShieldState();

// With localStorage persistence (browser)
const state = new ShieldState(localStorage);

// With custom storage
const state = new ShieldState({
  getItem: (key) => redis.get(key),
  setItem: (key, value) => redis.set(key, value),
});
```

**Methods:**

| Method | Description |
|--------|-------------|
| `recordSpend(mint, amount)` | Record a token transfer |
| `recordTransaction()` | Record a transaction for rate limiting |
| `getSpendInWindow(mint, windowMs)` | Get total spend for a token in the rolling window |
| `getTransactionCountInWindow(windowMs)` | Get transaction count in the rolling window |
| `pruneExpired(maxWindowMs)` | Remove entries older than the window |
| `reset()` | Clear all state |

### Protocol & Token Registry

#### Constants

| Constant | Description |
|----------|-------------|
| `KNOWN_PROTOCOLS` | `ReadonlyMap<string, string>` — 30+ DeFi protocol program IDs |
| `KNOWN_TOKENS` | `ReadonlyMap<string, { symbol, decimals }>` — 12+ common token mints |
| `SYSTEM_PROGRAMS` | `ReadonlySet<string>` — always-allowed system programs |

#### Functions

| Function | Description |
|----------|-------------|
| `getTokenInfo(mint)` | Lookup token symbol and decimals by mint address |
| `getProtocolName(programId)` | Lookup protocol name by program ID |
| `isSystemProgram(programId)` | Check if a program is always-allowed (Token, ATA, System, etc.) |
| `isKnownProtocol(programId)` | Check if a program is in the DeFi registry |

**Registered protocols include:** Jupiter (V2-V6), Orca, Raydium (V4 + CPMM + CLMM), Meteora (DLMM + Pools), Flash Trade, Drift, Mango V4, Kamino, Marginfi, Solend, Marinade, Jito, Saber, OpenBook V2, and more.

### Error Types

#### `ShieldDeniedError`

Thrown when a transaction violates one or more policies.

```typescript
import { ShieldDeniedError } from "@phalnx/core";

try {
  enforcePolicy(analysis, policies, state);
} catch (error) {
  if (error instanceof ShieldDeniedError) {
    for (const v of error.violations) {
      console.log(v.rule);       // "spending_cap" | "rate_limit" | "unknown_program" | ...
      console.log(v.message);    // "Spending cap exceeded for USDC: ..."
      console.log(v.suggestion); // "Reduce amount to 300000000 or wait for the window to reset"
      console.log(v.details);    // { limit: "500000000", attempted: "600000000", ... }
    }
  }
}
```

#### `ShieldConfigError`

Thrown when policy configuration is invalid (e.g., unknown token symbol, invalid time window).

### Types

#### `ShieldPolicies`

```typescript
interface ShieldPolicies {
  maxSpend?: SpendLimit | SpendLimit[] | string | string[];
  maxTransactionSize?: bigint | string;
  allowedProtocols?: string[];
  allowedTokens?: string[];
  blockUnknownPrograms?: boolean;
  rateLimit?: RateLimitConfig;
  customCheck?: (analysis: TransactionAnalysis) => PolicyCheckResult;
}
```

#### `SpendLimit`

```typescript
interface SpendLimit {
  mint: string;       // Token mint address (base58)
  amount: bigint;     // Maximum amount in base units per window
  windowMs?: number;  // Rolling window in milliseconds (default: 86400000 = 24h)
}
```

#### `PolicyViolation`

```typescript
interface PolicyViolation {
  rule: "spending_cap" | "transaction_size" | "protocol_not_allowed"
      | "token_not_allowed" | "rate_limit" | "unknown_program";
  message: string;
  suggestion: string;
  details: Record<string, string>;
}
```

#### `TransactionAnalysis`

```typescript
interface TransactionAnalysis {
  programIds: string[];
  transfers: TokenTransfer[];
  estimatedValueLamports: bigint;
}
```

#### `TokenTransfer`

```typescript
interface TokenTransfer {
  mint: string;
  amount: bigint;
  direction: "outgoing" | "incoming" | "unknown";
  destination?: string;
}
```

## Architecture

```
@phalnx/core (this package)
├── policies.ts    — Config types, parsing, defaults
├── engine.ts      — Policy evaluation + enforcement
├── state.ts       — Rolling spend + rate limit tracking
├── registry.ts    — Protocol/token/system program registry
└── errors.ts      — ShieldDeniedError, ShieldConfigError

Used by:
├── @phalnx/sdk      — On-chain guardrails (primary package)
└── (your custom integration)
```

## When to Use This Package Directly

- Building a custom wallet wrapper for a chain not yet supported
- Implementing server-side policy enforcement (e.g., in a signing service)
- Testing policy logic in isolation
- Building framework integrations beyond Solana Agent Kit and ElizaOS

For Solana-specific integrations, use `@phalnx/sdk` which wraps this package with Solana transaction analysis and wallet signing.

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/phalnx/issues)

## License

Apache-2.0
