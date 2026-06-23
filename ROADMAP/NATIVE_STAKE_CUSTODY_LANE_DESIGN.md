# Native-Stake Custody Lane — Design Specification

> Status: **DESIGN — pre-implementation, owner sign-off pending.** This document is
> the build spec for the additive _agnostic_ custody lane (BS-1). It synthesizes:
> the architecture pass, the BS-1 covenant spike (`spike/bs1-native-stake-covenant`),
> and the BS-1b `invoke_signed`-Withdraw spike (`spike/bs1b-invoke-signed-withdraw`).
> No production code is written until the **Open Decisions** below are ratified.

---

## 1. What this lane is

A native Solana stake account is initialized with
`Authorized { staker: <agent>, withdrawer: <vault PDA> }`. This splits control:

- **Agent = staker** → may `DelegateStake` / `Deactivate` / `Split` (operational).
  These go **directly** to the native Stake program, signed by the agent key.
  Sigil does **not** gate them — the Stake program itself prevents the staker from
  withdrawing or re-authorizing the withdrawer.
- **Vault PDA = withdrawer** → sole authority to `Withdraw` and to re-authorize the
  withdrawer (custody). Withdrawals require the **vault PDA to sign**, which only the
  Sigil program can do via `invoke_signed`.

Sigil's added value is therefore narrow and precise:

1. **Admission verification** — prove a stake account is genuinely vault-custodied
   (`withdrawer == vaultPDA`, `staker == registered agent`) before treating it as a
   guarded position.
2. **Gated exit** — the vault PDA `invoke_signed`'s the Stake `Withdraw`, with the
   destination **pinned to `vault.owner`** and the existing TA-09 cosign gate applied.
3. **Lockup handling** — read the lockup and either withdraw (vault is custodian, or
   lockup expired) or fail explicitly (a third-party custodian truly blocks it).

This is the one **agnostic, additive** custody lane: no per-venue integration, no new
trust surface — it leans entirely on the native Stake program's own enforcement,
which both spikes verified holds.

---

## 2. Spike-verified facts (ground truth)

### 2.1 BS-1 — covenant (`spike/bs1-native-stake-covenant`, LiteSVM, 8/8 passing)

- agent (staker) **cannot** withdraw / re-authorize the withdrawer — only the withdrawer can.
- withdrawer (vault PDA) **can** withdraw.
- agent **can** delegate/deactivate/split; **split inherits the withdrawer** (no custody leak).
- lockup withdrawer-change is **custodian-gated** (custodian co-sign required in-lockup).

### 2.2 BS-1b — `invoke_signed` Withdraw (`spike/bs1b-invoke-signed-withdraw`, LiteSVM, 5/5 passing)

- **CONFIRMED:** the Sigil program signing as the vault PDA via `invoke_signed`
  successfully withdraws from a stake account whose `withdrawer == vaultPDA`.
  Seeds: `[b"vault", vault.vault_authority, vault.vault_id.to_le_bytes(), [vault.bump]]`
  (verbatim from `withdraw_funds.rs:107-116` — note `vault_authority`, **not** `owner`, per LBL-01).
- **CONFIRMED CPI account list** for the Stake `Withdraw` (verified empirically + against
  `solana-stake-program-2.3.13/src/stake_instruction.rs`):

  | Idx | Account                            | Signer  | Writable | Notes                                 |
  | --- | ---------------------------------- | ------- | -------- | ------------------------------------- |
  | 0   | stake account                      | no      | **yes**  | drained                               |
  | 1   | destination                        | no      | **yes**  | receives lamports                     |
  | 2   | Clock sysvar                       | no      | no       | `SysvarC1ock…`                        |
  | 3   | **StakeHistory sysvar**            | no      | no       | `SysvarStakeHistory…` — **MANDATORY** |
  | 4   | withdrawer authority (= vault PDA) | **yes** | no       | satisfied by `invoke_signed`          |
  | 5   | custodian                          | yes     | no       | OPTIONAL (lockup override only)       |

  Call: `stake::instruction::withdraw(&stake, &vault_pda, &dest, amount, custodian_opt)`.

- **StakeHistory is mandatory** — `PublicKey.default` at idx 3 → `MissingAccount` before
  any balance logic. (Resolves the architecture pass's flagged uncertainty.)
- **Destination is UNCONSTRAINED by the Stake program** — an arbitrary attacker dest
  succeeds. ∴ the lane's `dest == owner` pin is **load-bearing** (mirrors `ErrOutputNotVaultOwned` 6112).
- Withdraw cannot breach the **rent-exempt reserve** (full close needs deactivation, a
  separate path); CU ~11.5k for the bare `invoke_signed` (trivial vs 1.4M budget).

### 2.3 Verified byte offsets (StakeStateV2, from BS-1 finding (f))

```
[0..4)   discriminant   u32 LE   (1 = Initialized, 2 = Stake)
[12..44) Meta.authorized.staker      Pubkey
[44..76) Meta.authorized.withdrawer  Pubkey
[76..84) Meta.lockup.unix_timestamp  i64
[84..92) Meta.lockup.epoch           u64       ← NOTE: in-force check needs BOTH ts AND epoch
[92..124)Meta.lockup.custodian       Pubkey
MIN_DATA_LEN = 124
```

---

## 3. Instruction surface (2 instructions; a 3rd deferred)

All new instructions are **standalone owner instructions** — NOT routed through the
agent `validate_and_authorize → DeFi → finalize_session` sandwich. Withdrawals are
owner-initiated (`Owner = full authority; Agent = execute only`), so the sandwich
(which requires an agent signature) would be semantically wrong. Each does
`reject_cpi!()` at entry (top-level only).

### 3.1 `verify_stake_admission` — stateless predicate

Asserts a stake account is vault-custodied. No state written; emits
`StakeAdmissionVerified`. Callable by owner or an OPERATOR agent.

**Accounts:** `caller` (signer; owner or OPERATOR agent), `vault` (AgentVault PDA),
`stake_account` (UncheckedAccount — raw bytes read), `claimed_staker` (UncheckedAccount —
must be a registered vault agent).

**Handler (ordered):** `reject_cpi!()` → `vault.is_active()` → caller is owner OR
OPERATOR → `claimed_staker` is a registered agent → `read_and_verify_stake_authorities`
→ `require_keys_eq!(staker, claimed_staker, ErrStakeStakerMismatch 6118)` →
`require_keys_eq!(withdrawer, vault.key(), ErrStakeWithdrawerNotVault 6122)` →
**[DECISION #5]** if lockup in-force AND custodian ∉ {vaultPDA, default} → revert
(refuse to admit a "time-bomb" account) → emit.

### 3.2 `withdraw_stake` — gated exit (the security-critical instruction)

The vault PDA `invoke_signed`'s the Stake `Withdraw`. Owner-only.

**Accounts:** `owner` (signer, mut), `vault` (`has_one = owner`), `policy`,
`stake_account` (UncheckedAccount, mut), `destination` (UncheckedAccount, mut —
pinned to `vault.owner`), `audit_log_success`, **`clock_sysvar`** (address-pinned),
**`stake_history_sysvar`** (address-pinned — **mandatory**, per 2.2),
`stake_program` (address-pinned to `stake::program::id()`), `system_program`.
Cosign accounts arrive via `remaining_accounts` (TA-09 path).

**Args:** `amount: u64` (lamports; cannot breach rent reserve).

**Handler (ordered):**

1. `reject_cpi!()`.
2. `vault.status != Closed` → `VaultAlreadyClosed`. **[DECISION #3]** do NOT block on
   Frozen (mirror `withdraw_funds.rs:83-86`).
3. **Cosign gate** — if `policy.cosign_required`, `has_bound_cosigner(remaining_accounts,
owner, policy.cosign_session_pubkey)` → `ErrCosignRequired` (reuse `withdraw_funds.rs:87-95`).
4. **Dest pin** — `require_keys_eq!(destination, vault.owner, ErrStakeWithdrawDestMismatch 6123)`.
   (Load-bearing per 2.2 — the Stake program does not constrain the dest.)
5. **Read stake bytes** (`#[inline(never)]` helper) — verify `withdrawer == vault.key()`
   (`ErrStakeWithdrawerNotVault 6122`); read lockup `(unix_ts@76, epoch@84, custodian@92)`.
6. **Lockup resolution** (see §4) → choose `custodian_arg` or revert `ErrStakeLockupInForce 6121`.
7. **CPI:** `stake::instruction::withdraw(&stake, &vault_pda, &dest, amount, custodian_arg)`,
   `invoke_signed` with the vault seeds, passing the 5 (or 6) accounts per 2.2.
8. Audit-log success entry (reuse `withdraw_funds.rs:147-163` pattern).
9. emit `StakeWithdrawGated`.

### 3.3 `set_stake_lockup` — DEFERRED (PR-S4) **[DECISION #4]**

Vault PDA (as custodian) `invoke_signed`'s the Stake `SetLockup` to clear/extend a
lockup. Owner-only, cosign-gated. Specified for completeness; NOT in the initial PRs.
The initial `withdraw_stake` already fails explicitly (`ErrStakeLockupInForce`) on a
truly-blocking lockup, so nothing is silently stranded.

---

## 4. Lockup flow (refined from the architecture pass)

The architecture pass conservatively reverted on **any** in-force lockup and read only
the timestamp. Two corrections from the lockup deepening + BS-1 test (e):

- **In-force = `clock.unix_timestamp < lockup.unix_timestamp` OR `clock.epoch < lockup.epoch`.**
  Both fields (ts@76, epoch@84) must be read; the architecture pass missed `epoch`.
- **A vault that IS the custodian can override its own lockup.** The Stake `Withdraw`
  accepts an optional custodian (idx 5); if the custodian co-signs, the lockup is
  bypassed. Since the vault PDA can `invoke_signed` as the custodian too, it is **not
  stranded**.

Resolution in `withdraw_stake` step 6:
| Case | Condition | Action |
|---|---|---|
| A | lockup not in-force | withdraw, `custodian = None` |
| B | in-force AND `lockup.custodian == vaultPDA` | withdraw, `custodian = Some(vaultPDA)` (idx 5, vault signs) → overrides |
| C | in-force AND custodian is a third party (≠ vaultPDA, ≠ default) | revert `ErrStakeLockupInForce 6121` |

> **OPEN — UNPROVEN:** Case B (PDA-as-custodian override on Withdraw via `invoke_signed`,
> idx 5) was NOT exercised by either spike (BS-1b used `custodian = None`; BS-1 test (e)
> used a _keypair_ custodian on Authorize, not Withdraw). A small follow-up spike should
> confirm the vault PDA can sign idx 5 before PR-S3 ships Case B. Until then, PR-S3 MAY
> ship Cases A + C only (revert on any in-force lockup), with Case B added once proven.

---

## 5. Architecture decisions (owner sign-off)

| #   | Decision                                         | Recommendation                                             | Rationale                                                                                                                                                               |
| --- | ------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | State model                                      | **Stateless** (no registry PDA)                            | Stake bytes are always ground truth; a registry could go stale after an external re-authorize. Zero new attack/rent surface. (Registry is the only _irreversible_ alt.) |
| 2   | Withdraw destination                             | **Pin to `vault.owner` only** (not `allowed_destinations`) | Stake withdrawal is a full-custody exit, not an agent spend; allowing the allowlist adds a drain vector.                                                                |
| 3   | `withdraw_stake` on Frozen vault                 | **Allow** (mirror `withdraw_funds`)                        | Owner must always be able to retrieve funds.                                                                                                                            |
| 4   | `set_stake_lockup` in v1                         | **Defer to PR-S4**                                         | Conservative; `withdraw_stake` fails explicitly meanwhile.                                                                                                              |
| 5   | Admission with foreign in-force-lockup custodian | **Hard-revert**                                            | Refuse to admit a stake account that could become unwithdrawable.                                                                                                       |

`Decision drivers:` every recommendation is the **maximum-custody-safety** option —
smallest trusted surface (stateless), strongest anti-redirection (owner-pin),
fail-explicit-never-strand (lockup), refuse-time-bombs (admission). No time/effort/cost
input influenced these; the rejected alternatives (registry PDA, allowlist dests,
block-on-frozen, eager set_stake_lockup, soft-warn admission) each either add a drain
vector, a staleness class, or a custody-strand risk.

---

## 6. Errors, SIZE, digest, seal

- **Errors (append-only, 6118–6124):** `ErrStakeStakerMismatch` 6118, `ErrStakeAccountTooSmall`
  6119, `ErrStakeAccountWrongDisc` 6120, `ErrStakeLockupInForce` 6121, `ErrStakeWithdrawerNotVault`
  6122, `ErrStakeWithdrawDestMismatch` 6123, `ErrVaultNotCustodian` 6124 (reserved for `set_stake_lockup`).
  These are **not** policy-violation codes — do NOT extend `is_policy_violation_code` (state/mod.rs:199).
- **PolicyConfig SIZE / TA-19 digest:** **no change.** The lane reuses `cosign_required` /
  `cosign_session_pubkey` and pins dest to `owner`; no new policy fields → no SIZE bump,
  no digest recompute, no queue/apply ceremony.
- **PROTECTED_SEED_PREFIXES / TA-11:** no new Sigil PDAs (stateless) → no additions, no
  pin-test change (state/mod.rs:779-813).
- **seal / SDK:** `seal()` unchanged. New owner-tx builders `withdrawStake()` /
  `verifyStakeAdmission()` in `sdk/kit/src/owner-transaction.ts`. Agent delegate/deactivate/split
  helpers may be added but are NOT Sigil-gated instructions. **Changeset required** (SDK).
- **IDL:** committed-not-generated — after `anchor build --no-idl`, manually update
  `target/idl/sigil.json` + `target/types/sigil.ts` + codama for the 2 new instructions + 2 events.

---

## 7. Threat model

| ID  | Attack                                                            | Resisted by                                          | Status                                              |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| T1  | Agent self-provisions a self-custodied stake (withdrawer = agent) | admission `withdrawer == vaultPDA`                   | BS-1 (c)                                            |
| T2  | Withdraw-dest redirection (dest = attacker)                       | `ErrStakeWithdrawDestMismatch` pin                   | BS-1b (4) confirms unconstrained → pin load-bearing |
| T3  | Lockup griefing (foreign custodian + in-force lockup)             | admission hard-revert (#5) + `ErrStakeLockupInForce` | design                                              |
| T4  | Split-to-escape (child has different withdrawer)                  | Stake program inherits withdrawer                    | BS-1 (d.3) — non-issue                              |
| T5  | Agent re-authorizes withdrawer to self                            | Stake program: only current withdrawer can           | BS-1 (c) — non-issue                                |
| T6  | `staker == vaultPDA` (vault operates, not just custodies)         | admission requires `staker == registered agent`      | design                                              |
| T7  | Fake/crafted stake account bytes                                  | discriminant guard + on-chain-derived `vault.key()`  | design                                              |
| T8  | CPI-nesting the withdraw                                          | `reject_cpi!()` (top-level only)                     | design                                              |

---

## 8. PR breakdown (build order — each under the mandatory pipeline)

- **PR-S1 — foundation:** `utils/stake_offsets.rs` (offset consts + disc + `#[inline(never)]`
  `read_and_verify_stake_authorities`), errors 6118–6124, wire `utils/mod.rs`. Purely
  additive; all existing tests stay green.
- **PR-S2 — `verify_stake_admission`:** instruction + `StakeAdmissionVerified` event + IDL +
  LiteSVM tests (pass on correct setup; fail on wrong withdrawer / wrong staker / bad disc /
  time-bomb lockup). Adversarial review + CI.
- **PR-S3 — `withdraw_stake`:** instruction (the `invoke_signed` CPI per 2.2) + `StakeWithdrawGated`
  event + `read_and_verify_stake_withdraw_preconditions` + IDL + LiteSVM tests (withdraw-to-owner;
  reject wrong-dest / lockup-in-force / non-vault-withdrawer; allow-on-frozen; reject-closed;
  rent-reserve floor). **Highest security risk** (Stake CPI) — most careful review. Ship Cases
  A+C; add Case B after the PDA-custodian-override mini-spike (§4 open item).
- **PR-S4 (deferred) — SDK + lockup:** `withdrawStake()`/`verifyStakeAdmission()` builders +
  changeset; `set_stake_lockup` instruction if Decision #4 is revisited.

---

## 9. Open questions

1. **Case B (PDA-as-custodian Withdraw override)** — unproven by spikes; needs a small
   follow-up LiteSVM check before PR-S3 ships it (§4). PR-S3 can ship A+C without it.
2. **Mainnet warmup/cooldown** — withdraw mechanic is epoch-independent (BS-1b ran at epoch 0);
   real activation/deactivation timing is a Surfpool/devnet concern, out of scope here.
3. **Full account closure** — Withdraw cannot zero a stake account (rent floor); closing requires
   `Deactivate` then a separate withdraw of the full (post-deactivation) balance. The lane treats
   closure as out of scope for v1 (agent deactivates; owner withdraws after cooldown).

---

_Provenance: architecture pass + `spike/bs1-native-stake-covenant` (BS-1) +
`spike/bs1b-invoke-signed-withdraw` (BS-1b, SHA `42f762ba`). All offsets/CPI facts
verified empirically in LiteSVM against the Agave Stake program._
