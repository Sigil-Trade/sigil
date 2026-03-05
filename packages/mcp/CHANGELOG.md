# @phalnx/mcp

## 0.4.8

### Patch Changes

- [#74](https://github.com/Kaleb-Rupe/phalnx/pull/74) [`372805a`](https://github.com/Kaleb-Rupe/phalnx/commit/372805af5eec01dcd8ac4913d657c935cc78a9e6) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix(mcp): config hardening — tilde expansion uses os.homedir(), schema validation rejects corrupted configs

## 0.4.6

### Patch Changes

- [#70](https://github.com/Kaleb-Rupe/phalnx/pull/70) [`23fa5d9`](https://github.com/Kaleb-Rupe/phalnx/commit/23fa5d9dd3f041d7611135fa67a91b34c279bc8e) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Update @modelcontextprotocol/sdk dependency from ^1.12.1 to ^1.27.0

- Updated dependencies [[`23fa5d9`](https://github.com/Kaleb-Rupe/phalnx/commit/23fa5d9dd3f041d7611135fa67a91b34c279bc8e)]:
  - @phalnx/sdk@0.5.4
  - @phalnx/custody-crossmint@0.1.4

## 0.4.4

### Patch Changes

- [#42](https://github.com/Kaleb-Rupe/phalnx/pull/42) [`d455d9f`](https://github.com/Kaleb-Rupe/phalnx/commit/d455d9f176aa05eece2a615abb0865800129014f) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix(security): audit findings batch 1
  - **core**: Add `checkpoint()` and `rollback()` to `ShieldState` to prevent phantom spend recording when `signAllTransactions` fails
  - **sdk**: Enforce `maxPayment` ceiling in `shieldedFetch()` (rejects if server asks more than specified cap); wrap `signAllTransactions` evaluate-record-sign loop in checkpoint/rollback to prevent phantom spend on signing failure
  - **mcp**: Lazy-cache `ShieldedWallet` across x402 tool calls so spending caps persist; pass `maxPayment` through to `shieldedFetch()`; tighten `maxPayment` schema with regex validation

- Updated dependencies [[`d455d9f`](https://github.com/Kaleb-Rupe/phalnx/commit/d455d9f176aa05eece2a615abb0865800129014f)]:
  - @phalnx/sdk@0.5.2
  - @phalnx/custody-crossmint@0.1.4
