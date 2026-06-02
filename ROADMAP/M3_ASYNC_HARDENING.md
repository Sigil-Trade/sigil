# M3 — Async / Perps Custody Hardening (read-only)

**Created:** 2026-06-02 · **Branch:** `revamp/onchain-m1` · **Status:** PLANNED (design locked; not started)
**Origin:** the on-chain-model first-principles validation (2026-06-02). See `ENFORCEMENT_MODEL.md`
and the async-settlement / CPI-depth research. This milestone operationalizes one verdict from
that arc:

> **Async-settlement blindness is a SCOPE LINE for position MTM/PnL and a SOLVABLE FRONTIER for
> custody + capital-at-risk** — closable with read-only on-chain controls available *today*
> (no CPI depth-8, no CPI-interposition, no oracle).

All four items below are **read-only**: no new custody, no fund-origination by the Sigil program,
no per-asset valuation. They extend the existing balance-delta + post-assertion machinery.

---

## Why this milestone exists (the realignment result)

The validation arc corrected the framing of "perps are async, so Sigil is blind":

1. **The collateral outflow of an async OPEN is already measured in-transaction.** For
   request/fulfill protocols the collateral escrows into the request PDA **in the user's own
   (sandwiched) transaction**, crossing the vault's stablecoin ATA — so `finalize_session`'s
   balance-delta records it as spend (`finalize_session.rs:314-337`: `actual_spend =
   total_decrease − fees`, capped against `max_transaction_size_usd` + the daily cap). Only
   (a) the keeper's later **settlement-return** (value coming *back*) and (b) the position's
   **mark-to-market** are out-of-window.
2. **The real drain vector is custody mis-pinning, not measurement** — an agent funds a position
   from the vault but sets the position/receiver owner = agent, so the keeper settles to the
   agent. That is an account-validation gap, fixed by a positive owner-pin.
3. **The current denylist over-blocks measurable opens.** `KNOWN_ASYNC_FULFILLMENT_PROGRAMS`
   (`state/mod.rs:603-651`, rejected at `validate_and_authorize.rs:786-796`, err 6069
   `AsyncFulfillmentNotPermitted`) hard-rejects Jupiter Perps + Drift v2 + Drift JIT. Its comment
   claims *"balance-delta measurement is always 0"* — that is the over-conservative error: the
   open's collateral *is* measured; only the keeper settlement is later. It is fail-CLOSED (safe)
   but needlessly excludes high-value protocols.
4. **The honest guarantee:** *"Sigil bounds the capital an agent can commit (= max-loss for
   isolated margin) and pins custody so the position belongs to the vault; it does NOT bound the
   mark-to-market PnL of an open position."* MTM is information-theoretically outside conservation
   (a T+Δ oracle-determined payoff cannot be bounded by a time-T delta). For **isolated margin,
   committed collateral ≡ max loss**, so the cash-cap *is* the bound. For **cross-margin (Drift)**,
   flow bounds only the incremental commitment, not shared-pool / ADL exposure.

**Note:** Flash Trade's market `openPosition`/`closePosition` are **synchronous** (instant pool
settle at oracle price) — already measured by the base sandwich today, not on the denylist. Its
only async surface is limit/trigger orders (see M3-04 residuals).

---

## Scope boundary (normative)

**IN (this milestone, all read-only, available today):** floor-as-backstop, positive per-protocol
custody owner-pins, denylist retirement (per protocol, gated), honest scope-line + cap-coverage
audit.

**OUT (tracked elsewhere — do NOT scope-creep into M3):**
- **CPI-interposition** (Model B): an optional future hardening for a curated high-value allowlist,
  gated on CPI depth-8 (SIMD-0268, accepted but **NOT yet live** — expected ~Agave 4.1 / Alpenglow
  Q3 2026; **verify the on-chain feature gate before building**). It does *not* solve async (changes
  who signs, not when the keeper settles) and elevates custody to tier-1 — so it is not part of the
  async fix.
- **SOL-denominated valuation side-cap** for the safe redeemable set (SPL-LSTs + wSOL): oracle-free
  but a second unit of account; gated on the round-trip-vs-terminal-holds product decision.
- **MTM / position-risk / leverage caps:** the valuation wall — advisory (off-chain) only.
- **Cross-ledger bridges:** out-of-domain (value crosses ledgers); cap the source outflow + state
  the scope, do not attempt to follow it.

---

## Items

### M3-01 — Floor as the agnostic catastrophic backstop  ·  tier-1  ·  LANDS FIRST
**Goal:** make `stable_balance_floor` the protocol-independent, timing-independent backstop that
bounds drain regardless of which async venue or settlement timing is involved (its own comment at
`finalize_session.rs:671-673` names "per-protocol cap evasion via async fulfillment" as a threat it
catches).

**Current state (verified):** opt-in — `finalize_session.rs:694` gates the whole check on
`stable_balance_floor > 0` (default 0 = skip). Sources 1+2 (typed `vault_token_account` +
`output_stablecoin_account`, raw post-CPI re-read, `:713-763`) are **alive on seal** post-F-Q1a.
Source 3 (`ctx.remaining_accounts`, `:765-829`) — the *other* stablecoin ATA for the combined
USDC+USDT sum — depends on the caller feeding it.

**Changes:**
- (a) **Forced onboarding decision:** SDK refuses to build a funded+armed vault unless the owner
  sets `stable_balance_floor` or explicitly waives it (logged) — reuse the F-Q5 fail-closed-
  onboarding pattern (`sdk/kit/.../create-vault.ts`). Optional on-chain `require!` for vaults that
  route to async venues.
- (b) **Complete the combined-stablecoin sum on seal:** extend the F-Q1a `seal()` satisfier so it
  feeds the vault's *other* stablecoin ATA (USDT when the session is USDC, etc.) into finalize's
  `remaining_accounts` (Source 3), making the USDC+USDT floor non-omittable on the seal path.

**Accept / test:** LiteSVM (seal-path) — a sandwiched spend that drops the **combined** stablecoin
balance below the floor reverts (`ErrStableFloorViolation`) with both vault stablecoin ATAs present;
sources 1+2 confirmed already-live.

**Depends on:** F-Q1a satisfier (DONE, commit `3ed911bd`). Lands first — agnostic, protects every
vault regardless of the per-protocol work below.

### M3-02 — Positive per-protocol custody owner-pin  ·  tier-1  ·  the real drain-vector fix
**Goal:** assert the perp `Position` / receiver account's owner field **== vault** (finalize-time,
post-CPI, read-only), closing the custody-misdirection drain.

**Current state (verified):** `verify_ata_authority_pin` (`utils/post_assertion_helpers.rs:69-102`)
pins a **token account's** authority (bytes 32..64) == vault, as a finalize-time post-assertion
(R-2). It requires the account be owned by a token program — which a perp `Position` (owned by the
*perp* program) would fail. The owner-pin must be finalize-time because the `Position` is **created
during the CPI** (not readable pre-CPI).

**Changes:**
- New finalize-time assertion variant extending the R-2 pattern:
  `verify_protocol_account_owner_pin(account, owner_field_offset, expected_owner=vault,
  expected_program)` — relaxes the token-program-owner check (Position is perp-program-owned) and
  reads the owner field at a **per-protocol offset**.
- A small **hand-audited curated table** `{program_id → (account-role-to-pin, owner-field-offset)}`
  for **Jupiter Perps (`Position.owner`)** and **Drift (`User.authority`)**.
- `seal()` feeds the position account into finalize's `remaining_accounts`.
- New error: `ErrPositionOwnerMismatch` — **appended positionally** in `errors.rs`, no renumber of
  existing codes (per the error-code-blast-radius lesson).

**Accept / test:** per protocol — a perp open whose position owner ≠ vault REVERTS
(`ErrPositionOwnerMismatch`); a vault-owned position passes. Offsets verified against the live
Jupiter-Perps + Drift IDLs.

**Open question:** is the owner field at a *stable* offset per protocol? Confirm against each IDL
before shipping that protocol's pin.

### M3-03 — Retire the denylist, one protocol at a time  ·  tier-1 liveness  ·  STRICTLY GATED
**Goal:** stop over-blocking measurable opens; allow Jupiter Perps + Drift once each is pinned +
floor-backstopped.

**Changes:**
- For each protocol, **only after its M3-02 owner-pin + M3-01 floor coverage land**, remove it from
  `KNOWN_ASYNC_FULFILLMENT_PROGRAMS` (`state/mod.rs:647-651`); the open is then allowed + measured
  (`finalize.rs:314-337`) + owner-pinned + floor-backstopped.
- Correct the now-wrong denylist comment (`state/mod.rs:604-615`): the open is measured; only the
  keeper settlement-return + MTM are out-of-window.
- **Keep the denylist as the fail-closed default for any not-yet-pinned async program.**

**Accept / test:** LiteSVM — Jupiter Perps + Drift opens succeed via seal (collateral measured +
capped + owner-pinned + floor-backstopped); a *different* un-pinned async program still rejects.

**Depends on:** STRICT — never retire a protocol's entry before its M3-02 pin exists (fail-closed
discipline).

### M3-04 — Honest scope-line + cap-coverage audit  ·  claim-honesty  ·  parallelizable
**Goal:** the advertised guarantee equals the on-chain-verifiable property; named residuals are
disclosed, not silent.

**Changes:**
- (a) **Publish the scope line** — *"bounds capital committed (= max-loss for isolated margin) +
  pins custody; does NOT bound the MTM PnL of an open position"* — in `docs/`, SDK comments,
  `ENFORCEMENT_MODEL.md` (the G-table row + §5 claim-honesty), and the dashboard claim layer.
- (b) **Cap-coverage audit:** confirm open / add-collateral / margin-deposit / fees all flow
  through `finalize.rs:314-337`'s `actual_spend` (none carved out). Test-confirm.
- (c) **Document the named residuals + handling:** cross-margin (Drift) under-bounds shared-pool /
  ADL → treat conservatively or exclude; limit/trigger orders open in a later keeper tx → flagged
  gap (verify whether collateral escrows at order-creation [measurable] or only at fill [blind]);
  bridges → out-of-domain.

**Accept:** scope line consistent across docs/SDK/dashboard; cap-coverage test-confirmed; residuals
documented.

---

## Sequencing (dependency, not calendar)

`M3-01` (agnostic backstop) → `M3-02` (per-protocol owner-pin) → `M3-03` (retire denylist per
protocol, only after its pin) ; `M3-04` runs in parallel — but its cap-coverage audit (b) must
precede advertising any perps guarantee.

Each step runs the mandatory pipeline: `anchor build --no-idl` → regen/restore IDL → relevant test
suite green → adversarial code-review → PR → CI.

---

## Open decisions (Kaleb)

- **Cross-margin (Drift):** treat conservatively or exclude? (the one venue where committed
  collateral ≠ max-loss).
- **v1 scope:** ship all of M3-01..04, or a subset?
- **Per-protocol owner-field offsets:** verify against Jupiter-Perps + Drift IDLs (M3-02).
- **Limit/trigger escrow timing:** real gap or already covered (M3-04 residual)?
- **(Out-of-scope but owed):** the definitive on-chain feature-gate check for CPI depth-8 before any
  interposition work is treated as real.

---

## Verified anchors (read 2026-06-02 against `revamp/onchain-m1`)

- Denylist: `programs/sigil/src/state/mod.rs:603-651` (3 programs); reject at
  `programs/sigil/src/instructions/validate_and_authorize.rs:786-796`; err 6069
  `AsyncFulfillmentNotPermitted` at `programs/sigil/src/errors.rs:259`.
- Collateral/spend measurement: `programs/sigil/src/instructions/finalize_session.rs:314-337`.
- Floor: `finalize_session.rs:694` (gated `>0`), sources 1+2 typed (`:713-763`), source 3
  remaining_accounts (`:765-829`), `require!` (`:831-834`).
- Owner-pin primitive to extend: `programs/sigil/src/utils/post_assertion_helpers.rs:69-102`
  (`verify_ata_authority_pin`).
- F-Q1a satisfier (to extend in M3-01b): committed `3ed911bd` (`sdk/kit/src/seal.ts`).

## References

`ROADMAP/ENFORCEMENT_MODEL.md` (authoritative enforcement spec + decidability boundary),
`ENFORCEMENT_MODEL_DECISIONS.md`, the on-chain-model validation PRD
(`~/.claude/MEMORY/WORK/20260602-110403_onchain-model-first-principles-validation/`), and the
async-settlement + CPI-depth research reports.
