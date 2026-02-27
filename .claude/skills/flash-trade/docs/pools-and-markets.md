# Flash Trade Pools and Markets

## Pool Architecture

Flash Trade uses a **pool-to-peer** model where all traders trade against shared liquidity pools. Each pool holds multiple token custodies, and markets define tradable pairs within a pool.

```
Pool (e.g., Crypto.1)
├── Custody: USDC (collateral, stable)
├── Custody: SOL (target, volatile)
├── Custody: BTC (target, volatile)
├── Custody: ETH (target, volatile)
├── Market: SOL-Long (target=SOL, collateral=USDC, side=Long)
├── Market: SOL-Short (target=SOL, collateral=USDC, side=Short)
├── Market: BTC-Long ...
└── ...
```

## Pool Discovery

**Always use `PoolConfig` as the source of truth.** Pool addresses, custodies, and markets change as Flash Trade adds or updates pools.

```typescript
import { PoolConfig } from "flash-sdk";

// Load by name -- the canonical way to discover pools
const crypto = PoolConfig.fromIdsByName("Crypto.1", "mainnet-beta");
const virtual = PoolConfig.fromIdsByName("Virtual.1", "mainnet-beta");
const governance = PoolConfig.fromIdsByName("Governance.1", "mainnet-beta");

// Access pool data
console.log("Pool:", crypto.poolAddress);
console.log("Custodies:", crypto.custodies.length);
console.log("Markets:", crypto.markets.length);
console.log("Program:", crypto.programId);
console.log("Composability:", crypto.perpComposibilityProgramId);
```

**Valid clusters:** `mainnet-beta`, `devnet`

## Pool Categories

| Category | Example Names | Asset Types | Description |
|----------|--------------|-------------|-------------|
| Crypto | `Crypto.1` | USDC + major crypto (SOL, BTC, ETH) | Primary trading pool |
| Virtual | `Virtual.1` | USDC + synthetic assets (XAU, XAG, EUR, GBP, CRUDEOIL) | Forex, commodities, metals |
| Governance | `Governance.1` | USDC + governance tokens (JUP, PYTH, JTO, RAY) | Solana ecosystem governance |
| Community | `Community.1`, `Community.2` | USDC + meme/community tokens | Community-driven markets |
| RWA (Remora) | `Remora.1` | USDC + tokenized equities (TSLAr, NVDAr, SPYr) | Real-world asset exposure |
| Single-Asset | Various | USDC + single token | Focused liquidity pools |

## Pool Account (IDL)

```typescript
interface Pool {
  name: string;                   // e.g., "Crypto.1"
  permissions: Permissions;       // 13 boolean flags controlling what operations are allowed
  inceptionTime: BN;
  lpMint: PublicKey;             // FLP token mint
  oracleAuthority: PublicKey;    // internal oracle price setter
  stakedLpVault: PublicKey;      // vault holding staked FLP
  rewardCustody: PublicKey;      // custody used for reward distribution
  custodies: PublicKey[];        // registered custody addresses
  ratios: TokenRatios[];        // target/min/max allocation per custody
  markets: PublicKey[];          // registered market addresses
  maxAumUsd: BN;                // AUM cap
  rawAumUsd: BN;                // current raw AUM
  equityUsd: BN;                // pool equity
  totalStaked: StakeStats;      // staking statistics
  stakingFeeShareBps: BN;       // share of fees to stakers (BPS)
  vpVolumeFactor: number;       // voltage program volume factor
  stakingFeeBoostBps: BN[];     // fee boost per stake level [6]
  compoundingMint: PublicKey;    // compounding LP token mint
  compoundingStats: CompoundingStats;
  lpPrice: BN;                  // current FLP price (USD, 6 decimals)
  compoundingLpPrice: BN;       // compounding FLP price
  lastUpdatedTimestamp: BN;
  feesObligationUsd: BN;
  rebateObligationUsd: BN;
  thresholdUsd: BN;
}
```

## Market Account (IDL)

Each market defines a tradable pair within a pool:

```typescript
interface Market {
  pool: PublicKey;               // parent pool
  targetCustody: PublicKey;      // the asset being traded (e.g., SOL)
  collateralCustody: PublicKey;  // the collateral token (e.g., USDC)
  side: Side;                    // Long or Short
  correlation: boolean;          // price correlation with collateral
  maxPayoffBps: BN;             // max profit multiplier (in BPS)
  permissions: MarketPermissions; // per-market operation controls
  degenExposureUsd: BN;         // Degen Mode exposure cap
  collectivePosition: PositionStats; // aggregate position data
  targetCustodyUid: number;     // custody array index
  collateralCustodyUid: number; // custody array index
}

interface MarketPermissions {
  allowOpenPosition: boolean;
  allowClosePosition: boolean;
  allowCollateralWithdrawal: boolean;
  allowSizeChange: boolean;
}
```

## Virtual Tokens

Virtual tokens provide synthetic exposure to assets without actual token custody. The pool holds only the collateral token (USDC) and uses oracle prices to settle PnL.

**How virtual tokens work:**
1. Trader deposits USDC collateral
2. Position tracks `sizeUsd` and `collateralUsd` denominated in USD
3. Pyth oracle provides the reference price for the virtual asset
4. PnL is settled in USDC based on price movement

**Identified by:** `Custody.is_virtual = true` in the custody configuration.

**Examples:** XAU (gold), XAG (silver), EUR, GBP, CRUDEOIL, USDJPY, USDCNH, TSLAr, NVDAr, SPYr

**Inverse price tokens:** Some virtual tokens use `Custody.inverse_price = true` for currency pairs where the quote convention is inverted (e.g., USDJPY).

## Custody Configuration (IDL)

Each custody within a pool has independent configuration controlling fees, oracle setup, pricing limits, and borrow rates:

### Pricing Parameters

```typescript
interface PricingParams {
  tradeSpreadMin: BN;             // minimum trade spread (BPS)
  tradeSpreadMax: BN;             // maximum trade spread (BPS)
  swapSpread: BN;                 // swap spread (BPS)
  minInitLeverage: number;        // minimum initial leverage (u32)
  minInitDegenLeverage: number;   // minimum Degen initial leverage
  maxInitLeverage: number;        // max leverage at entry (typically 100x)
  maxInitDegenLeverage: number;   // max Degen leverage at entry (up to 500x)
  maxLeverage: number;            // max leverage post-entry (more lenient)
  maxDegenLeverage: number;       // max Degen leverage post-entry
  minCollateralUsd: number;       // minimum collateral (USD, 6 decimals)
  minDegenCollateralUsd: number;  // minimum Degen collateral
  delaySeconds: BN;               // price delay for entry/exit (anti-frontrunning)
  maxUtilization: number;         // max pool utilization (BPS)
  degenPositionFactor: number;    // Degen position scaling (u16)
  degenExposureFactor: number;    // Degen exposure scaling (u16)
  maxPositionSizeUsd: BN;        // per-position size limit (USD)
  maxExposureUsd: BN;            // max pool exposure (USD)
}
```

### Fee Structure (per custody)

```typescript
interface Fees {
  mode: FeesMode;                // Fixed or Linear
  swapIn: RatioFees;            // swap input fees
  swapOut: RatioFees;           // swap output fees
  stableSwapIn: RatioFees;      // stable-to-stable swap in
  stableSwapOut: RatioFees;     // stable-to-stable swap out
  addLiquidity: RatioFees;      // LP deposit fees
  removeLiquidity: RatioFees;   // LP withdrawal fees
  openPosition: BN;             // position opening fee (BPS)
  closePosition: BN;            // position closing fee (BPS)
  volatility: BN;               // volatility adjustment factor
}

interface RatioFees {
  minFee: BN;      // minimum fee
  targetFee: BN;   // fee at target ratio
  maxFee: BN;      // maximum fee
}
```

Fees are ratio-dependent: depositing an underweight token gets lower fees, overweight gets higher fees. This incentivizes balanced pool composition.

### Borrow Rates

```typescript
interface BorrowRateParams {
  baseRate: BN;              // base rate (RATE_DECIMALS = 9)
  slope1: BN;                // slope below optimal utilization
  slope2: BN;                // slope above optimal (steeper)
  optimalUtilization: BN;    // target utilization for slope transition
}
```

Similar to Aave's interest rate model. Rates increase with pool utilization.

### Oracle Configuration

```typescript
interface OracleParams {
  intOracleAccount: PublicKey;   // internal backup oracle
  extOracleAccount: PublicKey;   // external oracle (Pyth)
  oracleType: OracleType;       // None, Custom, or Pyth
  maxDivergenceBps: BN;         // max divergence between oracles
  maxConfBps: BN;               // max confidence interval (BPS)
  maxPriceAgeSec: number;       // max staleness (seconds)
  maxBackupAgeSec: number;      // max backup oracle staleness
}
```

## Token Ratios

Each pool defines target allocation ratios per custody:

```typescript
interface TokenRatios {
  target: BN;   // target allocation percentage (BPS_DECIMALS)
  min: BN;      // minimum allocation (rebalancing trigger)
  max: BN;      // maximum allocation (deposit cap)
}
```

**Impact on LP operations:**
- Depositing a token below target ratio → lower fees
- Depositing a token above target ratio → higher fees
- Withdrawing an overweight token → lower fees
- Withdrawing an underweight token → higher fees

## Global Permissions

The `Perpetuals` global account and each `Pool` have a `Permissions` struct with 13 boolean flags:

```typescript
interface Permissions {
  allowSwap: boolean;
  allowAddLiquidity: boolean;
  allowRemoveLiquidity: boolean;
  allowOpenPosition: boolean;
  allowClosePosition: boolean;
  allowCollateralWithdrawal: boolean;
  allowSizeChange: boolean;
  allowLiquidation: boolean;
  allowLpStaking: boolean;
  allowFeeDistribution: boolean;
  allowUngatedTrading: boolean;   // if false, requires NFT or referral
  allowFeeDiscounts: boolean;
  allowReferralRebates: boolean;
}
```

When `allowUngatedTrading` is false, traders need either an NFT from a registered collection or a referral account to trade (error 6046: `InvalidAccess`).
