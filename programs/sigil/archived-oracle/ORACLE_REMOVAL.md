# Oracle System Removal Documentation

## Context

The dual-oracle system (Pyth + Switchboard) was removed in favor of stablecoin-only USD tracking.
Every swap must have a stablecoin (USDC/USDT) on at least one side. USD spent = stablecoin outflow / 10^decimals.

## Archived Files (complete modules)

1. `oracle.txt` — Full oracle module: Pyth PriceUpdateV2 parser, Switchboard PullFeed median, OracleSource enum (417 lines)
2. `registry.txt` — OracleRegistry zero-copy state: 104-entry array, authority, find_entry methods (125 lines)
3. `pending_oracle_update.txt` — PendingOracleUpdate state: timelocked oracle update queue (54 lines)
4. `initialize_oracle_registry.txt` — Init instruction: creates protocol-level OracleRegistry PDA
5. `update_oracle_registry.txt` — Update instruction: add-only instant updates
6. `queue_oracle_update.txt` — Queue instruction: timelocked adds + removals
7. `apply_oracle_update.txt` — Apply instruction: executes queued update after 24h
8. `cancel_oracle_update.txt` — Cancel instruction: cancels pending update
9. `propose_oracle_authority.txt` — Propose authority transfer (step 1 of 2)
10. `accept_oracle_authority.txt` — Accept authority transfer (step 2 of 2)

## Code Removed from Partially-Modified Files

### state/mod.rs

Removed oracle constants:

- `PYTH_RECEIVER_PROGRAM` — Pyth Receiver program ID
- `SWITCHBOARD_ON_DEMAND_PROGRAM` — Switchboard On-Demand program ID
- `MAX_ORACLE_STALE_SLOTS` (50) — slot-based staleness threshold
- `MIN_ORACLE_SAMPLES` (5) — minimum Switchboard submissions
- `MAX_CONF_CAP_BPS` (200) — 2% confidence cap
- `ORACLE_SAFETY_VALVE_BPS` (2000) — 20% broken feed rejection
- `ADAPTIVE_CONF_MULTIPLIER` (5) — spot_conf vs ema_conf ratio
- `MIN_ADAPTIVE_CONF_BPS` (50) — 0.5% floor for adaptive check
- `MAX_ORACLE_DIVERGENCE_BPS` (500) — 5% primary/fallback spread
- `ORACLE_UPDATE_TIMELOCK` (86400) — 24h timelock for removals
- `MAX_ORACLE_UPDATE_BATCH` (10) — max entries per batch

Removed module declarations: `pub mod registry`, `pub mod pending_oracle_update`

### instructions/utils.rs

Removed functions:

- `convert_to_usd()` — main USD conversion (stablecoin + oracle paths)
- `check_oracle_divergence()` — primary vs fallback midpoint divergence check
- `oracle_price_to_usd()` — oracle mantissa to USD conversion

Kept: `stablecoin_to_usd()` — now the ONLY USD conversion function

### instructions/validate_and_authorize.rs

- Removed `oracle_registry: AccountLoader<'info, OracleRegistry>` account
- Removed oracle registry lookup + oracle feed reading from remaining_accounts
- Added `output_stablecoin_account` for non-stablecoin swap balance snapshots
- Added protocol slippage verification (Jupiter/Flash Trade instruction introspection)
- Added dust deposit guard (rejects top-level SPL transfers to vault stablecoin ATA)

### instructions/agent_transfer.rs

- Removed `oracle_registry: AccountLoader<'info, OracleRegistry>` account
- Replaced oracle lookup with `is_stablecoin_mint()` check
- Replaced `convert_to_usd()` with `stablecoin_to_usd()`
- Removed remaining_accounts oracle usage

### instructions/mod.rs

Removed 7 module declarations: initialize_oracle_registry, update_oracle_registry,
queue_oracle_update, apply_oracle_update, cancel_oracle_update,
propose_oracle_authority, accept_oracle_authority

### lib.rs

- Removed `pub mod oracle;`
- Removed 7 instruction handlers: initialize_oracle_registry, propose_oracle_authority,
  accept_oracle_authority, update_oracle_registry, queue_oracle_update,
  apply_oracle_update, cancel_oracle_update

### errors.rs

Oracle errors reserved (error codes preserved for ABI compatibility):

- OracleFeedStale (6028) → Reserved6028
- OracleFeedInvalid (6029) → Reserved6029
- OracleAccountMissing (6032) → Reserved6032
- OracleConfidenceTooWide (6033) → Reserved6033
- OracleUnsupportedType (6034) → Reserved6034
- OracleNotVerified (6035) → Reserved6035
- OracleRegistryFull (6042) → Reserved6042
- UnauthorizedRegistryAdmin (6043) → Reserved6043
- OraclePriceDivergence (6044) → Reserved6044
- OracleBothFeedsFailed (6045) → Reserved6045
- OracleConfidenceSpike (6046) → Reserved6046
- InvalidAuthorityKey (6047) → Reserved6047
- NoPendingAuthority (6048) → Reserved6048
- OracleRemovalRequiresTimelock (6055) → Reserved6055
- OracleUpdateBatchTooLarge (6056) → Reserved6056

### events.rs

Removed 6 events:

- OracleRegistryInitialized
- OracleRegistryUpdated
- OracleAuthorityProposed
- OracleAuthorityTransferred
- OracleUpdateQueued
- OracleUpdateCancelled

Updated ActionAuthorized: removed `oracle_price` and `oracle_source` fields
Updated PolicyUpdated: added `max_slippage_bps` field
