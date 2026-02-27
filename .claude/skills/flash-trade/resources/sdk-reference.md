# Flash Trade SDK Reference

## Installation

```bash
npm install flash-sdk
# or
yarn add flash-sdk
```

**Package:** [flash-sdk on npm](https://www.npmjs.com/package/flash-sdk)
**Docs:** [flash-trade.github.io/flash-sdk-docs](https://flash-trade.github.io/flash-sdk-docs/)

## PerpetualsClient

The main client class for constructing Flash Trade instructions. All trading methods return `{ instructions: TransactionInstruction[], additionalSigners: Signer[] }`.

### Constructor & Setup

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `provider, programId, perpComposibilityProgramId, fbNftRewardProgramId, rewardDistributionProgramId, opts?` | `PerpetualsClient` | Create client instance |
| `loadAddressLookupTable` | `poolConfig` | `Promise<void>` | **Must call before any operation.** Load ALTs for versioned transactions. |
| `setPrioritizationFee` | `fee: number` | `void` | Set priority fee in microLamports |
| `sendTransaction` | `instructions, additionalSigners` | `Promise<string>` | Build and send versioned transaction |
| `sendTransactionV3` | `instructions, additionalSigners, opts?` | `Promise<string>` | V3 transaction sending with options |

### Position Management

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `openPosition` | `targetSymbol, collateralSymbol, priceWithSlippage, collateralAmount, sizeAmount, side, poolConfig, privilege` | `FlashTradeResult` | Open new leveraged position |
| `closePosition` | `targetSymbol, collateralSymbol, priceWithSlippage, side, poolConfig, privilege` | `FlashTradeResult` | Close entire position |
| `increaseSize` | `targetSymbol, collateralSymbol, priceWithSlippage, sizeDelta, side, poolConfig, privilege` | `FlashTradeResult` | Add to existing position size |
| `decreaseSize` | `targetSymbol, collateralSymbol, priceWithSlippage, sizeDelta, side, poolConfig, privilege` | `FlashTradeResult` | Reduce existing position size |

### Collateral

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `addCollateral` | `targetSymbol, collateralSymbol, collateralDelta, side, poolConfig, privilege` | `FlashTradeResult` | Deposit collateral (token decimals) |
| `removeCollateral` | `targetSymbol, collateralSymbol, collateralDeltaUsd, side, poolConfig, privilege` | `FlashTradeResult` | Withdraw collateral (USD, 6 decimals) |

### Composability (Atomic Swap+Trade)

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `swapAndOpenPosition` | `inputSymbol, targetSymbol, collateralSymbol, price, inputAmount, sizeAmount, side, poolConfig, privilege` | `FlashTradeResult` | Swap then open position |
| `closeAndSwapPosition` | `targetSymbol, collateralSymbol, outputSymbol, price, side, poolConfig, privilege` | `FlashTradeResult` | Close then swap out |
| `swapAndAddCollateral` | `inputSymbol, targetSymbol, collateralSymbol, amountIn, side, poolConfig, privilege` | `FlashTradeResult` | Swap then add collateral |
| `removeCollateralAndSwap` | `targetSymbol, collateralSymbol, outputSymbol, collateralDeltaUsd, side, poolConfig, privilege` | `FlashTradeResult` | Remove collateral then swap |

### Trigger Orders

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `placeTriggerOrder` | `targetSymbol, collateralSymbol, side, params, poolConfig, privilege` | `FlashTradeResult` | Place TP/SL trigger order |
| `editTriggerOrder` | `targetSymbol, collateralSymbol, side, params, poolConfig, privilege` | `FlashTradeResult` | Modify existing trigger order |
| `cancelTriggerOrder` | `targetSymbol, collateralSymbol, side, params, poolConfig, privilege` | `FlashTradeResult` | Cancel trigger order |

### Limit Orders

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `placeLimitOrder` | `targetSymbol, collateralSymbol, side, params, poolConfig, privilege` | `FlashTradeResult` | Place limit entry order with optional SL/TP |
| `editLimitOrder` | `targetSymbol, collateralSymbol, side, params, poolConfig, privilege` | `FlashTradeResult` | Modify limit order (size=0 to cancel) |

### Swaps

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `swap` | `inputSymbol, outputSymbol, amountIn, minAmountOut, poolConfig` | `FlashTradeResult` | Swap tokens within a pool |

### Liquidity

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `addLiquidityAndStake` | `tokenSymbol, amountIn, minLpOut, poolConfig, privilege` | `FlashTradeResult` | Deposit + auto-stake FLP |
| `addLiquidity` | `tokenSymbol, amountIn, minLpOut, poolConfig, privilege` | `FlashTradeResult` | Deposit without staking |
| `removeLiquidity` | `tokenSymbol, lpAmountIn, minAmountOut, poolConfig, privilege` | `FlashTradeResult` | Withdraw + burn FLP |
| `addCompoundingLiquidity` | `tokenSymbol, amountIn, minCompoundingOut, poolConfig, privilege` | `FlashTradeResult` | Deposit to compounding pool |
| `removeCompoundingLiquidity` | `tokenSymbol, compoundingAmountIn, minAmountOut, poolConfig, privilege` | `FlashTradeResult` | Withdraw from compounding pool |

### FLP Staking

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `depositStake` | `tokenSymbol, depositAmount, poolConfig` | `FlashTradeResult` | Stake FLP tokens |
| `unstakeInstant` | `tokenSymbol, unstakeAmount, poolConfig` | `FlashTradeResult` | Instant unstake (fee) |
| `unstakeRequest` | `tokenSymbol, unstakeAmount, poolConfig` | `FlashTradeResult` | Deferred unstake (no fee) |
| `withdrawStake` | `tokenSymbol, poolConfig` | `FlashTradeResult` | Withdraw unstaked FLP |
| `collectStakeFees` | `tokenSymbol, poolConfig` | `FlashTradeResult` | Collect staking rewards |

### Token Staking (FLASH)

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `depositTokenStake` | `depositAmount, poolConfig` | `FlashTradeResult` | Stake FLASH tokens |
| `unstakeTokenInstant` | `amount, poolConfig` | `FlashTradeResult` | Instant unstake FLASH |
| `unstakeTokenRequest` | `amount, poolConfig` | `FlashTradeResult` | Request deferred unstake |
| `cancelUnstakeTokenRequest` | `withdrawRequestId, poolConfig` | `FlashTradeResult` | Cancel pending unstake |
| `withdrawToken` | `withdrawRequestId, poolConfig` | `FlashTradeResult` | Withdraw unstaked FLASH |
| `collectTokenReward` | `poolConfig` | `FlashTradeResult` | Collect FLASH rewards |
| `collectRevenue` | `poolConfig` | `FlashTradeResult` | Collect revenue share |
| `collectRebate` | `poolConfig` | `FlashTradeResult` | Collect referral rebates |

### Referrals

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `createReferral` | `poolConfig` | `FlashTradeResult` | Create referral account |

### Utility

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `getCompoundingLPTokenPrice` | `poolConfig` | `Promise<BN>` | LP token price in USD (6 decimals) |

## PoolConfig

Static configuration loader for pool data. **This is the canonical source of truth for pool addresses, custodies, and markets.**

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `fromIdsByName` | `poolName: string, cluster: string` | `PoolConfig` | Load pool config by name |

### PoolConfig Properties

| Property | Type | Description |
|----------|------|-------------|
| `programId` | `string` | Perpetuals program address |
| `perpComposibilityProgramId` | `string` | Composability program address |
| `fbNftRewardProgramId` | `string` | NFT reward program address |
| `rewardDistributionProgram` | `{ programId: string }` | Reward distribution program |
| `poolAddress` | `string` | Pool PDA address |
| `custodies` | `CustodyConfig[]` | Custody configurations |
| `markets` | `MarketConfig[]` | Market configurations |

## ViewHelper

Read-only on-chain queries.

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `getEntryPriceAndFee` | `targetSymbol, collateralSymbol, collateralAmount, sizeAmount, side, poolConfig` | `{ entryPrice, feeUsd }` | Estimated entry price and fees |
| `getExitPriceAndFee` | `targetSymbol, collateralSymbol, side, poolConfig` | `{ price, feeUsd }` | Estimated exit price and fees |
| `getPnl` | `targetSymbol, collateralSymbol, side, poolConfig` | `{ profit, loss }` | Current unrealized PnL |
| `getPositionData` | `targetSymbol, collateralSymbol, side, poolConfig` | `PositionData` | Full position summary (PnL, leverage, liq price) |
| `getLiquidationPrice` | `targetSymbol, collateralSymbol, side, poolConfig` | `OraclePrice` | Liquidation trigger price |
| `getLiquidationState` | `targetSymbol, collateralSymbol, side, poolConfig` | `boolean` | Whether position is liquidatable |
| `getOraclePrice` | `targetSymbol, poolConfig` | `OraclePrice` | Current oracle price |
| `getLpTokenPrice` | `poolConfig` | `BN` | FLP token USD price |
| `getAssetsUnderManagement` | `poolConfig` | `BN` | Pool AUM in USD |
| `getAddLiquidityAmountAndFee` | `tokenSymbol, amountIn, poolConfig` | `{ amount, fee }` | FLP tokens for deposit |
| `getRemoveLiquidityAmountAndFee` | `tokenSymbol, lpAmountIn, poolConfig` | `{ amount, fee }` | Tokens for FLP withdrawal |
| `getSwapAmountAndFees` | `inputSymbol, outputSymbol, amountIn, poolConfig` | `{ amountOut, feeIn, feeOut }` | Swap output estimate |

## Types & Enums

```typescript
// Side
enum Side { None, Long, Short }
// In instruction params: Side.Long or Side.Short

// Privilege
enum Privilege { None, Stake, Referral }

// OraclePrice
interface OraclePrice {
  price: BN;       // price value
  exponent: number; // negative exponent (e.g., -6 means divide by 10^6)
}

// FlashTradeResult (return type for all client methods)
interface FlashTradeResult {
  instructions: TransactionInstruction[];
  additionalSigners: Signer[];
}

// PositionData (from ViewHelper.getPositionData)
interface PositionData {
  collateralUsd: BN;
  profitUsd: BN;
  lossUsd: BN;
  feeUsd: BN;
  leverage: BN;
  liquidationPrice: OraclePrice;
}
```

## Additional Classes

| Class | Purpose |
|-------|---------|
| `PoolAccount` | Pool state with LP calculations |
| `PoolDataClient` | On-chain data reader for pool statistics |
| `PositionAccount` | Position state reader |
| `CustodyAccount` | Custody state reader |
| `MarketAccount` | Market configuration reader |
| `OrderAccount` | Order state reader |
| `OraclePrice` | Oracle price handling and conversion |
| `TokenStakeAccount` | FLASH token staking state |
| `TokenVaultAccount` | Token vault state |
