---
"@usesigil/kit": minor
---

feat(kit): C1 — `previewCreateVault(config)` typed SDK primitive

Single SDK call that wraps the existing `buildOwnerTransaction()` +
`createVault()` primitives and returns everything the dashboard
split-screen `/onboard` page needs to render rent + cost + PDA list AND
hand the FE the unsigned transaction in one call.

Returns `CreateVaultPreview`:

- `pdaList` — the 4 PDAs `initialize_vault` creates (AgentVault,
  PolicyConfig, SpendTracker, AgentSpendOverlay), each with address,
  bump, sizeBytes mirrored from `<Account>::SIZE`, and rentLamports.
- `rentLamports` — sum of pdaList rents.
- `computeUnits` — defaults to `CU_VAULT_CREATION` (400,000).
- `feeLamports` — `priorityFeeMicroLamports × computeUnits / 1_000_000n`
  via explicit BigInt math (no number/bigint mixing).
- `totalCostUsd` — `(rentLamports + feeLamports) × solPriceUsd / 1e9n`
  in 6-decimal USD base units; mul-before-divide preserves precision.
- `vaultAddress` — same as `pdaList[0].address`.
- `unsignedTxBytes` — wire-encoded versioned transaction; pass to wallet
  adapter for signing.
- `txSizeBytes` — byte size of the wire tx; ≤ 1232 (Solana hard limit).
- `lastValidBlockHeight` — FE detects stale blockhash before sign.
- `warnings?` — soft signals (`daily_cap_zero`, `daily_cap_unusually_high`,
  `no_protocols_approved`, `max_tx_exceeds_daily_cap`); sorted by code
  ascending so React keys stay stable on re-type. Returns `undefined`
  when none fire.

API takes `Address` (not `TransactionSigner`) for both `owner` and
`agentAddress` — preview never signs. Internally constructs
`createNoopSigner` to satisfy `buildOwnerTransaction`.

`solPriceUsd: bigint` (6-decimal USD per SOL) is REQUIRED — kit has no
oracle, and a hidden default would silently misrepresent total cost.

Hard on-chain limits surface as early `RangeError` throws (not warnings):
`timelockDuration < 1800`, `developerFeeRate > 500`, `protocols.length > 10`,
`allowedDestinations.length > 10`. Negative bigints throw `RangeError`.
Bad RPC responses (`getMinimumBalanceForRentExemption` returning 0n /
non-bigint) throw typed `SigilSdkDomainError`.

The returned object is `Object.freeze`d; nested arrays are also frozen.
Two parallel previews share `altCache` + `getBlockhashCache` without
corruption.

Closes FE↔BE Contract v2.2 commitment **C1**. Unblocks the dashboard
split-screen `/onboard` (PR #38).

60 new tests in `sdk/kit/tests/preview-create-vault.test.ts` covering
public surface, PDA derivation, account sizes, cost math, warning
rules, input validation, determinism + immutability, tx integrity, and
RPC failure handling. Total kit suite now 1,673 tests (was 1,613).
