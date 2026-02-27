# Basic Setup

## TypeScript Setup

```typescript
import { PerpetualsClient, PoolConfig, Side, Privilege } from "flash-sdk";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

// ── Configuration ──
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const CLUSTER = "mainnet-beta"; // or "devnet"
const POOL_NAME = "Crypto.1";
const PRIORITY_FEE = 10_000; // microLamports

// ── Provider Setup ──
const connection = new Connection(RPC_URL, { commitment: "processed" });
const keypair = Keypair.fromSecretKey(/* your key */);
const wallet = new NodeWallet(keypair);
const provider = new AnchorProvider(connection, wallet, {
  commitment: "processed",
  preflightCommitment: "processed",
});

// ── Pool Config ──
const poolConfig = PoolConfig.fromIdsByName(POOL_NAME, CLUSTER);

// ── Client Initialization ──
const client = new PerpetualsClient(
  provider,
  new PublicKey(poolConfig.programId),
  new PublicKey(poolConfig.perpComposibilityProgramId),
  new PublicKey(poolConfig.fbNftRewardProgramId),
  new PublicKey(poolConfig.rewardDistributionProgram.programId),
  { prioritizationFee: PRIORITY_FEE },
);

// ── CRITICAL: Load Address Lookup Tables ──
// This MUST be called before any trading operation.
// ALTs reduce transaction size by replacing full pubkeys with indices.
await client.loadAddressLookupTable(poolConfig);

console.log("Flash Trade client ready");
console.log("Program:", poolConfig.programId);
console.log("Pool:", poolConfig.poolAddress);
console.log("Custodies:", poolConfig.custodies.length);
console.log("Markets:", poolConfig.markets.length);
```

## Loading Multiple Pools

```typescript
// Load all pools you need upfront
const pools = {
  crypto: PoolConfig.fromIdsByName("Crypto.1", CLUSTER),
  virtual: PoolConfig.fromIdsByName("Virtual.1", CLUSTER),
  governance: PoolConfig.fromIdsByName("Governance.1", CLUSTER),
};

// Load ALTs for each pool
for (const [name, config] of Object.entries(pools)) {
  await client.loadAddressLookupTable(config);
  console.log(`Loaded ALTs for ${name}: ${config.poolAddress}`);
}
```

## Checking Pool State

```typescript
import { PoolAccount, PoolDataClient } from "flash-sdk";

// Read pool data for LP statistics
const poolDataClient = new PoolDataClient(connection);
const poolData = await poolDataClient.getPoolData(poolConfig);

console.log("Pool AUM:", poolData.aumUsd.toString(), "USD (6 decimals)");
console.log("Total LP tokens:", poolData.totalLpTokens.toString());
```

## Devnet Setup

```typescript
const DEVNET_RPC = "https://api.devnet.solana.com";
const connection = new Connection(DEVNET_RPC, { commitment: "processed" });

// Devnet uses different program IDs -- PoolConfig handles this automatically
const poolConfig = PoolConfig.fromIdsByName("Crypto.1", "devnet");

const client = new PerpetualsClient(
  provider,
  new PublicKey(poolConfig.programId),           // FTPP4jEWW1n8s2FEccwVfS9KCPjpndaswg7Nkkuz4ER4
  new PublicKey(poolConfig.perpComposibilityProgramId), // SWAP4AE4N1if9qKD7dgfQgmRBRv1CtWG8xDs4HP14ST
  new PublicKey(poolConfig.fbNftRewardProgramId),
  new PublicKey(poolConfig.rewardDistributionProgram.programId),
  { prioritizationFee: 1_000 }, // lower fees on devnet
);

await client.loadAddressLookupTable(poolConfig);
```

## Sending Transactions

```typescript
// Method 1: Use the built-in sendTransaction (builds versioned tx automatically)
const { instructions, additionalSigners } = await client.openPosition(
  "SOL", "USDC",
  { price: new BN(160_000_000), exponent: -6 },
  new BN(100_000_000),  // 100 USDC
  new BN(1_000_000_000), // 1 SOL
  Side.Long,
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Transaction:", sig);

// Method 2: Build your own versioned transaction for custom signing
import { VersionedTransaction, TransactionMessage } from "@solana/web3.js";

const { blockhash } = await connection.getLatestBlockhash();
const messageV0 = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: blockhash,
  instructions,
}).compileToV0Message(client.addressLookupTables);

const tx = new VersionedTransaction(messageV0);
tx.sign([keypair, ...additionalSigners]);
const sig2 = await connection.sendTransaction(tx);
```

## Environment Variables

```bash
# Required
RPC_URL=https://your-rpc-endpoint.com
WALLET_PRIVATE_KEY=<base58-encoded-private-key>

# Optional
PRIORITY_FEE=10000          # microLamports (default: 10000)
CLUSTER=mainnet-beta        # mainnet-beta or devnet
POOL_NAME=Crypto.1          # default pool
```
