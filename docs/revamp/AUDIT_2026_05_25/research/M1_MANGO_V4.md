# M-1 Research: Mango Markets v4

**Repo:** `blockworks-foundation/mango-v4` @ `dev` (single-program Anchor workspace, `programs/mango-v4`).
**Scope:** `MangoAccount` close path, open-orders lifecycle, account_close preconditions.

## Pattern

**Type-state via sentinel-index + reference-counted `in_use_count` — close path hard-fails on any active row.**

Mango carries NO per-class boolean flags. Each row in `MangoAccount`'s dynamic tail (token / serum3 / perp position / perp open-order) encodes liveness via a sentinel of its primary index:

- `TokenPosition::is_active()` → `token_index != TokenIndex::MAX` — `mango_account_components.rs:72-74`.
- `Serum3Orders::is_active()` → `market_index != Serum3MarketIndex::MAX` — `:175-178`.
- `PerpPosition::is_active()` → `market_index != PerpMarketIndex::MAX` — `:398-401`.
- `PerpOpenOrder::is_active()` — same idiom, `:849-855`.

`deactivate_*` helpers stamp the sentinel back in (`mango_account.rs:1103-1109` serum3, `:1174-1185` perp, `:1028-1031` token). The sentinel IS the lifecycle bit — no separate "in flight" tracker can desync.

Cross-class dependencies use **`TokenPosition::in_use_count: u8`**. Opening a serum3 OO or perp position calls `increment_in_use()` on its settle-token; deactivating that dependent calls `decrement_in_use()` (`serum3_close_open_orders.rs:37-40`; `mango_account.rs:1162-1163`). A token row only deactivates when `in_use_count == 0` — asserted at `mango_account.rs:1029` and `:1040`.

`account_close.rs:14-25` is canonical: if `!force_close`, require `!being_liquidated`, then `for ele in all_{token,serum3,perp}_positions(): require_eq!(ele.is_active(), false)`. Every active row hard-fails. `force_close: bool` is test-only (`account_close.rs:10-12`). Closure uses Anchor's `close = sol_destination` (`accounts_ix/account_close.rs:19`), plus `is_operational()` (`:18`) and per-ix `IxGate` (`:10`).

Serum3 deactivation requires `serum3_close_open_orders` per market — CPI-closes the external openbook OO, decrements both base+quote in_use counters, then deactivates the row (`serum3_close_open_orders.rs:33-44`). Perp deactivation requires `base_position_lots == 0`, `quote_position_native == 0`, no resting bids/asks, no taker events (`perp_deactivate_position.rs:20-36`).

## Failure history

No published audit-finding or post-mortem flags a close-path desync, orphaned-rent, or stale-flag bug in `account_close`. OtterSec / Trail-of-Bits audits (2022-2023) focused on health calc and liquidation, not close lifecycle. Most recent close-path commit: PR #1013 "perp-close" at `ee671d2`. Immunefi disclosures silent on this surface. Notable absence: sentinel-state enforced uniformly across 4 row types, 3+ years production, zero reported lifecycle bug.

## End-user recovery story

Failed `account_close` returns a deterministic `require_eq!` error naming the active class. Recovery is on-chain only via deactivate ixs: `serum3_close_open_orders` per market, `perp_deactivate_position` per perp, dust-token settlement for token rows. No admin escape — `force_close` is test-only. Pattern: "iterate close until empty, then close account." TS client automates the enumeration.

## M-1 fit verdict

**Partial.** Fits Sigil if pending PDAs are reframed as Mango-style rows: each class's liveness encoded in its own discriminator/sentinel, close_vault iterates ALL classes, hard-fails on any live one. `in_use_count` directly maps to Sigil's pending-agent-grant ↔ agent-row coupling. BUT: Mango rows live inside ONE account; Sigil's pending state lives in SEPARATE PDAs not passed to close_vault — the exact constraint that killed Option β. Mango's pattern works because the runtime CAN see every row.

## Security-first scores

- **Defense-in-depth:** 5/5 — sentinel IS the state; no separate flag to desync.
- **End-user recovery:** 4/5 — deterministic error, on-chain ixs to clear, no admin needed; -1 for no escape if a row is wedged.
- **Auditor onboarding:** 5/5 — `is_active()` definitions are 3-liners; close handler is 22 lines.
- **Long-term consistency:** 5/5 — adding a new row class means adding one `is_active()` and one line to `account_close`; 4 classes already follow the contract.

## Recommendation for Sigil M-1

Steal the **uniform hard-fail loop** and the **`in_use_count` cross-reference counter** for Sigil's α-flag design. Sigil can't use sentinel-rows wholesale (separate PDAs ≠ tail rows), but α-flags + `PendingPdaClass` trait + CI exhaustiveness test is the closest Solana-program-account equivalent. Mango proves the philosophy: **liveness lives ON the resource, close iterates exhaustively, no silent skips, no admin escape outside test mode.** Reject any δ/γ variant where some classes hard-fail and others no-op — that asymmetry has zero exemplar in 3+ years of production Mango.
