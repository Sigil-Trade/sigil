# M-1 Research: Squads V4 Multisig

**Target**: Squads Protocol V4 — production Solana multisig program securing approximately $10B in TVL.
**Repo**: [github.com/Squads-Protocol/v4](https://github.com/Squads-Protocol/v4) (commit `edbca834` head at time of research).
**Researcher**: Remy (Codex Researcher), 2026-05-25.

---

## Pattern

Squads V4 implements close-with-pending-state via a **discriminator state machine + global monotonic stale-index**. Three primitives compose the pattern:

1. **`ProposalStatus` tagged enum** ([state/proposal.rs:188–208](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/state/proposal.rs#L188-L208)) — every transient lifecycle node is its own variant carrying a `timestamp: i64`. Variants: `Draft`, `Active`, `Approved`, `Rejected`, `Executed`, `Cancelled`, plus a deprecated transient `Executing` (kept for backwards compat with `#[non_exhaustive]` on the enum — pattern arms must still handle it).
2. **Monotonic `Multisig.stale_transaction_index: u64`** ([state/multisig.rs:33](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/state/multisig.rs#L33), invalidator at [200–202](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/state/multisig.rs#L200-L202)). Any config change that affects voting consensus (members, threshold, time_lock) calls `invalidate_prior_transactions()` which sets `stale_transaction_index = transaction_index`. ALL prior proposals are now "stale" by index comparison — no per-proposal flag is touched.
3. **Per-instruction explicit truth table** keyed on `(ProposalStatus, is_stale)`. Each closer makes its own decision; the matrix is hand-written and visible in source.

The canonical close handler is [`transaction_accounts_close.rs`](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/transaction_accounts_close.rs), which exposes THREE distinct closers (`ConfigTransactionAccountsClose`, `VaultTransactionAccountsClose`, `VaultBatchTransactionAccountClose` + `BatchAccountsClose`) because Anchor's `close=` attribute can only target `Account<'info, T>` types — file header documents that rationale at [lines 1–11](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/transaction_accounts_close.rs#L1-L11).

What the close path enforces (the M-1-relevant decision logic):

| Status | ConfigTransaction close | VaultTransaction close | Batch close |
|---|---|---|---|
| `Draft` | only if stale | only if stale | only if stale |
| `Active` | only if stale | only if stale | only if stale |
| `Approved` | only if stale | **NEVER** (line 200) | **NEVER** (line 434) |
| `Rejected` | always | always | always |
| `Executed` | always | always | always |
| `Cancelled` | always | always | always |
| `Executing` (deprecated) | `false` | `false` | `false` |

The asymmetry is **deliberate**: a `VaultTransaction` whose proposal is `Approved` can still execute, so closing it would orphan a still-valid spend authorization. The comment at [`vault_transaction_execute.rs:77–78`](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/vault_transaction_execute.rs#L77-L78) seals the contract: *"Stale vault transaction proposals CAN be executed if they were approved before becoming stale, hence no check for staleness here."*

The close routine itself is hand-rolled: [`utils/system.rs:close()`](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/utils/system.rs) — transfer all lamports, assign to `system_program::ID`, `realloc(0, false)`. Lifted from Anchor's private `common::close`. Same primitive Sigil uses.

Note one nuance Sigil's M-1 brief should NOT miss: the proposal account is declared as `AccountInfo` (not `Account<Proposal>`) at [transaction_accounts_close.rs:40](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/transaction_accounts_close.rs#L40), then conditionally deserialized at [74–80](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/transaction_accounts_close.rs#L74-L80) with `if proposal.data.borrow().is_empty()`. This **is the same anti-pattern** Sigil's M-1 calls out (the `lamports() > 0` skip in Sigil → Squads' `data.borrow().is_empty()`). The Squads team accepted this asymmetry consciously: a missing Proposal is permitted iff the transaction is independently stale.

---

## Failure history

Across four published audits ([OtterSec 2023+2024](https://github.com/Squads-Protocol/v4/blob/main/audits/ottersec_squads_v4_audit_2024.pdf), [Neodyme 2023+2024](https://github.com/Squads-Protocol/v4/blob/main/audits/neodyme_squads_v4_report_2024_final.pdf), [Certora 2023+2024 with formal verification](https://github.com/Squads-Protocol/v4/blob/main/audits/certora_squads_v4_security_report_and_formal_verification_2024_final.pdf), [Trail of Bits 2023](https://github.com/Squads-Protocol/v4/blob/main/audits/trail_of_bits_squads_v4_security_audit.pdf)), the close-with-pending-state pattern itself was **not flagged as a vulnerability**. But adjacent findings reveal the failure modes the pattern was hardened against:

1. **OS-SQD-ADV-02 (OtterSec 2023, Low, Resolved)** — Batch lifecycle DoS. A malicious member with `Initiate` permission could front-run a batch's `proposal_create` and set status directly to `Active`, locking the batch out of `batch_add_transaction` (which requires `Draft`). Fixed in commit `3906ce9` by gating who can create proposals. **Lesson for M-1**: status transitions can be weaponized when any actor can write a status; restrict the *writer*, don't just validate the *reader*.

2. **ND-SQD2-L2 (Neodyme 2024, Low, Accepted-not-fixed)** — `multisig_remove_spending_limit` allows anyone to collect rent even when `rent_collector` is configured, breaching the documented invariant. Remediation note quoted verbatim: *"This issue has been acknowledged without a remediation, due to the low impact and the high complexity of fixing the inconsistency in `config_transaction_execute`."* ([neodyme_squads_v4_report_2024_final.pdf p.11](https://github.com/Squads-Protocol/v4/blob/main/audits/neodyme_squads_v4_report_2024_final.pdf)). **Lesson for M-1**: even with a $10B-TVL multisig, rent/close consistency across N closers degrades over time; the audit explicitly cites "high complexity of fixing" as the reason it stays broken.

3. **ND-SQD3-LO-01 (Neodyme 2023, Low, Resolved)** — `TransactionBuffer` DoS: any `Initiate` member could write garbage to a buffer that hashed wrong, locking out close for everyone except the original creator. Fixed by namespacing the PDA per-creator (256 buffers *each* instead of 256 *total*). **Lesson for M-1**: pending PDAs whose close-authority is gated on data validation can be permanent griefs.

4. **TOB-SQUADS-4 (Trail of Bits, Informational)** — `invariant()` is called *before* `invalidate_prior_transactions()` in five handlers in `multisig_config.rs`. Since the invariant validates `stale_transaction_index <= transaction_index`, future changes to either method could silently violate it. TOB recommends always calling `invariant()` *last*. **Lesson for M-1**: the global stale-index pattern depends on a specific call ordering — that ordering is *invisible* at compile time and must be a coding convention.

5. **TOB-SQUADS-7 (Trail of Bits, High, Resolved)** — Unrelated to close, but shows the audit posture: `create_key` was unauthenticated, enabling front-run multisig creation. Fixed by requiring `create_key` to sign. **Lesson for M-1**: every PDA seed parameter that isn't a signer is a potential attack vector — same shape as Sigil's `vault_id`.

No GitHub Issue or post-mortem documents an orphaned-rent or close-while-pending data loss in production. Open issue [#135](https://github.com/Squads-Protocol/v4/issues/135) ("Allow Vote Changes to Reset Timelock and Approval State") is an enhancement request, not a bug.

**ENFORCEMENT SPLIT**: Squads is on-chain-strict for close. There is no off-chain "drain" sweep — every transaction account close goes through one of the four handlers above. Indexing is documented as off-chain (Top Ledger per [TOB p.43](https://github.com/Squads-Protocol/v4/blob/main/audits/trail_of_bits_squads_v4_security_audit.pdf)), but no critical invariant depends on indexer correctness.

---

## End-user recovery story

If a user's close path fails, the recovery story is **on-chain self-service**:

- **Stuck `Approved` VaultTransaction**: just execute it. Time-lock then execute — the transaction will succeed unless the multisig config changed (which would have made it stale, which the close handler then permits via the `Rejected/Cancelled` paths after explicit member votes).
- **Stuck `Draft` or `Active` proposal**: cosign-cancel via `proposal.cancel()` ([state/proposal.rs:90–105](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/state/proposal.rs#L90-L105)) — when threshold-many members vote cancel, status becomes `Cancelled` and close is allowed. OR wait for a config change that invalidates the prior index, making it stale.
- **Stuck pending state with no quorum**: the config_authority (if set) can issue any config change → `invalidate_prior_transactions()` → all old proposals stale → all old transactions closeable. This is the explicit admin escape, and it's *the same primitive* used for normal config changes — no special "admin clear pending" instruction is needed.
- **Spending Limit residue (ND-SQD2-I1)**: known footgun — a removed member who is still on a spending limit can be re-added later and reuse the old limit. Squads accepted this rather than passing all spending-limit accounts on every member-remove.

No rent is structurally lost. Worst case: rent locked until next config change. There is no immutable-state lockout. There is no admin-only escape hatch *outside* the standard governance flow — which is itself the recovery primitive.

---

## M-1 fit verdict

**Partial yes.** The discriminator-state-machine + monotonic-index pattern is the strongest defense-in-depth observed in any Solana program I've researched on this question. It self-documents (every status arm is a separate case in source), it scales to N pending classes without per-class flags (the index covers everything), and it gives users an on-chain recovery primitive that's just "do another config change." But it **does not directly drop into Sigil**, because:

1. Squads' index works because *one* monotonic counter (`transaction_index`) covers ALL pending state. Sigil's six pending-PDA classes are heterogeneous (per-agent perms, constraints, owner rotation, agent grants) — they don't share a single counter today. To adopt Squads' pattern verbatim, Sigil would need either (a) a single `pending_state_epoch: u64` on `AgentVault` that ALL queue handlers bump, OR (b) a separate epoch per class (which collapses to α's per-class flags).
2. Squads' three-closer split (one per Anchor `Account<T>` discriminator type) is a feature, not a bug — it makes the truth table explicit and visible at each call site. Sigil's *single* `close_vault.rs` with six embedded blocks loses that local visibility.
3. Squads accepts the `data.borrow().is_empty()` pattern (Sigil's `lamports() > 0`) but compensates with the stale-index requirement. Sigil cannot adopt the empty-check on its own without the compensating index.

The strongest **transferable insight**: Squads' pattern is α + a global-epoch defensive bound. Per-class flags are still the inner ring; the epoch is the outer fence. This is a **sixth Council option** that R1–R3 didn't surface explicitly.

---

## Security-first scores

- **Defense-in-depth strength**: **5/5**. Two independent gates — (1) explicit per-status truth table, (2) stale-index global epoch — must both fail for a corruption. No third party (no monitor, no indexer) is trusted with safety. Plus `#[non_exhaustive]` on the enum forces compile-time exhaustiveness in every handler arm, which catches contributor-#7 drift at PR review time, not at audit time.
- **End-user recovery**: **5/5**. Three orthogonal recovery paths: execute the Approved transaction, cosign-cancel, or any config change → invalidate. No lockouts. No admin God-mode required.
- **Auditor onboarding**: **5/5**. Every closer file has a hand-written truth table in the same function. A new auditor reads `transaction_accounts_close.rs` *once* and sees the entire close lattice. Audits across four firms across three years did not find a single close-while-pending bug — the strongest possible auditor-readability signal.
- **Long-term consistency**: **4/5**. The pattern scales well, but TOB-SQUADS-4 (the `invariant()`-ordering finding) demonstrates the brittleness: a *coding convention* (always call invariant last) is the only thing keeping the global epoch invariant safe. ND-SQD2-L2 (the rent_collector inconsistency Squads chose not to fix because it lived in a fourth, unrelated closer) shows that the per-handler truth table model does drift as N grows — which is exactly the M-1 problem in microcosm. Docked one point.

---

## Recommendation for Sigil M-1

**Adopt Squads' pattern explicitly as Council Option ζ ("zeta"): epoch + flags + exhaustive enum.** This is a strictly stronger superset of α that R1–R3 did not name. Concretely:

1. **Add `AgentVault.pending_state_epoch: u64`** (8 bytes, one-time schema cost). Every queue handler `*_queue_pending_*` increments it. Every cancel/apply handler ALSO increments it (so a cancel followed by a re-queue gets a new epoch and never collides with a stale flag).
2. **Keep α's per-class flags** (the inner ring — they prevent the silent no-op today). `close_vault.rs` requires *both* (epoch matches AND all flags clear) — defense-in-depth.
3. **Make `PendingPdaClass` a Rust enum with `#[non_exhaustive]` + exhaustive `match` in every queue/cancel/close handler**. Then Jordan's CI exhaustiveness test becomes a `cargo check` artifact — the compiler enforces drift prevention. This is the Squads ProposalStatus pattern.
4. **Apply TOB-SQUADS-4 ordering rule preventively**: `vault.invariant()` MUST be the last line of every handler that touches pending state. Document and lint-enforce.
5. **Preserve Riley's `admin_clear_pending_flag` escape-hatch ix** — Squads has an implicit one (any config change → invalidate index) but Sigil's heterogeneous pending classes mean an explicit escape per class is safer than overloading the policy-update flow. Squads' pattern works because their stale-index is *coincidentally* attached to config changes; Sigil should not entangle.

ζ costs more bytes than α (8 + 14 = 22 bytes vs 14) and more handler edits (every queue/cancel/apply touches epoch AND flag, vs α's flag-only). Per the user's directive — **cost is documentation, not a vote**. ζ is what the strongest Solana multisig in production has been auditing and not-failing for three years. That is the security signal R4 should weight.

**Critical caveat**: I did not find Squads' `#[non_exhaustive]` + exhaustive-match pattern called out as the security-load-bearing primitive in any audit. The enum exhaustiveness is enforced by Rust, not by audit recommendation. Treat my Long-term-consistency score (4/5) as my own inference, not a Squads-audit-endorsed claim.

---

**Sources**:
- [Squads-Protocol/v4 repo](https://github.com/Squads-Protocol/v4)
- [state/proposal.rs — ProposalStatus enum](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/state/proposal.rs)
- [state/multisig.rs — stale_transaction_index + invalidate_prior_transactions](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/state/multisig.rs)
- [instructions/transaction_accounts_close.rs — 4-way close truth table](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/transaction_accounts_close.rs)
- [instructions/vault_transaction_execute.rs — explains why Approved blocks close](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/vault_transaction_execute.rs)
- [utils/system.rs — close primitive](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/utils/system.rs)
- [OtterSec 2024 final audit PDF](https://github.com/Squads-Protocol/v4/blob/main/audits/ottersec_squads_v4_report_2024_final.pdf) — OS-SQD-ADV-02 batch lifecycle DoS
- [Neodyme 2024 final audit PDF](https://github.com/Squads-Protocol/v4/blob/main/audits/neodyme_squads_v4_report_2024_final.pdf) — ND-SQD2-L2 rent_collector inconsistency, accepted-not-fixed
- [Neodyme 2023 audit PDF](https://github.com/Squads-Protocol/v4/blob/main/audits/neodyme_squads_v4_report.pdf) — ND-SQD3-LO-01 TransactionBuffer DoS
- [Trail of Bits 2023 audit PDF](https://github.com/Squads-Protocol/v4/blob/main/audits/trail_of_bits_squads_v4_security_audit.pdf) — TOB-SQUADS-4 invariant-ordering, TOB-SQUADS-7 front-run
- [Certora 2024 formal verification PDF](https://github.com/Squads-Protocol/v4/blob/main/audits/certora_squads_v4_security_report_and_formal_verification_2024_final.pdf) — formally verified `stale_transaction_index <= transaction_index` invariant
- [Squads V4 security page](https://docs.squads.so/main/security/security-audits/squads-protocol-v4)
