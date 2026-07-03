---
"@usesigil/kit": minor
---

Dashboard punch-list (5 additive, non-breaking additions):

- **Export `sendAndConfirmTransaction`** (+ `SendAndConfirmOptions`) from the root
  barrel and `@usesigil/kit/dashboard` — the send/poll primitive every internal
  send path already uses, now available to offline-signing / custom-fee-payer
  flows.
- **Policy/vault read-back parity.** `VaultState.vault` gains `observeOnly`;
  `PolicyData` gains `cosignRequired`, `cosignSessionPubkey` (default →
  `null`), `stableBalanceFloor`, `perRecipientDailyCapUsd` (0 → `null`),
  `destinationMode`, `operatorGrantDelaySeconds`, `protocolHashes`
  (per-protocol armed-state + hash) and `graylist` — all populated from the
  decoded `AgentVault` / `PolicyConfig` and threaded through `toJSON()` +
  `fromJSON`. New `getPendingOwnership(rpc, vault, network)` read returns the
  in-flight ownership transfer (or `null`).
- **Activity pagination + bounded-parallel fetch.** `ActivityFilters` gains
  `before` / `until` signature cursors; `ActivityData` gains `nextCursor`. The
  per-signature `getTransaction` loop now runs 5-at-a-time (order-preserving).
  New `getVaultActivityPage()` fetcher exposes the cursor; `getVaultActivity()`
  is an unchanged back-compat wrapper.
- **Export timelock constants** `MIN_TIMELOCK_DURATION` (1800) and
  `MAX_TIMELOCK_DURATION` (172800) from root.
- **Export instruction discriminators** `INITIALIZE_VAULT_DISCRIMINATOR` and
  `REGISTER_AGENT_DISCRIMINATOR` from root.

All new type fields are optional so existing consumers/serialized JSON remain
compatible.
