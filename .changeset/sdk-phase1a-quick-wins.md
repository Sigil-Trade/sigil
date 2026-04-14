---
"@usesigil/kit": minor
---

Phase 1 safety lockdown (PR 1.A — quick wins) — 6 targeted fixes addressing the full-spectrum SDK audit:

- **Fix broken `VAULT_PRESETS` capability values.** All four presets (`jupiter-swap-bot`, `perps-trader`, `lending-optimizer`, `full-access`) now use `FULL_CAPABILITY` (= `2n`, Operator) for both `capability` and `permissions`. Previous values used the legacy 21-bit permission bitmasks (`SWAP_ONLY`, `PERPS_FULL | SWAP_ONLY`, `LENDING_PERMISSIONS`) which either registered agents as Observer (cannot execute anything — silently wrong) or exceeded the on-chain `capability <= 2n` invariant and were rejected with `InvalidArgument`.

- **Remove the pre-v6 permission API from the public root export.** `SWAP_ONLY`, `PERPS_ONLY`, `TRANSFER_ONLY`, `ESCROW_ONLY`, `PERPS_FULL`, `ACTION_PERMISSION_MAP`, `hasPermission`, `permissionsToStrings`, `stringsToPermissions`, and `PermissionBuilder` are no longer re-exported from `@usesigil/kit`. They encoded a pre-v6 permission model the on-chain program replaced with a 2-bit capability enum. `FULL_CAPABILITY` / `FULL_PERMISSIONS` (both `2n`) remain the canonical spending-agent capability. The identifiers still exist inside `src/types.ts` for internal use but are no longer part of the public surface.

- **Stop silencing stablecoin-ATA decode errors.** `resolveVaultState` used a bare `try/catch` around USDC and USDT balance parsing that swallowed both legitimate "account missing" and actual decode failures. Downstream, `seal.ts` uses `stablecoinBalances` as the drain-detection baseline — a spurious zero silently disabled the `LARGE_OUTFLOW` / `FULL_DRAIN` gates. Missing-ATA still returns `0n` (the `.exists` guard handles it); genuine parse errors now propagate so callers refuse to transact on unknown state instead of transacting on zero.

- **Per-RPC blockhash cache (SDK-wide).** Three module-level `BlockhashCache` singletons (`dashboard/mutations.ts`, `seal.ts`, `owner-transaction.ts`) all shared state across every consumer — a dashboard that switches `devnet ↔ mainnet`, a CLI `--network` flag, or an MCP server multiplexing tenants would pull a blockhash fetched against one RPC and send it against another, producing intermittent `BlockhashNotFound` that the 30s TTL then hid. A new `getBlockhashCache(rpc)` helper in `rpc-helpers.ts` hands out caches keyed by RPC-client identity via `WeakMap<Rpc, BlockhashCache>`: consumers who reuse an RPC client keep the perf win; distinct RPCs stay isolated; short-lived RPC handles can be garbage-collected. The per-instance cache inside `SigilClient` is unaffected (already correctly scoped). Exported from `@usesigil/kit` so consumers can call `.invalidate()` explicitly when needed.

- **Guard `buildHealth` against partial `OverviewContext`.** Matches the three peer `build*` helpers — emits a labeled `[dashboard/reads] OverviewContext.state.vault is required but missing` error instead of a cryptic NPE when a test fixture or custom composition passes a context without `state.vault`. The guard only fires when the helper actually needs to touch `state.vault` (non-memoized path); consumers that pre-populate `ctx.posture` and `ctx.alerts` — the whole reason for `OverviewContext` — still work.

- **Mark S14 composition primitives `@experimental`.** The six `build*` helpers (`buildVaultState`, `buildAgents`, `buildSpending`, `buildHealth`, `buildPolicy`, `buildActivityRows`), plus `OverviewData` and `GetOverviewOptions`, now carry `@experimental` JSDoc. Their field shapes and memoization pipeline may shift before v1.0; pin your SDK version if you depend on this surface.

- **Fix misleading SPL-Token-Transfer error message in `seal.ts`.** The top-level Transfer block no longer advises consumers to "Use the Transfer ActionType instead" (`ActionType` was removed in v6). The message now reflects the current API: transfers must route through an approved DeFi program's CPI; for owner-initiated withdrawals, use `OwnerClient.withdraw()`.

**Breaking:** removal of the legacy permission re-exports from the package root. Third-party consumers of `OwnerClient` / `SigilClient` / presets / vault-creation are unaffected — the only outward change is that agents registered via presets now actually execute.

**Migration guidance — do NOT treat `FULL_CAPABILITY` as a drop-in for `SWAP_ONLY`.** The v6 on-chain model replaced the 21-bit permission bitmask with a 2-bit capability enum:

- `0` = Disabled (no execution)
- `1` = Observer (read-only, cannot sign anything)
- `2` = Operator (full spending authority) — exported as `FULL_CAPABILITY`

There is **no middle ground**. Granular per-action restriction ("can swap but cannot transfer", "can open positions but cannot add collateral") no longer lives on the capability field — it moved to on-chain `InstructionConstraints`. If your previous code imported `SWAP_ONLY` (= `1n`) intending "agent can swap," the faithful replacement is `FULL_CAPABILITY` (= `2n`) *combined with* a constraints policy that only allows your chosen DeFi programs. Using `FULL_CAPABILITY` alone gives the agent full spending authority bounded only by the vault's spending caps and protocol allowlist.

`createVault()` now validates this client-side: passing any `permissions` value outside `[0n, 2n]` throws a descriptive error before any RPC roundtrip, catching the common "I imported `PERPS_FULL | SWAP_ONLY` and things look fine" mistake immediately.
