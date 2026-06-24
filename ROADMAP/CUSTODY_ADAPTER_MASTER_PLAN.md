# Custody-Adapter Master Plan — account-position venues

> **Status: PLAN — implementation-ready, owner approval pending.** Every venue
> claim below is verified against the protocol's **own program source** (cited),
> not docs or memory, by parallel adversarial audits (2026-06-23). Native-stake is
> additionally backed by the 5-front audit against Agave. Nothing is asserted that
> wasn't primary-source-confirmed; what could not be confirmed is labelled.

---

## 1. The model (what Sigil is)

**Sigil is a destination firewall, not a value tracker.** Two rules, only two:

1. **Egress** — the vault's value leaves only to a human-allowlisted destination, or back to the owner.
2. **Return** — whatever an allowlisted venue gives back lands in the **vault**, never the agent.

Sigil does **not** track P&L, value, or judge protocol quality. The allowlist is the
human's entire trust decision; a loss inside an allowlisted venue is the human's
deliberate, accepted risk. (Spend caps are a rate-limit on top — not the custody core.)

---

## 2. Three buckets (this is the whole scope)

| Bucket                          | What it is                                                                                                                                                            | Sigil work                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **A — Token venues**            | Deposit returns a transferable SPL token to the vault (mSOL, JitoSOL, Sanctum INF/LSTs, Kamino kTokens/kVault shares, Solend/Kamino cToken supply side)               | **None** — Rule 2 applies to the token; the existing model covers it. (Caveat §7.) |
| **B — Native stake**            | Solana Stake program accounts (raw native staking **and Marinade Native** — same thing)                                                                               | **One adapter** (scoped-executor; the v2 native-stake design)                      |
| **C — Account-position venues** | Position lives in a protocol-owned account whose control is an _authority field_ (Drift `User`, MarginFi `MarginfiAccount`, Kamino `Obligation`, Solend `Obligation`) | **One small adapter per venue** (verified below)                                   |

Verified token-vs-account split (token sweep, on-chain `getAccountInfo` confirmed):

- **TOKEN (free):** mSOL `mSoLz…`, JitoSOL `J1to…`, Sanctum INF `5oVN…` + router LSTs, Kamino kTokens/kVault `sharesMint`, Solend/Kamino cTokens.
- **ACCOUNT (adapter):** Marinade Native (stake accounts, no receipt token), Kamino Lend/Multiply/Leverage (`Obligation`), MarginFi, Drift, Solend obligation side.

---

## 3. The two operation patterns (verified)

Every account-position adapter is one of these. The difference is **how the agent
operates** the position; the **exit is always vault-gated + Sigil-pinned**.

- **Delegate** — the venue has a protocol-level delegate role that can _operate but
  not withdraw_. The agent is the delegate; the vault PDA is the authority. The agent
  trades **directly** against the venue (Sigil not in the loop per-trade); Sigil only
  (a) verifies `authority == vault`, (b) gates + pins the exit. **Only Drift.**
- **Scoped-executor** — the venue has **no** delegate; the authority must sign every
  op. The vault PDA _is_ the authority, and Sigil `invoke_signed`s each validated op
  inside its guard (the GUARD_SPINE §8 scoped-executor, generalized). **Native stake,
  MarginFi, Kamino Lend, Solend.**

---

## 4. Universal adapter requirements (every venue, non-negotiable)

1. **Authority assertion** — read the position account's authority field at the
   verified offset; `require_keys_eq!(authority, vault)`.
2. **Account integrity** — `require_keys_eq!(account.owner, venue_program_id)` +
   length/discriminant check **before** any offset read (the native-stake CRITICAL
   fix, generalized — none of these layouts export an owner-offset constant).
3. **Verified-build-hash gate** — because the authority is read at a raw offset,
   pin the adapter to the venue program's build hash (reuse PR-C `program_hash.rs`);
   a venue upgrade that moves the field invalidates the adapter until re-verified.
4. **Exit-destination pin** — `require` the withdraw/borrow destination's owner ==
   vault (or the exact expected vault ATA). **Every venue leaves this open** (Drift,
   MarginFi, Solend fully; Kamino self-pins to `owner` but Sigil still pins the ATA).
   Omitting it is a tier-1 loss-of-funds hole.
5. **Discriminator whitelist** — scoped-executor signs only the exact whitelisted
   venue instructions (never a general executor); block owner-only ops (e.g.
   ownership-transfer, delegate-reassign) on the agent path.

Plus, from the v2 native-stake decisions (apply to all account positions):

- **Close-safety** — a per-vault `PositionCustodyRegistry` marker (count + bounded
  list ≤ 10) so `close_vault` blocks while any position is outstanding. Only
  Sigil-provisioned/adopted positions are registered (an attacker naming the vault as
  authority can't block close).
- **Custody-only** — positions are protected from theft, **not** metered by caps
  (documented, per owner decision).

---

## 5. On-chain architecture (implementation-ready)

A **CustodyAdapter descriptor** (config, one per venue, hash-pinned):

```
program_id            : Pubkey          // the venue program (must be in allowlist)
build_hash            : [u8;32]         // PR-C verified-build pin (layout stability)
account_discriminant  : bytes           // identify the position account type
account_len           : u32             // exact size (native-stake 200, mfi 2304, klend 3336…)
authority_offset      : u16             // native-stake 44(withdrawer)/Drift 8/mfi 40/klend 64
operation_model       : Delegate | ScopedExecutor
op_discriminators     : [bytes]         // whitelisted ops the scoped-executor may sign
exit_discriminators   : [{disc, dest_account_index}]  // exits → pin dest owner==vault
delegate_offset       : Option<u16>     // Drift 40 (assert delegate==agent, optional)
```

Three core instructions (generic over the descriptor):

1. **`custody_verify`** — owner/agent reads the position account; asserts integrity
   (req 2) + build-hash (req 3) + `authority==vault` (req 1) [+ `delegate==agent`];
   registers it in the `PositionCustodyRegistry`. Replaces v1's stateless admission.
2. **`scoped_execute`** — for ScopedExecutor venues: validate the venue ix (program ==
   descriptor.program_id ∧ in allowlist; discriminator ∈ op_discriminators; if an exit,
   pin `dest.owner == vault`), then `invoke_signed` it with the vault seeds. This is the
   GUARD_SPINE §8 scoped executor, descriptor-driven. `reject_cpi!()`, top-level only.
3. **`gated_exit`** — for both models, the vault-PDA-signed withdraw with the
   exit-destination pin; decrements the registry on a full position close.

Delegate venues (Drift) additionally need **`delegate_setup`** (vault PDA
`invoke_signed`s init-as-authority + set delegate=agent). Native stake needs its v2
set (`fund_stake`, `unstake_to_vault`, `reauthorize_staker`, `withdraw_native_sol`).

How it plugs into the firewall: **allowlisting an account-position venue = loading its
descriptor.** Token venues need only the existing program allowlist. So the human's one
action ("allow this venue") is the same; the descriptor is what teaches Sigil how to
verify custody + pin exits for the account-based ones.

---

## 6. Per-venue verified specs

| Venue                              | Program     | Model        | Authority field                                                   | Exit-pin                           | Key residual (disclose)                                                                                         | Confidence                       |
| ---------------------------------- | ----------- | ------------ | ----------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Native stake / Marinade Native** | `Stake111…` | scoped-exec  | withdrawer @ **44** (len 200, disc∈{1,2})                         | dest==vault                        | cooldown not atomic; Case-B unproven (spike)                                                                    | CONFIRMED (Agave)                |
| **Drift**                          | `dRifty…`   | **delegate** | authority @ **8**, delegate @ 40                                  | dest unconstrained → pin           | `forceDeleteUser` (admin, ~3mo-idle, →authority) = liveness only                                                | CONFIRMED (`b27ab76`)            |
| **MarginFi**                       | `MFv2hW…`   | scoped-exec  | authority @ **40** (len 2304); seat via `transfer_to_new_account` | dest unconstrained → pin           | group-admin freeze/seize over any account                                                                       | CONFIRMED (`4d57e2c`)            |
| **Kamino Lend**                    | `KLend2g…`  | scoped-exec  | owner @ **64** (len 3336; ignore `LEN=1784` decoy)                | program pins owner; Sigil pins ATA | 4 permissionless keeper exits (autodeleverage/maturity/term/orders) route to owner; admin in ownership-transfer | CONFIRMED (klend master)         |
| **Solend / Save**                  | `So1end…`   | scoped-exec  | owner (**immutable** — no reassign ix)                            | dest arbitrary → pin               | permissionless liquidation (model, don't block)                                                                 | CONFIRMED (token-lending master) |

Cross-venue adversarial result: **no agent (non-authority/delegate) drain or
relocate path was found on any venue** once `authority==vault` + the exit-pin hold.
Authority reassignment is blocked everywhere (Drift immutable-by-seed; MarginFi
current-authority-only; Kamino 3-party+admin; Solend none). All residuals are
_protocol-level_ trust (admin powers, liquidation, keeper exits) the human accepts by
allowlisting — consistent with the firewall model, **not** Sigil-closable, **disclose**.

---

## 7. What is NOT possible / honest boundaries

- **No universal/agnostic adapter.** Each account venue is a **hand-authored,
  verified descriptor** — you cannot auto-derive one from an IDL (four research walls;
  re-confirmed: every layout needed manual offset computation, no exported constant).
  New venue = new descriptor + audit + spike. Bounded, not free.
- **Token venues are free _only while held/swapped_.** Native-unstake legs touch
  accounts: mSOL delayed-unstake → ticket account; JitoSOL `withdraw_stake` → stake
  account; Sanctum `withdrawStake` → stake account. Rule: **hold the LST and exit via
  DEX swap = fully free**; gate that single native-unstake instruction only if a user
  opts into native unstaking.
- **MarginFi integration banks** (routing into Drift/Kamino/Solend) are nested
  per-venue walls — restrict the adapter to standard marginfi asset-tag banks unless
  each integration is separately verified.
- **Permissionless keeper exits & liquidation** (Kamino especially) move collateral on
  protocol triggers; value routes to the owner, but _timing_ isn't owner-controlled.
  Model them as non-agent events; never count them as agent spend.
- **Per-venue admin trust** (MarginFi freeze; Kamino admin in transfers) — disclosed
  to the owner at allowlist time, not papered over.

---

## 8. Implementation sequence (PRs + gating spikes)

**Phase F — Foundation (shared, no venue yet)**

- **PR-F1:** `CustodyAdapter` descriptor type + `PositionCustodyRegistry` (close-safety
  marker, lazy PDA) + errors; compose with PR-C `program_hash` for the build-hash pin.
- **PR-F2:** `custody_verify` (integrity + build-hash + authority==vault + register) +
  `close_vault` block while registry > 0. Generic; no venue specifics.

**Phase G — Native stake (first adapter; ships Marinade Native too)**

- **PR-G1:** the v2 native-stake set (`fund_stake`, `unstake_to_vault` dest=vault,
  `reauthorize_staker`, `withdraw_native_sol`). **Gating spikes:** Case-B PDA-custodian
  override; active-stake cooldown on Surfpool. (Detailed in `…_V2.md`.)

**Phase H — Drift (the one delegate venue; reference for the cleaner pattern)**

- **PR-H1:** `delegate_setup` (vault=authority via `invoke_signed`, delegate=agent) +
  `gated_exit` withdraw with dest-pin. Agent trades direct. **Spike:** re-confirm
  init-as-authority signing + delegate-trades + delegate-withdraw-reverts (fixes BS-7's
  non-signing-authority premise).

**Phase I — Scoped-executor account venues (MarginFi, Kamino Lend, Solend)**

- **PR-I1:** the generic `scoped_execute` (descriptor-driven validate + invoke_signed +
  exit-pin).
- **PR-I2 / I3 / I4:** MarginFi / Kamino / Solend descriptors + per-venue **spikes**
  (seat vault PDA as authority via the venue's init/transfer path; assert a non-vault
  exit destination REVERTS; assert a delegate/non-authority op REVERTS).

**Phase J — Token-venue hardening (small)**

- **PR-J1:** gate the LST native-unstake instructions (mSOL ticket / JitoSOL stake /
  Sanctum withdrawStake) when those venues are allowlisted; document hold+DEX-swap as
  the free path. No new custody primitive.

Each PR under the mandatory pipeline (build→test→adversarial-review→CI). Every venue
adapter requires its spike green before its descriptor ships.

---

## 9. Open owner decisions (most already settled)

Settled (carry from prior turns): block-close marker; custody-only (no SOL/position
metering); human allowlists the venue (= descriptor load), agent free within it; native
stake = the `(b)` withdrawer-check adapter.

Remaining:

1. **Venue order** — recommend Native-stake → Drift → Kamino Lend → MarginFi → Solend
   (stake is simplest + ships Marinade Native; Drift proves the delegate pattern; the
   three scoped-executor lenders share `scoped_execute`). Acceptable?
2. **MarginFi/Kamino admin-trust + keeper-exit disclosures** — surface these to the
   owner in the dashboard at allowlist time (recommended), or document-only?
3. **Borrowing** — allow the agent to _borrow_ against vault collateral (debt stays on
   the vault position; borrowed tokens still fenced by the egress allowlist), or restrict
   adapters to deposit/withdraw only in v1? (Borrowing is in-model but adds liquidation
   exposure = human's risk.)

---

_Provenance: parallel primary-source venue audits 2026-06-23 — Drift `protocol-v2@b27ab76`,
MarginFi `marginfi-v2@4d57e2c`, Kamino `klend master`, Solend `token-lending master`,
token sweep on-chain — + the native-stake 5-front audit (Agave `2.3.13`) + owner
decisions. Builds on `NATIVE_STAKE_CUSTODY_LANE_DESIGN_V2.md` and GUARD_SPINE §8._
