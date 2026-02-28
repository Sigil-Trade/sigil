# @agent-shield/plugin-solana-agent-kit

AgentShield plugin for [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) — adds shield monitoring, management, and transaction history tools to any SAK agent. The shield wraps wallet signing transparently, so SAK's built-in swap/position tools are automatically policy-guarded without any code changes.

## Installation

```bash
npm install @agent-shield/plugin-solana-agent-kit @agent-shield/sdk
```

Peer dependencies: `solana-agent-kit >=2.0.0`, `@agent-shield/sdk >=0.1.0`, `@solana/web3.js >=1.90.0`

## Quick Start

### Option A: Pre-created ShieldedWallet

```typescript
import { shieldWallet } from "@agent-shield/sdk";
import { createAgentShieldPlugin } from "@agent-shield/plugin-solana-agent-kit";
import { SolanaAgentKit } from "solana-agent-kit";

// 1. Wrap your wallet with spending controls
const protectedWallet = shieldWallet(wallet, { maxSpend: "500 USDC/day" });

// 2. Create the plugin (provides monitoring tools)
const plugin = createAgentShieldPlugin({ wallet: protectedWallet });

// 3. Create the agent — all actions are now policy-guarded
const agent = new SolanaAgentKit(protectedWallet, rpcUrl, {
  plugins: [plugin],
});
```

### Option B: Factory (auto-creates ShieldedWallet)

```typescript
import { createAgentShieldPlugin } from "@agent-shield/plugin-solana-agent-kit";

// Pass a raw wallet + policies — the plugin creates the ShieldedWallet for you
const plugin = createAgentShieldPlugin({
  rawWallet: keypairWallet,
  policies: { maxSpend: "500 USDC/day" },
  logger: console,
});

// Event callbacks (onDenied, onApproved, onPause, onResume, onPolicyUpdate)
// are automatically wired to the logger
```

### Standalone Factory

```typescript
import { createShieldedWallet } from "@agent-shield/plugin-solana-agent-kit";

const protectedWallet = createShieldedWallet({
  wallet: keypairWallet,
  policies: { maxSpend: "500 USDC/day" },
  logger: console,
  options: {
    onDenied: (err) => alertService.notify(err.message),
  },
});
```

## Tools

The plugin registers 6 monitoring/management tools on the agent:

| Tool | Description | Parameters |
|------|-------------|------------|
| `shield_status` | Check current spending vs limits, rate limit usage, and enforcement state | *(none)* |
| `shield_update_policy` | Update spending limits or program blocking at runtime | `maxSpend?`, `blockUnknownPrograms?` |
| `shield_pause_resume` | Pause or resume policy enforcement | `action: "pause" \| "resume"` |
| `shield_transaction_history` | View per-token usage percentages and rate limit summary | *(none)* |
| `shield_provision` | Provision a vault via Solana Actions | `vaultAddress` |
| `shield_x402_fetch` | Fetch a URL with automatic x402 payment negotiation | `url`, `method?`, `body?` |

### Tool Details

#### `shield_status`

Returns a formatted status report including:
- Whether enforcement is paused or active
- Per-token spending vs limits (with percentage used and window duration)
- Remaining budget per token
- Rate limit usage (transaction count vs limit, remaining, window)

**Example output:**
```
=== AgentShield Status ===
Paused: false

--- Spending Limits ---
  USDC: 200000000 / 500000000 (40% used, 24h window)
    Remaining: 300000000
  SOL: 1000000000 / 10000000000 (10% used, 24h window)
    Remaining: 9000000000

--- Rate Limit ---
  Transactions: 5 / 60 (55 remaining)
  Window: 1h
```

#### `shield_update_policy`

Updates shield policies at runtime. Both parameters are optional — only provided fields are changed.

**Schema:**
```typescript
{
  maxSpend?: string;              // e.g. "1000 USDC/day"
  blockUnknownPrograms?: boolean; // true or false
}
```

#### `shield_pause_resume`

Toggles enforcement on or off. When paused, transactions pass through without policy checks or spend recording.

**Schema:**
```typescript
{
  action: "pause" | "resume";
}
```

#### `shield_transaction_history`

Returns a detailed per-token usage summary with percentages and rolling window information, plus rate limit status.

**Example output:**
```
=== AgentShield Transaction History ===
Enforcement: ACTIVE

--- Per-Token Usage ---
  USDC:
    Spent: 200000000 / 500000000
    Usage: 40%
    Remaining: 300000000
    Window: 24h rolling

--- Rate Limit ---
  Transactions: 5 / 60
  Remaining: 55
  Window: 1h
```

## Configuration

```typescript
interface AgentShieldPluginConfig {
  // Option A: Pre-created ShieldedWallet
  wallet?: ShieldedWallet;

  // Option B: Auto-create from raw wallet
  rawWallet?: WalletLike;
  policies?: ShieldPolicies;
  logger?: { info?: Function; warn?: Function };
  options?: ShieldOptions;
}
```

You must provide either `wallet` or `rawWallet`. If both are provided, `wallet` takes precedence.

When using `rawWallet`, the factory automatically wires event callbacks to the logger:
- `onDenied` logs warnings with the denial reason
- `onApproved`, `onPause`, `onResume`, `onPolicyUpdate` log info messages
- Any callbacks in `options` are chained after logger callbacks

## Exported Functions

| Export | Description |
|--------|-------------|
| `createAgentShieldPlugin(config)` | Create the SAK plugin with 6 tools |
| `createShieldedWallet(config)` | Standalone factory for ShieldedWallet creation |
| `resolveWallet(config)` | Resolve config to a `{ wallet: ShieldedWallet }` |
| `status(agent, config, input)` | Status tool handler (for custom use) |
| `updatePolicy(agent, config, input)` | Update policy tool handler |
| `pauseResume(agent, config, input)` | Pause/resume tool handler |
| `transactionHistory(agent, config, input)` | Transaction history tool handler |

All Zod schemas are also exported: `statusSchema`, `updatePolicySchema`, `pauseResumeSchema`, `transactionHistorySchema`.

## How It Works

The `shieldWallet()` wrapper intercepts `signTransaction` and `signAllTransactions` on the wallet. When the agent calls any SAK tool (swap, transfer, open position, etc.), the transaction passes through the shield's policy engine before signing. If a policy is violated (spending cap, rate limit, unknown program, etc.), the transaction is rejected with a descriptive `ShieldDeniedError`.

The plugin's tools give the agent visibility into spending state and the ability to manage enforcement — no DeFi execution tools are needed since the shield guards signing transparently.

```
Agent calls swap() → SAK builds transaction → shieldWallet() intercepts signTransaction
                                                  ↓
                                        Policy engine evaluates:
                                        • Spending cap check
                                        • Rate limit check
                                        • Protocol allowlist
                                        • Token allowlist
                                                  ↓
                                        Pass → sign with inner wallet
                                        Fail → throw ShieldDeniedError
```

## Testing

```bash
npm test
# Runs 29 tests covering all tools, factory, config resolution, and event wiring
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@agent-shield/sdk`](https://www.npmjs.com/package/@agent-shield/sdk) | On-chain guardrails — `withVault()` primary API |
| [`@agent-shield/core`](https://www.npmjs.com/package/@agent-shield/core) | Pure TypeScript policy engine |
| [`@agent-shield/plugin-elizaos`](https://www.npmjs.com/package/@agent-shield/plugin-elizaos) | ElizaOS integration |

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/agentshield/issues)

## License

Apache-2.0
