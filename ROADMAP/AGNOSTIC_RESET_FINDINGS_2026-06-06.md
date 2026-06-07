# Agnostic Non-Custodial Reset — Source-Grounded Findings & Decision Fork

**Status: AUTHORITATIVE FINDINGS — FRAME RESOLVED (2026-06-06); ARCHITECTURE RUN IN FLIGHT.**

> **RESOLUTION (2026-06-06):** The "Decision Fork" below is SUPERSEDED by Kaleb's framing correction — **the vault is the *human's*** (they create it with Sigil and own it; `owner==signer==vault`), so the vault signing & owning a position is the *human* holding it (the Squads model), **not** Sigil custody. Under that frame the F4 collision largely **dissolves**: the vault signs the open (`owner==signer==vault`), the venue's own `has_one=owner` routes settlement back to the vault, and the guard watches the very account that owns the position (F2 blindness gone) — agnostic, no curation, Sigil-protocol holds nothing. Genuinely-remaining work: the vault-signs mechanic; the BUILT mandatory agnostic outcome floor (C1/C2); an agnostic permission-escalation block; the empirical gates; the accepted action-honeypot residual. A corrected-frame, on-chain-Rust source-of-truth run (`wf_01e6f2e3-b7f`, 2026-06-06) is extracting best-in-class Rust patterns across all action classes (swap/perp/lend/governance/stake/payments) and will produce the authoritative architecture. **F1–F5 below remain valid; the "Decision Fork" section is now historical.**
**Supersedes `GUARD_SPINE_AND_CUSTODY_DESIGN.md` §8** (the "scoped executor + re-instated per-protocol owner-pin" design). **DO NOT IMPLEMENT §8** — it violates hard constraints #1 (Sigil holds nothing) and #2 (no curated list). §0–§7 of that doc remain useful reference.

**Provenance:** Workflow `wf_06c0b5ec-a36` (task `wnm6wkxvp`) — 33 source-grounded agents, 3.84M tokens, 847 tool-uses, ~84 min. Raw result: `/private/tmp/claude-501/-Users-kalebrupe-Downloads-Middleware-Agent-Layer/e6d732d1-4035-45d9-b1ba-527b6ca72828/tasks/wnm6wkxvp.output` (+ 3 distillations in session tool-results). Code HEAD `06568db8`, branch `revamp/v2-2026-05`. Program ID `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK`.

## The three hard constraints (physics — from Kaleb, non-negotiable)
1. **Sigil holds NOTHING** — zero custody; no Sigil-PDA owns funds/positions; no Sigil executor that signs/holds.
2. **NO Sigil-curated protocol list** — no per-protocol adapters/offsets/owner-pins maintained by Sigil. Owner-*configured* allowlists OK.
3. **Fully PROTOCOL-AGNOSTIC** — any protocol works with zero per-protocol integration.
Plus the product requirement Kaleb called non-negotiable: **own Jupiter & Flash (and Phoenix) perp positions.**

## What is CONFIRMED (could not be disproven)

- **F1 — The corrected thesis is right, and §8 is correctly discarded.** `owner == signer` is universal across venues, and a **user-controlled PDA is accepted as `owner==signer` on Jupiter Perps, Flash, Mango, Parcl, Drift** (CONFIRMED at source: Jupiter deliberately refactored `SystemAccount→UncheckedAccount` to accept PDA owners — OtterSec OS-JPT-ADV-04 patch `802da52` + Offside PR-65; Flash `owner: Signer` + `has_one=owner` with no constraint). So the USER (not Sigil, not the bare agent) owning the position is feasible agnostically.

- **F2 — THE LOAD-BEARING REALIZATION: Sigil's current guard is ACCOUNT-bound to the vault's own ATA, not SIGNER-agnostic.** `finalize_session` only ever sees `vault_token_account` + `output_stablecoin_account`; the stable-floor sums only **vault-owned** canonical ATAs. The moment the USER owns the position, collateral routes to a **user-owned** account Sigil's finalize **cannot see** → balance-delta measures ~0, caps record nothing, floor trivially satisfied → **the guard goes blind.** Red-team R1 (CRITICAL): *"signer-agnostic ≠ account-agnostic — the conflation is the bug."* This is the single deepest finding.

- **F3 — Native-DELEGATE perps are a clean win and satisfy all 3 constraints.** Drift, Mango v4, Parcl — and **Phoenix ("Phoenix Eternal") is native-delegate too** (premise corrected: it is NOT a non-delegate venue) — separate `owner` (can withdraw) from `delegate` (can trade, **cannot** withdraw) **in the venue's own code**. User owns, agent is the venue-native delegate, the venue enforces custody, **Sigil curates nothing.** `drift-vaults` (SHA `a2208c6b`) is production proof. Mango pins delegate withdrawals to `ATA(owner)` natively; Parcl/Drift gate withdraw on `has_one=authority`.

- **F4 — Non-DELEGATE perp custody (Jupiter, Flash) is the collision — and it is information-theoretic + account-model, not a design gap.** To *own* a Jupiter/Flash position safely you must either (a) have Sigil read/verify the user's position via a **per-venue account map / owner-pin offset** (breaks #2/#3 — this is §8), or (b) own it in a user-controlled account that is **not** Sigil's gated vault (then Sigil's funding-gate is out of the funding path → Sigil demotes to an opt-in hook = the Squads/Swig footgun). Flash `funding_account has_one=owner` **CONFIRMS the two custody domains do not stack.** And a perp's **mark-to-market PnL + keeper settlement-return are out-of-window** — there is **no agnostic in-window outcome** to assert. Today Jupiter Perps + Drift v2/JIT are **hardcoded-denied** (`KNOWN_ASYNC_FULFILLMENT_PROGRAMS`, `state/mod.rs:647`) precisely for this reason.

- **F5 — Two LIVE CRITICALs in the EXISTING swap lane (true regardless of the fork):**
  - **C1:** the "mandatory slippage/conservation floor" we keep citing **does not exist on-chain** — `max_slippage_bps` is stored but never enforced at finalize (`SwapSlippageExceeded` was deleted in "Phase 1 Option A demolition," moved to off-chain SDK).
  - **C2:** on a stablecoin→X swap, finalize measures only the **input** (USDC) decrease (≤ authorized, passes); the **output** asset is never measured and its destination never checked → an agent holding the SPL delegation can route **100% of the output to an attacker, within caps, no revert.**
  - Net: Sigil today bounds **how much value LEAVES a vault ATA**, not what is received for it or where it lands. The "agnostic output guard" is **spec, not code.** Loss is bounded only by the per-tx/daily dollar caps.

## Corrections to prior assumptions (CONFIRMED)
- **`err 6111` IS the next-free code** (CORRECTED 2026-06-06, verified against `errors.rs` + the generated map): 111 variants, codes 6000–6110 (`IDL_ERROR_MAX=6110`); `ErrIntentDigestMismatch` is **6102**, not 6111. So `ErrConservationFloorMissing` (the mandatory-floor error) takes **6111**. [A prior run wrongly claimed 6111 was taken; the cross-run adversarial check caught it.]
- **Error count = 111 named codes** (CONFIRMED against source: codes 6000–6110, `IDL_ERROR_MAX=6110`; the earlier "144" was stale).
- **The agnostic floor is OPT-IN machinery, not "spec, not code"** (REFINED 2026-06-06, verified at source): `verify_output_balance_floor` (`post_assertion_helpers.rs:116-161`) exists, reads both `anchor_spl::token::ID` + `TOKEN_2022_PROGRAM_ID`, and pins vault-ownership — but it is gated `has_post_assertions != 0` (`finalize_session.rs:937`) and the always-on stablecoin floor is opt-in + stablecoin-only (`:723`). So F5/C1 = **make the existing floor mandatory (non-omittable) + generalize the always-on path beyond stablecoins + fix the `saturating_sub` MaxDecrease vacuous-pass** — NOT build from zero.
- **CpiGuard does NOT cover the stablecoin core** (CONFIRMED): USDC/USDT are *legacy* SPL mints (`state/mod.rs:340/362`); CpiGuard is a Token-2022 extension; no `CpiGuard` exists in Sigil. The agnostic permission-escalation defense for the vault's own *legacy-SPL* accounts is the token-agnostic **authority-unchanged post-assertion** (`AtaAuthorityPin`/`NoChange` over the ATA `authority`/`delegate` bytes), which Sigil already has — CpiGuard is Token-2022-only defense-in-depth.
- **Drift program ID** corrected to `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` (my workflow prompt's seed was stale).
- **"Async ⇒ Sigil measures 0" is over-conservative** — the OPEN's collateral *outflow* IS measured in-window; only the *return* + MTM are blind.
- **Constraint #2 is not perfectly met even today:** `KNOWN_ASYNC_FULFILLMENT_PROGRAMS` (3-program denylist) and `is_stablecoin_mint` (USDC/USDT) are Sigil-curated lists. The stablecoin numéraire is core/acceptable; the denylist is a fail-closed stopgap removable under the chosen model.

## THE IRREDUCIBLE TRADEOFF
You can have **at most three** of these four; the fourth must bend:
**{Sigil holds nothing} · {no Sigil-curated list} · {fully agnostic} · {own Jupiter/Flash positions}.**
This is proven by F2+F4, not asserted. The choice is tier-1 (custody) and irreversible → it is Kaleb's to make.

## Option space (full; no false binary)

- **Option 1 — Pure agnostic guard (strict reading of #1).** Sigil never sits in the ownership/signing path. *Owned-position* custody only on **native-delegate** venues (Drift/Mango/Parcl/Phoenix-Eternal; venue enforces custody, Sigil curates nothing). Jupiter/Flash supported as **loss-bounded swaps only — not owned positions.** Swap lane gets a real on-chain output-side conservation floor (fixes C1/C2). **Keeps all 3 hard constraints strictly; gives up owning Jupiter/Flash positions.** Smallest trusted surface.

- **Option 2 — §8 scoped-executor + curated owner-pin. REJECTED.** Owns Jupiter/Flash but breaks #1/#2/#3 for that lane. Listed only as the rejected baseline.

- **Option 3 — Sigil as a user-controlled smart-account ("Squads-for-agents").** The USER's own Sigil smart-account PDA owns positions on **every** venue incl. Jupiter/Flash (`owner==user-PDA`, CONFIRMED accepted; settlement returns to it by the venue's own `has_one=owner` — **no per-protocol pin**, because the user-account IS the owner and signs). The agent is a bounded signer. The guard is **non-omittable because it is the account's OWN program** (Sigil's code) enforcing a mandatory agnostic outcome assertion on the account's own accounts — which *also resolves F2's blindness* (the guard now lives in the owning account). **Owns Jupiter/Flash AND is agnostic AND non-curated.** Bigger build (Sigil becomes an account-abstraction program; Squads SAP `SMRTzfY6…`, OtterSec+Certora-FV, is the reference). **Hinges on the definitional question below.** This is the path Kaleb gestured at with "be like Squads V4 but for agents."

### The definitional hinge (the actual decision)
Does **"Sigil holds nothing"** mean:
- **(strict)** no Sigil program code may ever sit in the signing/ownership path, even a user-controlled one → only **Option 1** is available, and owning Jupiter/Flash non-custodially+agnostically is **genuinely impossible**; or
- **(Squads reading)** *Sigil-the-protocol/team* holds nothing — but a **user-controlled** smart-account running Sigil's code is "the user holding via code," exactly as Squads' program is code while the user's vault holds → **Option 3** is available and reconciles everything.

## True under EITHER option (build regardless)
- Build the swap-lane **on-chain output-side conservation floor** (fix C1/C2); make it **mandatory** (validate refuses an unguarded spending session), agnostic, oracle-free.
- The **action-honeypot residual** (an agent making bad/self-dealing trades *within* a user-owned position) is **not closable on-chain** for any open venue — bounded by caps + the mandatory floor + monitoring, never eliminated. Universal; everyone (incl. Drift) lives with it.

## Empirical gates required before implementing perp ownership
- **Jupiter T2/T3 (devnet):** confirm `closePositionRequest2/3` pins `ownerAta == ATA(position.owner, mint)` on keeper fill when `owner==user`; run a keeper-fill close with attacker `ownerAta ≠ owner` and assert REJECT before retiring Jupiter from the async denylist. (LIKELY-HIGH, not IDL-provable, closed-source.)
- **Phoenix Eternal (devnet `phDEVv4…`):** confirm PDA-as-authority + owner-pinned withdraw (closed-source, no IDL, private beta — LIKELY not CONFIRMED).
- **Per delegate venue:** source-verify "delegate cannot withdraw" (not "LIKELY") — "leaky Mango" flagged.
- **Adrena / Parcl:** owner-as-user-PDA acceptance untested (devnet open-as-PDA), Adrena's owner-account *constraint type* unread.
- Residual UNCERTAIN venues (programId unknown): Pacifica (off-chain matching may be custodial-at-vault), Hxro/Dexterity, GooseFX, Solayer, Percolator. Appchains (Bullet, Zeta X) have no Solana PDA-owned position (model boundary).

## Next step
**Resolve the definitional hinge / pick Option 1 vs Option 3** (AskUserQuestion posed to Kaleb 2026-06-06). Then: write the authoritative architecture doc for the chosen model, lay out the implementation plan under the mandatory adversarial-review pipeline, and (for Option 3) scope the smart-account program + the empirical gates. The M1 arc remains ~288 commits ahead of `main`, unpushed/never-CI'd — eventual PR/CI.
