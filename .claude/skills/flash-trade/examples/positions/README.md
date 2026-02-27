# Position Management

## Open a Long Position

```typescript
import { PerpetualsClient, PoolConfig, Side, Privilege, ViewHelper } from "flash-sdk";
import { BN } from "@coral-xyz/anchor";

// Get current oracle price for slippage calculation
const viewHelper = new ViewHelper(connection, provider);
const oraclePrice = await viewHelper.getOraclePrice("SOL", poolConfig);

// Add 2% slippage for a long (willing to pay up to 2% above oracle)
const slippageBps = 200;
const priceWithSlippage = {
  price: oraclePrice.price.mul(new BN(10_000 + slippageBps)).div(new BN(10_000)),
  exponent: oraclePrice.exponent,
};

// Open 10x long: 100 USDC collateral, ~1000 USDC notional
const { instructions, additionalSigners } = await client.openPosition(
  "SOL",
  "USDC",
  priceWithSlippage,
  new BN(100_000_000),     // 100 USDC (6 decimals)
  new BN(6_600_000_000),   // ~6.6 SOL at $150 = ~$1000 (9 decimals)
  Side.Long,
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Opened long position:", sig);
```

## Open a Short Position

```typescript
// For shorts, slippage price is BELOW oracle (willing to accept lower entry)
const priceWithSlippage = {
  price: oraclePrice.price.mul(new BN(10_000 - slippageBps)).div(new BN(10_000)),
  exponent: oraclePrice.exponent,
};

const { instructions, additionalSigners } = await client.openPosition(
  "ETH",
  "USDC",
  priceWithSlippage,
  new BN(500_000_000),     // 500 USDC
  new BN(150_000_000),     // 1.5 ETH (8 decimals)
  Side.Short,
  poolConfig,
  Privilege.None,
);
```

## Close a Position

```typescript
// For closing a long, set price BELOW oracle (worst acceptable exit)
const exitSlippage = {
  price: oraclePrice.price.mul(new BN(10_000 - slippageBps)).div(new BN(10_000)),
  exponent: oraclePrice.exponent,
};

const { instructions, additionalSigners } = await client.closePosition(
  "SOL",
  "USDC",
  exitSlippage,
  Side.Long,
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Closed position:", sig);
```

## Increase Position Size

```typescript
// Add 0.5 SOL to an existing long, with 50 USDC additional collateral
const { instructions, additionalSigners } = await client.increaseSize(
  "SOL",
  "USDC",
  priceWithSlippage,
  new BN(500_000_000),   // 0.5 SOL size increase
  new BN(50_000_000),    // 50 USDC additional collateral
  Side.Long,
  poolConfig,
  Privilege.None,
);
```

## Decrease Position Size

```typescript
// Remove 0.3 SOL from position, return 30 USDC collateral
const { instructions, additionalSigners } = await client.decreaseSize(
  "SOL",
  "USDC",
  exitSlippage,          // below oracle for closing a long portion
  new BN(300_000_000),   // 0.3 SOL size decrease
  new BN(30_000_000),    // 30 USDC collateral returned
  Side.Long,
  poolConfig,
  Privilege.None,
);
```

## Check Position PnL

```typescript
const { profit, loss } = await viewHelper.getPnl("SOL", "USDC", Side.Long, poolConfig);

if (profit.gt(new BN(0))) {
  console.log(`Profit: $${profit.toNumber() / 1_000_000}`);
} else {
  console.log(`Loss: $${loss.toNumber() / 1_000_000}`);
}
```

## Get Liquidation Price

```typescript
const liqPrice = await viewHelper.getLiquidationPrice("SOL", "USDC", Side.Long, poolConfig);
console.log(`Liquidation at: $${liqPrice.toNumber() / 1_000_000}`);

// Check if currently liquidatable
const isLiquidatable = await viewHelper.getLiquidationState("SOL", "USDC", Side.Long, poolConfig);
if (isLiquidatable) {
  console.warn("Position is at risk of liquidation!");
}
```

## Position PDA Derivation

```typescript
// Derive position address manually (useful for checking existence)
const [positionPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("position"),
    ownerPubkey.toBuffer(),
    new PublicKey(poolConfig.poolAddress).toBuffer(),
    custodyPubkey.toBuffer(),
    Buffer.from([1]), // 1 = Long, 2 = Short
  ],
  new PublicKey(poolConfig.programId),
);

const positionInfo = await connection.getAccountInfo(positionPda);
if (positionInfo) {
  console.log("Position exists, size:", positionInfo.data.length, "bytes");
} else {
  console.log("No position found");
}
```

## Degen Mode (125x-500x)

```typescript
// Degen Mode: only SOL, BTC, ETH -- up to 500x leverage
const collateralUsdc = 10_000_000;   // 10 USDC
const sizeUsdc = 2_500_000_000;      // $2,500 notional = 250x leverage

// Verify eligibility
const degenEligible = ["SOL", "BTC", "ETH"];
if (!degenEligible.includes("SOL")) {
  throw new Error("Degen Mode not available for this asset");
}

const leverageX = sizeUsdc / collateralUsdc; // 250x
if (leverageX > 500) {
  throw new Error("Max Degen leverage is 500x");
}

// Open with high leverage (on-chain enforcement via custody max_leverage)
const { instructions, additionalSigners } = await client.openPosition(
  "SOL",
  "USDC",
  priceWithSlippage,
  new BN(collateralUsdc),
  new BN(16_500_000_000), // ~16.5 SOL at $150 = ~$2,500
  Side.Long,
  poolConfig,
  Privilege.None,
);
```
