# @phalnx/sdk

## 0.5.4

### Patch Changes

- [#70](https://github.com/Kaleb-Rupe/phalnx/pull/70) [`23fa5d9`](https://github.com/Kaleb-Rupe/phalnx/commit/23fa5d9dd3f041d7611135fa67a91b34c279bc8e) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Update flash-sdk dependency from ^15.1.2 to ^15.1.4

## 0.5.2

### Patch Changes

- [#42](https://github.com/Kaleb-Rupe/phalnx/pull/42) [`d455d9f`](https://github.com/Kaleb-Rupe/phalnx/commit/d455d9f176aa05eece2a615abb0865800129014f) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix(security): audit findings batch 1
  - **core**: Add `checkpoint()` and `rollback()` to `ShieldState` to prevent phantom spend recording when `signAllTransactions` fails
  - **sdk**: Enforce `maxPayment` ceiling in `shieldedFetch()` (rejects if server asks more than specified cap); wrap `signAllTransactions` evaluate-record-sign loop in checkpoint/rollback to prevent phantom spend on signing failure
  - **mcp**: Lazy-cache `ShieldedWallet` across x402 tool calls so spending caps persist; pass `maxPayment` through to `shieldedFetch()`; tighten `maxPayment` schema with regex validation

- Updated dependencies [[`d455d9f`](https://github.com/Kaleb-Rupe/phalnx/commit/d455d9f176aa05eece2a615abb0865800129014f)]:
  - @phalnx/core@0.1.5
