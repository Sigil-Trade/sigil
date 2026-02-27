# Flash Trade Constants

## Program IDs

### Mainnet

| Program | Address | Purpose |
|---------|---------|---------|
| Perpetuals | `FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn` | Main trading program |
| Composability | `FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm` | Swap-and-trade atomic operations |
| FB NFT Reward | `FBRWDXSLysNbFQk64MQJcpkXP8e4fjezsGabV8jV7d7o` | NFT reward distribution |
| Reward Distribution | `FARNT7LL119pmy9vSkN9q1ApZESPaKHuuX5Acz1oBoME` | Token reward distribution |
| Pyth Lazer | `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt` | Fast oracle updates |

### Devnet

| Program | Address |
|---------|---------|
| Perpetuals | `FTPP4jEWW1n8s2FEccwVfS9KCPjpndaswg7Nkkuz4ER4` |
| Composability | `SWAP4AE4N1if9qKD7dgfQgmRBRv1CtWG8xDs4HP14ST` |

Use `PoolConfig.fromIdsByName(poolName, cluster)` to get the correct program IDs for your target network. Never hardcode program addresses.

## Precision Constants

| Constant | Value | Decimal Places | Purpose |
|----------|-------|----------------|---------|
| `BPS_DECIMALS` | 4 | 10^4 = 10,000 | Basis points denominator |
| `BPS_POWER` | 10,000 | — | 1 BPS = 0.01% |
| `PRICE_DECIMALS` | 6 | 10^6 = 1,000,000 | Oracle price precision |
| `USD_DECIMALS` | 6 | 10^6 = 1,000,000 | USD value precision ($1 = 1,000,000) |
| `LP_DECIMALS` | 6 | 10^6 = 1,000,000 | FLP token precision |
| `RATE_DECIMALS` | 9 | 10^9 = 1,000,000,000 | Borrow rate precision |
| `RATE_POWER` | 1,000,000,000 | — | Rate denominator |
| `ORACLE_EXPONENT` | 9 | — | Small-price token oracle exponent |
| `FAF_DECIMALS` | 6 | — | FLASH governance token decimals |
| `PERCENTAGE_DECIMALS` | 4 | — | Percentage decimals |
| `MAX_SIGNERS` | 6 | — | Maximum multisig signers |

## Token Decimals

Common tokens and their decimal places (verify via `PoolConfig` for the latest):

| Token | Decimals | Notes |
|-------|----------|-------|
| USDC | 6 | Primary collateral for most pools |
| SOL | 9 | Native SOL |
| BTC (wrapped) | 8 | Varies by wrapper |
| ETH (wrapped) | 8 | Varies by wrapper |
| JitoSOL | 9 | Liquid staking token |
| BONK | 5 | Community token |
| Virtual tokens | Varies | Defined per custody, typically 6 or 9 |

## Leverage Limits

Leverage is configured per custody in `PricingParams`:

| Parameter | Typical Value | Notes |
|-----------|--------------|-------|
| `min_init_leverage` | 10,000 (1x) | Minimum leverage at entry |
| `max_init_leverage` | 1,000,000 (100x) | Max leverage at entry (standard) |
| `max_init_degen_leverage` | 5,000,000 (500x) | Max leverage at entry (Degen Mode) |
| `max_leverage` | >1,000,000 | Max leverage post-entry (more lenient) |
| `max_degen_leverage` | >5,000,000 | Max Degen leverage post-entry |
| `min_collateral_usd` | Varies | Minimum collateral in USD (6 decimals) |
| `min_degen_collateral_usd` | Varies | Minimum Degen collateral |

**Leverage calculation:** leverage = `sizeUsd / collateralUsd`. Values are in BPS where 10,000 = 1x.

## Fee Structure

Trading fees are configured per custody. Typical ranges:

| Fee Type | Typical Range | Notes |
|----------|--------------|-------|
| Open position | 4-8 BPS | `Fees.open_position` |
| Close position | 4-8 BPS | `Fees.close_position` |
| Swap in/out | 10-30 BPS | Ratio-dependent (`RatioFees.minFee` to `maxFee`) |
| Add liquidity | 0-30 BPS | Lower when token is underweight |
| Remove liquidity | 0-30 BPS | Lower when token is overweight |

Fee modes:
- **Fixed**: Constant fee regardless of pool state
- **Linear**: Fee scales linearly with pool utilization / ratio deviation

## Order Limits

| Limit | Value | Error Code |
|-------|-------|------------|
| Max stop-loss orders per market | 5 | 6052 (MaxStopLossOrders) |
| Max take-profit orders per market | 5 | 6053 (MaxTakeProfitOrders) |
| Max limit orders per market | 5 | 6054 (MaxOpenOrder) |
| Max withdraw requests per TokenStake | 5 | 6058 (MaxWithdrawTokenRequest) |

## Staking Levels

FLASH token staking has 6 levels with increasing benefits:

| Level | Feature |
|-------|---------|
| Level 0 | Base level (no stake required) |
| Level 1-5 | Progressive fee discounts, referral rebates, and reward boosts |

Configured via `TokenVault.stake_level: [u64; 6]` and `Pool.staking_fee_boost_bps: [u64; 6]`.

Trading discounts and referral rebates are configured in `Perpetuals.trading_discount: [u64; 6]` and `Perpetuals.referral_rebate: [u64; 6]`.

## PDA Seeds

| Account | Seeds |
|---------|-------|
| Perpetuals (global) | `["perpetuals"]` |
| Multisig | `["multisig"]` |
| Transfer Authority | `["transfer_authority"]` |
| Pool | `["pool", pool_name.as_bytes()]` |
| Custody | `["custody", pool_key, custody_mint]` |
| Custody Token Account | `["custody_token_account", pool_key, custody_mint]` |
| Position | `["position", owner, pool, custody, side_byte]` |
| Order | SDK-derived (per market per owner) |

**Side byte encoding:** None = `0`, Long = `1`, Short = `2`

## Enums

```typescript
enum Side { None, Long, Short }
enum Privilege { None, Stake, Referral }
enum OracleType { None, Custom, Pyth }
enum FeesMode { Fixed, Linear }
```
