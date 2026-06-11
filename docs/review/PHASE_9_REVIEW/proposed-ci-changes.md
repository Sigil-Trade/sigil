# Phase 9 — Proposed CI Changes (deferred to follow-up PR)

**Status:** NOT applied in Phase 9 per user decision D-6. This file documents the
exact `.github/workflows/revamp-ci.yml` diff a follow-up PR should land after
Phase 9 merges.

## Background

Phase 9 ships the SDK code, scripts, and tests for seven new CI gates but
does NOT touch `.github/workflows/revamp-ci.yml`. The user explicitly chose
to hold all workflow edits for a separate follow-up PR so the Phase 9 SDK
PR stays reviewable.

## Gates ready to wire

Each gate has its enforcement-side code shipped in Phase 9; only the
workflow YAML hookup remains.

### 1. Error-map drift gate (from Batch D)

```yaml
- name: Verify error-map ↔ IDL parity
  working-directory: agent-middleware/sdk/kit
  run: pnpm codegen:errors && git diff --exit-code src/errors/agent-errors.generated.ts
```

Failure surfaces when the IDL grows an error code but `agent-errors.generated.ts`
hasn't been regenerated. Drift gate also fires from `tests/error-map-drift.test.ts`
via `pretest`.

### 2. SIZE invariant gate (from Batch G)

Already exercised by `tests/pending-constraints-size.invariant.test.ts`. The
workflow needs no additional step — the test fails the run if drift.

### 3. Codama-staleness extended for events (from Batch D)

The existing `verify-codama-staleness.ts` (from Phase 8) should be extended to
also assert event-discriminator stability. Pending follow-up — script update
is small (add a stability hash of `src/generated/event-discriminators.ts`).

### 4. Bundle-size delta (from Batch L — DEFERRED)

Not shipped in Phase 9 (per D-6 scope reduction). Future gate would use
`size-limit` or `agadoo` against a baseline committed in `etc/`.

### 5. Lockfile-pin verifier (from Batch L)

```yaml
- name: Verify lockfile pins
  working-directory: agent-middleware/sdk/kit
  run: pnpm verify-lockfile-pins
```

Fails when `@noble/hashes` major drifts off v1, or when codama package majors
drift.

### 6. Generated-tree SHA-256 stability (from Batch D)

Pending — the `tests/generated-tree-stability.test.ts` was not shipped in
Phase 9. Trivial follow-up: hash `src/generated/` after a fresh `codama` run
and compare against a baseline hash committed to `etc/`.

### 7. Surface-tracking diff gate (from Batch G)

```yaml
- name: Verify public API surface unchanged
  working-directory: agent-middleware/sdk/kit
  run: pnpm build && pnpm check-surface --check
```

Fails when `dist/*.d.ts` exports differ from the snapshot in `etc/kit.api.txt`.

## Out of scope until v0.17 prep

- `@deprecated` tagging pass on the 54 root-barrel exports
  (`dead-export-audit.md` in this directory)
- pre-commit codama-regen hook (skipped per D-6 user choice — existing
  `verify-codama-staleness.ts` is sufficient)
