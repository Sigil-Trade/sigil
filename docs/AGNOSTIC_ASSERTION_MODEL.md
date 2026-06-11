# Sigil — Protocol-Agnostic Assertion Model (Golden-Goose Design Brief)

**Status:** DESIGN BRIEF (report-only — north-star spec; no code changed by this doc)
**Date:** 2026-05-30
**Grounded in:** code recon (file:line), Lighthouse source research (`Jac0xb/lighthouse`), and prior in-repo research (`docs/revamp/AUDIT_2026_05_25/research/M1_LIGHTHOUSE.md`, 2026-05-18).
**Supersedes framing in:** the deleted `v2-blueprint/` constraints-engine direction.

---

## 0. One-paragraph thesis

Sigil is a best-in-class, **non-custodial** guardrail for AI-agent wallets on Solana. It lets a human *or* an AI agent stand up a vault in seconds, give an agent execute-only spending power, and **guarantee the agent cannot do anything the owner didn't allow** — measured not by trusting the agent's declared intent, but by **asserting on the vault's observable on-chain state before and after every transaction.** This is the Lighthouse model, but *enforced by the program itself* rather than appended hopefully by a wallet. The golden goose is that this protection is **100% protocol-agnostic**: it constrains *any* protocol — known or unknown, today or future — without parsing that protocol's instructions, because it only ever checks what actually happened to the vault.

---

## 1. The corrected framing (what changed, and why)

**DEAD:** the bespoke instruction-**parsing** constraints engine (`InstructionConstraints` — owner-supplied byte-offsets + operators + account-meta indices dispatched against each protocol's instruction data). It is the thing that kept spawning CRIT/HIGH findings, because to configure it you must know a protocol's exact instruction layout, and an attacker who routes value differently than the asserted offsets evades it. It cannot be both protocol-agnostic *and* caveat-free. It dies.

**ALIVE (the golden goose):** protocol-agnostic protection via **state/outcome assertions** — assert on observable account state (balances, owner, delegate, mint, deltas, effective slippage computed from deltas) before/after the tx. Agnostic *by construction*: it never needs to know what program ran. **This is not new work — Sigil is ~80% there already** (§3).

**The load-bearing distinction:** the parsing engine constrains the **path** (which instruction, which bytes). State-assertions constrain the **outcome** (what the vault looks like after). The outcome is what the owner actually cares about, and it's the only thing that generalizes to every protocol.

---

## 2. Why Sigil is *ahead* of Lighthouse (the key architectural fact)

Lighthouse (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`, OtterSec+Neodyme audited, shipped in Phantom as "Guard Instructions") has one structural weakness: **nothing forces the assertion instruction to be included.** It's advisory — the tx builder (wallet) chooses to append it. An adversarial agent would simply omit it.

**Sigil closes exactly that gap.** The on-chain authorizer (`validate_and_authorize`) will not authorize a session unless a matching `finalize_session` (which runs the assertions) is present in the same atomic transaction — enforced by the forward-scan. The agent *cannot omit the guard*. As the prior M-1 research put it: *"Sigil's sandwich is a specialized, enforced Lighthouse."* On the binding guarantee, we are strictly stronger than the reference implementation.

This is the moat. Keep it central to every design decision: **agnostic assertions only bind if the program requires their presence + parameters at authorize-time.**

---

## 3. Current agnostic surface — what's ALREADY built (KEEP)

All of the following read the **universal SPL / Token-2022 layout** (`0..32` mint, `32..64` owner, `64..72` amount u64-LE — identical for both token programs) and assert on observable state. Zero protocol knowledge.

| Mechanism | file:line | What it guarantees |
|---|---|---|
| **Balance-delta sandwich** (the engine) | `finalize_session.rs:240-498` | Spend = REAL measured token-balance delta (raw post-CPI re-read defeats Anchor stale cache, per F19/H-2), not declared intent. Enforces per-tx + rolling-24h + per-agent + per-protocol caps on the measured number. |
| **MintDeltaCap** (drain ceiling) | `utils/post_assertion_helpers.rs:31-65` | A mint's vault-wide balance can't drop more than X in one tx. |
| **AtaAuthorityPin** | `post_assertion_helpers.rs:69-102` | A token account's authority stays the vault (no delegate/owner hijack). |
| **OutputBalanceFloor** | `post_assertion_helpers.rs:116-161` | A vault-owned token account must increase by ≥ Y. |
| **Stable-balance floor (TA-12)** | `finalize_session.rs:665-720+` | Vault's combined USDC+USDT never drops below a reserve. |
| **Per-recipient cap (TA-14)** | `finalize_session.rs:526-663` | Caps spend per destination wallet — **asserts on the destination**, which is the documented closure for drain-then-refill (see §6.1). |
| **Stablecoin value-proxy** | `state/mod.rs:537-544` | Oracle-free USD: value measured via stablecoin balance deltas. No price feed. |

### §3.1 Bakeable assertion catalog (source-verified 2026-05-30) — the BAKED-IN offset menu

Per §7.1, offsets are **baked into the program** (engineer + auditor verified once against a published standard layout), never caller-supplied. This is the concrete catalog Sigil can offer as typed assertions. Byte ranges `[start..end)`.

- **SPL Token account** (165B, owner `Tokenkeg…5DA`): `mint` 0..32 · `owner` 32..64 · `amount` 64..72 · `delegate` COption (tag 72..76 / key 76..108) · `state` @108 (0 Uninit / 1 Init / 2 Frozen) · `is_native` COption 109..121 · `delegated_amount` 121..129 · `close_authority` COption 129..165.
- **SPL Mint** (82B): `mint_authority` COption 0..36 · `supply` 36..44 · `decimals` @44 · `is_initialized` @45 · `freeze_authority` COption 46..82.
- **Token-2022** (owner `Tokenz…uEb`): first 165/82 bytes byte-identical to SPL; `account_type` @165; TLV from 166 (u16 type + u16 len + value). **High-value presence checks (assert absence / allowlist):** `PermanentDelegate`(12), `TransferHook`(14), `TransferFeeConfig`(1), `DefaultAccountState`(6) — each silently defeats balance/delegate assertions if unhandled.
- **AccountInfo** (runtime, no offset): `lamports` · `owner` (the anti-spoof gate) · `data_len` · `executable`.
- **Sysvar Clock** (40B): `slot` 0..8 · `epoch` 16..24 · `unix_timestamp` 32..40 — enables time-window / session-expiry gating.
- **Stake** (owner `Stake111…`) + **BPF Upgradeable Loader** (detect a program-upgrade-authority swap — Lighthouse has it; bake via typed deserializer, not raw offsets).
- **Reference:** Lighthouse (`Jac0xb/lighthouse`) bakes exactly this set (`AssertAccountInfo`/`TokenAccount`/`MintAccount`/`StakeAccount`/`UpgradeableLoader`/`SysvarClock`) + `TokenAccountOwnerIsDerived` (ATA-derivation check) + `VerifyDatahash`. Note Lighthouse's token assert is spl-token-only — **Sigil must accept BOTH token programs**.

**MUST-PRECEDE anti-spoof checks before trusting any baked offset:** (1) **verify `account.owner` == the program whose layout you baked** — THE load-bearing gate (any account can hold arbitrary bytes); (2) check initialized (`state != 0` / `is_initialized`) — a zeroed account reads as authority=None/amount=0 = false protection; (3) decode COption by its 4-byte LE tag, never assume Some; (4) Token-2022: discriminate by owner + `account_type`@165, **not** by size (padding collides with Multisig's 355B); (5) never read past 165/82 as base data; (6) bound the TLV walk (overrun guard); (7) pin transfer-altering Token-2022 extensions before trusting `amount`.

---

## 4. What's REMOVED (surgical — 2 files, 1 wire-in site)

| Target | file:line | Note |
|---|---|---|
| `ConstraintEntry / DataConstraint / AccountConstraint` + `DiscriminatorFormat` A5 gate | `state/constraints.rs:15-139, 266-291` | The parsing types. |
| Generic-constraints matcher | `instructions/integrations/generic_constraints.rs` (entrypoints `verify_against_entries_zc` etc.) | The dispatcher. |
| Runtime wire-in | `validate_and_authorize.rs:860-870` | The ONE call site. |
| 10 constraints handlers + 3 state files | (per teardown map) | `*_constraints_*` + `pending_constraints` + `pending_close_constraints`. |
| Jupiter slippage parser | **already gone** (`validate_and_authorize.rs:875-878` tombstones) | Phase-1 demolition. |

**⚠️ Preserve-on-removal (do NOT delete):**
- `bytes_match` / LE-compare helpers in `generic_constraints.rs` — **reused by the agnostic post-assertion path.** Move to a kept util module.
- `ConstraintOperator` enum — **shared with `post_assertions`.** Relocate to a kept module (e.g. `state/mod.rs` or a new `state/assertions.rs`).
- `ct_eq_32` (in `state/pending_constraints.rs`) — **used by the kept `apply_agent_grant`.** Move first, or the build breaks.
- `policy.has_constraints` flag is referenced by ~28 handlers — unwind carefully (this is the largest mechanical piece).

**Removal weakens nothing agnostic** — caps, allowlists, sessions, and all §3 primitives are independent of the parser. It DOES drop **call-graph control** (see §6.2).

---

## 5. What's REPURPOSED (the slippage golden example)

**`policy.max_slippage_bps`** survives as pure config (its on-chain parser is already deleted). Re-point it at a **universal effective-slippage guard computed from the token deltas the sandwich already measures**:

> assert: output-ATA `amount` increased by ≥ `min_out` **AND** input-ATA `amount` decreased by ≤ `max_in`, on **vault-owned ATAs with Mint + Owner PINNED**.

This protects the vault from scam/slow-drain-by-slippage on **any DEX** (Jupiter, Orca, Raydium, anything) *and* satisfies what Jupiter's own slippage param did — without parsing a single instruction byte. **Mint+Owner pinning is mandatory, not optional** (see §6.3 closures).

**`DeclarationConsistency` (mode 7)** — keep the agnostic (recipient, mint) owner-match; **drop** its protocol-coupled account-meta-index dependency (its own docstring admits ix-data-routed protocols bypass it).

---

## 6. The "NO CAVEAT" answer — engineered, not assumed

State-assertions are caveat-free for a large, well-defined class. There are exactly **three** edges where a naive "assert and done" leaks. Each is named with its closure. *This section is the heart of the brief — "no caveat" means we know every edge and close it, not that edges don't exist.*

### 6.1 Net-outcome only (drain-then-restore within one tx)
**Edge:** a flat assertion sees end-of-tx state; value that leaves an account and returns within the same tx nets zero and passes. Deltas compare endpoints, not the path.
**Closure (already in Sigil):** assert on the **destination**, not just the source. TA-14 per-recipient cap does this — value that left must have gone *somewhere*, and that somewhere is capped/allowlisted. Prior research flagged this exact closure. **Action:** make destination-assertion a first-class, always-on part of the model, not an optional mode.

### 6.2 No call-graph restriction ("only program P may run")
**Edge:** state-assertions bound the *result*, never *which programs/CPIs executed*. Removing the parser drops the ability to say "only Jupiter."
**Closure:** that's a **separate, parsing-free mechanism** — the program-ID **allowlist** (`is_recognized_defi` / protocol allowlist), which checks identity, not instruction bytes. Keep it for call-graph control; it composes with (doesn't conflict with) the agnostic outcome assertions. **Decision needed (§7.3):** keep vs narrow.

### 6.3 Identity & token-edge pitfalls (the slippage caveats)
**Edges + closures:**
- **Token-substitution / wrong-mint** → pin exact output **Mint** and that it lands in a **vault-owned** ATA (assert Owner, or derived-owner). Without this, an attacker delivers a junk token that "increases a balance."
- **Token-2022 fee-on-transfer / hooks** → received `amount` already nets the fee; bound conservatively and gate which Token-2022 extensions are allowed.
- **Partial fills** → a 1-unit fill satisfies a tiny `min_out`; **require both `min_out` AND `max_in`** so a partial can't drain the input side.
- **Pre-existing balance / multiple ATAs same mint** → use **deltas, not absolute totals**, and assert the specific ATA.

### 6.4 The one genuine non-agnostic input: USD value of *volatile* assets
**Edge:** "portfolio USD didn't drop > X%" across heterogeneous mints needs a **price per volatile mint** — not derivable from raw balances. This is the *only* thing state-assertions can't do agnostically.
**Closure (HARD CONSTRAINT — Kaleb 2026-05-30: NO oracles, now or near-future):** Sigil's **stablecoin-only value model is the answer, and it is oracle-free by design.** Value-denominated caps apply **only to stablecoin balances** (1 stable ≈ $1, a unit the chain reads directly). **Volatile assets are capped by QUANTITY, not USD** — agnostic, chain-readable, no price feed. There is **no "oracle-backed mode."** The trade-off is explicit and measurable: Sigil cannot enforce a USD ceiling on volatile holdings in V1; it enforces per-asset quantity ceilings instead. The **only** scenario that could later force an oracle is **stablecoin depeg** — and that would be an oracle on the *stablecoins themselves* (is USDC still ≈$1?), not volatile-asset pricing — a deferred V-next consideration, not a V1 mechanism.

### 6.5 Operational ceiling: transaction size (not CU)
**Edge:** the 1,232-byte tx limit caps how many accounts/assertions fit; many targets blow the tx.
**Closure:** assert the **minimal deterministic** target set (vault PDA + owner ATAs per allowlisted mint + counterparty), batch with `*Multi`-style grouping, and use Address Lookup Tables. Per-assert CU is small; size is the real budget.

**Net:** with 6.1–6.5 closed, the agnostic guard is caveat-free for *quantity- and stable-value-denominated outcomes on identity-pinned accounts*, with call-graph control available as a separate allowlist and volatile-USD explicitly scoped as oracle-backed. That is the honest, complete "no caveat" statement.

---

## 7. Open design decisions (yours — needed before implementation)

1. **Post-assertion offset freedom — RESOLVED (Kaleb 2026-05-30): NO caller-supplied byte offsets anywhere; NO advanced mode.** Assertions are **typed token-field checks** (amount/owner/mint) whose field position is **fixed by the assertion type**, never passed in. *Why:* (a) arbitrary-offset is a config-agnostic violation (it needs the protocol's layout to configure = the dead parsing engine relabeled); (b) Sigil **cannot validate** a caller offset without knowing that layout — so a wrong offset yields a guardrail that *looks* like protection but silently asserts a garbage field; (c) **reputation/liability** — a user sets a wrong offset, Sigil can't catch it, the dashboard shows a false "✓ protected", funds move that the user believed were guarded, and the user blames Sigil *correctly* (a platform-handed footgun is the platform's liability). One "Sigil told me I was safe and I got drained" story outweighs any missing feature. This is an instance of the **No-Unverifiable-Guarantee principle** (§0.1). Also avoids engine bloat. **Implication:** the free-offset modes 0-3 (`Absolute`/`MaxDecrease`/`MaxIncrease`/`NoChange`) are **removed or rewritten as fixed-offset typed assertions**; modes 4/5/6 (`MintDeltaCap`/`AtaAuthorityPin`/`OutputBalanceFloor`) already read fixed canonical offsets and are the template. Mirrors Lighthouse `TokenAccountAssertion` + the safe `ProgramScope` pattern.
2. **DeclarationConsistency.** Confirm the repurpose (keep recipient/mint owner-match, drop meta-index). Recommendation: yes.
3. **Program-ID allowlist (`is_recognized_defi` + async-fulfillment block).** Keep as the call-graph-control mechanism, or narrow? Recommendation: keep — it's parsing-free and provides §6.2.
4. **Volatile-asset USD.** Confirm stablecoin-only is the V1 value model (volatile = quantity caps; oracle-backed USD deferred). Recommendation: yes for V1.

---

## 8. How this connects to the product (the WOW)

- **Owner-facing constraint-builder API:** adopt Lighthouse's clean *typed* assertion DX (`AssertTokenAccount`, `AssertMintAccount`-style) as the SDK surface — agnostic primitives expressed as readable owner intent ("max $500/day", "never below $1k reserve", "≤0.5% slippage", "only these destinations"). Prior research flagged this as the one Lighthouse borrow worth taking.
- **SDK → MCP → dashboard:** an AI agent composes these assertions for a vault and hands the user a URL; the dashboard renders them in plain English ("here's exactly what the agent set up"); the **user signs last** to create + fund. Because the assertions are observable-state, the dashboard can show *and the chain can prove* precisely what the vault will and won't allow. That transparency *is* the WOW — verifiable, not promised.
- **Non-custodial invariant (unbreakable):** only the vault owner can freeze/pause/transfer-ownership. Neither the protocol nor the founder can ever touch a user vault. The agnostic guard protects the owner's funds *from the agent*; it never gives anyone power *over the owner*.

---

## 9. What implements against this brief (sequencing)

1. **(docs)** Canonical `MISSION.md` + verified `ARCHITECTURE.md` (this brief is the source for the agnostic section).
2. **(code, HIGH)** Fix the 2 audit HIGHs first — frozen-accept kill-switch gate; destination-allowlist swap bypass (the latter is part of making destination-assertion first-class per §6.1).
3. **(code, teardown)** Remove the parsing engine per §4 (move `ct_eq_32`/`bytes_match`/`ConstraintOperator` first; unwind `has_constraints`).
4. **(code, repurpose)** Universal effective-slippage from deltas + mandatory Mint+Owner pinning (§5, §6.3).
5. **(code, promote)** Elevate the §3 primitives to first-class assertions; make destination-assertion always-on (§6.1).
6. **(verify)** Tests + focused re-audit of every changed handler → clean committed baseline. Then move outward (SDK → MCP → dashboard).

---

## §3.2 Production evidence — 10-protocol deep on-chain source study (2026-05-30)

Ten battle-tested mainnet protocols' actual Rust read (source + audits cited per agent). Purpose: prove every Sigil technique is production-proven AND verify which are agnostically transferable (work on accounts the protocol did NOT create) vs protocol-internal (need self-layout knowledge — the dead-parsing-engine trap).

**Ranked trust matrix:**

| Protocol | Trust rank | Audits | Exploit history | Delta approach | Structural position |
|---|---|---|---|---|---|
| Kamino | TIER-1 (formal-verified) | Certora(+FV) / OtterSec / Offside / Sec3 / Ackee (10+, per-version) | none (fund-loss) | **OBSERVE** (pre/post delta `require_eq!`) | opaque external acct = **Sigil's position** |
| Raydium-CLMM | TIER-1 (~$1B) | OtterSec / MadShield / Kudelski | 2022 admin-KEY compromise (not code) | **OBSERVE** (`reload()`+`checked_sub`) | opaque external acct = **Sigil's** |
| Drift | TIER-1 (~$550M peak) | Trail of Bits / Neodyme / OtterSec | Apr-2026 $285M GOVERNANCE exploit (not code) | **OBSERVE** (`reload()`+`validate!`) | opaque external acct = **Sigil's** |
| Orca | TIER-1 (6 audits, 0 exploit 4yr) | Kudelski / Neodyme / OtterSec / 3×Sec3 | none | compute (fee-adjusted min-out) | controls transfer |
| Marinade | TIER-1 (4.75yr clean) | Kudelski / Ackee / Neodyme / Sec3 | none | predict + own-PDA snapshot | controls transfer |
| Jupiter Lend | HIGH (~$2B, 10mo) | 7+ firms + $107K Code4rena | none | (ERC-4626 share vault) | controls transfer; BSL-1.1 source-available |
| Meteora | HIGH (~$1B) | Halborn / Quantstamp / OtterSec / Offside / Sec3 / Sherlock / Zenith | thin-pool MEV (economic) | predict (analytic fee) | controls transfer; DLMM binary-only |
| MarginFi | HIGH (TVL collapsed $810M→$45M) | OtterSec / Sec3 / Accretion / Kamino | $160M flash-loan bug caught pre-exploit | predict (gross-up) | controls transfer |
| Phoenix | HIGH (raw, $75B cum vol) | OtterSec (0 crit) | none | authoritative-amount (no sandwich) | controls amount |
| Save/Solend | HIGH (declining ~$82M) | Kudelski / Neodyme / OSEC | 2021 config-AUTH bug, 0 loss | none (internal accounting) | controls transfer |
| Lulo | MEDIUM (closed src, IDL public, ~$86M) | Certora / Halborn / OtterSec / Offside / Sec3 | none (Certora caught crits) | its CPI example uses `reload()` delta | meta-aggregator |

**Finding 1 — OBSERVE-the-delta is the production-proven pattern FOR SIGIL'S POSITION.** Every protocol that treats a token account as opaque/external (Kamino, Raydium-CLMM, Drift — ~$3.5B+ combined, one FORMALLY VERIFIED) uses pre/post balance-delta: snapshot `amount` → CPI → `reload()` → `checked_sub`/`require_eq!` the delta. Protocols that CONTROL their own transfer (Orca/MarginFi/Meteora/Phoenix/Save) predict/compute instead — because they know their own math. Sigil wraps UNTRUSTED protocols → it is structurally Kamino/Raydium/Drift → observe-delta is correct, oracle-free, parsing-free, and battle-tested. Canonical reference impl: Kamino `post_transfer_vault_balance_liquidity_reserve_checks` (conservation + exact-delta invariants) and Raydium CLMM `exact_internal`.

**Finding 2 — the universal-offset answer (Kaleb's question), SETTLED across Anchor + raw + native:** The SPL/Token-2022 token-account base layout is the 100%-present cross-protocol universal: **`mint` 0..32 · `owner` 32..64 · `amount` 64..72 (u64 LE) · LEN 165 · NO discriminator.** Confirmed read at these exact offsets by Kamino (`amount`), Drift (`amount`), Meteora (raw `mint`), Phoenix (all three), Save (native unpack, all three). MANDATORY PRE-REQ, unanimous across Phoenix/Save/Kamino/Meteora: **assert `account.owner == the token program` BEFORE trusting the offset** (else a spoofed 165-byte account lies). The Anchor 8-byte discriminator `0..8` is NOT universal — refuted by Phoenix (keccak(id‖typename)), Save (1-byte version tag), Raydium-AMM-v4 (none). Second universal: SPL-stake-pool native pair `total_lamports@258` / `pool_token_supply@266` (every LST: Sanctum/Jito/Blaze) for LST value-conservation. ⇒ Sigil's reader branches on owner-program first; bakes SPL offsets; never assumes a discriminator on a foreign program.

**Finding 3 — foreign-account-validation TRIAD (production-sourced, Phoenix + Save + Meteora):** (1) `account.owner == expected token program`; (2) pin which token program is canonical; (3) read at fixed SPL offset (or `transfer_checked` to delegate mint+decimals enforcement). Plus PDA re-derivation + `info.key == derived` to pin a known account (MarginFi/Phoenix/Save). This is Sigil's anti-spoof discipline, unanimously practiced.

**Finding 4 — Token-2022 extension gating is UNANIMOUS among top protocols:** Orca (badge-gate PermanentDelegate/TransferHook, reject NonTransferable), Kamino (`check_only_supported_liquidity_token_extensions`), Drift (reject nonzero transfer-fee), Meteora/Raydium (analytic fee handling). Strongest must-adopt signal — these extensions silently defeat a naive delta check. Sigil must gate them.

**Finding 5 — Sanctum Infinity = Sigil's thesis ALREADY SHIPPING.** Per-LST "SOL Value Calculator" programs read a FOREIGN protocol's state account and mirror its value math — no oracle, no instruction parsing — 3-firm audited, 1.5yr+ clean. Live mainnet proof the read-foreign-state-and-mirror-outcome model is sound. Reference implementation to study.

**Finding 6 — the trust/exploit lesson VINDICATES the non-custodial + no-admin-kill-switch posture.** The three largest incidents among these were NOT value-flow/contract bugs: Drift $285M (governance: durable-nonce multisig social-engineering + ZERO-timelock 2/5 multisig + fake-collateral), Raydium $2.2M (admin key compromise), Save (config-auth bug). The on-chain invariants HELD; the trust boundary/governance collapsed. Direct $285M evidence for [[project-sigil-non-custodial-no-protocol-freeze]] and against weak-signer admin kill-switches. Also: Save's per-reserve `RateLimiter` (max_outflow/window) independently validates Sigil's velocity/rate-cap layer.

**Bottom line — every Sigil primitive is production-proven AND agnostically transferable:** observe-the-delta sandwich (Kamino/Raydium/Drift) · universal SPL offsets + owner-pin (all) · foreign-account triad (Phoenix/Save) · Token-2022 gating (Orca/Kamino/Drift) · rate-limiting (Save) · read-foreign-state-mirror-outcome (Sanctum). NONE require parsing a protocol's instruction data. The dead parsing engine is the ONE technique no battle-tested protocol uses agnostically — confirming its removal.

Full per-protocol reports: this session's research fleet, 2026-05-30; every claim file:line + audit-link sourced + confidence-labeled.

---

## 10. Provenance

- Code recon (agnostic-vs-parsing classification, file:line): this session, 2026-05-30.
- Lighthouse source research: `github.com/Jac0xb/lighthouse` main; Phantom "Guard Instructions"; QuickNode/Blockaid edge analysis; 2026-05-30.
- Prior in-repo research: `docs/revamp/AUDIT_2026_05_25/research/M1_LIGHTHOUSE.md` (2026-05-18) — independently reached "Sigil's sandwich is an enforced Lighthouse" + destination-assertion closure.
- On-chain audit (2 HIGH / MEDIUMs): this session, 2026-05-30.
- Non-custodial invariant: Kaleb, 2026-05-29 (memory `project-sigil-non-custodial-no-protocol-freeze`).
