# Liquidity Provision

## Add Liquidity and Stake

```typescript
import { PerpetualsClient, PoolConfig, Privilege } from "flash-sdk";
import { BN } from "@coral-xyz/anchor";

// Deposit 1000 USDC and auto-stake the LP tokens
const { instructions, additionalSigners } = await client.addLiquidityAndStake(
  "USDC",
  new BN(1_000_000_000),   // 1000 USDC (6 decimals)
  new BN(990_000_000),     // min 990 LP tokens (1% slippage tolerance)
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Added liquidity and staked:", sig);
```

## Add Compounding Liquidity

Compounding pools auto-reinvest rewards into the LP position.

```typescript
const { instructions, additionalSigners } = await client.addCompoundingLiquidity(
  "USDC",
  new BN(1_000_000_000),
  new BN(990_000_000),
  poolConfig,
  Privilege.None,
);
```

## Remove Liquidity

```typescript
// Withdraw by burning LP tokens
const { instructions, additionalSigners } = await client.removeLiquidity(
  "USDC",                     // receive USDC
  new BN(500_000_000),        // burn 500 LP tokens
  new BN(495_000_000),        // minimum 495 USDC returned (1% slippage)
  poolConfig,
  Privilege.None,
);

const sig = await client.sendTransaction(instructions, additionalSigners);
console.log("Removed liquidity:", sig);
```

## Remove Compounding Liquidity

```typescript
const { instructions, additionalSigners } = await client.removeCompoundingLiquidity(
  "USDC",
  new BN(500_000_000),
  new BN(495_000_000),
  poolConfig,
  Privilege.None,
);
```

## Staking Operations

```typescript
// Deposit LP tokens for staking (if not using addLiquidityAndStake)
const { instructions: stakeIx } = await client.depositStake(
  "USDC",
  new BN(100_000_000),   // stake 100 LP tokens
  poolConfig,
);

// Instant unstake (may incur a fee)
const { instructions: unstakeIx } = await client.unstakeInstant(
  "USDC",
  new BN(100_000_000),   // unstake 100 LP tokens
  poolConfig,
);

// Withdraw after unstaking period
const { instructions: withdrawIx } = await client.withdrawStake("USDC", poolConfig);

// Collect accumulated staking rewards
const { instructions: collectIx } = await client.collectStakeFees("USDC", poolConfig);
```

## Check LP Token Price

```typescript
const lpPrice = await client.getCompoundingLPTokenPrice(poolConfig);
console.log(`LP token price: $${lpPrice.toNumber() / 1_000_000}`);

// Estimate value of LP holdings
const lpTokens = new BN(1_000_000_000); // 1000 LP tokens
const valueUsd = lpTokens.mul(lpPrice).div(new BN(1_000_000));
console.log(`Holdings value: $${valueUsd.toNumber() / 1_000_000}`);
```

## Estimate Fees Before Depositing

```typescript
import { ViewHelper } from "flash-sdk";

const viewHelper = new ViewHelper(connection, provider);

// Check what you'll receive before depositing
const { amount: lpOut, fee } = await viewHelper.getAddLiquidityAmountAndFee(
  "USDC",
  new BN(1_000_000_000), // 1000 USDC
  poolConfig,
);

console.log(`Will receive: ${lpOut.toNumber() / 1_000_000} LP tokens`);
console.log(`Fee: $${fee.toNumber() / 1_000_000}`);

// Check withdrawal estimate
const { amount: usdcOut, fee: withdrawFee } = await viewHelper.getRemoveLiquidityAmountAndFee(
  "USDC",
  new BN(500_000_000), // 500 LP tokens
  poolConfig,
);

console.log(`Will receive: ${usdcOut.toNumber() / 1_000_000} USDC`);
console.log(`Withdrawal fee: $${withdrawFee.toNumber() / 1_000_000}`);
```

## LP Fee Dynamics

LP fees depend on the pool's token ratio balance:

- **Depositing an underweight token** → lower fees (incentivized)
- **Depositing an overweight token** → higher fees (disincentivized)
- **Withdrawing an overweight token** → lower fees
- **Withdrawing an underweight token** → higher fees

This mechanism keeps the pool balanced around its target allocation ratios.
