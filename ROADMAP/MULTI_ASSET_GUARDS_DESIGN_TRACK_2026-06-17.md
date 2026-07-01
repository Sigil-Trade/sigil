# Multi-Asset Vault Guards — Design Track (opened 2026-06-17)

**Status:** OPEN (design track). No implementation yet. Opened during the cosign
take-over arc after the owner clarified the vault's intended scope.

**Owner directive (verbatim, 2026-06-17):** *"the vault is able to hold SOL,
WIF, BONK, etc... whatever the user at the end of the day wants to hold not just
stables. The vault will also be used to take out positions on perp dex, make
governance votes, etc... borrow and lend."*

This invalidates a stablecoin-only assumption that the **value-guard** layer was
implicitly built on. It does **not** affect the authority layer. This doc scopes
the resulting work.

---

## 1. What is NOT in scope here (already done + converged)

The **authority layer** — *who* may act — is asset-agnostic and was hardened to
convergence during the cosign take-over (branch `audit/onchain-fixes` →
`takeover/audit-fixes-finish-2026-06-16`). A leaked **owner key alone** cannot,
on a `cosign_required` vault: move funds (`withdraw_funds`), escalate an agent
(register / grant / perms-update), weaken policy (caps / destinations / floor /
slippage / fee / operating-hours), remove a guard (observe / post-assertions),
rotate/evict the cosigner, or destroy the vault (`close_vault`). All require the
bound cosigner K. These gates do not care what assets the vault holds — they
gate the owner's signature authority. **Nothing in this track changes that.**

The take-over also **reverted** a `close_vault` "empty stablecoin custody" check
(commit `c6374de8` → reverted in `3ce09f5d`): it verified only USDC/USDT, which
is the wrong shape for a multi-asset vault (false "verified-empty" signal). The
mint-agnostic replacement lives in Facet A below.

---

## 2. The problem this track addresses

A vault that holds arbitrary SPL tokens + perp/lend positions + governance power
breaks two stablecoin-centric assumptions:

1. **Value accounting is a stablecoin balance-delta proxy.** Spend caps
   (`daily_spending_cap_usd`, `max_transaction_size_usd`, per-protocol caps) are
   denominated in USD and measured in `finalize_session` as the **stablecoin**
   balance delta of the vault. An agent action that moves *non-stablecoin* value
   (swap BONK→WIF, open a 10× perp, supply to a lending market, vote) can show a
   ~zero stablecoin delta, so **the caps don't fire**. This is the "position
   world" / M2 leak: the agent can move large non-stablecoin value uncapped.

2. **Close-safety assumed a known, small custody set.** `close_vault` cannot
   enumerate the arbitrary token accounts / positions a multi-asset vault may
   own, so a per-mint "empty" check is unsound (see §1).

The authority layer bounds *who*; this track is about bounding *how much
value/risk* an agent can move across *arbitrary* assets and venues, and making
vault teardown safe regardless of holdings.

---

## 3. Facet A — Mint-agnostic close→recreate defense

**Threat (B-1, residual after the cosign-gate):** `close_vault` closes the
PolicyConfig (which holds `cosign_session_pubkey`). A vault PDA at
`[b"vault", owner/authority, vault_id]` can be **re-initialised at the same
address** after close, with `cosign_required` forced OFF, and would then control
any token account still authority'd to that PDA address — `withdraw_funds`
accepts **any** mint. The cosign-gate on `close_vault` already blocks a leaked
**owner key alone** from starting this (close needs K). The residual is the
*compromised-agent* / owner+K path, and the fact that a per-mint empty-check
can't cover arbitrary holdings.

**Recommended approach — incarnation nonce in the vault seed (un-reusable
`vault_id`):** add a monotonic `incarnation: u64` to the vault PDA seed scheme so
a re-init after close yields a **fresh PDA address** that cannot inherit *any*
orphaned token account (stablecoin or not). This kills the close→reinit
inheritance at the mechanism, mint-agnostically — no enumeration needed.

**Open design questions for Facet A:**
- Where does the incarnation counter persist across close? (A closed vault PDA
  can't store it.) Options: a tiny persistent per-`(owner, vault_id)` registry
  PDA that survives close (rent cost — the exact thing the original T-19
  deferral avoided; the owner has already overruled rent-cost as a security
  driver); or require the owner to pick a fresh `vault_id` each time (UX burden,
  no protocol guarantee).
- This is a **one-way seed-scheme change** (irreversible; affects every PDA
  derivation + the SDK). Needs explicit owner sign-off before implementation.
- Orphaning vs loss: with an un-reusable `vault_id`, closing a still-funded vault
  *permanently strands* its assets (no re-init to recover them). So Facet A
  pairs with a "withdraw-all-first" close UX, or an explicit on-chain
  enumeration-free emptiness proof — which is impossible for arbitrary mints, so
  the practical answer is a loud SDK/UX "you still hold X, Y, Z — withdraw
  before closing" guard plus accepting that close-while-funded is owner error.

---

## 4. Facet B — Non-stablecoin & position value guarding (the position world)

> **⚠️ PARTLY OBE / SUPERSEDED (read before treating as active scope).** Facet B is **no longer wholly-open scope.** Its perp/leverage/lend-health strand has been **overtaken by events**: subsequent decisions (1) **accepted the leverage/liquidation/PnL risk as a disclosed, owner-owned risk** — losses on an owner-allowlisted venue are an *authorized* agent action bounded by spend caps + instant freeze, not an on-chain Sigil mechanism (cf. the §8.1 "health bound DISSOLVED" verdict in `SIGIL_V2_AUTHORITATIVE_ARCHITECTURE_2026-06-06.md`), and (2) **shelved perp/position custody guarding** as a separate deferred track. Treat the perp-notional/leverage/lend-health and per-venue-position sub-items below as **superseded / on-ice**, not active work. The still-live residual is the **non-stablecoin *flow* value-cap gap** (an agent moving large non-stablecoin value with ~zero stablecoin balance-delta, so USD caps don't fire); read the rest of this section as background, not a committed design.

This is the hard, irreducible part. **The design answer largely already exists**
— the value-anchor fork was settled in the 2026-06-16 MASTER PLAN verdict:
**value-BLIND conservation over an owner-declared mint set + output-ownership
pin** (reject signed-quote/price min_out per the no-oracle ethos), with a native
lamport-plane floor, and per-venue adapters for positions (cf. the CONTROL-CLOSURE
"does the vault still control its closure?" reframe and `GUARD_SPINE_AND_CUSTODY_DESIGN.md`).
So Facet B is mostly **designed, pending implementation** — the open items below
are implementation-level + the genuinely-irreducible per-venue position wall, not
a greenfield design. The stablecoin-value-proxy works for *flow*, not held
*stock* or *positions*; position risk is per-venue.

**Sub-problems:**
- **Non-stablecoin token value caps.** To cap an agent swapping/holding BONK,
  WIF, SOL, the program needs a *value* for those — which requires a price
  source (oracle / adapter / execution-revealed). On-chain valuation of
  arbitrary tokens is the open agnostic-valuation problem. Today: uncapped.
- **Perp positions (Drift/Flash/etc.).** Notional, leverage, liquidation risk
  are per-venue concepts; a USD spend-cap doesn't express "max 5× leverage" or
  "max $X notional." Per-venue guard adapters are likely required (cf.
  `ROADMAP/GUARD_SPINE_AND_CUSTODY_DESIGN.md`).
- **Lend/borrow.** Borrowing increases liabilities without a stablecoin
  out-flow; collateral can be seized. Health-factor / max-LTV guards are
  per-venue.
- **Governance votes.** Not a value movement but a power exercise; may warrant
  its own allow/deny + cosign policy rather than a value cap.

**Open design questions for Facet B:**
- What is the *agnostic* guarantee for non-stablecoin/position activity, vs what
  must be *per-venue*? (Prior work: an agnostic acquisition-conservation floor on
  measurable tokens, per-venue adapters for positions.)
- Price source + manipulation resistance for non-stablecoin value caps.
- Does this reuse the post-execution-assertion primitives (OutputBalanceFloor,
  MintDeltaCap, etc.) generalised beyond stablecoins?
- Relationship to the scoped-executor / guard-spine custody design already
  drafted in `ROADMAP/GUARD_SPINE_AND_CUSTODY_DESIGN.md`.

---

## 5. Threat-model note carried in from the 5th review (Finding 2)

A vault-owned **non-stablecoin** token account (e.g. wSOL) created via the
agent swap path (`validate_and_authorize` is **agent-signed only**; owner is
structurally barred from being an agent) survives `close_vault` and is
`withdraw_funds`-drainable (any mint). This is **not** a leaked-owner-key lane
(creating the balance needs the agent key) — it is a compromised/colluding-agent
lane. Facet A's incarnation nonce closes the close→reinit half; Facet B governs
how much non-stablecoin value an agent can route in the first place.

---

## 6. Recommended sequencing

1. **Finish the authority-layer arc to PR first** (cosign hardening — done;
   pending: kit SDK lockstep + coverage + merge). Independent of this track.
2. **Facet A (incarnation nonce)** — smaller, mint-agnostic, high-value; needs an
   owner decision on the persistent-counter mechanism (irreversible seed change).
3. **Facet B (position-world value guarding)** — the large design effort; align
   with `GUARD_SPINE_AND_CUSTODY_DESIGN.md`. Likely agnostic-floor + per-venue
   adapters.

**Decision drivers:** correctness/security ranked first — Facet A is a contained,
mint-agnostic mechanism that removes a whole drain class; Facet B is the
irreducible per-venue position-risk problem and is sequenced after the
authority-layer PR because it is a larger, independent design effort, not because
of calendar pressure.
