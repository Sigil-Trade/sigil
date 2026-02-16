# AgentShield

Solana middleware that gives AI agents permission-guarded DeFi access through PDA vaults with configurable spending limits, token whitelists, and kill switches.

## The Problem

Every AI agent on Solana today operates with unrestricted wallet access. Frameworks like Solana Agent Kit give agents raw keypair signing authority with zero spending limits, asset restrictions, or kill switches. There is no way for an agent owner to say "this agent can spend up to 500 USDC/day on Jupiter swaps, nothing else."

## The Solution

AgentShield is a Solana program that holds agent funds in PDA vaults and validates every transaction against configurable policies before it reaches DeFi protocols. Owners set the rules, agents operate within them, and a complete audit trail is maintained on-chain.

### How It Works

AgentShield uses **instruction composition** to avoid Solana's 4-level CPI depth limit. Instead of wrapping DeFi calls inside the program, it sandwiches them in an atomic transaction:

```
Transaction = [
  ValidateAndAuthorize,   // AgentShield checks policy, creates session
  DeFi instruction(s),    // Jupiter swap, Flash Trade open, etc.
  FinalizeSession         // AgentShield records audit, collects fees, closes session
]
```

All instructions succeed or all revert atomically. The agent's signing key is validated, spending limits are checked, and the action is recorded — without adding CPI depth to the DeFi call.

### Account Model

| Account | Seeds | Purpose |
|---------|-------|---------|
| **AgentVault** | `[b"vault", owner, vault_id]` | Holds owner/agent pubkeys, status, fee destination |
| **PolicyConfig** | `[b"policy", vault]` | Spending caps, token/protocol whitelists, leverage limits |
| **SpendTracker** | `[b"tracker", vault]` | Rolling 24h spend entries, bounded audit log (max 50 txs) |
| **SessionAuthority** | `[b"session", vault, agent]` | Ephemeral PDA created per action, expires after 20 slots |

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@agent-shield/core`](./sdk/core) | Pure TypeScript policy engine — zero blockchain dependencies | [![npm](https://img.shields.io/npm/v/@agent-shield/core)](https://www.npmjs.com/package/@agent-shield/core) |
| [`@agent-shield/solana`](./sdk/wrapper) | Client-side wallet wrapper — 3 lines to protect any Solana agent | [![npm](https://img.shields.io/npm/v/@agent-shield/solana)](https://www.npmjs.com/package/@agent-shield/solana) |
| [`@agent-shield/sdk`](./sdk/typescript) | On-chain vault SDK — Jupiter & Flash Trade composition | [![npm](https://img.shields.io/npm/v/@agent-shield/sdk)](https://www.npmjs.com/package/@agent-shield/sdk) |
| [`@agent-shield/plugin-solana-agent-kit`](./plugins/solana-agent-kit) | Solana Agent Kit plugin — 4 monitoring/management tools | [![npm](https://img.shields.io/npm/v/@agent-shield/plugin-solana-agent-kit)](https://www.npmjs.com/package/@agent-shield/plugin-solana-agent-kit) |
| [`@agent-shield/plugin-elizaos`](./plugins/elizaos) | ElizaOS plugin — 4 actions, 2 providers, 1 evaluator | [![npm](https://img.shields.io/npm/v/@agent-shield/plugin-elizaos)](https://www.npmjs.com/package/@agent-shield/plugin-elizaos) |

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

### Level 3: On-Chain Vault (Cryptographic Guarantees)

```bash
npm install @agent-shield/sdk @coral-xyz/anchor @solana/web3.js
```

```typescript
import { AgentShieldClient } from "@agent-shield/sdk";
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet, BN } from "@coral-xyz/anchor";

const connection = new Connection("https://api.devnet.solana.com");
const wallet = new Wallet(ownerKeypair);
const client = new AgentShieldClient(connection, wallet);

// Create a vault with policy
const sig = await client.createVault({
  vaultId: new BN(1),
  dailySpendingCap: new BN(500_000_000), // 500 USDC
  maxTransactionSize: new BN(100_000_000), // 100 USDC per tx
  allowedTokens: [USDC_MINT, SOL_MINT],
  allowedProtocols: [JUPITER_PROGRAM_ID],
  maxLeverageBps: 0,
  maxConcurrentPositions: 0,
  feeDestination: feeWallet.publicKey,
});

// Register an agent
const [vaultPDA] = client.getVaultPDA(wallet.publicKey, new BN(1));
await client.registerAgent(vaultPDA, agentKeypair.publicKey);

// Agent executes a Jupiter swap through the vault
const tx = await client.executeJupiterSwap({
  vault: vaultPDA,
  owner: wallet.publicKey,
  vaultId: new BN(1),
  agent: agentKeypair.publicKey,
  inputMint: USDC_MINT,
  outputMint: SOL_MINT,
  amount: new BN(10_000_000), // 10 USDC
  slippageBps: 50,
});
```

## Program

| Network | Program ID |
|---------|------------|
| Devnet | [`4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`](https://explorer.solana.com/address/4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL?cluster=devnet) |

## Development

```bash
# Build the Anchor program
anchor build --no-idl

# Generate IDL (requires nightly Rust)
RUSTUP_TOOLCHAIN=nightly anchor idl build -o target/idl/agent_shield.json

# Run on-chain tests (57 tests across 3 suites)
anchor test

# Run wrapper tests (49 tests)
cd sdk/wrapper && pnpm test

# Run plugin tests (53 tests)
cd plugins/solana-agent-kit && pnpm test
cd plugins/elizaos && pnpm test

# Lint
npm run lint
cargo fmt --check --manifest-path programs/agent-shield/Cargo.toml
```

### Test Suites

| Suite | Tests |
|-------|-------|
| Core vault management & permission engine | 39 |
| Jupiter integration (composed swaps) | 9 |
| Flash Trade integration (leveraged perps) | 9 |
| Wrapper SDK (`@agent-shield/solana`) | 49 |
| SAK plugin (`@agent-shield/plugin-solana-agent-kit`) | 23 |
| ElizaOS plugin (`@agent-shield/plugin-elizaos`) | 30 |
| **Total** | **159** |

## License

MIT
