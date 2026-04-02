# @usesigil/custody

TEE wallet custody adapters for [Sigil](https://github.com/Kaleb-Rupe/sigil) — hardware-enclave signing where the private key never leaves the TEE.

## Adapters

| Subpath | Provider | TEE |
|---------|----------|-----|
| `@usesigil/custody/crossmint` | Crossmint | Intel TDX |
| `@usesigil/custody/privy` | Privy | AWS Nitro Enclave |
| `@usesigil/custody/turnkey` | Turnkey | Secure Infrastructure |

## Install

```bash
npm install @usesigil/custody
```

## Usage

```typescript
import { crossmint } from "@usesigil/custody/crossmint";
import { privy } from "@usesigil/custody/privy";
import { turnkey } from "@usesigil/custody/turnkey";

// Create a TEE-backed wallet
const wallet = await crossmint({ apiKey: "sk_..." });

// Use with Sigil's shieldWallet
import { shieldWallet } from "@usesigil/kit";
const shielded = shieldWallet(wallet, { maxSpend: "500 USDC/day" });
```

Each adapter also supports zero-config from environment variables:

```typescript
import { crossmintFromEnv } from "@usesigil/custody/crossmint";
import { privyFromEnv } from "@usesigil/custody/privy";
import { turnkeyFromEnv } from "@usesigil/custody/turnkey";
```

## License

Apache-2.0
