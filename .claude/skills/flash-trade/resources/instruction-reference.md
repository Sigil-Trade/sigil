# Flash Trade Instruction Reference (from IDL v13.0.0)

108 total instructions across 4 categories.

## Public Trading Instructions

These require the `owner` signer (the position/LP holder).

### Position Management

| Instruction | Params | Description |
|-------------|--------|-------------|
| `open_position` | `price_with_slippage: OraclePrice, collateral_amount: u64, size_amount: u64, privilege: Privilege` | Open a new leveraged position |
| `close_position` | `price_with_slippage: OraclePrice, privilege: Privilege` | Close entire position |
| `close_and_swap` | `price_with_slippage: OraclePrice, privilege: Privilege` | Close position and swap collateral to another token |
| `increase_size` | `price_with_slippage: OraclePrice, size_delta: u64, privilege: Privilege` | Increase position size |
| `decrease_size` | `price_with_slippage: OraclePrice, size_delta: u64, privilege: Privilege` | Decrease position size |
| `add_collateral` | `collateral_delta: u64` | Deposit collateral (reduce leverage) |
| `remove_collateral` | `collateral_delta_usd: u64` | Withdraw collateral in USD (increase leverage) |
| `remove_collateral_and_swap` | `collateral_delta_usd: u64` | Remove collateral and swap to another token |
| `swap_and_open` | `price_with_slippage: OraclePrice, amount_in: u64, size_amount: u64, privilege: Privilege` | Swap input token then open position (atomic) |
| `swap_and_add_collateral` | `amount_in: u64` | Swap input token then add to collateral (atomic) |

### Trigger Orders

| Instruction | Params | Description |
|-------------|--------|-------------|
| `place_trigger_order` | `trigger_price: OraclePrice, delta_size_amount: u64, is_stop_loss: bool` | Place stop-loss or take-profit |
| `edit_trigger_order` | `order_id: u8, trigger_price: OraclePrice, delta_size_amount: u64, is_stop_loss: bool` | Modify existing trigger order |
| `cancel_trigger_order` | `order_id: u8, is_stop_loss: bool` | Cancel a trigger order |

### Limit Orders

| Instruction | Params | Description |
|-------------|--------|-------------|
| `place_limit_order` | `limit_price: OraclePrice, reserve_amount: u64, size_amount: u64, stop_loss_price: OraclePrice, take_profit_price: OraclePrice` | Place limit entry order with optional SL/TP |
| `edit_limit_order` | `order_id: u8, limit_price: OraclePrice, size_amount: u64, stop_loss_price: OraclePrice, take_profit_price: OraclePrice` | Edit limit order (size_amount=0 to cancel) |

### Swaps

| Instruction | Params | Description |
|-------------|--------|-------------|
| `swap` | `amount_in: u64, min_amount_out: u64` | Swap tokens within a pool |

### Liquidity

| Instruction | Params | Description |
|-------------|--------|-------------|
| `add_liquidity` | `amount_in: u64, min_lp_amount_out: u64` | Provide liquidity, receive FLP tokens |
| `add_liquidity_and_stake` | `amount_in: u64, min_lp_amount_out: u64` | Deposit + auto-stake FLP |
| `remove_liquidity` | `lp_amount_in: u64, min_amount_out: u64` | Withdraw liquidity, burn FLP |
| `add_compounding_liquidity` | `amount_in: u64, min_compounding_amount_out: u64` | Deposit to compounding pool |
| `remove_compounding_liquidity` | `compounding_amount_in: u64, min_amount_out: u64` | Withdraw from compounding pool |

### FLP Staking

| Instruction | Params | Description |
|-------------|--------|-------------|
| `deposit_stake` | `deposit_amount: u64` | Stake FLP tokens |
| `unstake_instant` | `unstake_amount: u64` | Instant unstake (may incur fee) |
| `unstake_request` | `unstake_amount: u64` | Request deferred unstake (no fee) |
| `withdraw_stake` | `pending_activation: bool, deactivated: bool` | Withdraw unstaked FLP |
| `collect_stake_fees` | (none) | Collect staking rewards |

### Token Staking (FLASH)

| Instruction | Params | Description |
|-------------|--------|-------------|
| `deposit_token_stake` | `deposit_amount: u64` | Stake FLASH tokens |
| `unstake_token_instant` | `unstake_amount: u64` | Instant unstake FLASH |
| `unstake_token_request` | `unstake_amount: u64` | Request deferred FLASH unstake |
| `cancel_unstake_token_request` | `withdraw_request_id: u8` | Cancel pending unstake request |
| `withdraw_token` | `withdraw_request_id: u8` | Withdraw unstaked FLASH |
| `collect_token_reward` | (none) | Collect FLASH staking rewards |
| `collect_revenue` | (none) | Collect revenue share |
| `collect_rebate` | (none) | Collect referral rebates |

### Referrals

| Instruction | Params | Description |
|-------------|--------|-------------|
| `create_referral` | (none) | Create referral account |

### Migrations

| Instruction | Params | Description |
|-------------|--------|-------------|
| `migrate_flp` | `compounding_token_amount: u64` | Migrate FLP to compounding |
| `migrate_stake` | `amount: u64` | Migrate stake to new format |

---

## View Instructions (Read-Only)

No signers or writable accounts. Return data via program return.

| Instruction | Params | Returns | Description |
|-------------|--------|---------|-------------|
| `get_entry_price_and_fee` | `collateral: u64, size: u64, side: Side` | `NewPositionPricesAndFee { entry_price, fee_usd }` | Estimated entry price + fees |
| `get_exit_price_and_fee` | (none) | `PriceAndFee { price, fee_usd }` | Estimated exit price + fees |
| `get_pnl` | (none) | `ProfitAndLoss { profit, loss }` | Current unrealized PnL |
| `get_position_data` | (none) | `PositionData { collateral_usd, profit_usd, loss_usd, fee_usd, leverage, liquidation_price }` | Full position summary |
| `get_liquidation_price` | (none) | `OraclePrice` | Liquidation trigger price |
| `get_liquidation_state` | (none) | `bool` | Whether position is liquidatable |
| `get_oracle_price` | (none) | `OraclePrice` | Current oracle price |
| `get_lp_token_price` | (none) | `u64` | FLP token USD price |
| `get_compounding_token_price` | (none) | `u64` | Compounding FLP price |
| `get_compounding_token_data` | (none) | `CompoundingTokenData { lp_price, compounding_price, ratios }` | Full compounding data |
| `get_assets_under_management` | (none) | `u128` | Pool AUM in USD |
| `get_add_liquidity_amount_and_fee` | `amount_in: u64` | `AmountAndFee { amount, fee }` | FLP tokens for deposit |
| `get_remove_liquidity_amount_and_fee` | `lp_amount_in: u64` | `AmountAndFee { amount, fee }` | Tokens for FLP burn |
| `get_add_compounding_liquidity_amount_and_fee` | `amount_in: u64` | `AmountAndFee { amount, fee }` | Compounding tokens for deposit |
| `get_remove_compounding_liquidity_amount_and_fee` | `compounding_amount_in: u64` | `AmountAndFee { amount, fee }` | Tokens for compounding withdrawal |
| `get_swap_amount_and_fees` | `amount_in: u64` | `SwapAmountAndFees { amount_out, fee_in, fee_out }` | Swap output estimate |

---

## Permissionless / Keeper Instructions

Any account can call these (keepers, cranks, liquidators).

| Instruction | Params | Description |
|-------------|--------|-------------|
| `execute_limit_order` | `order_id: u8, privilege: Privilege` | Execute a limit order when price is reached |
| `execute_limit_with_swap` | `order_id: u8, privilege: Privilege` | Execute limit order with token swap |
| `execute_trigger_order` | `is_stop_loss: bool, order_id: u8, privilege: Privilege` | Execute TP/SL trigger order |
| `execute_trigger_with_swap` | `is_stop_loss: bool, order_id: u8, privilege: Privilege` | Execute trigger order with swap |
| `cancel_all_trigger_orders` | (none) | Cancel all trigger orders for a position |
| `liquidate` | (none) | Liquidate undercollateralized position |
| `compound_fees` | (none) | Compound accumulated fees into LP |
| `move_protocol_fees` | (none) | Move protocol fees to protocol vault |
| `refresh_stake` | (none) | Refresh stake state |
| `set_lp_token_price` | (none) | Update LP token price |
| `settle_rebates` | (none) | Settle pending rebates |

---

## Admin Instructions (32 total)

Require `admin` signer (through multisig). Not relevant to traders/integrators.

**Pool/Custody/Market management:** `init`, `add_pool`, `remove_pool`, `add_custody`, `remove_custody`, `add_market`, `remove_market`, `set_pool_config`, `set_custody_config`, `set_market_config`, `set_permissions`, `set_perpetuals_config`

**Oracle:** `add_internal_oracle`, `resize_internal_oracle`, `set_custom_oracle_price`, `set_internal_current_price`, `set_internal_ema_price`, `set_internal_lazer_price`, `set_position_price_impact`

**Fees/Rewards:** `withdraw_fees`, `withdraw_sol_fees`, `withdraw_instant_fees`, `withdraw_unclaimed_tokens`, `set_fee_share`, `set_protocol_fee_share`, `distribute_token_reward`, `set_token_reward`

**Staking:** `init_staking`, `init_compounding`, `init_token_vault`, `set_token_vault_config`, `set_token_stake_level`, `migrate_token_stake`

**Access Control:** `set_admin_signers`, `create_whitelist`, `set_whitelist_config`, `init_rebate_vault`, `init_revenue_token_account`

**Utility:** `add_custody_token22_account`, `reimburse`, `rename_flp`, `set_test_time`, `test_init`

---

## Types Used in Instructions

### OraclePrice
```
{ price: u64, exponent: i32 }
// Example: { price: 150_000_000, exponent: -6 } = $150.00
```

### Side
```
None = 0, Long = 1, Short = 2
```

### Privilege
```
None = 0, Stake = 1, Referral = 2
```

### Return Types

| Type | Fields | Used By |
|------|--------|---------|
| `NewPositionPricesAndFee` | `entry_price: OraclePrice, fee_usd: u64` | `get_entry_price_and_fee` |
| `PriceAndFee` | `price: OraclePrice, fee_usd: u64` | `get_exit_price_and_fee` |
| `ProfitAndLoss` | `profit: u64, loss: u64` | `get_pnl` |
| `PositionData` | `collateral_usd, profit_usd, loss_usd, fee_usd, leverage: u64, liquidation_price: OraclePrice` | `get_position_data` |
| `AmountAndFee` | `amount: u64, fee: u64` | LP amount queries |
| `SwapAmountAndFees` | `amount_out: u64, fee_in: u64, fee_out: u64` | `get_swap_amount_and_fees` |
| `CompoundingTokenData` | `lp_price: u64, compounding_price: u64, ratios: Vec<u64>` | `get_compounding_token_data` |
