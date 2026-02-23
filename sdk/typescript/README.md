# @agent-shield/sdk

TypeScript SDK for AgentShield — permission-guarded DeFi access for AI agents on Solana. Provides cryptographic guarantees via PDA vaults, on-chain policy enforcement, and atomic transaction composition.

This is the primary package for AgentShield. Use `withVault()` for full protection (client-side + TEE + on-chain vault) or `AgentShieldClient` for direct vault management.

## Installation

```bash
npm install @agent-shield/sdk @coral-xyz/anchor @solana/web3.js
```

Peer dependencies: `@coral-xyz/anchor ^0.32.1`, `@solana/web3.js ^1.95.0`

Optional: `flash-sdk ^12.0.3` (only needed for Flash Trade perpetuals)

## Quick Start

```typescript
import { AgentShieldClient } from "@agent-shield/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet, BN } from "@coral-xyz/anchor";

const connection = new Connection("https://api.devnet.solana.com");
const wallet = new Wallet(ownerKeypair);
const client = new AgentShieldClient(connection, wallet);

// 1. Create a vault with policy
await client.createVault({
  vaultId: new BN(1),
  dailySpendingCapUsd: new BN(500_000_000),   // $500 USD (6 decimals)
  maxTransactionSizeUsd: new BN(100_000_000),  // $100 per tx
  protocolMode: 1,                             // 1 = allowlist
  protocols: [JUPITER_PROGRAM_ID],
  maxLeverageBps: 0,
  maxConcurrentPositions: 0,
  feeDestination: feeWallet.publicKey,
});

// 2. Deposit funds
const [vaultPDA] = client.getVaultPDA(wallet.publicKey, new BN(1));
await client.deposit(vaultPDA, USDC_MINT, new BN(1_000_000_000));

// 3. Register an agent
await client.registerAgent(vaultPDA, agentKeypair.publicKey);

// 4. Agent executes a swap through Jupiter
const sig = await client.executeJupiterSwap({
  vault: vaultPDA,
  owner: wallet.publicKey,
  vaultId: new BN(1),
  agent: agentKeypair.publicKey,
  inputMint: USDC_MINT,
  outputMint: SOL_MINT,
  amount: new BN(10_000_000),
  slippageBps: 50,
});
```

## On-Chain Account Model

AgentShield uses 6 PDA account types:

| Account | Seeds | Description |
|---------|-------|-------------|
| **AgentVault** | `[b"vault", owner, vault_id]` | Holds owner/agent pubkeys, vault status, fee destination |
| **PolicyConfig** | `[b"policy", vault]` | Spending caps, protocol mode + protocols, leverage limits, destinations |
| **SpendTracker** | `[b"tracker", vault]` | Zero-copy 144-epoch circular buffer for rolling 24h USD spend tracking |
| **SessionAuthority** | `[b"session", vault, agent, token_mint]` | Ephemeral PDA for atomic transaction validation (expires after 20 slots) |
| **PendingPolicyUpdate** | `[b"pending_policy", vault]` | Queued policy change with timelock, applied after delay |
| **OracleRegistry** | `[b"oracle_registry"]` | Protocol-level PDA mapping token mints to oracle feeds (max 105 entries) |

## Instruction Composition Pattern

The SDK uses **atomic multi-instruction transactions** to avoid Solana's 4-level CPI depth limit:

```
Transaction = [
  SetComputeUnitLimit(1_400_000),
  ValidateAndAuthorize,    // AgentShield: check policy, create session PDA
  ...DeFi instructions,    // Jupiter swap / Flash Trade open / etc.
  FinalizeSession          // AgentShield: audit, fees, close session PDA
]
```

All instructions succeed or fail atomically. If the DeFi instruction fails, the session is never finalized and no spend is recorded.

## API Reference

### Vault Management

| Method | Description | Signer |
|--------|-------------|--------|
| `createVault(params)` | Create a new vault with policy, tracker, and fee destination | Owner |
| `deposit(vault, mint, amount)` | Deposit SPL tokens into the vault | Owner |
| `registerAgent(vault, agent)` | Register an agent signing key on the vault | Owner |
| `updatePolicy(vault, params)` | Update policy fields (partial update — only set fields change) | Owner |
| `revokeAgent(vault)` | Freeze the vault (kill switch) | Owner |
| `reactivateVault(vault, newAgent?)` | Unfreeze vault and optionally rotate agent key | Owner |
| `withdraw(vault, mint, amount)` | Withdraw tokens to owner | Owner |
| `closeVault(vault)` | Close vault and reclaim rent | Owner |

### Permission Engine

| Method | Description | Signer |
|--------|-------------|--------|
| `authorizeAction(vault, params)` | Validate agent action against policy, create session PDA | Agent |
| `finalizeSession(vault, agent, success, ...)` | Close session, record audit, collect fees | Agent |

### Transaction Composition

These methods build atomic transactions in the pattern `[ValidateAndAuthorize, DeFi_ix, FinalizeSession]`:

| Method | Description |
|--------|-------------|
| `composePermittedAction(params, computeUnits?)` | Build instruction array for any DeFi action |
| `composePermittedTransaction(params, computeUnits?)` | Build a complete `VersionedTransaction` |
| `composePermittedSwap(params, computeUnits?)` | Shorthand for swap-type actions |
| `composeAndSend(params, signers?, computeUnits?)` | Compose, sign, send, and confirm in one call |

### Jupiter Integration

| Method | Description |
|--------|-------------|
| `getJupiterQuote(params)` | Fetch a swap quote from Jupiter V6 API |
| `jupiterSwap(params)` | Build an unsigned `VersionedTransaction` for a Jupiter swap |
| `executeJupiterSwap(params, signers?)` | Quote, compose, sign, send, and confirm in one call |

### Flash Trade Integration

| Method | Description |
|--------|-------------|
| `flashTradeOpen(params, poolConfig?)` | Compose an open position through Flash Trade |
| `flashTradeClose(params, poolConfig?)` | Compose a close position |
| `flashTradeIncrease(params, poolConfig?)` | Compose an increase position |
| `flashTradeDecrease(params, poolConfig?)` | Compose a decrease position |
| `executeFlashTrade(result, agent, signers?)` | Sign, send, and confirm a Flash Trade transaction |
| `createFlashTradeClient(config?)` | Create/cache a `PerpetualsClient` |
| `getFlashPoolConfig(poolName?, cluster?)` | Get/cache Flash Trade pool config |

### PDA Helpers

```typescript
const [vaultPDA, bump] = client.getVaultPDA(owner, vaultId);
const [policyPDA] = client.getPolicyPDA(vaultPDA);
const [trackerPDA] = client.getTrackerPDA(vaultPDA);
const [sessionPDA] = client.getSessionPDA(vaultPDA, agent, tokenMint);
```

### Account Fetchers

```typescript
// Fetch by owner + vault ID
const vault = await client.fetchVault(owner, vaultId);
const policy = await client.fetchPolicy(vaultPDA);
const tracker = await client.fetchTracker(vaultPDA);

// Fetch by PDA address directly
const vault = await client.fetchVaultByAddress(vaultPDA);
const policy = await client.fetchPolicyByAddress(policyPDA);
const tracker = await client.fetchTrackerByAddress(trackerPDA);
```

## Types

### Instruction Parameters

- **`InitializeVaultParams`** — `vaultId`, `dailySpendingCapUsd`, `maxTransactionSizeUsd`, `protocolMode` (0=all, 1=allowlist, 2=denylist), `protocols`, `maxLeverageBps`, `maxConcurrentPositions`, `feeDestination`, `developerFeeRate?`, `timelockDuration?`, `allowedDestinations?`
- **`UpdatePolicyParams`** — All policy fields as optionals (only set fields are updated)
- **`AuthorizeParams`** — `actionType`, `tokenMint`, `amount`, `targetProtocol`, `leverageBps?`
- **`ComposeActionParams`** — Full params for composed transactions including `defiInstructions`, `success?`, token accounts

### Account Types

- **`AgentVaultAccount`** — owner, agent, feeDestination, vaultId, status, stats (totalTransactions, totalVolume)
- **`PolicyConfigAccount`** — dailySpendingCapUsd, maxTransactionSizeUsd, protocolMode, protocols, maxLeverageBps, maxConcurrentPositions, developerFeeRate, timelockDuration, allowedDestinations
- **`SpendTrackerAccount`** — vault, buckets (`EpochBucket[]` — 144 epochs, epoch_id + usd_amount per bucket)
- **`OracleRegistryAccount`** — authority, entries (`OracleEntry[]` — mint, oracleFeed, isStablecoin)
- **`SessionAuthorityAccount`** — vault, agent, actionType, expiresAt, delegated, delegationTokenAccount

### Enums

```typescript
// Vault status
VaultStatus.active    // Normal operation
VaultStatus.frozen    // Kill switch activated
VaultStatus.closed    // Vault closed

// Action types (for validation + audit)
ActionType.swap
ActionType.openPosition
ActionType.closePosition
ActionType.increasePosition
ActionType.decreasePosition
ActionType.deposit
ActionType.withdraw
```

## Constants

```typescript
import {
  AGENT_SHIELD_PROGRAM_ID,  // 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL
  JUPITER_V6_API,            // https://quote-api.jup.ag/v6
  JUPITER_PROGRAM_ID,        // JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
  FLASH_TRADE_PROGRAM_ID,    // PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
} from "@agent-shield/sdk";
```

## Architecture

```
Owner creates vault with policy → Agent operates within policy constraints

┌─────────────────────────────────────────────────────────────┐
│  Transaction (atomic — all succeed or all revert)           │
│                                                              │
│  1. SetComputeUnitLimit(1,400,000)                          │
│  2. ValidateAndAuthorize                                     │
│     • Check vault status (Active)                           │
│     • Check agent is registered                             │
│     • Check token/protocol whitelists                       │
│     • Check spending cap (rolling 24h)                      │
│     • Check leverage limits (if perp)                       │
│     • Create SessionAuthority PDA                           │
│  3. DeFi Instruction (Jupiter swap, Flash Trade, etc.)      │
│  4. FinalizeSession                                         │
│     • Record in audit log                                   │
│     • Update open positions counter                         │
│     • Collect protocol + developer fees                     │
│     • Close SessionAuthority PDA (reclaim rent)             │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| One agent per vault | Multiple agents = multiple vaults. Simplifies permission model. |
| Rolling 24h window | Not calendar-day. Prevents edge-case burst at midnight. |
| Fees at finalization only | Not at authorization. Prevents fee charging on failed txs. |
| Immutable fee destination | Prevents owner from changing fee recipient after vault creation. |
| Bounded vectors | Max 10 protocols, 10 destinations, 105 oracle entries. SpendTracker uses fixed 144-epoch circular buffer. |

### Policy Constraints

| Field | Range | Description |
|-------|-------|-------------|
| `dailySpendingCapUsd` | `u64` | Max aggregate USD spend in rolling 24h window (6 decimals) |
| `maxTransactionSizeUsd` | `u64` | Max single transaction USD value (6 decimals) |
| `protocolMode` | 0, 1, 2 | 0=allow all, 1=allowlist, 2=denylist |
| `protocols` | max 10 | Program IDs for allowlist/denylist |
| `maxLeverageBps` | `u16` | Max leverage in basis points |
| `maxConcurrentPositions` | `u8` | Max open positions |
| `developerFeeRate` | 0–500 | Developer fee in BPS (max 5%) |
| `timelockDuration` | `u64` | Seconds before policy changes take effect (0 = instant) |
| `allowedDestinations` | max 10 | Allowed destination addresses for agent transfers |

## Security Model

AgentShield provides three layers of protection in a single integration:

1. **Client-side policy checks** — fast deny before transactions hit the network
2. **TEE key custody** — agent private keys stored in hardware enclaves (Crossmint, Turnkey, Privy)
3. **On-chain vault enforcement** (this package) — PDA vaults with cryptographic policy guarantees enforced by Solana validators

All three layers are bundled into `withVault()` from `@agent-shield/sdk`.

**On-chain enforcement means:**
- Agent cannot exceed spending caps even if the agent software is compromised
- Owner can freeze the vault at any time (kill switch)
- All transactions are audited in the SpendTracker
- Session PDAs expire after 20 slots (~8 seconds)
- Fee destination is immutable after creation

## Devnet

Program deployed to devnet at: `4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`

IDL account: `Ev3gSzxLw6RwExAMpTHUKvn2o9YVULxiWehrHee7aepP`

## Related Packages

| Package | Description |
|---------|-------------|
| [`@agent-shield/solana`](https://www.npmjs.com/package/@agent-shield/solana) | Deprecated shim — re-exports from this package |
| [`@agent-shield/core`](https://www.npmjs.com/package/@agent-shield/core) | Pure TypeScript policy engine |
| [`@agent-shield/plugin-solana-agent-kit`](https://www.npmjs.com/package/@agent-shield/plugin-solana-agent-kit) | Solana Agent Kit integration |
| [`@agent-shield/plugin-elizaos`](https://www.npmjs.com/package/@agent-shield/plugin-elizaos) | ElizaOS integration |

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/agentshield/issues)

## License

Apache-2.0
