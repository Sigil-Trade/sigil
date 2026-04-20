---
"@usesigil/kit": minor
---

BREAKING: Remove position counter system per council decision (9-1 vote, 2026-04-19).

**Removed types / helpers:**
- `PositionEffect` type and `getPositionEffect()` helper
- `PositionsSynced` event type and its decoder
- `syncPositions()` instruction builder and `OwnerClient.syncPositions()` method
- `ActivityType` literals `"open_position"` and `"close_position"` (trade events now collapse to `"swap"`)

**Removed fields (accounts + instructions + events):**
- `AgentVault.openPositions` (u8)
- `PolicyConfig.canOpenPositions` (bool) and `PolicyConfig.maxConcurrentPositions` (u8)
- `PendingPolicyUpdate.canOpenPositions` and `PendingPolicyUpdate.maxConcurrentPositions` (both `Option<T>`)
- `SessionAuthority.positionEffect` (u8)
- `SessionFinalized.positionEffect` (u8)
- `VaultActivityItem.positionEffect`
- `VaultHealth.openPositions`
- `InscribeOptions.maxConcurrentPositions`, `CreateVaultOptions.maxConcurrentPositions`
- `PolicyData.canOpenPositions`, `PolicyData.maxConcurrentPositions` and their serialized counterparts

**Removed error codes:**
- 6008 `TooManyPositions`
- 6009 `PositionOpeningDisallowed`
- 6012 `OpenPositionsExist`
- 6032 `NoPositionsToClose`

**Error-code renumber cascade** (Anchor auto-assigns 6000+index):
- 6000-6007: unchanged
- 6008-6009: was 6010-6011 (shift -2)
- 6010-6028: was 6013-6031 (shift -3)
- 6029-6080: was 6033-6084 (shift -4)
- Total codes: 85 -> 81; max code: 6084 -> 6080

**Migration notes:**
- Consumers who used `maxConcurrentPositions` or `canOpenPositions` to limit agent behavior should rely on spending caps (`dailySpendingCapUsd`, `maxTransactionSizeUsd`), per-protocol caps, and the instruction-constraints PDA — these are the load-bearing guardrails.
- Dashboard `mapCategory()` now returns `"swap"` for all trade events that previously returned `"open_position"` / `"close_position"`. The `"lend"` category is preserved for deposit/withdraw flows that match action-type heuristics.
- Legacy JSON snapshots with `positionEffect`, `openPositions`, or `maxConcurrentPositions` keys still deserialize — unknown keys are silently ignored by `vaultStateFromJSON` / `policyFromJSON`.

Depends on the on-chain Rust deletion shipped in Sigil PR #258.
