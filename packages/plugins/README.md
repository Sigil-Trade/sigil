# @usesigil/plugins

Agent framework adapters for [Sigil](https://github.com/Kaleb-Rupe/sigil) — plug Sigil's security guardrails into popular AI agent frameworks.

## Available Adapters

| Subpath | Framework | Status |
|---------|-----------|--------|
| `@usesigil/plugins/sak` | [Solana Agent Kit](https://github.com/sendai-labs/solana-agent-kit) | Stable |

## Install

```bash
npm install @usesigil/plugins
```

## Usage — Solana Agent Kit

```typescript
import { createSigilPlugin } from "@usesigil/plugins/sak";

const plugin = createSigilPlugin({
  vault: "YOUR_VAULT_ADDRESS",
  agent: agentSigner,
  network: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
});

// Register with Solana Agent Kit
const agent = new SolanaAgentKit({ plugins: [plugin] });
```

The plugin wraps `seal()` from `@usesigil/kit` — every DeFi action the agent takes goes through Sigil's authorization and spending cap enforcement.

## License

Apache-2.0
