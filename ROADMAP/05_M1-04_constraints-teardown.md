# M1-04 — Constraints-Engine Teardown

**Milestone:** M1 · **Depends on:** M1-00 · **Severity:** architectural (the core reset) · **Status:** PLAN

## Why
The granular, protocol-agnostic *instruction-parsing* constraints engine is dead: it cannot be both agnostic and caveat-free, and it is the source of the recurring CRIT/HIGH churn. The 10-protocol study confirmed NO battle-tested protocol uses instruction-data parsing agnostically. Removing it leaves no security hole — caps, allowlists, sessions, and the balance-delta sandwich are all independent of it (CONFIRMED this session). This is surgical removal, not a rewrite.

## Scope (CONFIRMED footprint, ~3,312 LOC + wiring)
REMOVE:
- 10 handlers: `create_instruction_constraints`, `allocate_constraints_pda`, `allocate_pending_constraints_pda`, `apply_constraints_update`, `queue_constraints_update`, `cancel_constraints_update`, `apply_close_constraints`, `queue_close_constraints`, `cancel_close_constraints`, `cleanup_orphan_constraints_pda`.
- 3 state files: `state/constraints.rs`, `state/pending_constraints.rs`, `state/pending_close_constraints.rs`.
- `instructions/integrations/generic_constraints.rs` (+ check `integrations/mod.rs`, `token2022_opcode_test.rs`).
- The ONE runtime wire-in: `validate_and_authorize.rs:~860-870` (the `verify_against_entries_zc` call + the remaining_accounts constraints-PDA load ~272-322 + the `generic_constraints` import ~13).
- `lib.rs` registrations (~10 `pub fn` + Context types), `instructions/mod.rs`, `state/mod.rs` exports.
- (Off-chain, separate) the `sigil-constraints/` npm package — note as obsolete; not on-chain scope.

## ⚠️ PRESERVE-ON-REMOVAL (do these FIRST — deleting blind breaks the build)
1. **`ct_eq_32`** — defined in `state/pending_constraints.rs:175`, USED by the KEPT `apply_agent_grant.rs:6,230`. **MOVE it to a kept module first** (e.g. `state/mod.rs` or a new `state/assertions.rs`), update the import, build-green, THEN proceed.
2. **`ConstraintOperator` enum** — in `state/constraints.rs`, SHARED with `post_assertions` + `finalize_session`. **Relocate to a kept module** (e.g. `state/assertions.rs`) before deleting `constraints.rs`.
3. **`bytes_match` / LE-compare helpers** — in `generic_constraints.rs`, reused by the agnostic post-assertion path. **Move to a kept util** before deleting.
4. Re-grep at build start for ANY other symbol imported from a to-be-deleted file by a kept file. Treat each like the above.

## `has_constraints` unwind (the largest mechanical piece, ~28 handler refs)
`policy.has_constraints` is read across ~28 handlers (close_vault "constraints must be closed first", reactivate, init, revoke, apply_agent_grant, set_observe_only, etc.). Strategy:
1. At every read site, collapse to the "no constraints" branch (the feature is gone, so the flag is always false) — remove the conditional, keep the no-constraints path.
2. Remove the field from `PolicyConfig` LAST, after the account/handlers are deleted and all read sites collapsed.
3. **Grep-gate:** a CI/local grep proving ZERO residual `has_constraints` / `Constraint` / `constraints_pda` references in kept code before the field is removed.
4. Size impact: removing the field changes `PolicyConfig` SIZE → update the `const_assert!` + any size-pinned tests. Re-derive the new SIZE; do NOT trust stale frontmatter.

## Safe removal ORDER (no broken build at any step — each step builds+tests green)
1. Move `ct_eq_32` + `ConstraintOperator` + `bytes_match` to kept modules; update imports; **build+test green.**
2. Remove the `validate_and_authorize` wire-in (import + remaining_accounts load + scan); the engine is now dead-but-present; **build+test green.**
3. Collapse all `has_constraints` read sites to no-constraints branch; **build+test green.**
4. Delete the 10 handlers + 4 integration/state files; remove `lib.rs`/`mod.rs` registrations; **build+test green.**
5. Remove the `has_constraints` field + fix `PolicyConfig` SIZE + size tests; grep-gate zero residual refs; **build+test green.**
6. Remove constraints-only error variants from `errors.rs` IF they renumber cleanly; if removal would renumber shared/later codes (breaking IDL/SDK), LEAVE them as reserved/deprecated with a comment (pre-launch we can renumber, but do it deliberately, not as a side effect). Decision at design-review.

## Tests
**BASELINE (measured 2026-05-30): `anchor test` = 148 passing / 2 pending / 0 failing, exit 0.** This is the known-good reference to diff against.

Current constraint-test coupling (measured): 22 of 41 test files reference "constraint" — 1 NAMED (`tests/instruction-constraints.ts`, 656 refs = tests the engine itself), 21 incidental (top: `helpers/litesvm-setup.ts` 57, `close-vault-pending-drain` 67, `policy-digest-invariant` 57, `surfpool-integration` 86, `security-exploits` 117, `audit-log-coverage` 68). Plus a live case in `missing-coverage.ts` (`cancel_close_constraints: closes PendingCloseConstraints PDA`).

- **Delete the engine's OWN tests** (`instruction-constraints.ts` + the `cancel_close_constraints`/etc. cases in `missing-coverage.ts`) — they test a removed feature; this is NOT lost coverage.
- **Prune incidental references** in the ~21 other files: remove constraint-specific setup/assertions, KEEP each file's real (non-constraint) assertions. `helpers/litesvm-setup.ts` is the shared harness — update it first.
- **Confirm every surviving non-constraint test passes** (caps, sessions, allowlists, sandwich, ownership, freeze, audit-log, digest).
- NEW: sanity test asserting the removed instructions are no longer dispatchable.

**⚠️ "Green" after teardown ≠ same count.** Total passing count WILL DROP (engine tests removed) — that is CORRECT, not a regression. The gate is: **(a) all surviving non-constraint tests pass, (b) the drop is fully accounted for by removed engine-only tests (enumerate them), (c) no non-constraint test silently disappeared.** The danger is mistaking a REAL security regression for a scaffolding break — build-green at every ordered step + adversarial review keeps them distinguishable. Update `scripts/test-counts.json` to the new expected count with a note explaining the delta.

## DoD
Engine fully removed; build+test green at EVERY step of the order above; grep-gate proves zero residual constraints refs in kept code; `PolicyConfig` SIZE corrected; adversarial review confirms no kept guarantee weakened; pipeline complete.

## Risks
- Deleting before moving shared helpers → build break. Mitigation: the ordered steps, build-green gate each.
- `has_constraints` residual ref slips through → grep-gate is the backstop.
- Error-code renumbering breaks IDL/SDK → handle deliberately (step 6 decision).
- A kept handler relied on a constraints check for a guarantee caps/allowlists don't cover → audit found NONE, but re-confirm adversarially (this is the "does removal weaken anything" check).

## Anti-criteria
- No kept security guarantee weakened.
- No shared helper deleted without relocation.
- No silent error-code renumber.
