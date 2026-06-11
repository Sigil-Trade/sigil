# M2 — Production-Proven New Primitives (Design-Level PRDs)

**Milestone:** M2 · **Depends on:** M1 complete (clean base) · **Status:** PLAN (design-level — each item gets a full implementation PRD before its own code)

These are the agnostic primitives the 10-protocol study (`docs/AGNOSTIC_ASSERTION_MODEL.md §3.2`) confirmed as production-proven AND bakeable. Priority order = dependency order: the catalog + owner-pin is the substrate everything else reads through. None parse instruction data; none use oracles; none use caller-supplied offsets.

---

## M2-01 — Universal-offset typed assertion catalog (baked-in)

**Why:** the SPL/Token-2022 base layout is the confirmed 100% cross-protocol universal (Kamino/Drift/Meteora/Phoenix/Save all read it, Anchor + raw + native). Expand Sigil's assertion menu from today's few fields to the full safe catalog — all baked-in, auditor-verifiable, never caller-supplied (per §7.1 LOCKED).

**Catalog (exact offsets, source-verified):** SPL token acct — `mint 0..32`, `owner 32..64`, `amount 64..72`, `delegate` COption 72..108, `state` @108, `delegated_amount` 121..129, `close_authority` COption 129..165. SPL mint — `mint_authority` 0..36, `supply` 36..44, `decimals` @44, `freeze_authority` 46..82. AccountInfo (no offset) — lamports, owner, data_len. Sysvar Clock — `unix_timestamp` 32..40 (time gates). (LST/stake-pool `total_lamports@258`/`pool_token_supply@266` — defer unless LST support is in scope.)

**MANDATORY pre-req (unanimous across Phoenix/Save/Kamino):** assert `account.owner == the token program` BEFORE reading any offset; handle COption 4-byte LE tag; Token-2022 discriminate by owner + `account_type`@165 not size; bound TLV walks.

**Design decisions for the impl PRD:** which catalog fields ship in v1 (recommend the full token+mint+AccountInfo set; Clock if time-gating wanted); the typed-assertion API shape (each assertion = a typed enum variant with the field FIXED, no offset param); how it composes with the existing post-assertion framework. Evaluate `stash@{0}` (post-assertions R-1 MintDeltaCap) for reuse here.

---

## M2-02 — Token-2022 extension gating

**Why:** UNANIMOUS among top audited protocols (Orca badge-gates, Kamino allowlists, Drift rejects fee-mints). These extensions silently defeat a naive balance-delta check, so gating is a must for the agnostic core.

**Policy (LOCKED, §3 of master, Orca/Kamino-derived):** reject `NonTransferable`; gate/allowlist `PermanentDelegate` + `TransferHook` + `DefaultAccountState`; treat `TransferFeeConfig` as delta-affecting (bound conservatively / account for in the delta). OVERRIDES the dead blueprint's "allow NonTransferable."

**Design decisions for the impl PRD:** the exact allow/reject/gate matrix per extension (the 0-27 ExtensionType enum); whether gating is per-vault-policy-configurable or hardcoded; the TLV-walk helper (with overrun bound); interaction with the balance-delta sandwich (a fee/hook mint changes the realized delta — the gate is what keeps the delta honest).

---

## M2-03 — Delegate / freeze / owner integrity assertions (zero-balance-change defense)

**Why:** balance-delta assertions are BLIND to zero-balance-change attacks — `approve`/delegate grants and ownership reassignment move no tokens NOW but enable a deferred drain (the $3M+ 2024 class; flagged by in-repo prior research). Lighthouse + the integrity-pin pattern close this. Sigil has `AtaAuthorityPin` (partial); this generalizes it.

**Scope:** assert post-state integrity of vault-owned token accounts: `delegate == None` (or unchanged), `owner == vault` (unchanged), `close_authority == None` (or unchanged), `state != Frozen` unexpectedly. All read at fixed offsets from M2-01's catalog, gated by the owner-pin pre-req.

**Design decisions for the impl PRD:** which integrity fields are always-on vs policy-opt-in; how they compose into the sandwich (these are post-assertions on the vault's own accounts); ensuring they don't false-positive on legitimate owner-initiated delegate changes.

---

## M2-04 — ProgramScope-style balance-delta metering

**Why:** the purest expression of the golden goose ("call anything, never net-move more than X"), Swig-proven in production, and the slippage research confirmed delta-metering + allowlist is the REAL compromised-agent backstop. Architecturally native to `finalize_session` (where deltas are already measured). Distinct from Lighthouse: meters cumulative spend against a budget vs asserts a fixed post-state.

**Scope:** meter the net balance change of a watched vault token account against a running budget across the sandwich. **CAUTION (locked):** read the FIXED canonical SPL `amount` offset, never a caller-supplied offset (unlike Swig's offset param — that's the §7.1 trap). License: Swig is AGPL-3.0 → reimplement the pattern, never copy code.

**Design decisions for the impl PRD:** relationship to the existing spend caps / SpendTracker (is this a generalization, a new budget dimension, or defense-in-depth under them?); per-account vs per-mint budgets; window semantics (reuse the rolling-window from M1-06 MED-2 fix). This item may partly overlap existing caps — scope it against what M1 already does to avoid duplication.

---

## M2-05 — Universal slippage (stable / round-trip scope ONLY)

**Why:** the slippage research verdict was NO for universal oracle-free slippage on volatile one-way swaps (reference-rate problem; a compromised agent supplies its own quote). It IS valid oracle-free for stable↔stable (peg = reference) and round-trips (same asset both sides). Ship it ONLY in that scope, as defense-in-depth + anti-fat-finger — NOT marketed as volatile drain protection (that's the spend cap + destination allowlist, already shipped).

**Scope:** repurpose `policy.max_slippage_bps` (survives as config; on-chain parser already deleted) into a delta-derived check for the stable/round-trip slice: assert output-ATA `amount` ↑ ≥ min_out AND input-ATA `amount` ↓ ≤ max_in on vault-owned ATAs with mint+owner PINNED.

**Design decisions for the impl PRD:** how to detect "this is a stable/round-trip leg" agnostically (both legs stable, or same mint in/out); explicit doc that volatile one-way is out of scope; the min_out/max_in dual-bound (both required — kills partial-fill drain).

---

## M2 sequencing rationale
01 (catalog + owner-pin) is the substrate → 02 (gating, needs the catalog's TLV reader) → 03 (integrity, reads catalog fields) → 04 (metering, builds on caps + catalog) → 05 (slippage, narrowest, optional). Each ships independently behind M1's clean base. Each gets its own full implementation PRD + the mandatory pipeline before any code.
