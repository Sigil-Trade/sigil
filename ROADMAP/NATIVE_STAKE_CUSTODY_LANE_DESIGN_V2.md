# Native-Stake Custody Lane — Corrected Design (v2, security-first)

> **Status: DESIGN — supersedes v1.** A 5-front adversarial audit (north-star,
> fund-loss red-team, guardrail-coherence, Agave primary-source, spike re-audit)
> found the v1 design (`NATIVE_STAKE_CUSTODY_LANE_DESIGN.md`, PR #392) **unsafe to
> build as written** — a CRITICAL missing owner-check, two tier-1 fund-strands its
> own "statelessness" created, an ethos-violating recovery gap, an unspecified
> funding path, and three north-star deviations. This v2 corrects all of them and
> records the owner's ratified decisions. **No code until the two gating spikes
> (§9) pass and the owner approves this spec.**
>
> **Owner decisions ratified 2026-06-23:**
>
> 1. **Block vault close while staked SOL is outstanding** — accept a minimal
>    on-chain custody marker (safety outranks "zero new state").
> 2. **Custody-only** — staked/native SOL is protected from theft but is **not**
>    metered by spend caps (those are stablecoin-only); this is documented, not
>    papered over as guardrail coverage.
> 3. **Spec first, then decide on building** — gated on §9 spikes.

---

## 0. What changed from v1 (audit findings → fixes)

| v1 finding (severity)                                                                                              | Fix in v2                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRITICAL** — raw-offset reads with **no `owner == StakeProgram` check**; a forged account passes admission       | §5: `stake_account.owner == stake::program::id()` is the **first** check in every instruction, before any byte read, + `disc ∈ {1,2}` + `len == 200` |
| **HIGH/tier-1** — `close_vault` stake-unaware → silent strand of staked SOL; "statelessness ⇒ zero strand" refuted | §3: minimal **StakeCustodyRegistry** marker; §6: `close_vault` blocks while marker > 0                                                               |
| **HIGH/tier-1** — Case B (vault-as-custodian lockup override) **unproven**                                         | §9 Spike-1 gates any locked-stake support; lane ships lockup-cases A+C until proven                                                                  |
| **MED-HIGH** — no owner recovery if a malicious agent refuses to deactivate (only staker can deactivate)           | §4.4: `reauthorize_staker` — owner uses the vault's _withdrawer_ power to seize the staker role (Agave-confirmed)                                    |
| **MED** — `withdraw` didn't check `staker == registered agent`                                                     | §4.3: unstake re-runs the admission predicate                                                                                                        |
| **North-star HIGH** — unstake pinned to the **owner's external wallet** (ejects custody, 2nd exit door)            | §1/§4.3: unstake destination is **the vault**; exit-to-human is the separate §4.5 path                                                               |
| **North-star MED-HIGH** — unstake made owner-only (demotes a routine agent op)                                     | §4.3: unstake-to-vault is **agent-operable under policy** (value-positive, stays in custody)                                                         |
| **North-star MED** — oversold as agnostic guardrail coverage for SOL                                               | §1: declared **custody-only**, SOL not metered (owner decision 2)                                                                                    |
| **Gap** — v1 never specified how SOL gets _into_ a stake account                                                   | §4.1: `fund_stake` (the missing instruction), binding enforced                                                                                       |
| **Overstated** — "withdraw is epoch-independent"; active-stake cooldown untested                                   | §7 models the cooling state; §9 Spike-2 proves it on Surfpool                                                                                        |

---

## 1. The corrected north-star model

**Funds stay inside the vault for their entire lifecycle.** Native SOL enters the
vault (a plain lamport transfer to the vault PDA — permissionless, untracked),
the agent stakes it (still vault-custodied), unstaking returns it **to the vault**,
and the owner exits via a dedicated owner-only SOL withdrawal. At no point does a
routine operation send funds _out_ of the custody boundary.

- **Custody, not conservation.** This lane guarantees the agent cannot _steal_
  staked SOL (the vault is always the withdrawer; the destination of every
  unstake is the vault). It does **not** meter SOL against spend caps — Sigil's
  caps/floors are stablecoin-only, and per owner decision 2 that is stated
  plainly, not implied. Staking to a poor validator is _trade-quality_, out of
  scope ("custody-not-trade-quality").
- **Owner = full authority; agent = execute-only — but unstaking is "execute."**
  Unstake-to-vault _increases_ liquid vault value and keeps it in custody, so it
  is the safest possible agent action and is **agent-operable under policy**.
  Pulling SOL out _to the human_ is the only owner-gated step (§4.5).
- **Sigil signs its own CPI here — and that is fine.** Native staking has no
  sibling instruction to guard; the vault PDA _is_ the withdrawer, so only the
  program can produce the signature. This is the same, audited primitive
  `withdraw_funds.rs` already uses. The audit confirmed the mechanism is sound;
  the v1 errors were _where funds went_ and _who could trigger it_, not _that
  Sigil signs_.

---

## 2. Verified ground truth (Agave-confirmed; do not re-litigate)

All confirmed against `solana-stake-program-2.3.13` / `solana-stake-interface`
(primary source, not docs) by two independent audit fronts:

- **Authority split holds.** The staker (agent) **cannot** withdraw or
  re-authorize the withdrawer; only the withdrawer (vault PDA) can withdraw and
  can re-authorize **either** authority. A PDA-as-withdrawer signing via
  `invoke_signed` is accepted (signer-set membership only — no curve check).
- **Withdrawer can replace the staker** → built-in owner recovery / agent
  revocation (the basis for §4.4).
- **Withdraw destination is unconstrained by the Stake program** → the
  destination pin is 100% Sigil's responsibility (load-bearing).
- **`clock`@2 and `stake_history`@3 sysvars are mandatory** in the Withdraw CPI;
  withdraw-authority@4; optional custodian@5.
- **Split/Merge preserve the withdrawer** on the child / require identical
  authorities — the agent cannot strip custody via split or merge.
- **Lockup "in force" = `unix_ts > now` OR `epoch > now`**, bypassable only by a
  signer matching `lockup.custodian`. A non-vault custodian + far-future lockup =
  **permanent brick** (tier-1) → neutralize at admission (§4.2 / §5).
- **Active stake cannot be withdrawn** — Deactivate (staker) → multi-epoch
  cooldown → Withdraw. Never atomic. A rent-exempt reserve (~0.00228 SOL) stays
  locked until a full close.
- **`EpochRewardsActive`**: at each epoch boundary _all_ stake ops revert
  transiently — automation must tolerate this, not read it as a brick.
- **Byte offsets** (disc u32@0 ∈ {1,2}; staker@12; withdrawer@44; lockup
  ts@76 / epoch@84 / custodian@92; **len == 200**) are correct **but only valid
  after the owner + discriminant checks** (§5). The v1 `MIN_DATA_LEN = 124` has
  no upstream basis; the account is always 200 bytes.

---

## 3. State model — minimal StakeCustodyRegistry (owner decision 1)

v1 was stateless; the audit proved statelessness is exactly what lets
`close_vault` strand staked SOL. v2 adds the **smallest** marker that closes that
strand, nothing more (it is a custody _count_, not a USD value — consistent with
custody-only):

- **`StakeCustodyRegistry`** PDA, seeds `[b"stake_registry", vault]`, created
  **lazily** on first `fund_stake`/`adopt_stake` (so existing vaults need no
  migration; `AgentVault` SIZE is untouched).
- Holds: `bump`, `count: u16` (outstanding vault-custodied stake accounts), and a
  **bounded** `stakes: [Pubkey; N]` list (N ≤ 10, mirroring the project's
  bounded-vector rule) so close-checking and dashboards can enumerate exactly
  which stakes block a close. `count`/list are incremented on
  `fund_stake`/`adopt_stake` and decremented on a full unstake-close.
- **Only Sigil-provisioned (`fund_stake`) or owner-adopted (`adopt_stake`) stakes
  are registered.** Attacker-named external stakes (anyone can name your vault as
  withdrawer) are **never** auto-registered, so an attacker **cannot** block your
  vault from closing. Admission (§4.2 / Decision #5) refuses to adopt
  unrecoverable (foreign-custodian-locked) stakes, so the registry only ever
  contains stakes the owner _can_ recover — meaning a close is never permanently
  blocked by something unwithdrawable.

`Decision drivers:` chose a minimal per-vault marker over v1 statelessness because
a permanent strand of staked principal on close is a **tier-1 (loss-of-control)**
failure, which outranks the "zero new state" goal lexicographically. The registry
is a separate lazily-created PDA (not an `AgentVault` field) specifically to avoid
a SIZE migration of every existing vault. Bounded list (N ≤ 10) over an unbounded
vec per the on-chain bounded-vector constraint.

---

## 4. Instruction surface (corrected)

Every instruction: `reject_cpi!()` at entry (top-level only); owner-check on any
passed stake account **first** (§5). New error codes append after 6117 (next free
is 6118; the audit confirmed 6118–6124 unused).

### 4.1 `fund_stake` (NEW — the missing on-ramp)

**Agent-operable under policy.** The vault PDA `invoke_signed`s
CreateAccount + `StakeProgram::Initialize` (and optionally `DelegateStake`) to
provision a stake account funded from **vault lamports**, with
`Authorized { staker: <registered agent>, withdrawer: <vault PDA> }` and
`Lockup { custodian: <vault PDA or none> }`.
**Enforced (or revert):** the resulting `withdrawer == vault PDA`,
`custodian ∈ {vault PDA, default}`, `staker ∈ registered agents`. Registers the
stake in the registry (§3); `count += 1`. Emits `StakeFunded`.
_Why agent-operable is safe:_ funding keeps value vault-custodied (binding
enforced on-chain), and SOL isn't metered anyway (decision 2); the only agent
discretion is validator choice (trade-quality, out of scope).

### 4.2 `adopt_stake` (was `verify_stake_admission`, now stateful)

**Owner-only** (tightened from v1's owner-or-OPERATOR — adoption mutates the
registry, so it is an owner action). For an **externally-created** stake the owner
wants the lane to manage: owner-check first (§5); assert `withdrawer == vault`,
`staker ∈ registered agents`; **hard-revert** if lockup in-force with
`custodian ∉ {vault, default}` (refuse the time-bomb — Decision #5). On success,
register it (`count += 1`), emit `StakeAdopted`. This is now a _gate with state_,
not a point-in-time attestation — the registry is the source of truth, so no
consumer is asked to trust an unverified event.

### 4.3 `unstake_to_vault` (was `withdraw_stake`, CORRECTED)

**Agent-operable under policy.** Returns SOL **to the vault** (never the human).
Two-phase by nature of staking:

- **Deactivate** (staker authority): the agent may call the Stake program directly
  (`Deactivate`), or `unstake_to_vault` can perform it when the caller holds the
  staker authority. Sets the cooldown clock.
- **Withdraw-to-vault** (withdrawer authority): after cooldown, the vault PDA
  `invoke_signed`s the Stake `Withdraw` with **`destination == vault PDA`**
  (`require_keys_eq!`, error `ErrStakeWithdrawDestNotVault`). Owner-check first;
  re-assert `withdrawer == vault` **and** `staker ∈ registered agents` (closes v1
  V2). Passes `clock`@2 + `stake_history`@3 (mandatory). On a full close
  (account → Uninitialized), `count -= 1` and de-register. Emits
  `StakeUnstakedToVault`.
- **Lockup**: ships **cases A (no/expired lockup) + C (foreign custodian → revert
  `ErrStakeLockupInForce`)** only. **Case B** (vault-as-custodian override, passing
  the vault PDA as custodian@5 via `invoke_signed`) is added **only after** §9
  Spike-1 proves it.

### 4.4 `reauthorize_staker` (NEW — owner recovery from a stuck agent)

**Owner-only**, cosign-gated. Uses the vault PDA's **withdrawer** authority to
`invoke_signed` the Stake `Authorize(Staker → owner or vault)`. This is the
recovery path for a malicious/dead agent that refuses to `Deactivate` (only the
staker can deactivate; without this the principal is stranded — v1 V8). After
re-authorizing, the owner can deactivate and `unstake_to_vault`. Agave confirms
the withdrawer may reassign the staker. Emits `StakeStakerReauthorized`.

### 4.5 `withdraw_native_sol` (NEW — the SOL exit door)

**Owner-only**, `dest == vault.owner`, cosign-gated (mirrors `withdraw_funds` for
the lamport plane, which is token-only today). Moves liquid native lamports from
the vault PDA to the owner. This is the **only** path that takes SOL _out_ of the
custody boundary, and it is owner-authority — exactly like the existing token
exit. Not metered (decision 2; owner withdrawals are uncapped, as `withdraw_funds`
already is). Emits `NativeSolWithdrawn`.

> Rationale: the audit showed there is **no** native-SOL exit in the tree today
> (`deposit_funds`/`withdraw_funds` are SPL-only). Unstaked SOL lands as native
> lamports in the vault PDA; without this instruction it could only leave at
> `close_vault`. v1 wrongly solved this by pointing _unstake_ at the owner — v2
> keeps unstake → vault and adds this clean, owner-gated SOL door.

### 4.6 `close_vault` (MODIFY)

Add: **revert if the StakeCustodyRegistry `count > 0`** (new
`ErrVaultHasOutstandingStake`). The owner must unstake + withdraw (or
`reauthorize_staker` → deactivate → unstake) all registered stakes first. Closes
v1 V10. (A registry with `count == 0` can itself be closed, reclaiming its rent.)

---

## 5. Mandatory stake-account validation (applies to every instruction reading a stake account)

Ordered, **before any byte read** — this is the v1 CRITICAL fix:

1. `require_keys_eq!(stake_account.owner, stake::program::id(), ErrStakeAccountWrongOwner)`.
2. `require!(stake_account.data_len() == 200, ErrStakeAccountWrongSize)`.
3. Read `disc = u32::from_le_bytes(data[0..4])`; `require!(disc == 1 || disc == 2, ErrStakeAccountWrongDisc)`.
4. Only now read staker@12 / withdrawer@44 / lockup@76,84,92.
   Implemented once in `#[inline(never)] read_and_verify_stake_authorities`
   (stack-frame isolation, mirroring `program_hash.rs`).

---

## 6. Errors (append-only, 6118+)

`6118 ErrStakeAccountWrongOwner`, `6119 ErrStakeAccountWrongSize`,
`6120 ErrStakeAccountWrongDisc`, `6121 ErrStakeStakerNotAgent`,
`6122 ErrStakeWithdrawerNotVault`, `6123 ErrStakeWithdrawDestNotVault`,
`6124 ErrStakeLockupInForce`, `6125 ErrStakeCustodianNotVault`,
`6126 ErrVaultHasOutstandingStake`, `6127 ErrStakeRegistryFull`.
Not policy-violation codes — do **not** extend `is_policy_violation_code`.

---

## 7. Operational states the lane must model

- **Cooling / pending.** A deactivated stake is not immediately withdrawable
  (multi-epoch cooldown, rate ~0.09–0.25/epoch). The SDK/dashboard must show a
  "cooling, available at epoch N" state; `unstake_to_vault`'s withdraw leg reverts
  `InsufficientFunds`-class until cooled. Not a bug — surface it.
- **Rent-reserve floor** (~0.00228 SOL) stays locked until a full close
  (Deactivate-all → cooldown → Withdraw-all → Uninitialized). The registry
  de-registers only on the full close.
- **EpochRewardsActive window.** All stake ops revert at epoch boundaries during
  reward distribution. Automation (and `reauthorize_staker` recovery) must
  retry/back off, never interpret as a brick.

---

## 8. Threat model (v2 — post-fix)

| ID                                       | Attack                                                                                                 | Mitigation (v2)                                                                        | Residual |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------- |
| Forged/non-stake account                 | §5 owner+disc+len check first                                                                          | none                                                                                   |
| Withdraw redirection                     | dest pinned to **vault** (unstake) / **owner** (§4.5), `require_keys_eq!`                              | none                                                                                   |
| CPI confused-deputy                      | `stake_program` address-pinned; helper fixes program id; no caller-supplied ix data; `reject_cpi!()`   | none                                                                                   |
| Cross-vault / attacker-named stake       | withdrawer==vault re-checked; registry only holds provisioned/adopted; close not blockable by attacker | dust/clutter (benign)                                                                  |
| Agent re-auth escape (staker→withdrawer) | Agave: staker cannot re-authorize withdrawer (all 3 Authorize variants)                                | none                                                                                   |
| Agent won't deactivate                   | §4.4 `reauthorize_staker` owner recovery                                                               | none                                                                                   |
| Lockup brick (foreign custodian)         | adoption hard-reverts (Decision #5); registry excludes them                                            | external-custodian stakes the owner creates _outside_ Sigil — out of scope, documented |
| Close-time strand                        | §6 close blocked while `count > 0`                                                                     | none                                                                                   |
| invoke_signed scope bleed                | per-ix signature only; `reject_cpi!()`                                                                 | none                                                                                   |

---

## 9. Gating spikes (must pass before code; owner decision 3)

1. **Spike-1 — PDA-as-custodian lockup override (Case B).** Vault PDA =
   withdrawer = lockup custodian, lockup in force, `invoke_signed` Withdraw passing
   the vault PDA as custodian@5 → assert success. Confirmed in Agave _code_, never
   tested. Blocks any locked-stake support; until it passes, ship cases A+C.
2. **Spike-2 — active-stake cooldown on Surfpool (real epochs).** `fund_stake` →
   advance epochs (warmup) → `Deactivate` → advance cooldown → `unstake_to_vault`
   to the vault. Proves the cooling state + the `staked + rent` floor behave as
   modeled with a populated `StakeHistory` (the LiteSVM spikes ran at epoch 0 with
   an empty history and never exercised real cooldown).

(Production unit tests — not spikes — must also cover the §5 negative cases:
non-stake-owned account → 6118, wrong size → 6119, wrong disc → 6120, wrong
withdrawer → 6122, dest≠vault → 6123, staker∉agents → 6121, registry full → 6127,
close-with-stake → 6126.)

---

## 10. PR sequence (under the mandatory build→test→adversarial-review→CI pipeline)

- **PR-NS1 — foundation:** `read_and_verify_stake_authorities` (§5 owner+disc+len),
  errors 6118–6127, `StakeCustodyRegistry` state + lazy init. Additive; existing
  tests stay green.
- **PR-NS2 — `fund_stake` + `adopt_stake`:** provisioning + registry increment +
  binding enforcement + negative tests + adversarial review.
- **PR-NS3 — `unstake_to_vault` (cases A+C) + `withdraw_native_sol`:** the
  vault-pinned withdraw + the owner SOL exit + cooldown handling. Highest-risk;
  most careful review. Requires Spike-2 green.
- **PR-NS4 — `reauthorize_staker` + `close_vault` block:** owner recovery + the
  close-safety gate. Changeset for the SDK builders.
- **PR-NS5 (conditional) — Case B lockup override:** only if Spike-1 passes;
  adds custodian@5 + `set_stake_lockup`.

---

## 11. Open items for the owner (remaining)

1. **Validator/delegation policy.** `fund_stake` lets the agent pick the
   validator (trade-quality, out of custody scope). Do you want an optional
   owner **validator allowlist** (custody-adjacent: limits which vote accounts the
   agent may delegate to), or fully agent-discretionary? (Allowlist = more owner
   control, more policy surface; not required for fund safety.)
2. **Where does the vault's native SOL come from?** Today deposits are SPL-only.
   Confirm the intended on-ramp: a plain lamport transfer to the vault PDA
   (untracked, custody-only — matches decision 2), or a tracked `deposit_native_sol`
   (more machinery). Decision 2 implies the former; confirm.
3. **Registry bound N.** Cap on simultaneous vault-custodied stake accounts
   (proposed N ≤ 10, per the bounded-vector rule). Acceptable?

---

_Provenance: 5-front audit 2026-06-23 (north-star, fund-loss red-team,
guardrail-coherence, Agave `solana-stake-program-2.3.13` primary-source, spike
re-audit) + owner decisions 2026-06-23. Supersedes
`NATIVE_STAKE_CUSTODY_LANE_DESIGN.md` (v1, PR #392)._
