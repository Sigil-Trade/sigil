# Phalnx

[![CI](https://github.com/Kaleb-Rupe/phalnx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Kaleb-Rupe/phalnx/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-1032-brightgreen)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

On-chain guardrails for AI agents on Solana. Your policies are enforced by Solana validators, not software promises.

## The Problem

Every AI agent on Solana today operates with unrestricted wallet access. Frameworks like Solana Agent Kit give agents raw keypair signing authority with zero spending limits, asset restrictions, or kill switches. There is no way for an agent owner to say "this agent can spend up to 500 USDC/day on Jupiter swaps, nothing else."

## The Solution

Phalnx wraps your agent's wallet with on-chain policy enforcement. One call gives you client-side fast deny, TEE key custody, and on-chain vault enforcement — bundled as one product.

```typescript
import { withVault } from "@phalnx/sdk";

const result = await withVault(teeWallet, { maxSpend: "500 USDC/day" }, {
  connection,
});
// result.wallet is ready — policies enforced by Solana validators
```

### Security Model

Phalnx provides three layers of protection in a single integration:

1. **Client-side policy checks** — fast deny before transactions hit the network
2. **TEE key custody** — agent private keys stored in hardware enclaves (Crossmint, Turnkey, Privy)
3. **On-chain vault enforcement** — PDA vaults with cryptographic policy guarantees enforced by Solana validators

### Key Features

- **Stablecoin-only USD tracking** — no oracle dependency, no feed staleness, no price manipulation risk. USDC/USDT amount = USD value
- **Rolling 24h spending caps** — 144-epoch circular buffer tracks stablecoin outflows. No exploitable midnight reset
- **Risk-reducing actions exempt** — closing positions, decreasing exposure, and removing collateral never count as spending
- **On-chain slippage verification** — Jupiter and Flash Trade slippage enforced by Solana validators via `max_slippage_bps` policy
- **Token delegation** — SPL `approve`/`revoke` CPI instead of escrow transfers
- **Timelocked policy changes** — queue updates with configurable delay to prevent rug-pulls
- **Agent transfers** — destination-allowlisted stablecoin transfers initiated by agents
- **Kill switch** — owner can freeze any vault instantly, revoking all agent permissions
- **On-chain audit trail** — every action emits Anchor events for full transaction history
- **x402 payments** — `shieldedFetch()` for automatic HTTP 402 payment negotiation, policy-enforced
- **MCP server** — 49 tools + 3 resources for Claude Desktop, Cursor, and any MCP client
- **OpenClaw skill** — AI agent skill for autonomous vault management
- **Solana Actions/Blinks** — provision vaults via shareable action URLs

### How It Works

Phalnx uses **instruction composition** to avoid Solana's 4-level CPI depth limit. Instead of wrapping DeFi calls inside the program, it sandwiches them in an atomic transaction:

```
Transaction = [
  ValidateAndAuthorize,   // Phalnx checks policy, creates session, delegates tokens
  DeFi instruction(s),    // Jupiter swap, Flash Trade open, etc.
  FinalizeSession         // Phalnx records audit, revokes delegation
]
```

All instructions succeed or all revert atomically. The agent's signing key is validated, spending limits are checked, and the action is recorded — without adding CPI depth to the DeFi call.

### Account Model

| Account                 | Seeds                                    | Purpose                                                                                            |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **AgentVault**          | `[b"vault", owner, vault_id]`            | Holds owner/agent pubkeys, status, fee destination                                                 |
| **PolicyConfig**        | `[b"policy", vault]`                     | Spending caps, protocol allowlist/denylist, leverage limits, slippage limits, timelock duration, allowed destinations |
| **SpendTracker**        | `[b"tracker", vault]`                    | Zero-copy 144-epoch circular buffer for rolling 24h USD spend tracking (2,352 bytes)               |
| **SessionAuthority**    | `[b"session", vault, agent, token_mint]` | Ephemeral PDA created per action, expires after 20 slots                                           |
| **PendingPolicyUpdate** | `[b"pending_policy", vault]`             | Queued policy change with timelock, applied after delay                                            |

### On-Chain Instructions (15)

| Instruction              | Signer | Description                                                    |
| ------------------------ | ------ | -------------------------------------------------------------- |
| `initialize_vault`       | Owner  | Create vault, policy, and tracker PDAs                         |
| `deposit_funds`          | Owner  | Transfer SPL tokens into vault                                 |
| `register_agent`         | Owner  | Register agent signing key                                     |
| `update_policy`          | Owner  | Modify policy (direct if no timelock)                          |
| `validate_and_authorize` | Agent  | Check policy, collect fees, create session, delegate tokens    |
| `finalize_session`       | Agent  | Revoke delegation, close session PDA                           |
| `revoke_agent`           | Owner  | Kill switch — freeze vault                                     |
| `reactivate_vault`       | Owner  | Unfreeze vault, optionally rotate agent key                    |
| `withdraw_funds`         | Owner  | Withdraw tokens to owner                                       |
| `close_vault`            | Owner  | Close all PDAs, reclaim rent                                   |
| `queue_policy_update`    | Owner  | Queue timelocked policy change                                 |
| `apply_pending_policy`   | Owner  | Apply queued change after timelock expires                     |
| `cancel_pending_policy`  | Owner  | Cancel queued policy change                                    |
| `agent_transfer`         | Agent  | Transfer stablecoins to allowlisted destination                |
| `sync_positions`         | Owner  | Correct open position counter if out of sync                   |

## Packages

| Package                                                               | Description                                                          | npm                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@phalnx/core`](./sdk/core)                                    | Pure TypeScript policy engine — zero blockchain dependencies         | [![npm](https://img.shields.io/npm/v/@phalnx/core)](https://www.npmjs.com/package/@phalnx/core)                                       |
| [`@phalnx/sdk`](./sdk/typescript)                               | On-chain guardrails — `withVault()` primary API                      | [![npm](https://img.shields.io/npm/v/@phalnx/sdk)](https://www.npmjs.com/package/@phalnx/sdk)                                         |
| [`@phalnx/platform`](./sdk/platform)                            | Platform client — request TEE wallet provisioning via Solana Actions | [![npm](https://img.shields.io/npm/v/@phalnx/platform)](https://www.npmjs.com/package/@phalnx/platform)                               |
| [`@phalnx/custody-crossmint`](./sdk/custody/crossmint)          | Crossmint TEE custody adapter — hardware-enclave signing             | [![npm](https://img.shields.io/npm/v/@phalnx/custody-crossmint)](https://www.npmjs.com/package/@phalnx/custody-crossmint)             |
| [`@phalnx/mcp`](./packages/mcp)                                 | MCP server — 49 tools, 3 resources for AI tool management            | [![npm](https://img.shields.io/npm/v/@phalnx/mcp)](https://www.npmjs.com/package/@phalnx/mcp)                                         |
| [`@phalnx/plugin-solana-agent-kit`](./plugins/solana-agent-kit) | Solana Agent Kit plugin — 6 tools with factory                       | [![npm](https://img.shields.io/npm/v/@phalnx/plugin-solana-agent-kit)](https://www.npmjs.com/package/@phalnx/plugin-solana-agent-kit) |
| [`@phalnx/plugin-elizaos`](./plugins/elizaos)                   | ElizaOS plugin — 6 actions, 2 providers, 1 evaluator                 | [![npm](https://img.shields.io/npm/v/@phalnx/plugin-elizaos)](https://www.npmjs.com/package/@phalnx/plugin-elizaos)                   |

## Quick Start

### SDK Integration

```bash
npm install @phalnx/sdk
```

```typescript
import { withVault } from "@phalnx/sdk";

// One call = full protection (client-side + TEE + on-chain vault)
const result = await withVault(teeWallet, { maxSpend: "500 USDC/day" }, {
  connection,
});

// Use it like a normal wallet — policies enforced transparently
const agent = new SolanaAgentKit(result.wallet, RPC_URL, config);
```

For devnet testing without TEE:
```typescript
const result = await withVault(wallet, { maxSpend: "500 USDC/day" }, {
  connection,
  unsafeSkipTeeCheck: true,
});
```

### MCP Server (Claude Desktop / Cursor)

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "phalnx": {
      "command": "npx",
      "args": ["@phalnx/mcp"]
    }
  }
}
```

Then ask Claude: _"Set up Phalnx"_

The `shield_configure` tool handles everything automatically — generates a keypair, provisions a TEE wallet, and creates your on-chain vault. No env vars or private keys needed.

## Program

| Network | Program ID                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Devnet  | [`4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`](https://explorer.solana.com/address/4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL?cluster=devnet) |

## Deployment

| Service        | URL                                                                |
| -------------- | ------------------------------------------------------------------ |
| Actions Server | [agent-middleware.vercel.app](https://agent-middleware.vercel.app) |

## Development

```bash
# Build the Anchor program (--no-idl required on stable Rust with Anchor 0.32.1)
anchor build --no-idl

# Generate IDL separately (requires nightly Rust — anchor-syn 0.32.1 bug)
RUSTUP_TOOLCHAIN=nightly anchor idl build -o target/idl/phalnx.json

# Run on-chain tests (222 LiteSVM tests — no validator needed)
npx ts-mocha -p ./tsconfig.json -t 300000 \
  tests/phalnx.ts tests/jupiter-integration.ts \
  tests/flash-trade-integration.ts tests/security-exploits.ts

# Run all TypeScript tests (734 tests across 8 suites)
pnpm -r run test

# Lint
npm run lint
cargo fmt --check --manifest-path programs/phalnx/Cargo.toml
```

### Test Suites

| Suite                                                | Tests   |
| ---------------------------------------------------- | ------- |
| Core vault management & permission engine            |      67 |
| Jupiter integration (composed swaps)                 |       9 |
| Jupiter Lend integration (deposit/withdraw)          |       7 |
| Flash Trade integration (leveraged perps)            |      30 |
| Security exploit scenarios                           |     109 |
| Devnet integration tests (real network)              |      56 |
| Surfpool integration tests (local Surfnet)           |      20 |
| Core policy engine (`@phalnx/core`)                  |      73 |
| SDK tests (`@phalnx/sdk`)                            |     199 |
| Platform client tests (`@phalnx/platform`)           |      17 |
| Crossmint custody adapter                            |      29 |
| SAK plugin (`@phalnx/plugin-solana-agent-kit`)       |      29 |
| ElizaOS plugin (`@phalnx/plugin-elizaos`)            |      35 |
| MCP server (`@phalnx/mcp`)                           |     291 |
| Actions server (`@phalnx/actions-server`)            |      61 |
| **Total**                                            | **1032** |

## Security

- [Vulnerability Disclosure Policy](./SECURITY.md)
- [Security Tools & Scanning](./docs/SECURITY-TOOLS.md)
- [Published Audit Reports](./docs/audits/)

Raw scan output is stored as private CI artifacts (accessible to repo collaborators only). Published audit reports are added to `docs/audits/` after auditor release.

## License

This project is licensed under the [Apache License 2.0](./LICENSE).
