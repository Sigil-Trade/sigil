# M1-00 — Establish Clean Baseline

**Milestone:** M1 · **Depends on:** none · **Status:** PLAN

## Goal
A known-good, reproducible starting point before any change. "Ground truth before acting."

## Scope
IN: verify build+tests, commit in-flight hardening, triage stashes, branch, archive fractured docs.
OUT: any behavioral code change (none in this item).

## Steps (each tool-verified, evidence captured)
1. **Build green:** `anchor build --no-idl` → then `git checkout -- target/idl/ target/types/`. Capture output.
2. **Tests green:** `pnpm test` (LiteSVM ~361 tests). Zero failures. Capture summary. If any fail, STOP — baseline is not clean; triage before proceeding.
3. **Commit the F-4 WIP** (3 modified files): `accept_ownership_transfer.rs`, `accept_ownership_transfer_multisig.rs`, `apply_agent_grant.rs` — all the `saturating_sub`→`checked_sub` slot-freshness hardening (audit F-4, 2026-05-25). Single commit, conventional message. Confidence: CONFIRMED these are the only 3 dirty program files (verified this session).
4. **Triage the 5 stashes** (per `00_ROADMAP.md §3.5`):
   - `stash@{0}` post-assertions (on-chain) → leave stashed, tag for M2-01/M2-03 review. Do NOT apply now.
   - `stash@{1}`/`{3}`/`{4}` (CI/SDK) → leave stashed, out of on-chain scope.
   - `stash@{2}` (empty) → `git stash drop` after confirming empty.
5. **Fresh branch** off the committed baseline: `revamp/onchain-m1` (or per your naming). All M1 work lands here via PRs.
6. **Archive fractured docs** per `DOCS_CLEANup_MAP.md` (already drafted): move `PHASE_*_REVIEW/`, `AUDIT_*` closures, `STAGE_*`, `REVAMP_PLAN`, `HARDENED_V2_PROMPT_MAP`, `FUTURE.md`, `Plans/`, `MEMORY/WORK/` into `docs/_archive/2026-05-30/`. KEEP the canonical set + `research/` + `AGNOSTIC_ASSERTION_MODEL.md` + `ROADMAP/`. Archive = `git mv`, never delete.
7. **Pin baseline:** record HEAD SHA + test count in `ROADMAP/STATUS.md` (created here).

## Tests / verification
- Build exit 0; IDL restored (git diff clean on target/).
- `pnpm test` exit 0, count recorded.
- `git status` clean after commit + branch.
- Grep proves archived docs moved, canonical docs intact.

## DoD
Build+tests green on a fresh `revamp/onchain-m1` branch; F-4 committed; stashes triaged; docs archived; baseline SHA + test count pinned in STATUS.md. No behavioral change.

## Risks
- Tests already red at baseline → would invalidate "clean start." Mitigation: step 2 is a hard gate.
- Archiving moves a doc something references → grep for inbound refs before `git mv`; fix or leave in place.

## Anti-criteria
- No program-behavior change in this item.
- No stash auto-applied.
- No doc hard-deleted (archive only).
