# Sigil — Unified Plan (2026-06-06): folding the validated product demand into the near-complete on-chain plan

**Status: CURRENT FORWARD PLAN.** Rolls up `00_ROADMAP.md` + `STATUS.md` (the near-complete on-chain plan), the agnostic/vault-conservation reset (`AGNOSTIC_RESET_FINDINGS_2026-06-06.md`, `SIGIL_V2_AUTHORITATIVE_ARCHITECTURE_2026-06-06.md`), and the **demand-validated product scope** (customer discovery, 2026-06-06). Nothing below deletes the previous plan — it is preserved and credited in §1.

> ## ▶ RECONCILED 2026-06-27 — current state vs this 2026-06-06 plan (read first)
> `main` has moved well past this doc. Source of truth = `programs/sigil/src/errors.rs` (now through **6117**) + `STATUS.md`. Reconciliation of the §4 build order:
>
> - **§4.3 W5 audit-export wedge — ✅ DONE.** Activity CSV/JSON export wired (dashboard PR #74); blocked attempts reconstructed from failed-tx program logs in the SDK (kit PR #396 → published `@usesigil/kit@0.22.0`; dashboard consumes via PR #75). The third W5 increment — wiring the `AuditLogRejected` PDA — was **dropped on purpose**: that PDA is only written in the expired-session crank branch, so the failed-tx-log reconstruction replaced it.
> - **§4.2 on-chain hardening — ✅ largely DONE.** Shipped since this plan (errors now run to 6117): **6111** Squads-V4 ownership-custody close · **6112** output-ownership pin (the destination-owner-pin generalization this plan called for) · **6113/6114** finalize-side completeness (F-Q1b) · **6115** require-measurable-outcome · **6116/6117** verified-build gate. (= the entire `Plans/ancient-gathering-pie.md` foundation-hardening Items 1–3.)
> - **§4.1 merge/CI the M1 branch — ✅ DONE.** `main` runs the full enforcement model and devnet auto-deploys it. **Still owed:** the formal **M1-EXIT** sign-off — devnet adversarial exploit suite green + fix the 1 pre-existing **cu-budget Scenario-6** serialization test.
> - **§4.6 Step 6 (perp position-ownership / per-venue custody) — ⛔ SHELVED BY DECISION**, not pending work. Per-protocol custody adapters + native-stake were **rejected** (HARD PIN 2026-06-23: "no per-protocol adapter at all"); agnostic position custody is an epistemic wall; the volatile-outflow magnitude gap is **accepted human risk** (2026-06-26). Do not re-open without a new owner decision.
>
> **Still genuinely OPEN (the real backlog):**
> 1. **M1-EXIT formal close** (§4.1 residual) — devnet adversarial suite + cu-budget Scenario-6 fix.
> 2. **Remaining §4.2 pins** — `delegate` + `close_authority` authority-unchanged assertions (only `authority` is pinned today via `verify_ata_authority_pin`); centralized `fn invariant()` + **Certora I1** conservation rule (the F-Q9 code fix shipped as 6110, but the proof is still owed); self-deriving zero-copy size locks.
> 3. **§4.5 W4 positions** — per-venue read / portfolio indexer (display only, never the guard). **Confirmed missing** (no positions/portfolio page on the dashboard).
> 4. **§4.4 W1 allowlist editor + W2 option polish** — dashboard has `AllowlistCard` + `PolicyDrawer`, so this may be partly built; **verify before scoping**.
>
> Everything below this block is the **original 2026-06-06 plan, preserved unchanged** for lineage.

## 0. What changed (why this doc exists)
The previous on-chain plan's governing rule was **"ON-CHAIN ONLY — nothing outward (SDK/MCP/dashboard) until the base is 100%"** (`00_ROADMAP.md:6`, §5). Two things overturned that rule:
1. **The reset:** Sigil's boundary is **vault-conservation** — secure the vault (no transaction-level drain; authority can't change; owner can't be locked out); **losses are out of scope** (slippage/leverage/liquidation/debt/PnL on owner-allowlisted venues). One uniform guard: allowlist + destination-owner pin + authority-unchanged + caps + non-omittable atomic sandwich.
2. **Validated demand** (real users): agent transacts **only on allowed protocols**; **never breaks spend limits** (per-agent / per-protocol / overall / per-tx); **see activity**; **track positions**; **exportable, trackable audit trail**. (More asked-for items exist but are out-of-scope / not-possible-today — held out.)

**The fold:** M1 (the on-chain base) is **functionally done and IS the trustless control layer the demand validated** — so the value now is the **outward product layer the old plan deferred**, and the old plan's "finish M2/M3 on-chain before anything outward" gate is **retired**. `Decision drivers:` the demand validated that the outward layer is where the value + the ICP (professional operators who need control + accountability) live, and M1 already satisfies the control demand; continuing to gate outward work on M2 (now mostly superseded — §2) would be polishing the guard while ignoring the product (the roast's exact warning). Correctness/security bar is unchanged — the security model is the reset's vault-conservation, enforced by the already-shipped M1 + the small hardening in §2.

## 1. PREVIOUS PLAN — PRESERVED, DONE, the foundation (do not redo)
The M1 enforcement arc is the trustless control layer. **Shipped + green** (baseline HEAD `3e2e84e0`: **503 LiteSVM / 1868 kit / 166 cargo, 0 failing**):
- **W1 allowlist** ⇐ M1-01/F-Q1a (`is_protocol_allowed`, fail-closed) + agnostic-protocol removal. **DONE.**
- **W2 spend limits** ⇐ per-tx, daily/overall, per-agent, per-protocol, per-recipient caps (checked-math, rolling windows). **DONE** (per-protocol partial — MED-2 below).
- **Kill-switch integrity** ⇐ M1-02 frozen-accept + M1-03 systemic frozen-gate. **DONE.**
- **Agnostic-by-outcome base** ⇐ M1-04 constraints teardown + M1-05 F-Q8 output-ATA pin + F-Q2 (one DeFi ix) + F-Q4 (Token-2022 gate) + F-Q6 (OPERATOR timelock) + F-Q9 (checked spend). **DONE.**
- **Catastrophic floor** ⇐ M3-01 stable-balance-floor, canonical-ATA-pinned, opt-in. **DONE.**

**Owed to actually close the previous plan (the bridge — do this before building product on top):**
- **M1-EXIT gate** (`00_ROADMAP.md §4`): devnet upgrade-in-place + adversarial exploit suite green + fix the 1 pre-existing `cu-budget` Scenario-6 serialization test.
- **Merge/CI the M1 branch** (`revamp/onchain-m1` is far ahead of `main`, never CI'd) via PR + green CI.
- Residuals: M1-06 **MED-2** (per-protocol cap rolling-vs-boundary) — minor; M1-05 non-stablecoin upper-bound was **REJECTED** as the oracle-free valuation-wall residual (consistent with losses-out — keep rejected).

## 2. What the reset does to the old plan's remaining on-chain ambitions (reconcile, don't silently drop)
- **M2-01 universal-offset catalog → SUPERSEDED.** Curated/parsing-adjacent; dead post-M1-04 and against the no-curation constraint.
- **M2-05 universal slippage → DROPPED on-chain.** Slippage is an off-chain SDK route parameter (losses-out). Not a Sigil on-chain mechanism.
- **M2-04 balance-delta metering → REDUNDANT.** The M1 caps already meter value-out; the open "avoid duplication" decision resolves to: don't build it.
- **M2-03 integrity assertions → CARRIES FORWARD** as the reset's **authority-unchanged** assertion: build the `delegate` + `close_authority` pins (today only `authority` is pinned via `verify_ata_authority_pin`). The one M2 item that survives — folds into the §4 hardening track.
- **M3-02 per-protocol owner-pin (curated offset table) → SUPERSEDED** by the agnostic **destination-owner pin** (generalize F-Q8 across every value-out lane — no offset table). The goal (value/positions return to the owner) carries forward via the agnostic pin + native-delegate venue enforcement.
- **M3-03 retire denylist → REVISIT** under the demand: the agent should be able to *use* owner-allowlisted perp/lend venues (esp. native-delegate Drift/Mango/Parcl/Phoenix, where the venue itself enforces delegate-cannot-withdraw). The `KNOWN_ASYNC_FULFILLMENT_PROGRAMS` denylist currently blocks them; replace it with the structural destination-owner-pin property when the perp lane is actually built.
- **M3-04 honest scope-line → CARRIES FORWARD** (it *is* the vault-conservation positioning: "we secure the vault, not your losses").
- **Vault-signs one-lane re-architecture** (`SIGIL_V2_AUTHORITATIVE_ARCHITECTURE_2026-06-06.md`) → **DEFERRED design**, preserved: it's the answer for *owning positions on non-delegate owner==signer venues* (Jupiter/Flash). **Nobody asked for that yet.** Not the immediate build. `GUARD_SPINE §8` stays superseded.

## 3. NEW — the validated product layer (what the old plan deferred as "outward")
| Want | Verified state (code-grounded audit 2026-06-06) | Build |
|---|---|---|
| **W1 allowlist** | on-chain DONE; dashboard is **read-only** | allowlist **editor** UI |
| **W2 spend limits** | on-chain DONE; dashboard edits daily/per-tx/per-agent | "more options" (weekly/monthly windows, per-*destination* caps, action-granularity) = **optional new on-chain knobs, demand-gated** |
| **W3 activity** | **DONE end-to-end** (35 events → SDK feed → live `/activity`) | leave it |
| **W4 positions** | **MISSING** (deleted 2026-04-19; no venue SDK dep) | per-venue read / portfolio indexer — **read-side per-venue is fine** (display, not the guard) |
| **W5 exportable audit trail** | on-chain log is a **lossy cache** (no agent on spends, no reject reasons, 128 cap); SDK has structured records but **no file export**; dashboard "Export CSV" is a **dead button** | **THE WEDGE** — index the **event stream** (feed-complete, carries the agent) → complete queryable trail → export (CSV/JSON) + reconstruct **blocked attempts** from failed-tx logs + wire the export. ~80% there. → ✅ **DONE 2026-06-27** (#74 export, kit 0.22 blocked-attempt reconstruction, #75 consume). |

## 4. Forward build order (dependency- and value-ranked, each under the mandatory pipeline)

> ▶ Statuses (reconciled 2026-06-27, see top block): **1** merge/CI ✅ · M1-EXIT owed — **2** mostly ✅ (6111–6117) · pins+Certora-I1+size-locks owed — **3 ✅ DONE** — **4** open — **5** open (W4 missing) — **6 ⛔ shelved by decision**.
1. **Close the previous plan:** M1-EXIT gate (devnet + adversarial suite + cu-budget fix) + merge/CI the M1 branch. *Foundation passes its own gate before product is built on it.*
2. **Security hardening fold-ins** (small, alongside #1): generalize the destination-owner pin across all value-out lanes (extends F-Q8); build the `delegate`/`close_authority` authority-unchanged pins (the surviving M2-03); centralized `fn invariant()` + Certora I1 conservation rule; self-deriving zero-copy size locks (kills the SpendTracker padding-churn class). Reserve **`err 6111`** (VERIFIED free) for the conservation/floor error.
3. **W5 audit-export wedge:** event-indexer → complete trail → export (CSV/JSON) + blocked-attempt capture. Highest value, nearest win, the ICP wedge.
4. **W1 editor + W2 option polish** (dashboard UI + a couple of demand-gated on-chain knobs).
5. **W4 positions** (per-venue read / portfolio indexer).
6. **Deferred (design preserved, build only when demanded):** perp position-ownership — native-delegate venue support (revisit the denylist) → the vault-signs executor for non-delegate venues.

## 5. Cross-links + corrections
- **Previous plan (preserved):** `00_ROADMAP.md`, `STATUS.md`, `01_…`–`08_…` PRDs. M1 = done foundation.
- **Reset / deferred design:** `AGNOSTIC_RESET_FINDINGS_2026-06-06.md`, `SIGIL_V2_AUTHORITATIVE_ARCHITECTURE_2026-06-06.md`. Superseded: `GUARD_SPINE_AND_CUSTODY_DESIGN.md` §8.
- **Stale-doc corrections (verified):** inner `agent-middleware/CLAUDE.md` is wrong on error count (111, codes 6000–6110, not 71/6000–6070), `EscrowDeposit` (demolished), permission model (3-tier capability scalar, not 21-bit bitmask), and PDA sizes — fix when next touched. `programs/sigil/src/` is ground truth.
