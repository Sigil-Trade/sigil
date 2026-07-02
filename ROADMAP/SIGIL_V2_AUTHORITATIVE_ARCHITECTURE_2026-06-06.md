# Sigil v2 — Authoritative Architecture: the Agnostic, Non-Custodial Agent Guardrail

> ---
> ## ⚠️ DEFERRED / FUTURE DESIGN OF RECORD — NOT THE CURRENTLY-SHIPPED ARCHITECTURE
>
> **This document describes a "vault-signs-everything" (`invoke_signed`, zero standing agent authority) re-architecture that has NOT been built. It is retained as the design of record for *if/when* that direction is pursued — it does NOT describe how Sigil works today.**
>
> **The currently-shipped model is different:** it uses **SPL-`Approve` delegation** (the owner approves the vault/agent to spend, and the token program's `delegated_amount` is the hard cap), a per-agent **2-bit capability** (DISABLED / OBSERVER / OPERATOR), the atomic `validate_and_authorize → DeFi ix → finalize_session` sandwich, 32 instructions, 118 error codes (6000–6117), and 12 PDA account types. In particular, §2's central claim — "there is **no SPL-`Approve` delegation**" — is the *opposite* of the shipped state; do not read this file as current reality. The source of truth for what is live is the on-chain program code, not this design.
>
> A future session must NOT mistake anything below for the current architecture. Nothing here supersedes the shipped SPL-Approve model unless and until this design is explicitly adopted, built, reviewed, and merged.
> ---

**Status: DEFERRED / FUTURE DESIGN OF RECORD (report-only — no code changed; NOT currently shipped — see banner above). Supersedes** `GUARD_SPINE_AND_CUSTODY_DESIGN.md` §8 and the "Decision Fork" in `AGNOSTIC_RESET_FINDINGS_2026-06-06.md`. Those remain valid as findings/history; this is the design of record.

> **🔒 SCOPE LOCKED (2026-06-06):** Sigil's security boundary is **vault-conservation** — a transaction may only move value/control to **vault-owned** destinations and may never alter the vault's authority or lock out the owner. **Losses are out of scope:** slippage, leverage, liquidation, borrowing/debt, and PnL on any protocol the owner allowlisted are the agent trading on the owner's chosen venue — surfaced at add-time in the UI, bounded by spending caps + instant freeze, **never an on-chain Sigil mechanism.** Consequences for the text below: (1) the **owner allowlist is the primary scoping control** — the agent can only ever touch protocols the owner pinned, so "wash-trade through a malicious pool" and similar are non-issues unless the owner allowlisted that venue (their disclosed risk). (2) The **mandatory on-chain floor is the destination-owner pin + authority-unchanged assertion (§5), NOT a value floor** — §4's value/slippage "deltas" (min_output, value-conservation, exact-out ceiling) are **reclassified OPTIONAL / off-chain** (slippage is already an SDK route parameter, correctly); the only mandatory carry-over from §4 is signed-widen math for the assertions. (3) **§8.1 (perp/lend health bound) is DISSOLVED** — no health/leverage decision exists; it is out of scope.

**Provenance:** three source-grounded multi-agent runs (≈175 agents, ≈28M tokens) — `wf_06c0b5ec` (agnostic reset), `wf_01e6f2e3` (coarse), `wf_9c755a0c` (one-repo-per-agent fleet: 109 agents, 12.2M tokens, 32 repos cloned). Distilled by 6 readers, load-bearing claims re-verified against Sigil source at HEAD `06568db8` (branch `revamp/onchain-m1`), program `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK`.

---

## 1. The locked frame (physics)
- **Ownership:** the vault is the **human's** (`[b"vault", owner, vault_id]`, `owner` = the human). When the vault holds or signs, the human acts via their own account. **Sigil-the-protocol holds nothing** (Squads model: the program is code; the user's vault holds).
- **Autonomy:** the agent operates in the wild **without the human signing each action**, bounded by human-set guardrails, revocable/freezable instantly. Freedom within the rails; **can't go rogue.**
- **Three hard constraints:** (1) Sigil holds nothing. (2) No Sigil-curated protocol list. (3) Fully protocol-agnostic.
- **Scope:** all action classes — swap, perp, lend/borrow, governance, stake, payments/x402.

## 2. THE CORE MODEL — one lane: the vault signs everything

A vault PDA cannot sign a top-level instruction; it can only sign via `invoke_signed` from Sigil's program. So there is **one signer mechanic for every action class**: the vault PDA `invoke_signed`s the validated DeFi instruction, making `owner == signer == vault` for swap, perp, governance, lending, and payment alike. The venue's own `owner==signer` + `has_one=owner` rules then route ownership and settlement back to the vault with **no Sigil-curated owner-pin**.

- **The agent holds no token authority.** It signs only `validate` (to prove it is the authorized agent within policy). The vault does all the signing. There is **no SPL-`Approve` delegation** — so there is nothing for a compromised agent to misuse outside the guarded transaction.
- **One uniform guard** (mandatory, non-omittable, oracle-free, agnostic) bounds every action: owner-allowlist (the agent only touches owner-pinned programs) + **destination-owner pin** (value-out lands only in vault-owned accounts/positions) + **authority-unchanged** (the vault's `authority`/`delegate`/`close_authority` can't change, any CPI depth) + spending caps + no-lockout.

**Why not two lanes (dropped):** an earlier draft kept today's SPL-`Approve` delegation for swaps because its `delegated_amount` is a token-program-enforced hard cap. But that cap only matters *while the agent is a delegate*. With the vault signing directly and the agent holding zero authority, there is no delegation to cap — the uniform guard is the bound from the start. "Keep the hard cap" was a build-*sequencing* note (prove the guard before removing any old delegation), not an architecture fork. One lane is simpler **and** safer.

**One mechanical consequence (a Solana fact, not a second lane):** because the vault signs via `invoke_signed`, the DeFi ix runs one CPI level deeper than a top-level ix; a very deep route (some Jupiter multi-hops) can exceed the depth-4 limit and **revert** — consistent with atomic-guard-not-modifier (Sigil never reshapes the route to fit; a tx that can't be guarded reverts and the agent submits a fitting route). Per-venue devnet check (T3), not a fork.

`Decision drivers:` correctness + least-authority + simplicity (Rule B). One vault-signs lane gives `owner==signer==vault` uniformly, holds the agent to zero token authority, and presents one guard to audit/verify. Rejected: the two-lane (delegate-for-swaps) split — it preserved a redundant hard cap at the cost of two signing models and a standing agent delegation; the CPI-depth edge it avoided is handled by revert, not by a second lane.

## 3. The seal() flow, per lane (validate → act → finalize, one atomic tx, non-omittable)

- **validate_and_authorize** (rename intent → *validate_and_schedule*): top-level-only guard (`get_stack_height()==TRANSACTION_LEVEL`, `validate:152` — present); pre-checks (capability, policy_version TOCTOU `:208`, status/agent/paused, hours/cooldown); TA-11 protected-writable reentrancy (`:493`, present); **executor meta-validation** (port Squads-SAP: real `is_signer` except vault/ephemeral, declared==real writable, **ALT re-derivation**, ban Sigil-PDA-writable, strip agent `is_signer`); capture pre-CPI snapshots into `SessionAuthority`. Lane A arms `Approve(agent, hard_cap)`; Lane B arms nothing.
- **act:** Lane A — DeFi ix runs as a sibling using the agent's delegation. Lane B — `vault.invoke_signed(DeFi_ix, [b"vault", vault_authority, vault_id, bump])`, the **one** validated ix only (scoped, not general).
- **finalize_session** (own top-level guard `:118`): measure post-CPI via raw-bytes read (`:257`, F19); enforce **mandatory floor** + **authority-unchanged assertion** + spending/per-recipient caps; defer fees to **measured** spend via `transfer_checked`; Lane A revokes `Approve`.
- **CPI depth:** validate(0) + act(1 + venue's inner) + finalize(fee 1) ≤ 4. Move fees validate→finalize to free headroom.

## 4. Assertion math (see 🔒 SCOPE LOCK — the mandatory guarantee is the §5 destination-owner pin, NOT a value floor; the value deltas below are OPTIONAL/off-chain)

**Verified at source:** Sigil already ships the *primitive* — `verify_output_balance_floor` (`post_assertion_helpers.rs:116-161`) is token-program-agnostic and vault-ownership-pinned; the 8-mode assertion engine exists; snapshots run under the anti-spoof top-level guard. But it is **opt-in** (`has_post_assertions != 0`, `finalize:937`) and the only always-on floor is opt-in + stablecoin-only (`:723`). The work is four deltas:
- **DELTA-1 (signed-widen):** replace `saturating_sub` (`post_assertion_helpers.rs:157`, `finalize:319/329`) with `(b as i128 - a as i128)` — fixes the documented MaxDecrease vacuous-pass; i128 of two u64 cannot overflow.
- **DELTA-2 (NON-OMITTABLE — the actual deliverable):** add `SessionAuthority.min_output_amount: u64`; enforce **unconditionally** for any non-stablecoin output, gated on **measured outcome, not the agent-declared `amount`** (closes the `amount==0` self-classification hole and the +1-lamport dust-fill at `finalize:439`). Slippage-relative (`value_out ≥ authorized × (1 − max_slippage_bps)`), never `>0`.
- **DELTA-3 (exact-out ceiling):** `AssertionMode::InputBalanceCeiling` (`(pre-post) ≤ max_outlay`, Orca `swap.rs:96`) for fixed-outlay actions (x402, repay).
- **DELTA-4 (Token-2022 net-of-fee):** only on the stablecoin gross-outflow accounting, only if fee-bearing stablecoins are in scope.

**Error code: `6111` (VERIFIED FREE).** `errors.rs` has 111 variants, codes 6000–6110, `IDL_ERROR_MAX=6110`; `ErrIntentDigestMismatch=6102`. The reuse draft's "6112" and the carry-forward "6111 taken" were both wrong; the cross-run check caught it. New `ErrConservationFloorMissing = 6111`.

## 5. Inner-CPI permission-escalation defense (the legacy-SPL reality)
Sigil's dangerous-opcode scan (`validate:686`) is **top-level only** — blind to ops inside a Lane-B CPI. CpiGuard (`processor.rs:443`, Token-2022) is the depth-proof fix **but USDC/USDT are legacy SPL** (`state/mod.rs:340/362`; no CpiGuard in Sigil). Therefore:
- **Primary (agnostic, legacy + Token-2022):** mandatory post-CPI **authority-unchanged assertion** on every vault token account touched — `delegate==None` (or unchanged), `close_authority==None`, `authority==vault`, ATA-derivation pin (Lighthouse triple). Sigil today pins **only `authority`** (`verify_ata_authority_pin`) — the `delegate`/`close_authority` pins must be **built** (grep confirms absent).
- **Defense-in-depth (Token-2022 only):** offer owner-set CpiGuard on Token-2022 vault ATAs.
- Narrow the System-program whitelist to block `Assign`/`Allocate` on vault-owned accounts.

## 6. Best-in-class Rust adopted (per component, source-cited, license-aware)
Patterns are free to learn from; **vendoring code** is constrained — copy bytes only from MIT/Apache (Solana `multi-delegator`, Phoenix, Lighthouse, Drift, MarginFi, SPL). AGPL (Swig, both Squads) + BSL (Kamino kVault, Meteora) + Orca-proprietary = **learn the pattern, write our own**.

| Component | Adopt | Source |
|---|---|---|
| bounded-delegated-authority | Drift `can_sign_for_user` two-predicate split + `!=Pubkey::default()` guard; owner-only delegate setter | `drift protocol-v2 constraints.rs:17, user.rs:4731 @0ae3e3b1` (Apache) |
| exit owner-pin (agnostic) | `dest.TokenAccount.owner == vault.owner` as an Anchor constraint | OpenBook `open_orders_account.rs:88 @f3e1742` (GPL — pattern); Mango `token_withdraw.rs:121 @ee671d24` (GPL — pattern) |
| outcome / conservation floor | signed-widen delta + min-out/max-in + anti-spoof snapshot | Lighthouse `account_delta.rs:153, memory_write.rs:103 @4c579479`; Orca `swap.rs:91` (pattern) |
| executor hardening | `new_validated` + ALT-recheck + protected-writable ban + transfer_checked | Squads SAP/V4 `executable_transaction_message.rs:80 @80bf1f7/edbca83` (AGPL — pattern) |
| agnostic execution (no list) | PDA `invoke_signed` of any downstream ix, gates = human config only | SPL Governance `process_execute_transaction.rs:88 @264ca72` (Apache) |
| cap math + anti-replay | recurring-cap window-advance + `init_id` generation counter | Solana `multi-delegator transfer_validation.rs:43 @2c6e710` (**MIT — copyable, Cantina-audited**) |
| account-model hardening | self-deriving `assert!(SIZE==size_of+8)` + `offset_of!` slop; `NonZeroPubkeyOption` | Drift-vaults `vault.rs:206 @a2208c6b` (Apache); OpenBook `pubkey_option.rs @f3e1742` |
| invariants / FV | centralized `fn invariant()` at every handler tail (Sigil has **zero** today) → cvlr `#[rule]` | Squads V4 `multisig.rs:139 @edbca83` (pattern) |
| upgrade-authority | counterparty upgrade-authority assertion (agnostic, no list) | Lighthouse `upgradable_loader_state.rs:18 @4c579479` |
| governance vote-safety | vote-vs-withdraw split + discriminator pin-or-wildcard | SPL-Gov `token_owner_record.rs:155 @264ca72` (Apache) |

**Reject (constraint-#2 violations, named by the agents):** compiled-in program allowlists (Swig `ProgramCurated`, Mango `flash_loan`, GLAM curated integration, Drift `WHITELISTED_SWAP_PROGRAMS`); protocol-level admin/freeze over user accounts; drift-vaults `manager_borrow` trusted-class. **And Sigil's own `KNOWN_ASYNC_FULFILLMENT_PROGRAMS` denylist** (`state/mod.rs:647`) is itself a curated list that runs *before* the human allowlist — it must be replaced by a structural settlement-shape property, not extended.

## 7. Action-class coverage (source-verified)
| Class | Lane | Custody | Agnostic floor | Status |
|---|---|---|---|---|
| Swap | A | `owner==vault` on both ATAs | two-sided value-conservation (in-window) | **clean** — add mandatory floor |
| Perp | B | Drift/Mango/Parcl/**Phoenix** native-delegate (venue enforces delegate-cannot-withdraw); Jupiter/Flash via vault-signs + venue `has_one=owner` | capital-out cap + stable floor; **PnL/leverage NOT agnostic** | **fork** (§8.1) + devnet T3 |
| Lend/borrow | B | venue `has_one=owner` on exits (Kamino) / Sigil-pinned dest (MarginFi) | **borrow is a false-negative** — leverage invisible to value-delta | **fork** (§8.1) |
| Governance | B | `owner==vault` on TokenOwnerRecord | vote = zero-value-move (balance-delta proves it) + `NoChange` on withdraw-authority/delegate + discriminator-pin to `cast_vote` | **build** (engine torn out M1-04; offsets to measure §8.4) |
| Stake | A/B | Marinade liquid = SOL↔mSOL swap (swap floor); native-stake legs allowlist-denied | swap floor | **mostly clean** |
| Payments/x402 | A | existing `agent_transfer` | magnitude + WHERE (single allowlisted recipient) | **fork** (§8.2 model) |

## 8. Decisions to escalate (genuine tier-1 / owner-risk-appetite)
- **8.1 Perp/lend HEALTH bound — DISSOLVED (2026-06-06, out of scope).** Sigil does not bound leverage/health/loss. The agent trading — including opening leveraged perps or taking a loan — on a protocol the owner allowlisted is an *authorized* action: surfaced at add-time in the UI, visible to the owner, bounded by spending caps + instant freeze. There is no decision here; the only in-scope check on these lanes is the §5 destination/settlement-owner pin (the position/proceeds return to the vault, not the agent).
- **8.2 x402 model** — Model A (vault-PDA-signed `TransferChecked`, works today, **not facilitator-verifiable** because `agent_transfer` skims fees) vs Model B (agent session-EOA is the x402 authority). Product fork.
- **8.3 Floor shape** (recommend, can decide): owner-set policy default `min_output_bps` over per-session arg — owner-controlled, no agent input. Irreversible (seed/API).
- **8.4 Governance byte-offsets** — `governing_token_owner`/`governance_delegate` offsets in live `TokenOwnerRecordV2` (variable-length locks Vec) must be **measured on a real account**, not hardcoded from field order. Empirical gate before the governance lane.

## 9. Empirical gates (verify, never assume — before the relevant lane ships)
1. **Devnet T3** — vault-PDA open→close with a mismatched `receiving_account`/`ownerAta` must **revert** (Jupiter Perps + Flash, closed-source).
2. **CpiGuard arming via `invoke_signed`** under Anchor 0.32.1 (untested) — only matters for Token-2022 DiD.
3. **PDA-as-Signer live acceptance** on MarginFi/Kamino (code shows plain `Signer`, no e2e run).
4. **Re-verify before vendoring** any Drift/Squads/Raydium snippet not re-cloned this run.

## 10. Invariants for formal verification (cvlr, Solana dialect — Sigil has zero `fn invariant` today)
LIVENESS (owner can always freeze/withdraw; no agent/keeper can brick) · MONOTONICITY (policy_version strictly ↑, stales in-flight authz; nonce single-use) · CONSERVATION-1 (non-stablecoin output → output ATA ↑ ≥ min_output, signed-widen, **non-omittable**, err 6111) · CONSERVATION-2 (input net-decrease ≤ cap + ≤ max_outlay) · AUTHORITY-UNCHANGED (vault ATA authority/delegate/close_authority unchanged post-CPI) · NO-ESCALATION (no agent-reachable ix mutates owner/capability/policy) · CUSTODY (vault_authority + fee_destination immutable) · SNAPSHOT-INTEGRITY (snapshot only under top-level guard) · REENTRANCY (no Sigil PDA writable in DeFi metas) · SIZE-LOCK (`SIZE==size_of+8`). Add centralized `fn invariant()` to AgentVault/PolicyConfig/SpendTracker/AgentSpendOverlay; prove `bytes_match` + the floor with `#[rule]`.

## 11. Implementation plan (dependency-ordered; each step under the mandatory review pipeline: build→restore-IDL→test→adversarial code-review→fix→PR→CI)
**The sequencing is a hard correctness constraint, not a schedule (red-team tier-1):** the mandatory floor must land + be adversarially proven BEFORE Lane B's vault-signs executor, and the Lane-A `Approve` hard cap is **kept**, never removed ahead of a proven floor.
1. **Mandatory agnostic floor** (DELTA-1 signed-widen → DELTA-2 non-omittable, measured-outcome-gated → DELTA-3 ceiling), err 6111; adversarial tests: dust-fill, mint-swap, forged-snapshot, fee-on-transfer, increase-passes-decrease, amount==0. **Swap lane first** (Lane A, lowest risk, highest volume).
2. **Authority-unchanged assertion** (build delegate + close_authority pins; extend `verify_ata_authority_pin`).
3. **Centralized `fn invariant()` + cvlr rules + self-deriving size locks** (compile-time + FV; catches the SpendTracker padding-churn class).
4. **Lane-B scoped executor** with SAP meta-validation + ALT-recheck — gated on (1)+(2) proven + the devnet gates. Replace the async denylist with the structural settlement-shape property.
5. **Per-class lanes** in order: governance (after offsets measured) → perps (after the §8.1 fork + T3) → lend (after §8.1) → x402 (after §8.2).

## 12. Corrections banked (verified this arc)
`6111` is the next-free error code (not taken). Error count = 111 (6000–6110). Kamino **KLend is open-source** (`KLend2g3c…` @ `v1.12.6`), not closed. The floor primitive **exists but is opt-in** (not "spec, not code"). CpiGuard does **not** cover legacy-SPL stablecoins. The inner `agent-middleware/CLAUDE.md` is **stale** (says 71 errors / EscrowDeposit present) — fix pending. Phoenix is **native-delegate** (not a non-delegate venue).

---
**Next action:** proceed to implementation starting at step 1 (mandatory floor, swap lane) under the review pipeline — OR refine this design first. The §8.1 perp/lend-health fork is the one genuine owner-decision, due before the perp/lend lanes (not before the floor).
