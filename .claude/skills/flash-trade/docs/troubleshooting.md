# Flash Trade Error Reference & Troubleshooting

## Complete Error Codes (6000-6068)

All 69 error codes from the Flash Trade perpetuals program IDL.

### Multisig Errors (6000-6002)

| Code | Name | Message | Notes |
|------|------|---------|-------|
| 6000 | MultisigAccountNotAuthorized | Account is not authorized to sign this instruction | Admin-only: not relevant to traders |
| 6001 | MultisigAlreadySigned | Account has already signed this instruction | Admin-only |
| 6002 | MultisigAlreadyExecuted | This instruction has already been executed | Admin-only |

### Arithmetic (6003)

| Code | Name | Message | Solution |
|------|------|---------|----------|
| 6003 | MathOverflow | Overflow in arithmetic operation | Reduce position size. Rare -- usually caused by extreme sizes or prices. |

### Oracle Errors (6004-6008)

| Code | Name | Message | Solution |
|------|------|---------|----------|
| 6004 | UnsupportedOracle | Unsupported price oracle | Internal: custody oracle misconfigured |
| 6005 | InvalidOracleAccount | Invalid oracle account | Wrong oracle account passed. Ensure `PoolConfig` is up to date. |
| 6006 | InvalidOracleState | Invalid oracle state | Oracle feed offline or corrupted. Wait and retry. |
| 6007 | StaleOraclePrice | Stale oracle price | Oracle price too old (`max_price_age_sec` exceeded). Retry after a few slots. If persistent, check [Pyth status](https://status.pyth.network/). |
| 6008 | InvalidOraclePrice | Invalid oracle price | Oracle returned 0 or negative confidence. Wait and retry. |

### State Validation (6009-6018)

| Code | Name | Message | Solution |
|------|------|---------|----------|
| 6009 | InvalidEnvironment | Instruction is not allowed in production | Test-only instruction called on mainnet. |
| 6010 | InvalidPoolState | Invalid pool state | Pool account corrupted or uninitialized. Verify pool address via `PoolConfig`. |
| 6011 | InvalidCustodyState | Invalid custody state | Custody account issue. Re-fetch `PoolConfig`. |
| 6012 | InvalidMarketState | Invalid Market state | Market account issue. Verify market exists for this pool/side combo. |
| 6013 | InvalidCollateralCustody | Invalid collateral custody | Wrong collateral token for this market. Check `poolConfig.markets`. |
| 6014 | InvalidPositionState | Invalid position state | Position doesn't exist or is already closed. Verify position PDA. |
| 6015 | InvalidDispensingCustody | Invalid Dispensing Custody | Internal custody routing error. |
| 6016 | InvalidPerpetualsConfig | Invalid perpetuals config | Global config issue. |
| 6017 | InvalidPoolConfig | Invalid pool config | Pool parameters invalid. |
| 6018 | InvalidCustodyConfig | Invalid custody config | Custody parameters invalid. |

### Trading Errors (6019-6034)

These are the errors you'll encounter most often when building trading integrations.

| Code | Name | Message | Solution |
|------|------|---------|----------|
| 6019 | InsufficientAmountReturned | Insufficient token amount returned | Swap output below minimum. Increase slippage tolerance on the swap portion. |
| **6020** | **MaxPriceSlippage** | Price slippage limit exceeded | **Most common.** Oracle price moved beyond `priceWithSlippage`. Widen tolerance (1-3% from oracle) or retry with fresh price. |
| **6021** | **MaxLeverage** | Position leverage limit exceeded | Post-modification leverage exceeds `max_leverage`. Reduce size or add collateral first. |
| **6022** | **MaxInitLeverage** | Position initial leverage limit exceeded | New position leverage exceeds `max_init_leverage`. Reduce size or increase collateral. |
| 6023 | MinLeverage | Position leverage less than minimum | Leverage below `min_init_leverage`. Increase size or reduce collateral. |
| **6024** | **CustodyAmountLimit** | Custody amount limit exceeded | Pool capacity reached for this token (`max_total_locked_usd`). Try smaller position or wait. |
| 6025 | PositionAmountLimit | Position amount limit exceeded | Single position exceeds `max_position_size_usd`. Split into smaller positions. |
| 6026 | TokenRatioOutOfRange | Token ratio out of range | LP operation would push allocation outside min/max ratios. Deposit an underweight token instead. |
| 6027 | UnsupportedToken | Token is not supported | Token mint not recognized by this pool's custodies. |
| 6028 | UnsupportedCustody | Custody is not supported | Custody not found in pool. |
| 6029 | UnsupportedPool | Pool is not supported | Pool address invalid. |
| 6030 | UnsupportedMarket | Market is not supported | Market doesn't exist for this target/collateral/side combo. |
| **6031** | **InstructionNotAllowed** | Instruction is not allowed at this time | Trading paused by protocol (maintenance, circuit breaker). Check pool or global `Permissions`. Wait and retry. |
| **6032** | **MaxUtilization** | Token utilization limit exceeded | Pool utilization at capacity. Try smaller position or wait for utilization to drop. |
| **6033** | **CloseOnlyMode** | Close-only mode activated | Market in close-only mode. Only `closePosition` and `decreaseSize` are allowed. |
| **6034** | **MinCollateral** | Minimum collateral limit breached | Below `min_collateral_usd` (or `min_degen_collateral_usd` for Degen Mode). Increase collateral. |

### Oracle Authority (6035-6038)

| Code | Name | Message | Notes |
|------|------|---------|-------|
| 6035 | PermissionlessOracleMissingSignature | Must be preceded by Ed25519 signature verification | Keeper/oracle authority error. Not relevant to traders. |
| 6036 | PermissionlessOracleMalformedEd25519Data | Ed25519 data does not match expected format | Internal oracle error. |
| 6037 | PermissionlessOracleSignerMismatch | Not signed by the oracle authority | Internal oracle error. |
| 6038 | PermissionlessOracleMessageMismatch | Signed message does not match instruction params | Internal oracle error. |

### Protocol Errors (6039-6048)

| Code | Name | Message | Solution |
|------|------|---------|----------|
| 6039 | ExponentMismatch | Exponent Mismatch between operands | Internal price calculation error. |
| 6040 | CloseRatio | Invalid Close Ratio | Position close amount invalid relative to current size. |
| 6041 | InsufficientStakeAmount | Insufficient LP tokens staked | Trying to unstake more than staked balance. Check `FlpStake.stake_stats`. |
| 6042 | InvalidFeeDeltas | Invalid Fee Deltas | Internal fee calculation error. |
| 6043 | InvalidFeeDistributionCustody | Invalid Fee Distribution Custody | Internal custody routing. |
| 6044 | InvalidCollection | Invalid Collection | NFT collection not recognized for gated trading. |
| 6045 | InvalidOwner | Owner of Token Account does not match | Wrong token account owner. Ensure ATA is derived correctly. |
| 6046 | InvalidAccess | Only NFT holders or referred users can trade | Pool requires NFT or referral for access. Create a referral first or hold the required NFT. |
| 6047 | TokenStakeAccountMismatch | Token Stake account does not match referral account | Referral account linked to wrong stake account. |
| 6048 | MaxDepositsReached | Max deposits reached | Token vault deposit limit hit. |

### Order Errors (6049-6056)

| Code | Name | Message | Solution |
|------|------|---------|----------|
| **6049** | **InvalidStopLossPrice** | Invalid Stop Loss price | SL price doesn't make sense for position direction (e.g., SL above entry for a long). |
| **6050** | **InvalidTakeProfitPrice** | Invalid Take Profit price | TP price doesn't make sense for position direction (e.g., TP below entry for a long). |
| **6051** | **ExposureLimitExceeded** | Max exposure limit exceeded for the market | Degen Mode exposure cap hit (`Market.degen_exposure_usd`). Reduce size or wait. |
| **6052** | **MaxStopLossOrders** | Stop Loss limit exhausted | Max 5 SL orders per market. Cancel an existing one first. |
| **6053** | **MaxTakeProfitOrders** | Take Profit limit exhausted | Max 5 TP orders per market. Cancel an existing one first. |
| **6054** | **MaxOpenOrder** | Open order limit exhausted | Max 5 limit orders per market. Cancel an existing one first. |
| 6055 | InvalidOrder | Invalid Order | Order doesn't exist at the specified `orderId` index. |
| 6056 | InvalidLimitPrice | Invalid Limit price | Limit price invalid for the position direction. |

### Reserve / Withdrawal (6057-6058)

| Code | Name | Message | Solution |
|------|------|---------|----------|
| 6057 | MinReserve | Minimum reserve limit breached | Custody `min_reserve_usd` threshold. Pool must maintain minimum reserves. |
| 6058 | MaxWithdrawTokenRequest | Withdraw Token Request limit exhausted | Max 5 pending withdraw requests per `TokenStake` account. Wait for existing ones to complete. |

### Reward / LP Errors (6059-6062)

| Code | Name | Message | Solution |
|------|------|---------|----------|
| 6059 | InvalidRewardDistribution | Invalid Reward Distribution | Admin reward distribution error. |
| 6060 | LpPriceOutOfBounds | Liquidity Token price is out of bounds | FLP price outside `min_lp_price_usd` / `max_lp_price_usd`. Pool safety mechanism. |
| 6061 | InsufficientRebateReserves | Insufficient rebate reserves | Rebate vault doesn't have enough to pay out. |
| 6062 | OraclePenaltyAlreadySet | Oracle penalty already set on this position | Position already has a price impact penalty applied. |

### Pyth Lazer Errors (6063-6066)

| Code | Name | Message | Notes |
|------|------|---------|-------|
| 6063 | InvalidLazerMessage | Invalid Lazer message | Pyth Lazer oracle message format error. |
| 6064 | InvalidLazerPayload | Invalid Lazer payload | Pyth Lazer payload parsing failure. |
| 6065 | InvalidLazerChannel | Invalid Lazer channel | Wrong Lazer channel for this custody. |
| 6066 | InvalidLazerTimestamp | Invalid Lazer timestamp | Lazer message too old or in the future. |

### Withdrawal Errors (6067-6068)

| Code | Name | Message | Solution |
|------|------|---------|----------|
| 6067 | InvalidWithdrawal | Invalid amount for withdrawal | Withdrawal amount invalid (0 or exceeds balance). |
| 6068 | InvalidWithdrawRequestId | Invalid withdraw request ID | Withdraw request index doesn't exist (0-4). |

---

## Common Issues & Solutions

### Transactions Failing with "Transaction too large"

Flash Trade transactions with ALTs are already near the size limit.

**Solution:** Ensure ALTs are loaded and use V0 transactions:
```typescript
await client.loadAddressLookupTable(poolConfig);
// Use VersionedTransaction, not legacy Transaction
```

### "Account not found" on Position Operations

**Cause:** Position PDA doesn't exist (never opened, or already closed by keeper).

**Diagnosis:**
```typescript
const [positionPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("position"),
    ownerPubkey.toBuffer(),
    poolPubkey.toBuffer(),
    custodyPubkey.toBuffer(),
    Buffer.from([side === Side.Long ? 1 : 2]),
  ],
  new PublicKey(poolConfig.programId),
);
const info = await connection.getAccountInfo(positionPda);
if (!info) console.log("Position does not exist");
```

### Pool Config Not Found

**Cause:** Wrong pool name or cluster string.

```typescript
// Correct
PoolConfig.fromIdsByName("Crypto.1", "mainnet-beta");

// Wrong
PoolConfig.fromIdsByName("crypto.1", "mainnet-beta");  // lowercase
PoolConfig.fromIdsByName("Crypto", "mainnet-beta");    // missing .1
PoolConfig.fromIdsByName("Crypto.1", "mainnet");       // wrong cluster string
```

### Trigger Orders Not Executing

Trigger orders are executed by off-chain keepers. If they're not executing:
1. Verify the oracle price has actually crossed the trigger level
2. Check that the position still exists (not already liquidated)
3. Keepers may have latency during high-volatility periods
4. Check Flash Trade status channels for keeper outages

### Oracle Price Mismatch Between UI and On-Chain

Flash Trade uses two oracle layers: Pyth primary + internal backup oracle. The on-chain price may differ from external feeds due to:
- Pyth confidence interval adjustments (`max_conf_bps`)
- EMA vs spot price (`PricingParams.use_ema` -- not present in latest IDL, check custody config)
- Trade spread (`trade_spread_min` / `trade_spread_max`) applied to entry/exit prices
- Price impact (`price_impact_usd`) on positions
