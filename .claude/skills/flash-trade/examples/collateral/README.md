# Collateral Management

## Add Collateral (Reduce Leverage)

Adding collateral reduces position leverage without changing position size.

```typescript
import { PerpetualsClient, PoolConfig, Side, Privilege } from "flash-sdk";
import { BN } from "@coral-xyz/anchor";

// Add 50 USDC collateral to an existing SOL long position
const { instructions, additionalSigners } = await client.addCollateral(
  "SOL",
  "USDC",
  new BN(50_000_000),    // 50 USDC (6 decimals)
  Side.Long,
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Added collateral:", sig);
```

## Remove Collateral (Increase Leverage)

Removing collateral increases leverage. The amount is specified in USD, not token decimals.

```typescript
// Remove $25 worth of collateral from an existing position
const { instructions, additionalSigners } = await client.removeCollateral(
  "SOL",
  "USDC",
  new BN(25_000_000),    // $25 USD (6 decimals) -- NOTE: USD amount, not token amount
  Side.Long,
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Removed collateral:", sig);
```

**Important:** `removeCollateral` takes a USD-denominated amount (`collateral_delta_usd`), while `addCollateral` takes a token-denominated amount (`collateral_delta`). This asymmetry exists because removal happens at the current oracle price, while addition is a direct token transfer.

## Composability: Swap and Add Collateral

Add collateral from a different token by atomically swapping first.

```typescript
// Swap SOL into USDC and add as collateral to a SOL long position
const { instructions, additionalSigners } = await client.swapAndAddCollateral(
  "SOL",     // input token to swap from
  "SOL",     // target symbol (the position's market)
  "USDC",    // collateral symbol
  new BN(500_000_000),  // 0.5 SOL input amount
  Side.Long,
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Swapped and added collateral:", sig);
```

## Composability: Remove Collateral and Swap

Withdraw collateral and atomically swap it to a different token.

```typescript
// Remove $50 collateral and swap to SOL
const { instructions, additionalSigners } = await client.removeCollateralAndSwap(
  "SOL",     // target symbol (the position's market)
  "USDC",    // collateral symbol
  "SOL",     // output token to receive
  new BN(50_000_000),  // $50 USD to remove
  Side.Long,
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Removed collateral and swapped:", sig);
```

## Leverage Calculation

```typescript
// Calculate current leverage
const { profit, loss } = await viewHelper.getPnl("SOL", "USDC", Side.Long, poolConfig);
const position = await fetchPosition(connection, positionPda);

const collateralUsd = position.collateralUsd;
const sizeUsd = position.sizeUsd;
const currentLeverage = sizeUsd.toNumber() / collateralUsd.toNumber();

console.log(`Size: $${sizeUsd.toNumber() / 1_000_000}`);
console.log(`Collateral: $${collateralUsd.toNumber() / 1_000_000}`);
console.log(`Leverage: ${currentLeverage.toFixed(1)}x`);

// After adding 50 USDC
const newCollateral = collateralUsd.add(new BN(50_000_000));
const newLeverage = sizeUsd.toNumber() / newCollateral.toNumber();
console.log(`Leverage after add: ${newLeverage.toFixed(1)}x`);
```

## Safety Checks

```typescript
// Before removing collateral, check that resulting leverage is within limits
function canRemoveCollateral(
  sizeUsd: BN,
  currentCollateralUsd: BN,
  removeAmountUsd: BN,
  maxLeverage: number, // e.g., 100 for 100x
): boolean {
  const newCollateral = currentCollateralUsd.sub(removeAmountUsd);
  if (newCollateral.lte(new BN(0))) return false;

  const resultingLeverage = sizeUsd.toNumber() / newCollateral.toNumber();
  return resultingLeverage <= maxLeverage;
}

const safe = canRemoveCollateral(
  position.sizeUsd,
  position.collateralUsd,
  new BN(25_000_000),
  100,  // max 100x
);

if (!safe) {
  console.error("Removing this much collateral would exceed leverage limit");
}
```

## Full Position Data with ViewHelper

```typescript
import { ViewHelper } from "flash-sdk";

const viewHelper = new ViewHelper(connection, provider);

// Get comprehensive position data including leverage and liquidation price
const positionData = await viewHelper.getPositionData(
  "SOL", "USDC", Side.Long, poolConfig
);

console.log(`Collateral: $${positionData.collateralUsd.toNumber() / 1_000_000}`);
console.log(`Profit: $${positionData.profitUsd.toNumber() / 1_000_000}`);
console.log(`Loss: $${positionData.lossUsd.toNumber() / 1_000_000}`);
console.log(`Fee: $${positionData.feeUsd.toNumber() / 1_000_000}`);
console.log(`Leverage: ${positionData.leverage.toNumber() / 10_000}x`);
console.log(`Liquidation price: $${positionData.liquidationPrice.price.toNumber() / 1_000_000}`);
```
