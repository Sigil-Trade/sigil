---
"@usesigil/kit": patch
---

Fix `createVault` to default to a V2-valid policy and fail fast on inert configs:

- `protocolMode` now defaults to `1` (ALLOWLIST) instead of `0`. Phase 2
  Option A deleted the permissive ALL (0) / DENYLIST modes; the on-chain
  `initialize_vault` handler hard-rejects any `protocol_mode != 1`. The old
  default of `0` built an initialize instruction the deployed program reverts
  on, so any caller that didn't pass an explicit `protocolMode` produced an
  un-landable transaction.
- `createVault` now throws `INVALID_PARAMS` up front when an active
  (non-`observeOnly`) vault is given no protocols AND no destinations on its
  allowlist. The on-chain program rejects that as inert
  (`ActiveVaultRequiresAllowlist`, 6073); failing fast in the SDK surfaces an
  actionable message before the owner signs. `observeOnly` vaults (explicitly
  inert) are exempt. `previewCreateVault` surfaces this via its existing
  throw-propagation path.
