# @agent-shield/plugin-elizaos

AgentShield plugin for [ElizaOS](https://github.com/elizaOS/eliza) — provides shield status actions, pause/resume controls, transaction history, spending providers, and policy evaluators for AI agents with on-chain guardrails for spending, protocol allowlists, and rate limiting.

## Installation

```bash
npm install @agent-shield/plugin-elizaos @agent-shield/sdk
```

Peer dependencies: `@elizaos/core >=0.1.0`, `@agent-shield/sdk >=0.1.0`, `@solana/web3.js >=1.90.0`

## Quick Start

```typescript
import { agentShieldPlugin } from "@agent-shield/plugin-elizaos";

// Register in your ElizaOS character config
const character = {
  name: "DeFi Agent",
  plugins: [agentShieldPlugin],
  settings: {
    // ... other settings
  },
};
```

The plugin reads environment variables to create a `ShieldedWallet` automatically. Event callbacks (`onDenied`, `onApproved`, `onPause`, `onResume`, `onPolicyUpdate`) are wired to the ElizaOS runtime logger.

## Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `SOLANA_WALLET_PRIVATE_KEY` | Yes | Agent wallet private key (base58 or JSON array) | - |
| `AGENT_SHIELD_MAX_SPEND` | No | Spending limit string | `"1000 USDC/day"` + `"1000 USDT/day"` + `"10 SOL/day"` |
| `AGENT_SHIELD_BLOCK_UNKNOWN` | No | Block unknown programs | `"true"` |

**Private key formats supported:**
- Base58 string: `"4wBqp..."` (standard Solana CLI format)
- JSON array: `"[104,29,171,...]"` (Uint8Array bytes)

## Actions

The plugin provides 6 actions that agents can invoke conversationally:

### `SHIELD_STATUS`

**Triggers:** "shield status", "spending status", "budget remaining", "check spending", "how much budget"

Returns current spending summary including enforcement state, per-token usage with percentages, and rate limit status.

**Example conversation:**
```
User: "What's my shield spending status?"
Agent: "=== AgentShield Status ===
Enforcement: ACTIVE

USDC: 200000000 / 500000000 (40% used)
  Remaining: 300000000

Rate limit: 5/60 transactions (55 remaining)"
```

### `SHIELD_UPDATE_POLICY`

**Triggers:** "update policy", "change limit", "change spending cap", "set budget", "update shield"

Updates spending limits or program blocking at runtime.

**Message parameters:**
- `maxSpend` (string) — new spending limit, e.g. `"1000 USDC/day"`
- `blockUnknownPrograms` (boolean) — whether to block unknown programs

**Example conversation:**
```
User: "Update my shield limit to 1000 USDC per day"
Agent: "Shield policies updated: maxSpend: 1000 USDC/day"
```

### `SHIELD_PAUSE_RESUME`

**Triggers:** "pause shield", "resume shield", "pause enforcement", "resume enforcement", "disable shield", "enable shield"

Pauses or resumes policy enforcement. The action infers the intent (pause vs resume) from the message text. When paused, transactions pass through without policy checks or spend recording.

**Example conversations:**
```
User: "Pause the shield enforcement"
Agent: "Shield enforcement paused. Transactions will pass through without policy checks."

User: "Resume shield enforcement"
Agent: "Shield enforcement resumed. Policy checks are active."
```

### `SHIELD_TRANSACTION_HISTORY`

**Triggers:** "transaction history", "recent activity", "shield history", "spending history", "activity log"

Returns a detailed per-token usage summary with percentages, remaining budgets, rolling window information, and rate limit status.

**Example conversation:**
```
User: "Show me the transaction history"
Agent: "=== AgentShield Transaction History ===
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
  Window: 1h"
```

### `SHIELD_PROVISION`

**Triggers:** "provision vault", "create vault", "set up vault", "provision shield"

Provisions a new vault via Solana Actions Blink URL.

### `SHIELD_X402_FETCH`

**Triggers:** "fetch with payment", "x402 fetch", "paid fetch", "shielded fetch"

Fetches a URL with automatic x402 payment negotiation, policy-enforced.

## Providers

Providers inject shield context into the agent's memory before each response, giving the agent continuous awareness of its spending state:

### `shieldStatusProvider`

**Name:** `AGENT_SHIELD_STATUS`

Injects into every conversation turn:
- Wallet address
- Enforcement state (ACTIVE or PAUSED)
- Per-token spending summary with percentages
- Rate limit usage

**Returned data:**
```typescript
{
  text: "AgentShield Status: ...",  // Human-readable for agent context
  values: {
    address: "...",
    isPaused: false,
    tokens: [...],
    rateLimit: { ... },
  }
}
```

### `spendTrackingProvider`

**Name:** `AGENT_SHIELD_SPEND_TRACKING`

Injects per-token spending data with:
- Usage percentages per token
- Rolling window durations (in hours)
- Remaining budget per token
- Aggregate max usage percentage across all tokens

## Evaluators

### `policyCheckEvaluator`

**Name:** `AGENT_SHIELD_POLICY_CHECK`

Post-action evaluator that warns when any token's spending exceeds 80% of its cap. Helps the agent self-regulate and avoid hitting hard limits.

**Triggers on:** Messages containing "agentshield", "shield", or "transaction:"

**Behavior:**
- Returns `null` if enforcement is paused (no warnings when paused)
- Checks each token against the 80% threshold
- Returns warning text with token name, usage percentage, and remaining budget
- Silently fails on errors (evaluators should never block the agent)

**Example warning:**
```
"[AgentShield Warning] USDC spending at 85% of cap (150000000 remaining)"
```

## Event Callback Wiring

The plugin automatically wires shield event callbacks to the ElizaOS runtime logger:

| Event | Log Level | Message |
|-------|-----------|---------|
| `onDenied` | `warn` | `[AgentShield] Transaction denied: <reason>` |
| `onApproved` | `info` | `[AgentShield] Transaction approved` |
| `onPause` | `info` | `[AgentShield] Enforcement paused` |
| `onResume` | `info` | `[AgentShield] Enforcement resumed` |
| `onPolicyUpdate` | `info` | `[AgentShield] Policies updated` |

Falls back to `console` if `runtime.logger` is not available.

## Wallet Caching

The plugin uses a `WeakMap` to cache `ShieldedWallet` instances per ElizaOS runtime. This ensures:
- The same wallet is reused across all actions, providers, and evaluators within a runtime
- Spending state is consistent across the entire agent lifecycle
- Different runtime instances get independent wallets
- Wallets are garbage-collected when the runtime is released

## Exported API

| Export | Description |
|--------|-------------|
| `agentShieldPlugin` | Plugin object for ElizaOS registration |
| `getConfig(runtime)` | Read config from runtime settings |
| `getOrCreateShieldedWallet(runtime)` | Get/create cached ShieldedWallet |
| `statusAction` | SHIELD_STATUS action |
| `updatePolicyAction` | SHIELD_UPDATE_POLICY action |
| `pauseResumeAction` | SHIELD_PAUSE_RESUME action |
| `transactionHistoryAction` | SHIELD_TRANSACTION_HISTORY action |
| `shieldStatusProvider` | Shield status context provider |
| `spendTrackingProvider` | Spend tracking context provider |
| `policyCheckEvaluator` | Policy cap warning evaluator |
| `ENV_KEYS` | Environment variable key constants |
| `AgentShieldElizaConfig` | Config type interface |

The plugin is also available as a default export for ElizaOS plugin loader compatibility.

## How It Works

```
ElizaOS Runtime
    │
    ├── Providers (inject context before each response)
    │   ├── shieldStatusProvider → "Budget: 60% used"
    │   └── spendTrackingProvider → "USDC: 300M/500M remaining"
    │
    ├── Actions (agent invokes conversationally)
    │   ├── SHIELD_STATUS → detailed spending report
    │   ├── SHIELD_UPDATE_POLICY → change limits at runtime
    │   ├── SHIELD_PAUSE_RESUME → toggle enforcement
    │   └── SHIELD_TRANSACTION_HISTORY → per-token usage details
    │
    ├── Evaluators (run after actions)
    │   └── policyCheckEvaluator → "Warning: USDC at 85%"
    │
    └── ShieldedWallet (wraps signTransaction)
        └── Policy engine → spending caps, rate limits, allowlists
```

The `ShieldedWallet` wraps the agent's private key wallet and intercepts all `signTransaction` calls. Any DeFi action the agent takes — swaps, transfers, position opens — passes through the policy engine before the transaction is signed. If a policy is violated, the transaction is rejected with a descriptive error.

Providers give the agent continuous budget awareness. The evaluator proactively warns when spending approaches limits. No on-chain vault setup is needed.

## Testing

```bash
npm test
# Runs 35 tests covering all actions, providers, evaluator, config, caching, and event wiring
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@agent-shield/sdk`](https://www.npmjs.com/package/@agent-shield/sdk) | On-chain guardrails — `withVault()` primary API |
| [`@agent-shield/core`](https://www.npmjs.com/package/@agent-shield/core) | Pure TypeScript policy engine |
| [`@agent-shield/plugin-solana-agent-kit`](https://www.npmjs.com/package/@agent-shield/plugin-solana-agent-kit) | Solana Agent Kit integration |

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/agentshield/issues)

## License

Apache-2.0
