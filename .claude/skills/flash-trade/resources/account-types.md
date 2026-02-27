# Flash Trade Account Types (from IDL)

15 account types defined in the Flash Trade perpetuals program.

## Position

A leveraged trade owned by a user within a specific market.

**Seeds:** `["position", owner, pool, custody, side_byte]` (side: None=0, Long=1, Short=2)

| Field | Type | Description |
|-------|------|-------------|
| `owner` | PublicKey | Position owner |
| `market` | PublicKey | Market address |
| `delegate` | PublicKey | Delegated signer (if any) |
| `openTime` | i64 | Unix timestamp of position opening |
| `updateTime` | i64 | Last modification timestamp |
| `entryPrice` | OraclePrice | Entry price `{ price: u64, exponent: i32 }` |
| `sizeAmount` | u64 | Position size in target token decimals |
| `sizeUsd` | u64 | Position size in USD (6 decimals) |
| `lockedAmount` | u64 | Locked collateral in token decimals |
| `lockedUsd` | u64 | Locked collateral in USD |
| `priceImpactUsd` | u64 | Price impact at entry (USD) |
| `collateralUsd` | u64 | Current collateral in USD |
| `unsettledValueUsd` | u64 | Unsettled PnL (USD) |
| `unsettledFeesUsd` | u64 | Accumulated unpaid fees (USD) |
| `cumulativeLockFeeSnapshot` | u128 | Borrow fee tracking snapshot |
| `degenSizeUsd` | u64 | Degen Mode portion of size (USD) |
| `referencePrice` | OraclePrice | Reference price for calculations |
| `priceImpactSet` | u8 | Whether price impact has been set |
| `sizeDecimals` | u8 | Decimal places for size |
| `lockedDecimals` | u8 | Decimal places for locked amount |
| `collateralDecimals` | u8 | Decimal places for collateral |
| `bump` | u8 | PDA bump |

## Order

Trigger orders (TP/SL) and limit orders for a specific market.

| Field | Type | Description |
|-------|------|-------------|
| `owner` | PublicKey | Order owner |
| `market` | PublicKey | Market address |
| `limitOrders` | LimitOrder[5] | Up to 5 limit orders |
| `takeProfitOrders` | TriggerOrder[5] | Up to 5 take-profit orders |
| `stopLossOrders` | TriggerOrder[5] | Up to 5 stop-loss orders |
| `isInitialised` | bool | Whether account is initialized |
| `openOrders` | u8 | Count of active limit orders |
| `openSl` | u8 | Count of active stop-loss orders |
| `openTp` | u8 | Count of active take-profit orders |
| `inactiveSl` | u8 | Count of inactive stop-loss orders |
| `inactiveTp` | u8 | Count of inactive take-profit orders |
| `activeOrders` | u8 | Total active orders |
| `bump` | u8 | PDA bump |
| `referenceTimestamp` | i64 | Reference timestamp |
| `executionCount` | u64 | Total executions |

### LimitOrder

| Field | Type | Description |
|-------|------|-------------|
| `limitPrice` | OraclePrice | Trigger price for execution |
| `reserveAmount` | u64 | Collateral reserved (token decimals) |
| `reserveCustodyUid` | u8 | Reserve custody index |
| `receiveCustodyUid` | u8 | Receive custody index |
| `sizeAmount` | u64 | Position size when executed |
| `stopLossPrice` | OraclePrice | Attached SL price (optional) |
| `takeProfitPrice` | OraclePrice | Attached TP price (optional) |

### TriggerOrder

| Field | Type | Description |
|-------|------|-------------|
| `triggerPrice` | OraclePrice | Price at which to execute |
| `triggerSize` | u64 | Size to close (target token decimals) |
| `receiveCustodyUid` | u8 | Receive custody index |

## Pool

Container for custodies and markets with LP configuration.

**Seeds:** `["pool", pool_name.as_bytes()]`

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Pool name (e.g., "Crypto.1") |
| `permissions` | Permissions | 13-flag permission struct |
| `inceptionTime` | i64 | Pool creation timestamp |
| `lpMint` | PublicKey | FLP token mint |
| `oracleAuthority` | PublicKey | Internal oracle price setter |
| `stakedLpVault` | PublicKey | Vault holding staked FLP |
| `rewardCustody` | PublicKey | Custody for reward distribution |
| `custodies` | PublicKey[] | Registered custody addresses |
| `ratios` | TokenRatios[] | Target/min/max allocation per custody |
| `markets` | PublicKey[] | Registered market addresses |
| `maxAumUsd` | u64 | AUM cap |
| `rawAumUsd` | u64 | Current raw AUM |
| `equityUsd` | u64 | Pool equity |
| `totalStaked` | StakeStats | Staking statistics |
| `stakingFeeShareBps` | u64 | Share of fees to stakers |
| `vpVolumeFactor` | u8 | Voltage program volume factor |
| `uniqueCustodyCount` | u8 | Number of unique custodies |
| `stakingFeeBoostBps` | u64[6] | Fee boost per stake level |
| `compoundingMint` | PublicKey | Compounding LP token mint |
| `compoundingStats` | CompoundingStats | Compounding pool stats |
| `lpPrice` | u64 | Current FLP price (USD, 6 decimals) |
| `compoundingLpPrice` | u64 | Compounding FLP price |
| `lastUpdatedTimestamp` | i64 | Last price update |
| `feesObligationUsd` | u64 | Outstanding fee obligations |
| `rebateObligationUsd` | u64 | Outstanding rebate obligations |
| `thresholdUsd` | u64 | Fee threshold |

## Custody

Per-token configuration within a pool.

**Seeds:** `["custody", pool_key, custody_mint]`

| Field | Type | Description |
|-------|------|-------------|
| `pool` | PublicKey | Parent pool |
| `mint` | PublicKey | Token mint |
| `tokenAccount` | PublicKey | Token account holding custody funds |
| `decimals` | u8 | Token decimal places |
| `isStable` | bool | Whether this is a stablecoin |
| `depegAdjustment` | bool | Depeg pricing adjustment |
| `isVirtual` | bool | Virtual token (no actual custody) |
| `inversePrice` | bool | Inverse oracle price (e.g., USDJPY) |
| `oracle` | OracleParams | Oracle configuration |
| `pricing` | PricingParams | Leverage/spread/utilization limits |
| `permissions` | Permissions | Per-custody operation flags |
| `fees` | Fees | Fee configuration |
| `borrowRate` | BorrowRateParams | Borrow rate curve params |
| `rewardThreshold` | u64 | Reward distribution threshold |
| `assets` | Assets | Token balances (collateral, owned, locked) |
| `feesStats` | FeesStats | Fee accrual/distribution stats |
| `borrowRateState` | BorrowRateState | Current rate + cumulative lock fee |
| `uid` | u8 | Unique custody identifier within pool |
| `reservedAmount` | u64 | Reserved for limit orders |
| `minReserveUsd` | u64 | Minimum custody reserve |
| `limitPriceBufferBps` | u64 | Limit order price buffer |
| `token22` | bool | Whether this is a Token-2022 mint |

## Market

Defines a tradable pair within a pool.

| Field | Type | Description |
|-------|------|-------------|
| `pool` | PublicKey | Parent pool |
| `targetCustody` | PublicKey | Target asset custody |
| `collateralCustody` | PublicKey | Collateral custody |
| `side` | Side | Long or Short |
| `correlation` | bool | Price correlation with collateral |
| `maxPayoffBps` | u64 | Max profit multiplier (BPS) |
| `permissions` | MarketPermissions | Open/close/collateral/size permissions |
| `degenExposureUsd` | u64 | Degen Mode exposure cap |
| `collectivePosition` | PositionStats | Aggregate position statistics |
| `targetCustodyUid` | u8 | Target custody array index |
| `collateralCustodyUid` | u8 | Collateral custody array index |

## Perpetuals (Global State)

**Seeds:** `["perpetuals"]`

| Field | Type | Description |
|-------|------|-------------|
| `permissions` | Permissions | Global permission flags (13 bools) |
| `pools` | PublicKey[] | Registered pool addresses |
| `collections` | PublicKey[] | NFT collections for gated trading |
| `voltageMultiplier` | VoltageMultiplier | Volume/rewards/rebates multipliers |
| `tradingDiscount` | u64[6] | Discount per stake level |
| `referralRebate` | u64[6] | Rebate per stake level |
| `defaultRebate` | u64 | Default referral rebate |
| `inceptionTime` | i64 | Program inception timestamp |
| `transferAuthorityBump` | u8 | Transfer authority PDA bump |
| `perpetualsBump` | u8 | Global state PDA bump |
| `tradeLimit` | u8 | Trade rate limit |
| `triggerOrderLimit` | u8 | Trigger order rate limit |
| `rebateLimitUsd` | u32 | Rebate payout limit (USD) |

## Multisig

Admin multisig account (zero-copy, `repr(C, packed)`).

**Seeds:** `["multisig"]`

| Field | Type | Description |
|-------|------|-------------|
| `numSigners` | u8 | Total signers configured |
| `numSigned` | u8 | Current signatures collected |
| `minSignatures` | u8 | Required signatures for execution |
| `instructionAccountsLen` | u8 | Pending instruction accounts count |
| `instructionDataLen` | u16 | Pending instruction data length |
| `instructionHash` | u64 | Hash of pending instruction |
| `signers` | PublicKey[6] | Signer addresses (MAX_SIGNERS=6) |
| `signed` | u8[6] | Signature status per signer |
| `bump` | u8 | PDA bump |

## Other Accounts

### FlpStake (LP Staking)
Tracks a user's staked FLP tokens and reward entitlements for a specific pool.

### TokenStake (FLASH Token Staking)
Tracks a user's staked FLASH tokens, stake level, withdraw requests, trade history, and revenue/reward entitlements.

### TokenVault
Configuration for the FLASH token staking vault (permissions, withdraw limits, stake levels, reward distribution).

### CustomOracle
Internal oracle price data (price, exponent, confidence, EMA, Pyth Lazer feed).

### ProtocolVault
Protocol fee collection vault with fee share configuration.

### RebateVault
Rebate reserves for referral payouts.

### Referral
Links a user to their referrer's stake account for rebate tracking.

### Whitelist
Fee exemptions for specific addresses on specific pools.

## Shared Types

### OraclePrice
```typescript
{ price: u64, exponent: i32 }
// Example: { price: 150_000_000, exponent: -6 } = $150.00
```

### Assets
```typescript
{ collateral: u64, owned: u64, locked: u64 }
```

### PositionStats
```typescript
{
  openPositions: u64, updateTime: i64,
  averageEntryPrice: OraclePrice,
  sizeAmount: u64, sizeUsd: u64,
  lockedAmount: u64, lockedUsd: u64,
  collateralAmount: u64, collateralLiabilityUsd: u64,
  unsettledFeeUsd: u64, cumulativeLockFeeSnapshot: u128,
  sizeDecimals: u8, lockedDecimals: u8, collateralDecimals: u8,
}
```

### StakeStats
```typescript
{ pendingActivation: u64, activeAmount: u64, pendingDeactivation: u64, deactivatedAmount: u64 }
```

### CompoundingStats
```typescript
{ activeAmount: u64, totalSupply: u64, rewardSnapshot: u128, feeShareBps: u64, lastCompoundTime: i64 }
```
