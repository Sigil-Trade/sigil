# @phalnx/custody-crossmint

Crossmint TEE custody adapter for Phalnx — hardware-enclave signing for AI agents. The private key never leaves the Trusted Execution Environment.

`@phalnx/custody-crossmint` wraps Crossmint's Intel TDX-backed wallets into a standard `WalletLike` interface that works with `shieldWallet()` and the rest of the Phalnx ecosystem. Your agent gets a signing interface; the private key stays in hardware.

## Installation

```bash
npm install @phalnx/custody-crossmint @solana/web3.js
```

Optional peer dependency: `@phalnx/kit` (for `shieldWallet()` integration)

## Quick Start

```typescript
import { shieldWallet } from "@phalnx/kit";
import { crossmint } from "@phalnx/custody-crossmint";

// Create a TEE-backed wallet and wrap it with spending controls
const wallet = shieldWallet(await crossmint({ apiKey: "sk_production_..." }), {
  maxSpend: "500 USDC/day",
});

// Use like any other wallet — signing happens in hardware
await wallet.signTransaction(tx);
```

### Zero-Config from Environment

```typescript
import { shieldWallet } from "@phalnx/kit";
import { crossmintFromEnv } from "@phalnx/custody-crossmint";

// Reads CROSSMINT_API_KEY from environment
const wallet = shieldWallet(await crossmintFromEnv(), {
  maxSpend: "500 USDC/day",
});
```

## API Reference

### `crossmint(config, client?): Promise<CrossmintWallet>`

Create a `CrossmintWallet` from explicit configuration. If no `locator` is provided, a new wallet is created via the Crossmint API.

```typescript
const wallet = await crossmint({ apiKey: "sk_production_..." });
console.log(wallet.publicKey.toBase58()); // Solana address
```

### `crossmintFromEnv(client?): Promise<CrossmintWallet>`

Create a `CrossmintWallet` from environment variables. Throws if `CROSSMINT_API_KEY` is not set.

### `CrossmintWallet`

Implements `WalletLike` — compatible with `shieldWallet()`, Solana Agent Kit, and any code expecting a standard wallet interface.

| Property/Method                           | Description                                                         |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `publicKey`                               | Solana `PublicKey` of the TEE-backed wallet                         |
| `locator`                                 | Crossmint wallet locator string                                     |
| `provider`                                | Always `"crossmint"`                                                |
| `signTransaction(tx)`                     | Sign via TEE — serializes tx, sends to Crossmint, returns signed tx |
| `signAllTransactions(txs)`                | Sign multiple transactions sequentially via TEE                     |
| `CrossmintWallet.create(config, client?)` | Static factory method                                               |

### `CrossmintRESTClient`

Default SDK client that calls Crossmint's REST API directly. Used automatically when no custom client is provided.

| Method                                            | Description                                 |
| ------------------------------------------------- | ------------------------------------------- |
| `createWallet(params)`                            | Create a new wallet via Crossmint API       |
| `getWallet(locator)`                              | Get an existing wallet's address by locator |
| `signTransaction(locator, transaction, encoding)` | Sign a serialized transaction               |

### Configuration Utilities

| Export                   | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `configFromEnv()`        | Parse `CrossmintWalletConfig` from environment variables |
| `validateConfig(config)` | Validate config, throw on missing/invalid fields         |
| `CROSSMINT_ENV_KEYS`     | Environment variable key constants                       |

## Configuration

### `CrossmintWalletConfig`

```typescript
interface CrossmintWalletConfig {
  apiKey: string; // Required — Crossmint server-side API key
  locator?: string; // Existing wallet locator (creates new if omitted)
  chain?: string; // Default: "solana"
  signerType?: "api-key" | "evm-keypair"; // Default: "api-key"
  baseUrl?: string; // Default: "https://www.crossmint.com"
  linkedUser?: string; // User identifier for wallet association
}
```

### Environment Variables

| Variable                   | Required | Default                     | Description                                                                       |
| -------------------------- | -------- | --------------------------- | --------------------------------------------------------------------------------- |
| `CROSSMINT_API_KEY`        | Yes      | —                           | Server-side API key (needs `wallets.create` + `wallets:transactions.sign` scopes) |
| `CROSSMINT_WALLET_LOCATOR` | No       | —                           | Existing wallet locator (creates new wallet if omitted)                           |
| `CROSSMINT_SIGNER_TYPE`    | No       | `api-key`                   | `"api-key"` (custodial) or `"evm-keypair"`                                        |
| `CROSSMINT_BASE_URL`       | No       | `https://www.crossmint.com` | API base URL override                                                             |
| `CROSSMINT_LINKED_USER`    | No       | —                           | Linked user for wallet association                                                |

## Integration with shieldWallet()

```typescript
import { shieldWallet, ShieldDeniedError } from "@phalnx/kit";
import { crossmint } from "@phalnx/custody-crossmint";

const teeWallet = await crossmint({ apiKey: "sk_..." });
const protectedWallet = shieldWallet(teeWallet, {
  maxSpend: ["500 USDC/day", "10 SOL/day"],
  blockUnknownPrograms: true,
  rateLimit: { maxTransactions: 60, windowMs: 3_600_000 },
});

// Two layers of protection:
// 1. Private key in TEE — agent code never sees it
// 2. shieldWallet() enforces spending caps before signing
try {
  await protectedWallet.signTransaction(tx);
} catch (error) {
  if (error instanceof ShieldDeniedError) {
    console.log("Policy blocked:", error.violations[0].suggestion);
  }
}
```

## Related Packages

| Package                                                                          | Description                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`@phalnx/kit`](https://www.npmjs.com/package/@phalnx/kit)                       | On-chain guardrails — `withVault()` primary API  |
| [`@phalnx/core`](https://www.npmjs.com/package/@phalnx/core)                     | Pure TypeScript policy engine                    |

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/phalnx/issues)

## License

Apache-2.0
