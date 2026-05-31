# M-1 Protocol Research: SPL Governance (Realms)

**Protocol:** `solana-labs/solana-program-library/governance` (the canonical DAO
governance program — Mango DAO, Marinade DAO, MonkeDAO, Realms.today, and the
majority of large Solana DAOs run on this program or a fork of it).
**Source commit (master, fetched 2026-05-25):**
`https://github.com/solana-labs/solana-program-library/tree/master/governance`
**Audit reference:** OtterSec "SPL Governance v3" 2022-09-12
(`https://github.com/anza-xyz/security-audits/blob/master/spl/OtterSecGovernanceAudit-2022-09-12.pdf`).

---

## Pattern

SPL Governance uses a **discriminator state machine paired with monotonic
lifecycle counters**, and — most relevantly to M-1 — **it does not have a "close
the parent" instruction at all**. There is no `close_realm`, no
`close_governance`, no `close_proposal`, no `close_native_treasury`. The entire
attack surface that M-1 is trying to harden simply does not exist in SPL
Governance because pending state is never reconciled at close time. Instead,
every transition is guarded at the per-instruction layer by `assert_can_*`
helpers that read the discriminator (`ProposalState`) and the counters
(`active_proposal_count`, `outstanding_proposal_count`,
`unrelinquished_votes_count`).

The pieces:

**1. `ProposalState` discriminator** (`governance/program/src/state/enums.rs:109-146`):
ten variants split into "live" and "final" sets — `Draft`, `SigningOff`,
`Voting`, `Succeeded`, `Executing`, `ExecutingWithErrors`, `Completed`,
`Cancelled`, `Defeated`, `Vetoed`. The "is this state final?" predicate is
explicit and exhaustive (`proposal.rs:307-320`, `assert_is_final_state`) — every
new variant is forced through the `match` arms or the compiler rejects the
build. This is the textbook type-state pattern adapted to Borsh.

**2. `cancel_proposal` is a state transition, not a close**
(`processor/process_cancel_proposal.rs:19-61`). The handler runs
`assert_can_cancel` (proposal.rs:793-819) which whitelists exactly three live
states — `Draft | SigningOff | Voting`. On success it sets `state =
Cancelled`, stamps `closed_at = Some(now)`, and **leaves the account allocated
on chain**. The rent stays locked; the account becomes a permanent audit-trail
artifact.

**3. The two lifecycle counters** are the only thing that gates anything
remotely close-shaped:
- `Governance.active_proposal_count: u64` (governance.rs:118-127) — incremented
  on proposal create, decremented in `cancel_proposal` at line 57
  (`active_proposal_count.saturating_sub(1)`).
- `TokenOwnerRecord.outstanding_proposal_count: u8`
  (`state/token_owner_record.rs:80-85`) — incremented on create, decremented
  via `decrease_outstanding_proposal_count` (tor.rs:269-277), which is the
  function `cancel_proposal` calls at line 48.

**4. The "close-equivalent" path is `withdraw_governing_tokens`**
(`processor/process_withdraw_governing_tokens.rs:71`), which invokes
`assert_can_withdraw_governing_tokens` (tor.rs:241-266). This is the only place
in the program where pending state actually blocks an exit, and it does so with
**three hard-fail checks in sequence**:

```rust
if self.unrelinquished_votes_count > 0 {
    return Err(AllVotesMustBeRelinquishedToWithdrawGoverningTokens);
}
if self.outstanding_proposal_count > 0 {
    return Err(AllProposalsMustBeFinalisedToWithdrawGoverningTokens);
}
if self.locks.iter().any(|l| !l.is_expired(now)) {
    return Err(TokenOwnerRecordLocked);
}
```

No silent skip. No bitmask. No off-chain attestation. Three counters, three
hard-fail Err returns.

**5. The only true `dispose_account` in the entire governance program** lives
in `process_refund_proposal_deposit.rs:41` and is gated by
`assert_can_refund_proposal_deposit` (proposal.rs:355-368) — which whitelists
seven final / terminal states and explicitly rejects `Draft | SigningOff |
Voting` with `CannotRefundProposalDeposit`. A pending proposal's deposit cannot
be reclaimed, full stop.

So the pattern, named: **monotonic counter + final-state discriminator, no
parent close path**. Sigil's M-1 is asking "how do I safely close the parent
when N pending children exist?" — SPL Governance's architectural answer is "you
don't; you wait until the counters hit zero, and there is no close ix anyway."

---

## Failure history

The OtterSec v3 audit (Sep 2022) reported **3 findings, 0 critical, 0 high, 1
medium, 2 informational**. None touched the lifecycle-counter or close path.
The one medium — OS-GOV-ADV-00 "Voter weight manipulation by burning after
vote" (pp. 5-6) — is the *same class of bug as M-1's cancel-handler race*: a
state transition (`relinquish_vote`) that fired in the wrong proposal phase and
allowed an attacker to mutate state that downstream finalization assumed was
stable. The remediation is illuminating:

```rust
// process_relinquish_vote.rs (post-fix)
if proposal_data.state == ProposalState::Voting {
    return Err(GovernanceError::CannotRelinquishInFinalizingState.into());
}
```

A discriminator gate, not a flag. PR `solana-labs/solana-program-library#3210`
fixed it. The architectural lesson auditors took away (Appendix B "Internal
State" on p. 12): *"only open accounts should be eligible for closing."*

Two informational findings (OS-GOV-SUG-00, SUG-01) flagged that the
`mint_authority` paths for issuing/revoking membership tokens bypass the
counter system entirely, which Solana Labs acknowledged would be addressed with
"a queueing mechanism to enforce proposal order in the future." That queueing
mechanism, when it shipped, was the `active_proposal_count` field
(governance.rs:121-125 carries an explicit migration note: *"The counter was
introduced in program V3 and didn't exist in program V1 & V2. If the program
is upgraded from program V1 or V2 while there are any outstanding active
proposals the counter won't be accurate until all proposals are transitioned to
an inactive final state and the counter reset."*). That migration note is
itself an admission that counter desync is a real risk class — and their
mitigation was *not* to add an admin escape hatch but to let real DAO traffic
drain the legacy state naturally.

I searched the SPL repo's issue tracker for `outstanding`, `orphan`,
`pending`, and `lifecycle` related issues against governance and found no
post-mortem of a cancel-race, no orphaned-rent report, no flag-desync incident.
The pattern has been in production since v3 (2022) under multi-billion-dollar
DAO treasuries with zero published incidents in this area.

---

## End-user recovery story

If a user's token deposit gets stuck with `outstanding_proposal_count > 0`
because a proposal they own is wedged in `Voting`, the recovery path is:

1. Wait for `max_voting_time` to elapse, then call `finalize_vote` — the state
   machine will transition the proposal to `Defeated` (no quorum) or
   `Succeeded`, decrementing `outstanding_proposal_count` via the same
   `decrease_outstanding_proposal_count` helper.
2. If the proposal is in `Draft` or `SigningOff`, the owner can call
   `cancel_proposal` directly to drive it to `Cancelled`.
3. Once the counter hits zero, `withdraw_governing_tokens` succeeds.

There is no admin escape hatch, no `force_clear` instruction, no governance
override. The user's only recovery is to drive the state machine to a terminal
state through the public instructions. **This works precisely because the
counter and the discriminator are the same source of truth as the live state**
— there is no asymmetric flag to desync.

The Realm itself is *never* closable. A DAO can rotate authority to `None`
(`process_set_realm_authority.rs:46`), which makes the Realm immutable, but the
on-chain rent is permanent. SPL Governance accepts orphaned-rent on the parent
account as the cost of a fully audit-grade history.

---

## M-1 fit verdict

**Partial.** SPL Governance's pattern is *not* directly transplantable to
Sigil's `close_vault` because Sigil has a hard product requirement to release
the vault's rent and let the owner re-init, whereas SPL Governance simply
refuses to close anything. But three sub-patterns transfer cleanly:

1. **Counter-gated exit over flag-gated exit.** `outstanding_proposal_count`
   is a `u8` that *cannot* be desynced from reality because the only writers
   are the same handlers that mutate the underlying state. Sigil's M-1 α (per-
   class lifecycle flags) has the opposite property — flags are written by
   queue/apply/cancel handlers, and a single missed write desyncs the close
   path. Counters with monotonic increment-on-create / decrement-on-finalize
   are strictly safer because the invariant is *arithmetic*, not *categorical*.
2. **Hard-fail uniformity.** All three checks in
   `assert_can_withdraw_governing_tokens` (tor.rs:245-263) return distinct
   error codes; none silently skip. Sigil's current `close_vault` asymmetry
   (one hard-fail, five `lamports() > 0` silent-skips) is the exact anti-
   pattern that OS-GOV-ADV-00 burned SPL Governance for.
3. **Final-state discriminator + `assert_is_final_state` predicate.**
   Sigil's pending PDAs have no equivalent of `ProposalState`. A
   `PendingState { None, Queued, Applied, Cancelled }` enum per pending-class,
   with `assert_is_final_state` as a public helper used by both the apply/
   cancel handlers AND `close_vault`, would close the contributor-#7 drift
   risk Marcus raised in R3.

---

## Security-first scores

- **Defense-in-depth strength: 5/5.** Counter + discriminator + exhaustive
  match arms means a state-corruption attacker has to bypass three independent
  invariants. The compiler enforces the discriminator exhaustiveness; the
  counter is arithmetic and cannot be silently desynced; the close path is
  literally absent so there is no "close while pending" attack surface.
- **End-user recovery: 4/5.** Every wedge has a public-instruction recovery
  path (`finalize_vote`, `cancel_proposal`, `relinquish_vote`). The only
  reason this is not 5/5 is that rent on the parent Realm/Governance accounts
  is permanently locked — there is no exit at all, recovery or otherwise.
- **Auditor onboarding: 5/5.** `ProposalState` + `assert_is_final_state` +
  the three named counters are the entire mental model. A new auditor can
  audit the close path in zero minutes because there is no close path.
- **Long-term consistency: 5/5.** The pattern has scaled from V1 (no counter)
  through V3 (counter added) to V4 (locks, deposits, signatories) without
  introducing a single judgment-call drift point. New pending-class adds a
  new counter or a new `assert_can_*`; the close logic never grows because it
  doesn't exist.

---

## Recommendation for Sigil M-1

**Adopt the counter-and-discriminator-but-not-close-removal hybrid.**
Concretely, three changes ranked by security impact:

1. **Replace the five `lamports() > 0` silent-skip blocks in `close_vault.rs`
   with a single counter check on `AgentVault`.** Add
   `pending_pda_count: u8` to AgentVault. Every queue handler increments;
   every apply / cancel / drain handler decrements. `close_vault` requires
   `pending_pda_count == 0` or hard-fails with a single error code. This is
   the `outstanding_proposal_count` pattern verbatim (tor.rs:251-255).
   Counter math is enforced at the handler layer where the state actually
   mutates — there is no possible drift because the writer and reader are the
   same handler family. Schema cost: 1 byte. Handler edits: 1 line per
   queue/apply/cancel site.

2. **Per pending-class, add an explicit `PendingState` enum with
   `assert_is_final_state` predicate** (modeled on proposal.rs:307-320).
   This costs nothing at runtime — it's a compile-time exhaustiveness check —
   and it gives Jordan's `PendingPdaClass` trait + CI test something concrete
   to enforce. A new contributor adding a sixth pending-class cannot forget
   to wire it in because the match arm won't compile.

3. **Reject δ's "events for ephemerals" sub-option.** SPL Governance has
   roughly zero off-chain reconciliation in its security model — every
   guarantee is on-chain enforced. The OtterSec audit explicitly praised this
   (Appendix B "Internal State", p. 12). Sigil M-1's δ option splits the
   security boundary across on-chain flags + off-chain event consumers; that
   is precisely the architectural shape SPL Governance refused to ship, and
   for good reason — the off-chain consumer becomes the weakest link.

The single counter + per-class final-state enum is structurally identical to
the `outstanding_proposal_count` + `ProposalState` pair that has guarded
billions of dollars of DAO treasury for three years with zero reported
lifecycle bugs. It dominates α on schema cost (1 byte vs 14), it dominates γ
on attacker-honesty assumptions (no caller-attested data), it dominates δ on
boundary-clarity (no split on-chain/off-chain enforcement), and it dominates ε
on defense-in-depth (real on-chain gate vs documentation).
