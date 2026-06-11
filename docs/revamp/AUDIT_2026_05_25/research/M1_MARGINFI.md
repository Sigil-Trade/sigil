# M-1 Research: Marginfi v2

**Repo:** `mrgnlabs/marginfi-v2` @ `main` (program `programs/marginfi`, types in `type-crate/`).
**Scope:** `MarginfiAccount` close, `Bank` close, balance/emissions lifecycle.

## Pattern

**Reference-counted close + sentinel-balance check + u64 bit-field flags. All close paths hard-fail; no silent no-op anywhere.**

Two close ixs, both reject when prerequisites are unmet:

1. `marginfi_account_close` — `instructions/marginfi_account/close.rs:6-20`. Hard-fails on `ACCOUNT_FROZEN`, then `can_be_closed()` (`state/marginfi_account.rs:150-161`): 4-condition AND — not disabled, not in flashloan, not in receivership, every slot in the 16-balance inline array has `get_side().is_none()`. Anchor `close = fee_payer` runs only after `Ok` (`close.rs:28`).

2. `lending_pool_close_bank` — `instructions/marginfi_group/close_bank.rs:12-48`. Four `check!` gates: `CLOSE_ENABLED_FLAG` set (`:22-26`); `lending_position_count == 0 && borrowing_position_count == 0` (`:28`); `total_asset_shares` and `total_liability_shares` zero-with-tolerance (`:33`); `emissions_remaining` zero-with-tolerance (`:39`).

Position counters are the reference-count primitive: `increment/decrement_lending_position_count` / `..._borrowing_position_count` (`state/bank.rs:795-810`) fire from every balance mutation (`state/marginfi_account.rs:1846-1855, 1932-1941`; `purge_delev_balance.rs:44`). `saturating_add/sub` for safety, strict `== 0` at the close gate.

**Bools vs enums.** Transient account lifecycle is packed into one `u64 account_flags` bit-field (`type-crate/src/types/user_account.rs:106-113`): DISABLED, IN_FLASHLOAN, IN_RECEIVERSHIP, IN_DELEVERAGE, FROZEN, IN_ORDER_EXECUTION. Bank lifecycle parallels this (`constants.rs:77-83`, `CLOSE_ENABLED_FLAG=1<<4`). Bit-fields chosen because states co-exist (in-flashloan AND in-receivership) — an enum forbids that. `BankOperationalState` IS an enum (`Paused|Operational|ReduceOnly`) but covers admin-pause, not pending-state. `BankConfigOpt` is a config-patch type, no lifecycle bearing. Emissions are flag-driven plus permissionless `lending_account_clear_emissions` (`marginfi_account/emissions.rs:46+`).

## Failure history

**sec3 Dec 2023, [I-1] "No easy ways to close balance account with low balance"** (page 10; fixed in `1529657`) is the direct M-1 analog. `withdraw_all`/`repay_all` required value above `ZERO_AMOUNT_THRESHOLD` before `balance.close()`. Users who drained below threshold via partial `withdraw`/`repay` had no on-chain close path — and if the bank was `ReduceOnly`, the balance was permanently wedged. Remediation: dedicated `lending_account_close_balance` ix, no threshold gate.

sec3 [L-2] flagged `withdraw_all`/`repay_all` skipping the `Paused` check — adjacent flag-desync class, patched in `ed86fbe`. Pre-0.1.4 banks-cannot-close (`close_bank.rs:22-26`) is a permanent recovery-disabled state. OtterSec 2023 found nothing on close-path lifecycle. No orphaned-rent or cancel-race postmortems across 8 audits 2023-2026.

## End-user recovery story

`marginfi_account_close` failure returns named `IllegalAction` or `AccountFrozen`. Recovery: enumerate active balances client-side (16-slot inline array), call `close_balance` per row, retry close. No admin escape on user-account close. `ACCOUNT_FROZEN` is admin-only unwind (`freeze.rs:1-20`). `lending_pool_close_bank` failure is admin-only — drain shares + clear emissions. Legacy banks have no on-chain recovery; admin manages them indefinitely.

## M-1 fit verdict

**Yes (strong) for close_bank; Partial for MarginfiAccount.** `close_bank`'s 4-gate hard-fail with reference counters is the closest Solana exemplar to Sigil's need: each pending class is a counted resource, close validates `all == 0` uniformly. Sigil's pending PDAs don't pass into close_vault, but per-class lifecycle flags in `PolicyConfig` validated all-false IS that pattern, bool-shaped. `MarginfiAccount` partially fits: `can_be_closed()` iterates an inline array Sigil can't replicate for out-of-account PDAs, but the bit-field flag layout transplants directly.

## Security-first scores

- **Defense-in-depth:** 5/5 — every gate hard-fails; counters saturate but close check is strict; flags packed into atomic u64 (no torn-write windows).
- **End-user recovery:** 4/5 — deterministic named errors, on-chain ixs to clear each class; -1 for permanent legacy-bank lockout.
- **Auditor onboarding:** 5/5 — close_bank is 36 lines, can_be_closed is 12 lines, all flag constants in one file; readable in under 5 min.
- **Long-term consistency:** 4/5 — bit-field naturally extensible, counters scale; -1 because counters added only at v0.1.4 with no migration for older banks.

## Recommendation for Sigil M-1

**Adopt α with two Marginfi-derived modifications:**

1. **Pack the 4 pending-class lifecycle bools into a single `u8` bit-field** (or fold into a reserved u64 in PolicyConfig). Marginfi's `account_flags: u64` proves bit-fields beat parallel bools on bytes (4→1) and atomicity (one load). 5th class (`pending_agent_perms[N]`) stays per-agent.
2. **Ship `admin_clear_pending_flag` from day one.** Marginfi shipped close_bank without an escape hatch and is permanently stuck supporting pre-0.1.4 banks. Retrofit after the first stale-flag incident is harder than shipping it now.

The δ+γ hybrid has zero exemplar in mature Marginfi practice — Marginfi enforces uniformly across positions AND shares AND emissions, never "some classes hard-fail and others rely on caller-attestation." A future auditor will re-file M-1 with "Marginfi does this uniformly, why don't you?"
