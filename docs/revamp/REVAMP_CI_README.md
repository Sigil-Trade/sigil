# REVAMP_CI_README.md — Sigil v2 Revamp CI Workflow

**Status:** Living document — documents `.github/workflows/revamp-ci.yml`.
**Last updated:** 2026-05-17
**Branch scope:** `revamp/v2-2026-05` (and all Stage N tags on that branch).
**Companion docs:** [REVAMP_PLAN.md](./REVAMP_PLAN.md), [THREAT_MODEL_V2.md](./THREAT_MODEL_V2.md), [ACCEPTANCE_V2.md](./ACCEPTANCE_V2.md)

## Purpose

The `revamp-ci.yml` workflow runs on every `push` / `pull_request` against `revamp/v2-2026-05`. It mirrors the main `ci.yml` pipeline + adds a Stage-0-mandated **IDL diff** guardrail.

The main `ci.yml` is comprehensive (LiteSVM + Surfpool + Trident fuzz across 1,580+ tests). `revamp-ci.yml` does NOT replace it — it adds revamp-specific checks that the main pipeline doesn't have:
1. IDL-diff guard — detects when committed `target/idl/sigil.json` drifts from program source.
2. Scope guard — verifies the revamp branch's diff stays within `docs/revamp/**` + `.github/workflows/revamp-ci.yml` for Stage 0 (relaxes for Stages 1-7).

## IDL Diff Check

This is the **load-bearing new check** added in Stage 0 per CodexResearcher 2026-05-17 findings.

### Mechanism

After `anchor build --no-idl`, the workflow:

1. Saves a copy of the committed IDL: `cp target/idl/sigil.json /tmp/sigil.committed.json`
2. Regenerates the IDL via nightly anchor: `RUSTUP_TOOLCHAIN=nightly anchor idl build`
3. Canonicalizes both JSON files with `jq -S` (sorts keys alphabetically — defeats key-order non-determinism in serde JSON output).
4. Runs `diff -u` between the canonicalized files.
5. Non-zero diff → CI fails with an error message instructing the developer to:
   ```
   anchor build --no-idl && \
   RUSTUP_TOOLCHAIN=nightly anchor idl build && \
   git add agent-middleware/target/idl/ && \
   git commit -m "chore: regenerate IDL"
   ```

### Why NOT `> target/idl/sigil.json` redirect

The original Stage 0 plan proposal had:
```bash
RUSTUP_TOOLCHAIN=nightly anchor idl build > target/idl/sigil.json
```

**This is wrong** — per CodexResearcher 2026-05-17:
- `anchor idl build` writes the file at `target/idl/<program>.json` *directly* as a side effect.
- The `>` redirect captures **stdout** (log output / progress messages), NOT the JSON.
- Result: the IDL file is overwritten with log noise; the JSON is unrecoverable.

The correct mechanic is:
1. Let `anchor idl build` write its target file.
2. Compare against the committed file.

### Why `jq -S` canonicalization

Per CodexResearcher 2026-05-17, Anchor IDL output is non-deterministic across:
- Anchor CLI versions (every minor version changed IDL shape; 0.29 → 0.30 → 0.31 → 0.32).
- Rust toolchain versions (proc-macro spans differ).
- Cargo features (which `#[derive]`s are visible).
- Doc comment whitespace + line endings (CRLF vs LF).
- Field declaration order.
- `#[derive]` macro attribute order.
- `idl-build` feature flag presence.

`jq -S` sorts JSON keys alphabetically. This defeats key-order differences without losing semantic content. Combined with pinned `RUST_VERSION` + `SOLANA_VERSION` + `ANCHOR_VERSION` + `LANG=C.UTF-8` + `LC_ALL=C.UTF-8` + `SOURCE_DATE_EPOCH=1577836800` env vars in CI, the IDL diff check is deterministic across machines.

### Production reference

Per CodexResearcher 2026-05-17: **No production Solana protocol (Drift, Marginfi, Kamino, Jupiter) currently runs an IDL-diff CI guard.** They rely on:
- Pinned toolchains + manual `update-idl` scripts (Drift, Marginfi).
- `solana-verify` for the `.so` only (Kamino).

Sigil's IDL-diff guard is **novel for the Solana ecosystem.** This is appropriate for a guardrails-focused product, but means we are the first to discover IDL-determinism footguns at scale. Expect some false-positive friction during the first 2-4 weeks of operation; per [REVAMP_PLAN.md §7 Open Questions Q3](./REVAMP_PLAN.md#7-open-questions), document any perturbation sources discovered in the field.

## Flake Retry Policy

Per project root `CLAUDE.md` memory: devnet RPC congestion can cause spurious LiteSVM or `cargo-build-sbf` failures.

**Retry policy (per LOW-8 of the plan-review):**
- If `cargo-build-sbf` fails: retry the run via `gh run rerun <run-id>` up to **2 times** before treating failure as real.
- If LiteSVM tests fail due to RPC timeout (specifically): retry the run via `gh run rerun <run-id>` up to **2 times**.
- If Surfpool tests fail: retry **1 time** only (Surfpool flakes are rare).
- After all retries exhausted, the failure is treated as real and PR is blocked.

The `gh run rerun` command:
```bash
gh run rerun <RUN_ID> --repo <OWNER>/<REPO>
```

For automated retry, see `.github/workflows/revamp-ci-retry.yml` (Stage 1+ work, not in Stage 0 scope).

## Triggering

`revamp-ci.yml` triggers on:
- `push` to `revamp/v2-2026-05` branch (any push, including force-push).
- `pull_request` opened/synchronized targeting `revamp/v2-2026-05`.
- `workflow_dispatch` (manual trigger from GitHub Actions UI).

It does NOT trigger on `main` (main has its own `ci.yml`).

## Pinned Toolchain Versions

Per CodexResearcher 2026-05-17 + [REVAMP_PLAN.md §7 Q3](./REVAMP_PLAN.md#7-open-questions), the following versions are pinned in CI env to eliminate IDL determinism perturbations:

```yaml
env:
  RUST_VERSION: "1.89.0"              # Anchor 0.32.1 stable IDL build minimum
  SOLANA_VERSION: "2.1.14"            # Matches local dev (per memory)
  ANCHOR_VERSION: "0.32.1"            # Project-pinned per D-08
  LANG: "C.UTF-8"
  LC_ALL: "C.UTF-8"
  SOURCE_DATE_EPOCH: "1577836800"     # Defensive — fixed timestamp (2020-01-01)
```

Local dev must match these — see `agent-middleware/CLAUDE.md` for setup. CI authoritative; local dev must follow.

## Stage Scope Guard

For Stage 0 specifically: `revamp-ci.yml` includes a scope-guard job that fails if the branch's diff against `main` touches any path outside:
- `agent-middleware/docs/revamp/**`
- `.github/workflows/revamp-ci.yml`

This enforces the Stage 0 acceptance criterion "zero edits outside expected scope" per [REVAMP_PLAN §22.3](./REVAMP_PLAN.md#223-no-push-without-consultation).

For Stages 1-7, the scope-guard relaxes to allow paths appropriate to each stage (Stage 1 allows `agent-middleware/programs/**` + tests; Stage 4 allows `agent-middleware/sdk/**`; etc.). The scope-guard logic is parameterized by branch + tag at each stage entry.

## Cross-doc References

- §3.6 test coverage gate: [ACCEPTANCE_V2.md](./ACCEPTANCE_V2.md#36--test-coverage).
- IDL determinism research: prior CodexResearcher 2026-05-17 (referenced in [REVAMP_PLAN.md §0](./REVAMP_PLAN.md#0-referenced-research)).
- Project root `CLAUDE.md` IDL convention: see "IDL is committed, not auto-generated" section.

## Verification

This workflow is "green on first push" per [ACCEPTANCE_V2.md sequence diagram](./ACCEPTANCE_V2.md#5-sequence-diagram). User confirms green status via `gh run watch <run-id>` after the consultation-gated push (Phase K of the [snazzy-mixing-gosling plan](../../../Plans/snazzy-mixing-gosling.md)).

## Document Provenance

- **Created:** 2026-05-17 (Stage 0).
- **Authored by:** Claude (Opus 4.7) + Kaleb Rupe.
- **Reviewed by:** §RP reviewer fan + reverify swap pass.

---

**END OF REVAMP_CI_README.md**
