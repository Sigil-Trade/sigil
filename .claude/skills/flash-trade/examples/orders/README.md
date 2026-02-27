# Order Management

## Place Take-Profit Order

```typescript
import { PerpetualsClient, PoolConfig, Side, Privilege } from "flash-sdk";
import { BN } from "@coral-xyz/anchor";

// Place TP at $200 to close 0.5 SOL of a long position
const { instructions, additionalSigners } = await client.placeTriggerOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    triggerPrice: { price: new BN(200_000_000), exponent: -6 }, // $200
    deltaSizeAmount: new BN(500_000_000),                        // 0.5 SOL
    isStopLoss: false,                                            // TP, not SL
  },
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Placed take-profit:", sig);
```

## Place Stop-Loss Order

```typescript
// Place SL at $130 to close entire position (1 SOL)
const { instructions, additionalSigners } = await client.placeTriggerOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    triggerPrice: { price: new BN(130_000_000), exponent: -6 }, // $130
    deltaSizeAmount: new BN(1_000_000_000),                      // 1 SOL (full close)
    isStopLoss: true,
  },
  poolConfig,
  Privilege.None,
);
```

## Edit Trigger Order

```typescript
// Move take-profit from $200 to $210
const { instructions, additionalSigners } = await client.editTriggerOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    orderId: 0,  // index in the TP array (0-based)
    triggerPrice: { price: new BN(210_000_000), exponent: -6 },
    deltaSizeAmount: new BN(500_000_000),
    isStopLoss: false,
  },
  poolConfig,
  Privilege.None,
);
```

## Cancel Trigger Order

```typescript
// Cancel the first take-profit order
const { instructions, additionalSigners } = await client.cancelTriggerOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    orderId: 0,
    isStopLoss: false, // which array: false=TP, true=SL
  },
  poolConfig,
  Privilege.None,
);
```

## Place Limit Order

Limit orders open a position when the oracle price reaches the specified level. Collateral is reserved upfront from the user's token account.

```typescript
// Place a limit buy: open 1 SOL long at $140 with 100 USDC collateral
const { instructions, additionalSigners } = await client.placeLimitOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    limitPrice: { price: new BN(140_000_000), exponent: -6 },
    sizeAmount: new BN(1_000_000_000),   // 1 SOL
    reserveAmount: new BN(100_000_000),  // 100 USDC reserved as collateral
  },
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Placed limit order:", sig);
```

## Limit Order with Stop-Loss and Take-Profit

```typescript
// Limit buy at $140 with attached SL at $130 and TP at $170
const { instructions, additionalSigners } = await client.placeLimitOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    limitPrice: { price: new BN(140_000_000), exponent: -6 },
    sizeAmount: new BN(1_000_000_000),
    reserveAmount: new BN(100_000_000),
    stopLossPrice: { price: new BN(130_000_000), exponent: -6 },     // optional SL
    takeProfitPrice: { price: new BN(170_000_000), exponent: -6 },   // optional TP
  },
  poolConfig,
  Privilege.None,
);
```

## Edit Limit Order

```typescript
// Change limit price to $135
const { instructions, additionalSigners } = await client.editLimitOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    orderId: 0,  // index in the limit orders array (0-based)
    limitPrice: { price: new BN(135_000_000), exponent: -6 },
    sizeAmount: new BN(1_000_000_000),
    stopLossPrice: { price: new BN(0), exponent: 0 },     // no SL
    takeProfitPrice: { price: new BN(0), exponent: 0 },   // no TP
  },
  poolConfig,
  Privilege.None,
);
```

## Cancel Limit Order

Flash Trade has no dedicated `cancelLimitOrder` instruction. Cancel by calling `editLimitOrder` with `sizeAmount = 0`.

```typescript
// Cancel by setting size to 0
const { instructions, additionalSigners } = await client.editLimitOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    orderId: 0,
    limitPrice: { price: new BN(0), exponent: 0 },
    sizeAmount: new BN(0), // size=0 signals cancellation
    stopLossPrice: { price: new BN(0), exponent: 0 },
    takeProfitPrice: { price: new BN(0), exponent: 0 },
  },
  poolConfig,
  Privilege.None,
);
```

## Order Limits

Each market allows a maximum number of concurrent orders per user:

| Order Type | Max Per Market | Error on Exceed |
|-----------|---------------|-----------------|
| Stop-loss | 5 | `MaxStopLossOrders` (6052) |
| Take-profit | 5 | `MaxTakeProfitOrders` (6053) |
| Limit orders | 5 | `MaxOpenOrder` (6054) |

## Reading Order State

```typescript
import { OrderAccount } from "flash-sdk";

// Fetch order account to check active orders
const orderPda = /* derive from market + owner */;
const orderAccount = await OrderAccount.fetch(connection, orderPda);

if (orderAccount) {
  console.log("Open limit orders:", orderAccount.openOrders);
  console.log("Open stop-losses:", orderAccount.openSl);
  console.log("Open take-profits:", orderAccount.openTp);
  console.log("Total active:", orderAccount.activeOrders);
  console.log("Execution count:", orderAccount.executionCount.toString());

  // Inspect individual limit orders
  for (let i = 0; i < orderAccount.openOrders; i++) {
    const lo = orderAccount.limitOrders[i];
    console.log(`  Limit #${i}: price=${lo.limitPrice.price}, size=${lo.sizeAmount}`);
  }

  // Inspect trigger orders
  for (let i = 0; i < orderAccount.openTp; i++) {
    const tp = orderAccount.takeProfitOrders[i];
    console.log(`  TP #${i}: trigger=${tp.triggerPrice.price}, size=${tp.triggerSize}`);
  }
  for (let i = 0; i < orderAccount.openSl; i++) {
    const sl = orderAccount.stopLossOrders[i];
    console.log(`  SL #${i}: trigger=${sl.triggerPrice.price}, size=${sl.triggerSize}`);
  }
}
```

## Keeper Execution

Trigger orders and limit orders are executed by **off-chain keepers**, not the position owner. This has implications:

1. **Latency**: Orders may not execute immediately when price is hit -- depends on keeper polling frequency
2. **No guarantee of execution**: In extreme market conditions, keepers may be delayed or oracle prices may skip the trigger level
3. **Slippage**: Execution price may differ from trigger price due to spread and oracle latency
4. **Privilege pass-through**: Keepers must pass the correct `Privilege` for fee discounts

```typescript
// Keeper-side: execute a trigger order (TP)
const { instructions, additionalSigners } = await client.executeTriggerOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    isStopLoss: false,   // executing a take-profit
    orderId: 0,          // which order in the array
    privilege: Privilege.None,
  },
  poolConfig,
);

// Keeper-side: execute a limit order
const { instructions: limitIxs, additionalSigners: limitSigners } = await client.executeLimitOrder(
  "SOL",
  "USDC",
  Side.Long,
  {
    orderId: 0,
    privilege: Privilege.None,
  },
  poolConfig,
);
```
