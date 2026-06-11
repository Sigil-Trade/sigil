# Phase 9 — CI / Test-Runner Notes

## Surfpool retry policy (ISC-151)

`pnpm test:surfpool` runs Surfpool-backed integration tests in a separate
process. Known flake modes:

1. **Slot-advance race**: Surfpool can race `setClock` + `warpToSlot` on
   first invocation. Symptom: occasional `Account not found` on PDAs that
   were created in the same test. Retry budget: 2 attempts.

2. **RPC port collision**: parallel test workers may collide on Surfpool's
   default port. Mitigation: run `pnpm test:surfpool` serially (no parallel
   workers) until Surfpool gains per-worker port allocation.

3. **Slow first request**: cold-start can exceed mocha's default 10s
   timeout. Tests use `--timeout 60000` to absorb this.

## Quarantine policy

If a Surfpool test fails sporadically:
1. Run the suite 3 more times locally — if 3/3 pass, file as flake.
2. Add `.skip` with an inline TODO comment naming the flake mode + date.
3. Open a tracking issue with the failure log + count of consecutive flakes.
4. Quarantined tests are reviewed at every phase closure.

## LiteSVM cadence (unit-tier, Phase 9 default)

- `pnpm test` runs in ~5s across 1804 tests. No flakes observed in Phase 9.
- All AL3/AL4/AL2 unit tests live here.
- Integration coverage (executeAndConfirm RPC round-trips, real on-chain
  state) lives in `tests/integration/` and runs via `pnpm test:surfpool`
  separately.

## Codama staleness gate

`pretest` now runs `pnpm codegen:errors` (Phase 9 Batch D). The drift
gate at `tests/error-map-drift.test.ts` fails if the IDL grew error codes
that didn't make it into the hand-maintained `ON_CHAIN_ERROR_MAP`. This
closes the H-NEW-2 silent-miss class.
