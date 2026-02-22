# @agent-shield/platform

Platform client for AgentShield — request TEE wallet provisioning via Solana Actions endpoints. Zero runtime dependencies.

`@agent-shield/platform` is a lightweight HTTP client that lets AI agents request protected wallet provisioning through AgentShield's Solana Actions (Blinks) API. It generates Action URLs, Blink URLs, submits provision requests, and polls for results.

## Installation

```bash
npm install @agent-shield/platform
```

Zero runtime dependencies. Uses the native `fetch` API (Node.js 18+).

## Quick Start

```typescript
import { AgentShieldPlatform } from "@agent-shield/platform";

// 1. Create a platform client
const platform = new AgentShieldPlatform("https://agent-middleware.vercel.app");

// 2. Generate an Action URL for the user to sign
const actionUrl = platform.getProvisionActionUrl({ dailyCap: 500 });

// 3. Or generate a Blink URL for in-chat rendering
const blinkUrl = platform.getBlinkUrl({ dailyCap: 500 });

// 4. Request a provision transaction for a specific account
const { transaction } = await platform.requestProvision(
  "UserPublicKeyBase58...",
  { dailyCap: 500, template: "conservative" }
);

// 5. After the user signs, poll for the result
const result = await platform.waitForProvision(txSignature);
console.log(result.vaultAddress);  // On-chain vault PDA
console.log(result.agentPubkey);   // Agent signing key
```

## API Reference

### `new AgentShieldPlatform(baseUrl)`

Create a platform client pointing to an AgentShield Actions server.

| Parameter | Type | Description |
|-----------|------|-------------|
| `baseUrl` | `string` | Base URL of the Actions server (e.g. `https://agent-middleware.vercel.app`) |

### `getProvisionActionUrl(options?): string`

Generate a Solana Action URL for vault provisioning.

```typescript
const url = platform.getProvisionActionUrl({ dailyCap: 500, template: "moderate" });
// → "https://agent-middleware.vercel.app/api/actions/provision?template=moderate&dailyCap=500"
```

### `getBlinkUrl(options?): string`

Generate a Dialect Blink URL that renders the Action in-chat.

```typescript
const url = platform.getBlinkUrl({ dailyCap: 500 });
// → "https://dial.to/?action=solana-action:https%3A%2F%2F..."
```

### `getActionMetadata(): Promise<ActionMetadata>`

Fetch the Action metadata (GET endpoint). Returns the action's title, description, icon, and available parameters.

### `requestProvision(account, options?): Promise<{ transaction, message? }>`

Request a provision transaction for a specific Solana account. Returns a base64-encoded unsigned `VersionedTransaction`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `account` | `string` | User's Solana public key (base58) |
| `options` | `ProvisionOptions` | Optional daily cap and template |

### `checkStatus(txSignature): Promise<ProvisionResult>`

Poll the status endpoint for a provision result.

| Parameter | Type | Description |
|-----------|------|-------------|
| `txSignature` | `string` | Transaction signature from the user's wallet |

### `waitForProvision(txSignature, timeoutMs?, intervalMs?): Promise<ProvisionResult>`

Poll until the provision is confirmed or times out. Default timeout: 60s, default interval: 2s.

### `formatProvisionMessage(options?): string`

Generate a human-readable message with both Action URL and Blink URL for presenting to users.

## Types

### `ProvisionOptions`

```typescript
interface ProvisionOptions {
  dailyCap?: number;   // Daily spending cap in USDC (e.g. 500)
  template?: string;   // Policy template: "conservative" | "moderate" | "aggressive"
}
```

### `ProvisionResult`

```typescript
interface ProvisionResult {
  status: "pending" | "confirmed" | "not_found";
  vaultAddress?: string;
  agentPubkey?: string;
  agentLocator?: string;
  template?: string;
  error?: string;
}
```

### `ActionMetadata`

```typescript
interface ActionMetadata {
  type: string;
  icon: string;
  title: string;
  description: string;
  label: string;
  links: {
    actions: Array<{
      label: string;
      href: string;
      parameters?: Array<{ name: string; label: string; required?: boolean }>;
    }>;
  };
}
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@agent-shield/sdk`](https://www.npmjs.com/package/@agent-shield/sdk) | On-chain guardrails — `withVault()` primary API |
| [`@agent-shield/core`](https://www.npmjs.com/package/@agent-shield/core) | Pure TypeScript policy engine |
| [`@agent-shield/mcp`](https://www.npmjs.com/package/@agent-shield/mcp) | MCP server for AI tools |

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/agentshield/issues)

## License

Apache-2.0
