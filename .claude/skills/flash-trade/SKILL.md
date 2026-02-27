---
name: flash-trade
creator: flash-trade
description: Complete Flash Trade perpetuals DEX integration for Solana. Pool-to-peer leveraged trading (up to 100x, Degen Mode 500x), position management, trigger/limit orders, collateral operations, LP provision, and composability (swap-and-open, close-and-swap). Use when building trading bots, integrating Flash Trade markets, managing leveraged positions, or providing liquidity.
license: MIT
metadata:
  author: flash-trade
  version: "1.0.0"
tags:
  - flash-trade
  - flash
  - perpetuals
  - perps
  - leverage
  - trading
  - positions
  - collateral
  - trigger-orders
  - limit-orders
  - liquidity
  - lp
  - pool-to-peer
  - degen-mode
  - solana
  - defi
  - flash-sdk
  - composability
  - swap-and-open
  - close-and-swap
  - pyth
  - oracle
---

# Flash Trade Perpetuals Integration Guide

Flash Trade is a pool-to-peer perpetual futures and spot exchange on Solana. Traders trade against shared liquidity pools with up to 100x leverage (500x Degen Mode on SOL/BTC/ETH). The protocol uses Pyth oracles for pricing and supports virtual assets (forex, commodities, equities) without requiring actual token custody.

**Program ID (Mainnet):** `FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn`
**Composability Program:** `FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm`

## When to Use This Skill

- Opening, closing, increasing, or decreasing leveraged positions
- Placing or managing trigger orders (take-profit/stop-loss) and limit orders
- Adding or removing collateral from positions
- Composable flows: swap-and-open, close-and-swap, swap-and-add-collateral
- Providing or withdrawing liquidity (LP operations)
- Querying position state, PnL, liquidation prices
- Building trading bots or automated strategies on Flash Trade
- Integrating Flash Trade into wallets, aggregators, or agent frameworks

## When NOT to Use This Skill

- Jupiter swaps without Flash Trade positions -- use the `jupiter` skill
- Drift Protocol perpetuals -- use the `drift` skill
- General Solana program development -- use the `solana-dev` skill
- Priority fee estimation -- use the `helius` skill

## Triggers

**flash trade**, **flash perps**, **perpetual**, **leverage**, **open position**, **close position**, **increase size**, **decrease size**, **add collateral**, **remove collateral**, **trigger order**, **stop loss**, **take profit**, **limit order**, **degen mode**, **flash liquidity**, **LP**, **pool-to-peer**, **flash swap**, **swap-and-open**, **close-and-swap**, **flash-sdk**, **FLP**, **compounding LP**

---

## Quick Start

```typescript
import { PerpetualsClient, PoolConfig, Side, Privilege } from "flash-sdk";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

// 1. Setup
const connection = new Connection("https://api.mainnet-beta.solana.com");
const provider = new AnchorProvider(connection, wallet, { commitment: "processed" });

// 2. Load pool config -- this is the canonical source of truth for pools
const poolConfig = PoolConfig.fromIdsByName("Crypto.1", "mainnet-beta");

// 3. Create client
const client = new PerpetualsClient(
  provider,
  new PublicKey(poolConfig.programId),
  new PublicKey(poolConfig.perpComposibilityProgramId),
  new PublicKey(poolConfig.fbNftRewardProgramId),
  new PublicKey(poolConfig.rewardDistributionProgram.programId),
  { prioritizationFee: 10_000 },
);

// 4. Load address lookup tables (REQUIRED for versioned transactions)
await client.loadAddressLookupTable(poolConfig);

// 5. Open a 10x long SOL position with 100 USDC collateral
const { instructions, additionalSigners } = await client.openPosition(
  "SOL",                                          // target symbol
  "USDC",                                         // collateral symbol
  { price: new BN(150_000_000), exponent: -6 },   // max entry price (slippage)
  new BN(100_000_000),                             // 100 USDC collateral (6 decimals)
  new BN(1_000_000_000),                           // 1 SOL size (9 decimals)
  Side.Long,
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
```

---

## Architecture Overview

### Pool-to-Peer Model

All trades execute against shared liquidity pools. No orderbook, no counterparty matching:
- Near-zero slippage for typical trade sizes
- Instant settlement (single transaction)
- Deep liquidity from aggregated LP deposits

### Multi-Pool Architecture

Flash Trade organizes trading into multiple pools, each holding specific token custodies and defining markets within them. Use `PoolConfig.fromIdsByName(name, cluster)` to load any pool.

**Available pools** (as of the SDK -- always use `PoolConfig` for the latest):

| Pool Category | Name | Assets (examples) |
|--------------|------|-------------------|
| Crypto | `Crypto.1` | USDC, SOL, BTC, ETH, JitoSOL |
| Virtual (Forex/Commodities) | `Virtual.1` | USDC, XAU, XAG, EUR, GBP, CRUDEOIL |
| Governance | `Governance.1` | USDC, JUP, PYTH, JTO, RAY |
| Community | `Community.1`, `Community.2` | USDC, BONK, PENGU, WIF |
| Real-World Assets | `Remora.1` | USDC, TSLAr, NVDAr, SPYr |

See [docs/pools-and-markets.md](docs/pools-and-markets.md) for pool architecture details.

### Key Concepts

- **Custody**: A token's configuration within a pool (fees, oracle, pricing limits, borrow rates)
- **Market**: Defines a tradable pair (target custody + collateral custody + side + permissions)
- **Position**: A leveraged trade (owner, market, entry price, size, collateral, PnL)
- **Order**: Trigger orders (TP/SL) and limit orders, stored per-market per-owner. Max 5 TP, 5 SL, 5 limit per market.
- **Virtual tokens**: Synthetic exposure without actual token custody (forex, commodities, equities). Pool holds only USDC.
- **Degen Mode**: 125x-500x leverage on select assets. See `PricingParams.max_init_degen_leverage` per custody.
- **Privilege**: `None` (standard), `Stake` (FLP staker discount), `Referral` (referral rebate)

---

## Intent Router

| Intent | First Step | Section |
|--------|------------|---------|
| Open a leveraged long/short | `client.openPosition()` | [Position Management](#position-management) |
| Close an existing position | `client.closePosition()` | [Position Management](#position-management) |
| Increase position size | `client.increaseSize()` | [Position Management](#position-management) |
| Decrease position size | `client.decreaseSize()` | [Position Management](#position-management) |
| Add collateral to reduce leverage | `client.addCollateral()` | [Collateral](#collateral) |
| Remove collateral | `client.removeCollateral()` | [Collateral](#collateral) |
| Set stop-loss or take-profit | `client.placeTriggerOrder()` | [Trigger Orders](#trigger-orders) |
| Place a limit entry order | `client.placeLimitOrder()` | [Limit Orders](#limit-orders) |
| Swap into a position in one tx | `client.swapAndOpenPosition()` | [Composability](#composability) |
| Close and swap out in one tx | `client.closeAndSwapPosition()` | [Composability](#composability) |
| Provide liquidity to a pool | `client.addLiquidityAndStake()` | [Liquidity](#liquidity-provision) |
| Query position PnL | `ViewHelper.getPnl()` | [View Helpers](#view-helpers) |
| Get liquidation price | `ViewHelper.getLiquidationPrice()` | [View Helpers](#view-helpers) |
| Stake FLP tokens | `client.depositStake()` | [Staking](#staking) |
| Stake FLASH tokens | `client.depositTokenStake()` | [Token Staking](#token-staking) |

---

## Position Management

### Open Position

```typescript
const { instructions, additionalSigners } = await client.openPosition(
  targetSymbol,      // "SOL", "BTC", "ETH", "XAU", etc.
  collateralSymbol,  // "USDC" (primary collateral for most pools)
  priceWithSlippage, // OraclePrice { price: BN, exponent: number }
  collateralAmount,  // BN -- collateral in token decimals (USDC = 6)
  sizeAmount,        // BN -- position size in target token decimals
  side,              // Side.Long or Side.Short
  poolConfig,
  privilege,         // Privilege.None | Privilege.Stake | Privilege.Referral
);
```

**IDL params:** `OpenPositionParams { price_with_slippage: OraclePrice, collateral_amount: u64, size_amount: u64, privilege: Privilege }`

**Gotchas:**
- `priceWithSlippage` is the **worst acceptable entry price** -- set above oracle for longs, below for shorts
- `sizeAmount` uses the **target token's decimals** (SOL=9, BTC=8, etc.), NOT USD decimals
- **Always load ALTs first** via `client.loadAddressLookupTable(poolConfig)` -- transactions fail without them
- Leverage = `sizeUsd / collateralUsd` -- enforced on-chain against the custody's `max_init_leverage` (or `max_init_degen_leverage` for Degen Mode)
- **MinCollateral (6034)**: Position must meet minimum collateral threshold (`PricingParams.min_collateral_usd`)
- **CloseOnlyMode (6033)**: Market may be in close-only mode, rejecting new positions

### Close Position

```typescript
const { instructions, additionalSigners } = await client.closePosition(
  targetSymbol, collateralSymbol,
  priceWithSlippage, // worst acceptable exit price (below oracle for longs, above for shorts)
  side, poolConfig, Privilege.None,
);
```

**IDL params:** `ClosePositionParams { price_with_slippage: OraclePrice, privilege: Privilege }`

### Close and Swap

Atomically close a position and swap the returned collateral to a different token:

```typescript
const { instructions, additionalSigners } = await client.closeAndSwapPosition(
  targetSymbol, collateralSymbol, outputSymbol,
  priceWithSlippage, side, poolConfig, Privilege.None,
);
```

### Increase Size

```typescript
const { instructions, additionalSigners } = await client.increaseSize(
  targetSymbol, collateralSymbol, priceWithSlippage,
  sizeDelta,         // additional size in target token decimals
  side, poolConfig, Privilege.None,
);
```

**IDL params:** `IncreaseSizeParams { price_with_slippage: OraclePrice, size_delta: u64, privilege: Privilege }`

### Decrease Size

```typescript
const { instructions, additionalSigners } = await client.decreaseSize(
  targetSymbol, collateralSymbol, priceWithSlippage,
  sizeDelta,         // size to remove in target token decimals
  side, poolConfig, Privilege.None,
);
```

---

## Collateral

### Add Collateral

Reduces leverage by depositing additional collateral into an existing position.

```typescript
const { instructions, additionalSigners } = await client.addCollateral(
  targetSymbol, collateralSymbol,
  collateralDelta,   // amount to add in collateral token decimals
  side, poolConfig, Privilege.None,
);
```

**IDL params:** `AddCollateralParams { collateral_delta: u64 }`

### Remove Collateral

Increases leverage by withdrawing collateral from an existing position.

```typescript
const { instructions, additionalSigners } = await client.removeCollateral(
  targetSymbol, collateralSymbol,
  collateralDeltaUsd, // amount to remove in USD (6 decimals)
  side, poolConfig, Privilege.None,
);
```

**IDL params:** `RemoveCollateralParams { collateral_delta_usd: u64 }`

**Gotcha:** `removeCollateral` takes a **USD-denominated amount**, while `addCollateral` takes a **token-denominated amount**. Post-removal leverage must stay within `max_leverage` (not `max_init_leverage` -- the post-entry limit is more lenient).

### Remove Collateral and Swap

Atomically remove collateral and swap it to a different token:

```typescript
const { instructions, additionalSigners } = await client.removeCollateralAndSwap(
  targetSymbol, collateralSymbol, outputSymbol,
  collateralDeltaUsd, side, poolConfig, Privilege.None,
);
```

### Swap and Add Collateral

Swap a token to collateral and add it to a position in one transaction:

```typescript
const { instructions, additionalSigners } = await client.swapAndAddCollateral(
  inputSymbol, targetSymbol, collateralSymbol,
  amountIn, side, poolConfig, Privilege.None,
);
```

---

## Trigger Orders

Trigger orders execute when the oracle price crosses a threshold. Used for stop-loss and take-profit. Executed by off-chain keepers.

**Limits:** Max 5 stop-loss orders and 5 take-profit orders per market per owner.

### Place Trigger Order

```typescript
const { instructions, additionalSigners } = await client.placeTriggerOrder(
  targetSymbol, collateralSymbol, side,
  {
    triggerPrice: { price: new BN(200_000_000), exponent: -6 }, // trigger at $200
    deltaSizeAmount: new BN(500_000_000),                        // close 0.5 SOL
    isStopLoss: false,                                            // true=SL, false=TP
  },
  poolConfig, Privilege.None,
);
```

**IDL params:** `PlaceTriggerOrderParams { trigger_price: OraclePrice, delta_size_amount: u64, is_stop_loss: bool }`

### Edit Trigger Order

```typescript
await client.editTriggerOrder(targetSymbol, collateralSymbol, side, {
  orderId: 0,         // index in the order's TP/SL array (0-4)
  triggerPrice: { price: new BN(210_000_000), exponent: -6 },
  deltaSizeAmount: new BN(500_000_000),
  isStopLoss: false,
}, poolConfig, Privilege.None);
```

### Cancel Trigger Order

```typescript
await client.cancelTriggerOrder(targetSymbol, collateralSymbol, side, {
  orderId: 0,
  isStopLoss: false,
}, poolConfig, Privilege.None);
```

**Gotchas:**
- Trigger orders are **executed by keepers**, not the position owner
- `orderId` is the **array index** (0-4) within the order account's TP or SL array
- **InvalidStopLossPrice (6049)** / **InvalidTakeProfitPrice (6050)**: Trigger price doesn't make sense for the position direction
- **MaxStopLossOrders (6052)** / **MaxTakeProfitOrders (6053)**: 5 orders per type per market

---

## Limit Orders

Limit orders open positions at a specified price. Executed by keepers when the oracle price reaches the limit.

**Limits:** Max 5 limit orders per market per owner (`MaxOpenOrder` 6054).

### Place Limit Order

```typescript
const { instructions, additionalSigners } = await client.placeLimitOrder(
  targetSymbol, collateralSymbol, side,
  {
    limitPrice: { price: new BN(140_000_000), exponent: -6 },
    sizeAmount: new BN(1_000_000_000),
    reserveAmount: new BN(100_000_000),         // USDC collateral reserved
    stopLossPrice: { price: new BN(0), exponent: 0 },   // optional SL
    takeProfitPrice: { price: new BN(0), exponent: 0 },  // optional TP
  },
  poolConfig, Privilege.None,
);
```

**IDL params:** `PlaceLimitOrderParams { limit_price: OraclePrice, reserve_amount: u64, size_amount: u64, stop_loss_price: OraclePrice, take_profit_price: OraclePrice }`

### Edit Limit Order

```typescript
await client.editLimitOrder(targetSymbol, collateralSymbol, side, {
  orderId: 0,
  limitPrice: { price: new BN(135_000_000), exponent: -6 },
  sizeAmount: new BN(1_000_000_000),
  stopLossPrice: { price: new BN(0), exponent: 0 },
  takeProfitPrice: { price: new BN(0), exponent: 0 },
}, poolConfig, Privilege.None);
```

### Cancel Limit Order

**No direct cancel instruction.** Cancel by calling `editLimitOrder` with `sizeAmount = 0`:

```typescript
await client.editLimitOrder(targetSymbol, collateralSymbol, side, {
  orderId: 0,
  limitPrice: { price: new BN(0), exponent: 0 },
  sizeAmount: new BN(0), // size=0 signals cancellation
  stopLossPrice: { price: new BN(0), exponent: 0 },
  takeProfitPrice: { price: new BN(0), exponent: 0 },
}, poolConfig, Privilege.None);
```

---

## Composability

The Composability Program enables atomic swap+trade flows in a single transaction.

### Swap and Open

Swap one token to collateral, then open a position -- all atomically:

```typescript
const { instructions, additionalSigners } = await client.swapAndOpenPosition(
  inputSymbol, targetSymbol, collateralSymbol,
  priceWithSlippage, inputAmount, sizeAmount,
  side, poolConfig, Privilege.None,
);
```

### Close and Swap

Close a position, then swap the returned collateral to another token:

```typescript
const { instructions, additionalSigners } = await client.closeAndSwapPosition(
  targetSymbol, collateralSymbol, outputSymbol,
  priceWithSlippage, side, poolConfig, Privilege.None,
);
```

---

## Liquidity Provision

### Add Liquidity and Stake

```typescript
const { instructions, additionalSigners } = await client.addLiquidityAndStake(
  tokenSymbol,       // token to deposit (e.g., "USDC")
  amountIn,          // deposit amount in token decimals
  minLpOut,          // minimum FLP tokens (slippage protection)
  poolConfig, Privilege.None,
);
```

### Add Compounding Liquidity

Compounding pools auto-reinvest rewards into the LP position:

```typescript
const { instructions, additionalSigners } = await client.addCompoundingLiquidity(
  tokenSymbol, amountIn, minCompoundingOut, poolConfig, Privilege.None,
);
```

### Remove Liquidity

```typescript
const { instructions, additionalSigners } = await client.removeLiquidity(
  tokenSymbol, lpAmountIn, minAmountOut, poolConfig, Privilege.None,
);
```

### FLP Token Price

```typescript
const price = await client.getCompoundingLPTokenPrice(poolConfig);
// Returns USD price of one LP token (6 decimals)
```

**Gotcha:** LP fees depend on pool token ratios. Depositing an underweight token gets a fee discount; depositing overweight gets a premium. Check ratios before depositing to minimize fees.

---

## Staking

### FLP Staking (LP Token Staking)

```typescript
// Deposit LP tokens to earn trading fees
await client.depositStake(tokenSymbol, depositAmount, poolConfig);

// Instant unstake (may incur a fee)
await client.unstakeInstant(tokenSymbol, unstakeAmount, poolConfig);

// Request unstake (deferred, no fee)
await client.unstakeRequest(tokenSymbol, unstakeAmount, poolConfig);

// Withdraw after cooldown
await client.withdrawStake(tokenSymbol, poolConfig);

// Collect accumulated staking rewards
await client.collectStakeFees(tokenSymbol, poolConfig);
```

### Token Staking (FLASH Token)

Staking FLASH tokens provides trading fee discounts and referral rebates. 6 stake levels with increasing benefits:

```typescript
// Deposit FLASH tokens
await client.depositTokenStake(depositAmount, poolConfig);

// Collect token rewards
await client.collectTokenReward(poolConfig);

// Collect revenue share
await client.collectRevenue(poolConfig);

// Unstake (instant with fee, or request for deferred)
await client.unstakeTokenInstant(amount, poolConfig);
await client.unstakeTokenRequest(amount, poolConfig);

// Withdraw after cooldown
await client.withdrawToken(withdrawRequestId, poolConfig);
```

---

## View Helpers

Read-only on-chain queries that return pricing and PnL data without modifying state:

```typescript
import { ViewHelper } from "flash-sdk";

const viewHelper = new ViewHelper(connection, provider);

// Entry price and fees for a potential position
const { entryPrice, feeUsd } = await viewHelper.getEntryPriceAndFee(
  targetSymbol, collateralSymbol, collateralAmount, sizeAmount, side, poolConfig
);

// Exit price and fees for closing
const { price, feeUsd } = await viewHelper.getExitPriceAndFee(
  targetSymbol, collateralSymbol, side, poolConfig
);

// Current PnL
const { profit, loss } = await viewHelper.getPnl(
  targetSymbol, collateralSymbol, side, poolConfig
);

// Full position data (collateral, PnL, fees, leverage, liquidation price)
const posData = await viewHelper.getPositionData(
  targetSymbol, collateralSymbol, side, poolConfig
);

// Liquidation price
const liqPrice = await viewHelper.getLiquidationPrice(
  targetSymbol, collateralSymbol, side, poolConfig
);

// Whether position is currently liquidatable
const isLiq = await viewHelper.getLiquidationState(
  targetSymbol, collateralSymbol, side, poolConfig
);

// Oracle price
const oraclePrice = await viewHelper.getOraclePrice(targetSymbol, poolConfig);

// Swap quote
const { amountOut, feeIn, feeOut } = await viewHelper.getSwapAmountAndFees(
  inputSymbol, outputSymbol, amountIn, poolConfig
);

// LP token price
const lpPrice = await viewHelper.getLpTokenPrice(poolConfig);

// Assets under management
const aumUsd = await viewHelper.getAssetsUnderManagement(poolConfig);
```

---

## Degen Mode

Degen Mode allows higher-than-standard leverage on select assets. Eligibility is defined per custody via `PricingParams`:
- `max_init_degen_leverage`: Maximum initial leverage in Degen Mode (up to 500x)
- `min_init_degen_leverage`: Minimum Degen leverage
- `min_degen_collateral_usd`: Minimum collateral for Degen positions
- `max_degen_leverage`: Maximum ongoing leverage in Degen Mode
- `degen_position_factor` / `degen_exposure_factor`: Position and exposure scaling factors

**Key rules:**
- Standard max leverage: typically 100x (`max_init_leverage`)
- Degen max leverage: up to 500x (`max_init_degen_leverage`)
- Degen positions tracked separately via `degenSizeUsd` field on Position
- Pool-level Degen exposure cap: `Market.degen_exposure_usd`
- **ExposureLimitExceeded (6051)**: Degen exposure cap hit for the market
- Not available for limit orders or trigger orders

---

## Compute Budget

Flash Trade transactions require higher compute budgets than simple transfers:

| Operation | Recommended CU |
|-----------|---------------|
| Open/Close Position | 600,000 |
| Increase/Decrease Size | 600,000 |
| Add/Remove Collateral | 400,000 |
| Trigger/Limit Orders | 400,000 |
| Swap-and-Open / Close-and-Swap | 800,000 |
| Add/Remove Liquidity | 400,000 |

**Always set compute budget explicitly:**
```typescript
import { ComputeBudgetProgram } from "@solana/web3.js";
const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
```

---

## Error Handling

Flash Trade defines 69 error codes (6000-6068). The most common ones developers encounter:

```typescript
try {
  const { instructions, additionalSigners } = await client.openPosition(/*...*/);
  const tx = await client.sendTransaction(instructions, additionalSigners);
} catch (err) {
  const msg = err.message || "";

  if (msg.includes("6020")) console.error("MaxPriceSlippage: Price moved beyond slippage tolerance");
  if (msg.includes("6021")) console.error("MaxLeverage: Exceeds custody max_leverage");
  if (msg.includes("6022")) console.error("MaxInitLeverage: Exceeds initial leverage limit");
  if (msg.includes("6023")) console.error("MinLeverage: Below minimum leverage");
  if (msg.includes("6024")) console.error("CustodyAmountLimit: Pool capacity reached");
  if (msg.includes("6025")) console.error("PositionAmountLimit: Position size limit exceeded");
  if (msg.includes("6032")) console.error("MaxUtilization: Pool utilization too high");
  if (msg.includes("6033")) console.error("CloseOnlyMode: Market in close-only mode");
  if (msg.includes("6034")) console.error("MinCollateral: Below minimum collateral");
  if (msg.includes("6007")) console.error("StaleOraclePrice: Oracle price too old, retry");
  if (msg.includes("6031")) console.error("InstructionNotAllowed: Trading paused by protocol");
  if (msg.includes("6051")) console.error("ExposureLimitExceeded: Degen exposure cap hit");

  throw err;
}
```

See [docs/troubleshooting.md](docs/troubleshooting.md) for the complete 69-error reference with solutions.

---

## Production Hardening

1. **Always load ALTs** -- `client.loadAddressLookupTable(poolConfig)` before any operation
2. **Set priority fees** -- `client.setPrioritizationFee(fee)` in microLamports
3. **Validate oracle freshness** -- stale prices cause `StaleOraclePrice` (6007); retry with backoff
4. **Use slippage protection** -- set `priceWithSlippage` conservatively (1-3% from oracle for market orders)
5. **Monitor pool utilization** -- high utilization = higher borrow rates + potential `MaxUtilization` (6032) rejections
6. **Handle keeper latency** -- trigger/limit orders execute asynchronously; position state may lag
7. **Check pool permissions** -- some pools disable trading during maintenance (`InstructionNotAllowed` 6031)
8. **Check market permissions** -- markets have individual `MarketPermissions` (open, close, collateral withdrawal, size change)
9. **Compute budget** -- always set CU limit explicitly (see table above)
10. **Versioned transactions** -- Flash Trade requires V0 transactions with address lookup tables
11. **Use `PoolConfig` for pool discovery** -- never hardcode pool addresses; they can change
12. **Degen Mode guard** -- check `PricingParams` before attempting >100x leverage

---

## Referrals

Create a referral to earn rebates on referred users' trading fees:

```typescript
await client.createReferral(poolConfig);
```

Collect accumulated rebates:

```typescript
await client.collectRebate(poolConfig);
```

---

## Resources

- [Flash Trade App](https://flash.trade)
- [Flash Trade Documentation](https://docs.flash.trade)
- [flash-sdk npm Package](https://www.npmjs.com/package/flash-sdk)
- [Flash Trade TypeScript SDK (GitHub)](https://github.com/flash-trade/flash-trade-sdk)
- [Flash Trade Rust SDK (GitHub)](https://github.com/flash-trade/flash-sdk-rust)
- [Flash Trade Perpetuals Reference (GitHub)](https://github.com/flash-trade/flash-perpetuals)
- [Flash Trade Builder API (GitHub)](https://github.com/flash-trade/flash-builder-api)
- [Flash Trade SDK Docs (autogenerated)](https://flash-trade.github.io/flash-sdk-docs/)
- [Flash Trade Audit Reports (Halborn, Offside Labs)](https://github.com/flash-trade/Audits)

---

## Skill Structure

```
flash-trade/
├── SKILL.md                              # This file -- main reference
├── docs/
│   ├── pools-and-markets.md              # Pool architecture, custody config, virtual tokens
│   └── troubleshooting.md                # All 69 error codes with solutions
├── resources/
│   ├── sdk-reference.md                  # PerpetualsClient method reference (108 instructions)
│   ├── account-types.md                  # 15 on-chain account structures from IDL
│   ├── constants.md                      # Program IDs, precision values, fee parameters
│   └── instruction-reference.md          # Complete instruction catalog with params
├── examples/
│   ├── basic-setup/README.md             # Client initialization and pool config
│   ├── positions/README.md               # Open/close/increase/decrease positions
│   ├── collateral/README.md              # Add/remove collateral
│   ├── orders/README.md                  # Trigger orders and limit orders
│   └── liquidity/README.md              # LP deposit/withdraw/stake
└── templates/
    └── flash-trade-bot.ts                # Production perpetual trading bot template
```
