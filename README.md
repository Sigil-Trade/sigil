# AgentShield

[![CI](https://github.com/Kaleb-Rupe/agentshield/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Kaleb-Rupe/agentshield/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-591-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

Financial guardrails for AI agents on Solana — spending caps, protocol whitelists, oracle-priced limits, timelocked policy changes, and kill switches.

## The Problem

Every AI agent on Solana today operates with unrestricted wallet access. Frameworks like Solana Agent Kit give agents raw keypair signing authority with zero spending limits, asset restrictions, or kill switches. There is no way for an agent owner to say "this agent can spend up to 500 USDC/day on Jupiter swaps, nothing else."

## The Solution

AgentShield is a Solana program that holds agent funds in PDA vaults and validates every transaction against configurable policies before it reaches DeFi protocols. Owners set the rules, agents operate within them, and a complete audit trail is maintained on-chain.

### Key Features

- **Dual-oracle pricing** — Pyth-first with Switchboard fallback, auto-detected at runtime
- **USD-denominated spending caps** — $500/day across all tokens, converted via oracle prices
- **Per-token controls** — individual daily caps and max transaction sizes in base units
- **Token delegation** — SPL `approve`/`revoke` CPI instead of escrow transfers
- **Timelocked policy changes** — queue updates with configurable delay to prevent rug-pulls
- **Agent transfers** — destination-allowlisted token transfers initiated by agents
- **Kill switch** — owner can freeze any vault instantly, revoking all agent permissions
- **On-chain audit trail** — every action emits Anchor events; last 50 txs stored on-chain
- **MCP server** — 23 tools + 3 resources for Claude Desktop, Cursor, and any MCP client
- **OpenClaw skill** — AI agent skill for autonomous vault management
- **Solana Actions/Blinks** — provision vaults via shareable action URLs

### How It Works

AgentShield uses **instruction composition** to avoid Solana's 4-level CPI depth limit. Instead of wrapping DeFi calls inside the program, it sandwiches them in an atomic transaction:

```
Transaction = [
  ValidateAndAuthorize,   // AgentShield checks policy, creates session, delegates tokens
  DeFi instruction(s),    // Jupiter swap, Flash Trade open, etc.
  FinalizeSession         // AgentShield records audit, collects fees, revokes delegation
]
```

All instructions succeed or all revert atomically. The agent's signing key is validated, spending limits are checked, and the action is recorded — without adding CPI depth to the DeFi call.

### Account Model

| Account                 | Seeds                                    | Purpose                                                                                            |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **AgentVault**          | `[b"vault", owner, vault_id]`            | Holds owner/agent pubkeys, status, fee destination                                                 |
| **PolicyConfig**        | `[b"policy", vault]`                     | Spending caps, token/protocol whitelists, leverage limits, timelock duration, allowed destinations |
| **SpendTracker**        | `[b"tracker", vault]`                    | Tiered rolling 24h spend entries (Standard/Pro/Max: 200/500/1000), bounded audit log (max 50 txs)  |
| **SessionAuthority**    | `[b"session", vault, agent, token_mint]` | Ephemeral PDA created per action, expires after 20 slots                                           |
| **PendingPolicyUpdate** | `[b"pending_policy", vault]`             | Queued policy change with timelock, applied after delay                                            |

### On-Chain Instructions (14)

| Instruction              | Signer | Description                                   |
| ------------------------ | ------ | --------------------------------------------- |
| `initialize_vault`       | Owner  | Create vault, policy, and tracker PDAs        |
| `deposit_funds`          | Owner  | Transfer SPL tokens into vault                |
| `register_agent`         | Owner  | Register agent signing key                    |
| `update_policy`          | Owner  | Modify policy (direct if no timelock)         |
| `validate_and_authorize` | Agent  | Check policy, create session, delegate tokens |
| `finalize_session`       | Agent  | Record audit, collect fees, revoke delegation |
| `revoke_agent`           | Owner  | Kill switch — freeze vault                    |
| `reactivate_vault`       | Owner  | Unfreeze vault, optionally rotate agent key   |
| `withdraw_funds`         | Owner  | Withdraw tokens to owner                      |
| `close_vault`            | Owner  | Close all PDAs, reclaim rent                  |
| `queue_policy_update`    | Owner  | Queue timelocked policy change                |
| `apply_pending_policy`   | Owner  | Apply queued change after timelock expires    |
| `cancel_pending_policy`  | Owner  | Cancel queued policy change                   |
| `agent_transfer`         | Agent  | Transfer tokens to allowlisted destination    |

## Packages

| Package                                                               | Description                                                          | npm                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@agent-shield/core`](./sdk/core)                                    | Pure TypeScript policy engine — zero blockchain dependencies         | [![npm](https://img.shields.io/npm/v/@agent-shield/core)](https://www.npmjs.com/package/@agent-shield/core)                                       |
| [`@agent-shield/solana`](./sdk/wrapper)                               | Client-side wallet wrapper — 3 lines to protect any Solana agent     | [![npm](https://img.shields.io/npm/v/@agent-shield/solana)](https://www.npmjs.com/package/@agent-shield/solana)                                   |
| [`@agent-shield/sdk`](./sdk/typescript)                               | On-chain vault SDK — Anchor-based, Jupiter & Flash Trade composition | [![npm](https://img.shields.io/npm/v/@agent-shield/sdk)](https://www.npmjs.com/package/@agent-shield/sdk)                                         |
| [`@agent-shield/platform`](./sdk/platform)                            | Platform client — request TEE wallet provisioning via Solana Actions | [![npm](https://img.shields.io/npm/v/@agent-shield/platform)](https://www.npmjs.com/package/@agent-shield/platform)                               |
| [`@agent-shield/custody-crossmint`](./sdk/custody/crossmint)          | Crossmint TEE custody adapter — hardware-enclave signing             | [![npm](https://img.shields.io/npm/v/@agent-shield/custody-crossmint)](https://www.npmjs.com/package/@agent-shield/custody-crossmint)             |
| [`@agent-shield/mcp`](./packages/mcp)                                 | MCP server — 23 tools, 3 resources for AI tool management            | [![npm](https://img.shields.io/npm/v/@agent-shield/mcp)](https://www.npmjs.com/package/@agent-shield/mcp)                                         |
| [`@agent-shield/plugin-solana-agent-kit`](./plugins/solana-agent-kit) | Solana Agent Kit plugin — 5 monitoring/management tools              | [![npm](https://img.shields.io/npm/v/@agent-shield/plugin-solana-agent-kit)](https://www.npmjs.com/package/@agent-shield/plugin-solana-agent-kit) |
| [`@agent-shield/plugin-elizaos`](./plugins/elizaos)                   | ElizaOS plugin — 5 actions, 2 providers, 1 evaluator                 | [![npm](https://img.shields.io/npm/v/@agent-shield/plugin-elizaos)](https://www.npmjs.com/package/@agent-shield/plugin-elizaos)                   |

## Quick Start

### Level 1: Client-Side Wrapper (Zero Friction)

```bash
npm install @agent-shield/solana
```

```typescript
import { shield } from "@agent-shield/solana";

// Wrap any wallet in 1 line — secure defaults applied automatically
const protectedWallet = shield(wallet, { maxSpend: "500 USDC/day" });

// Use it like a normal wallet — shield enforces policies transparently
const agent = new SolanaAgentKit(protectedWallet, RPC_URL, config);
```

### Level 2: On-Chain Vault (Cryptographic Guarantees)

```bash
npm install @agent-shield/sdk @coral-xyz/anchor @solana/web3.js
```

```typescript
import { AgentShieldClient } from "@agent-shield/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet, BN } from "@coral-xyz/anchor";

const connection = new Connection("https://api.devnet.solana.com");
const wallet = new Wallet(ownerKeypair);
const client = new AgentShieldClient(connection, wallet);

// Create a vault with oracle-priced token limits
const sig = await client.createVault({
  vaultId: new BN(1),
  dailySpendingCapUsd: new BN(500_000_000), // $500 (6 decimals)
  maxTransactionSizeUsd: new BN(100_000_000), // $100 per tx
  allowedTokens: [
    {
      mint: USDC_MINT,
      oracleFeed: PublicKey.default, // stablecoin — 1:1 USD
      decimals: 6,
      dailyCapBase: new BN(0),
      maxTxBase: new BN(0),
    },
    {
      mint: SOL_MINT,
      oracleFeed: PYTH_SOL_USD_FEED, // oracle-priced via Pyth
      decimals: 9,
      dailyCapBase: new BN(0),
      maxTxBase: new BN(0),
    },
  ],
  allowedProtocols: [JUPITER_PROGRAM_ID],
  maxLeverageBps: 0,
  maxConcurrentPositions: 0,
  feeDestination: feeWallet.publicKey,
  trackerTier: 0, // 0=Standard (200 entries), 1=Pro (500), 2=Max (1000)
});
```

### Level 3: MCP Server (Claude Desktop / Cursor)

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-shield": {
      "command": "npx",
      "args": ["@agent-shield/mcp"],
      "env": {
        "SOLANA_RPC_URL": "https://api.devnet.solana.com",
        "SOLANA_PRIVATE_KEY": "your-base58-private-key"
      }
    }
  }
}
```

Then ask Claude: _"Create an AgentShield vault with a $500/day USDC spending cap"_

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
RUSTUP_TOOLCHAIN=nightly anchor idl build -o target/idl/agent_shield.json

# Run on-chain tests (93 tests, LiteSVM — no validator needed)
npx ts-mocha -p ./tsconfig.json -t 300000 \
  tests/agent-shield.ts tests/jupiter-integration.ts tests/flash-trade-integration.ts

# Run all TypeScript tests (470 tests across 9 suites)
pnpm -r run test

# Lint
npm run lint
cargo fmt --check --manifest-path programs/agent-shield/Cargo.toml
```

### Test Suites

| Suite                                                | Tests   |
| ---------------------------------------------------- | ------- |
| Core vault management & permission engine            |      51 |
| Jupiter integration (composed swaps)                 |       9 |
| Flash Trade integration (leveraged perps)            |       8 |
| Oracle + delegation + timelock + transfers           |      25 |
| Security exploit scenarios                           |      28 |
| Core policy engine (`@agent-shield/core`)            |      66 |
| SDK type & account tests (`@agent-shield/sdk`)       |      31 |
| Platform client tests (`@agent-shield/platform`)     |      17 |
| Crossmint custody adapter                            |      29 |
| Wrapper SDK (`@agent-shield/solana`)                 |      96 |
| SAK plugin (`@agent-shield/plugin-solana-agent-kit`) |      25 |
| ElizaOS plugin (`@agent-shield/plugin-elizaos`)      |      32 |
| MCP server (`@agent-shield/mcp`)                     |     124 |
| Actions server (`@agent-shield/actions-server`)      |      50 |
| **Total**                                            | **591** |

## Security

- [Vulnerability Disclosure Policy](./SECURITY.md)
- [Security Tools & Scanning](./docs/SECURITY-TOOLS.md)
- [Published Audit Reports](./docs/audits/)

Raw scan output is stored as private CI artifacts (accessible to repo collaborators only). Published audit reports are added to `docs/audits/` after auditor release.

## License

MIT
