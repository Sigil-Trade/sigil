# M1_ANCHOR — Anchor framework's own opinions on close-state-machines

**Target:** coral-xyz/anchor (canonical Solana program framework, now redirecting to solana-foundation/anchor)
**Mission:** what does Anchor itself do for close semantics + lifecycle hooks, and what idioms does it recommend for "account A must not exist if account B has flag set"? Sigil's M-1 question is whether the framework already answers this in a way that beats invention.

---

## Pattern

**Anchor's pattern is "owner-reassignment close + interleaved exit-serialization, with sibling-account deserialize-and-match for cross-account invariants."** It is NOT type-state. It is NOT RAII. It is NOT lifecycle flags. It is an explicit, ordered, fail-fast exit ritual driven by field declaration order in `#[derive(Accounts)]`.

### Close codegen (two-phase)

`#[account(close = recipient)]` emits code in two separate codegen sites:

1. **`lang/syn/src/codegen/accounts/constraints.rs::generate_constraint_close`** — runs during `try_accounts`, performs one check only: `if #field.key() == #target.key() { Err(ConstraintClose) }`. Self-transfer prevention. No lamports moved here.

2. **`lang/syn/src/codegen/accounts/exit.rs`** — runs during `AccountsExit::exit()` (post-handler). Iterates `accs.fields.iter().map(...)` in **declaration order**, emitting for close-marked fields:

   ```rust
   anchor_lang::AccountsClose::close(&self.#ident, #close_target.to_account_info())
       .map_err(|e| e.with_account_name(#name_str))?
   ```

   And for plain mutable fields: `AccountsExit::exit(&self.#ident, program_id)?`. The `?` operator means a failed close/exit aborts further serialization — fail-fast in declaration order.

### Runtime `close()` ritual

`lang/src/common.rs` (master, confirmed identical on 0.28.0 / 0.29.0 / 0.30.1):

```rust
pub(crate) fn close<'info>(info: &AccountInfo<'info>, sol_destination: &AccountInfo<'info>) -> Result<()> {
    sol_destination.add_lamports(info.lamports())?;
    **info.lamports.borrow_mut() = 0;
    info.assign(&system_program::ID);
    info.resize(0).map_err(Into::into)
}
```

**The `CLOSED_ACCOUNT_DISCRIMINATOR = [255; 8]` sentinel is GONE in modern Anchor** (≥0.28.0 already uses owner-reassignment). The Solana cookbook still teaches the old pattern (`developer-content/content/courses/program-security/closing-accounts.md`), creating doc/code drift. Replacement marker: `is_closed(info) = info.owner == &System::id() && info.data_is_empty()`.

### Why ordering is the killer detail

`exit_with_expected_owner` in `lang/src/accounts/account.rs`:

```rust
if expected_owner == program_id && !crate::common::is_closed(self.info) {
    let mut data = self.info.try_borrow_mut_data()?;
    let mut writer = BpfWriter::new(&mut data);
    self.account.try_serialize(&mut writer)?;
}
```

Because `close()` sets owner to `system_program::ID`, **any subsequent `exit()` call on the same account short-circuits**. Close-then-exit is idempotent. The OLD CLOSED_ACCOUNT_DISCRIMINATOR pattern lacked this — each handler had to manually check the sentinel.

### Sibling-account invariants — the Squads V4 idiom

`Squads-Protocol/v4` is the production exemplar of "close A only if sibling B is in allowed state." From `programs/squads_multisig_program/src/instructions/transaction_accounts_close.rs::VaultTransactionAccountsClose::validate`:

```rust
let is_stale = transaction.index <= multisig.stale_transaction_index;
let can_close = if let Some(proposal_account) = proposal_account {
    match proposal_account.status {
        ProposalStatus::Draft { .. }     => is_stale,
        ProposalStatus::Active { .. }    => is_stale,
        ProposalStatus::Approved { .. }  => false,   // pending — FORBIDDEN
        ProposalStatus::Rejected { .. }  => true,
        ProposalStatus::Executed { .. }  => true,
        ProposalStatus::Cancelled { .. } => true,
        ProposalStatus::Executing        => false,
    }
} else { is_stale };
require!(can_close, MultisigError::InvalidProposalStatus);
```

Proposal is optional `UncheckedAccount` — caller supplies, handler deserializes and matches. Cross-account invariant enforced by **on-chain deserialize + explicit match**, gated by a **monotonic staleness counter on the parent** (`multisig.stale_transaction_index`). Closest production analog to Sigil's M-1.

## Failure history

- **Account revival attack** (historical motivator for `CLOSED_ACCOUNT_DISCRIMINATOR`): attacker re-funds rent within the same transaction. Modern Anchor closes this via owner-reassignment — system program owning the account makes re-funding insufficient because `is_closed` checks owner AND empty data.
- **No issues on coral-xyz/anchor matching `typestate OR "type state" OR "state machine"`** — GitHub search returned zero results. The community has not pursued type-state programming over `Account<'info, T>`.
- **Field-declaration-order is load-bearing** — issue #1365 confirms order matters at the macro level. Combined with interleaved exit ordering: if close is on field 1 and a mutable account is on field 2, close fires first. Reverse them, serialize fires first. Invisible footgun.
- **Anchor does NOT use `PhantomData` or `Drop`** anywhere in `Account<'info, T>` — confirmed by direct read of `lang/src/accounts/account.rs`. Deliberate design: **explicit `exit()`, not implicit Drop**, because Drop fires on Ok AND Err but exit() is gated by `?` on handler result. Critical for M-1: **Sam's `PendingGuard<T>` RAII proposal cannot use Rust's Drop trait for state persistence** — Drop would fire on errors too, and the runtime reverts state on Err anyway, making Drop-based persistence meaningless.

## End-user recovery story

Anchor itself provides no recovery primitive for close-while-pending. Squads V4's recovery: `is_stale = transaction.index <= multisig.stale_transaction_index` — a parent-controlled counter lets the multisig forcibly "stale out" pending proposals, after which the otherwise-forbidden close becomes allowed. End user invokes `set_stale_transaction_index` (admin escape-hatch), then re-runs close. No on-chain refund for the pending account itself — rent goes to `close = rent_collector`.

The cookbook's `force_defund` pattern is the OLD-approach recovery (permissionless defund of CLOSED_ACCOUNT_DISCRIMINATOR-marked accounts). Modern Anchor's owner-reassignment makes this obsolete.

## M-1 fit verdict

**Partial.** Anchor itself does NOT solve M-1 directly — no `#[account(close = recipient, only_if = "no_pending_X")]` constraint exists. But the **production Squads V4 idiom** (sibling-deserialize-and-match + parent staleness counter) is directly portable to Sigil and beats Council options α/δ/γ/ε on auditor readability because the pattern self-documents in `validate()`.

Two framework opinions that ARE foundational:
1. **Use explicit exit(), not Drop-based RAII** — framework rejects implicit cleanup because Drop doesn't compose with revert-on-error semantics. Rules out Sam's `PendingGuard<T>` as RAII; could exist as explicit-call helper but loses the "automatic" property.
2. **Owner-reassignment beats discriminator-sentinel for reinit defense** — baked into Anchor 0.28+. Sigil should rely on this and NOT manually overwrite a sentinel.

## Security-first scores

- **Defense-in-depth: 4/5** — sibling deserialize-and-match closes "stale pending state at close." Loses 1 because caller can omit sibling; fallback (`is_stale` check) is weaker. Bidirectional binding (parent `has_pending_X: bool` + sibling existence cross-check) would push to 5/5.
- **End-user recovery: 4/5** — staleness counter is elegant escape-hatch (no per-class admin function needed). Loses 1 for no on-chain audit trail of why a particular close was permitted.
- **Auditor onboarding: 5/5** — `validate()` IS the spec. Auditor reads the match statement and knows every allowed/forbidden state combination. Strongest argument against α (4 boolean flags scattered across PolicyConfig — auditor has to grep).
- **Long-term consistency: 4/5** — scales linearly with N pending classes (add a match arm). Loses 1 because adding a class requires touching the close handler, not just queue/apply. Jordan's `PendingPdaClass` trait + CI exhaustiveness test would give compile-time enforcement.

## Recommendation for Sigil M-1

**Adopt the Squads V4 sibling-deserialize-and-match pattern.** Concretely:

1. **Replace the 6 pending-PDA drain blocks** in `close_vault.rs` with explicit sibling accounts in the Accounts struct (`pending_policy: Option<Account<PendingPolicyUpdate>>`, etc.), each with `close = owner`. Let Anchor's exit() ritual handle the lamports transfer.

2. **Add `close_vault::validate()`** that pattern-matches every sibling's state and uses `require!(no_pending_actions, SigilError::PendingActionsBlockClose)`. Makes close-while-pending invariant **read-as-spec** — auditor onboarding 5/5.

3. **Add `stale_index: u32` monotonic counter on AgentVault** as escape-hatch. Owner calls `bump_stale_index`; stales out ALL pending PDAs in one shot. Close then allowed. No per-class admin function needed (vs. α's `admin_clear_pending_flag` which needs N).

4. **Do NOT pursue Sam's `PendingGuard<T>` as Rust RAII** — framework rejects this. If wanted, make it explicit-call (`guard.commit()?`) so borrow semantics match Anchor's `exit()`.

5. **Do NOT pursue type-state `Account<'info, Locked>` vs `Account<'info, Unlocked>`** — zero community precedent (GitHub issue search returned 0), Anchor's `Account<T>` requires `T: AccountSerialize + AccountDeserialize + Owner + Clone` constraining phantom-type creativity, and `PhantomData` is unused throughout Anchor. Ecosystem has spoken: discriminator-based status enums (Squads `ProposalStatus`) are canonical, not type-state.

Council should treat the Squads V4 idiom as **option ζ (zeta)** and evaluate head-to-head with α/δ/γ/ε under security-first rubric. Initial scoring suggests ζ beats α on auditor-readability and end-user-recovery while matching it on defense-in-depth.

---

**Primary citations:**
- `coral-xyz/anchor` master: `lang/src/common.rs` (close ritual, identical on 0.28.0/0.29.0/0.30.1)
- `lang/syn/src/codegen/accounts/constraints.rs` (generate_constraint_close — validation only)
- `lang/syn/src/codegen/accounts/exit.rs` (interleaved field-order on_save)
- `lang/src/accounts/account.rs` (exit_with_expected_owner, no PhantomData, no Drop)
- `lang/src/lib.rs` (AccountsExit + AccountsClose trait defs)
- `Squads-Protocol/v4`: `programs/squads_multisig_program/src/instructions/transaction_accounts_close.rs` (sibling-deserialize-and-match exemplar)
- `Squads-Protocol/v4/programs/squads_multisig_program/src/state/proposal.rs` (ProposalStatus discriminator state machine — `Executing` variant deprecated as reentrancy-prevention)
- `solana-foundation/developer-content/content/courses/program-security/closing-accounts.md` (cookbook — still teaches outdated CLOSED_ACCOUNT_DISCRIMINATOR pattern; flag as doc drift)
- GitHub issue search on coral-xyz/anchor for typestate / state machine → 0 results (confirms type-state is not a community pattern)
