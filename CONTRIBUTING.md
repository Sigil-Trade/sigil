# Contributing to Sigil

Thanks for your interest. This document covers the monorepo workflow — the
conventions, the review pipeline, and the common sub-tasks (adding a protocol,
adding an SDK helper, running tests).

Sigil is pre-1.0 and moves quickly. If anything in this doc disagrees with
what you see in the code, the code is canonical — please open a PR to correct
this file.

## Repo Shape

This repo is a pnpm monorepo with four top-level projects:

| Project                       | Stack                       | Purpose                                                                              |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `agent-middleware/`           | Anchor 0.32.1 (Rust) + pnpm | Core Solana program (`sigil`), TypeScript SDKs, and all on-chain tests               |
| `dashboard/`                  | Next.js 14 + TanStack Query | Vault-owner admin cockpit. Consumes `@usesigil/kit` via file reference.              |
| `Sigil-Smart-Wallet/`         | React 19 + Vite 6           | Landing page / standalone web app. No Solana deps.                                   |
| `protocol-scalability-tests/` | tsx + @solana/kit           | Adversarial security tests against live devnet. Passing = program rejects an attack. |

Each sub-project has its own README. Read the relevant one before you start.

## First-Time Setup

```bash
git clone git@github.com:Sigil-Trade/sigil.git
cd sigil/agent-middleware

# Node + pnpm
pnpm install

# Rust toolchain (only needed for program work)
rustup install 1.89.0
rustup default 1.89.0

# Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.32.1 && avm use 0.32.1
```

## Day-to-Day Workflow

### Running tests

The most common thing you'll want:

```bash
# All LiteSVM tests (in-process, no validator, ~45s, ~361 tests)
pnpm test

# A single test file
npx ts-mocha -p ./tsconfig.json -t 300000 tests/<file>.ts

# SDK tests only
pnpm --filter @usesigil/kit test
```

### Modifying the Solana program (Rust)

Any time you touch `programs/sigil/src/**`:

```bash
# 1. Build (--no-idl required on stable Rust with Anchor 0.32.1)
anchor build --no-idl

# 2. Restore the committed IDL + types (anchor overwrites them on build)
git checkout -- target/idl/ target/types/

# 3. Run the relevant test suite
pnpm test
```

**Always do all three.** Shipping a Rust change without running tests is the #1
cause of CI regression in this repo. The IDL restore is critical — the committed
IDL is the source of truth; `anchor build` generates a placeholder that will
break every TypeScript test that uses generated types.

### Modifying the SDK (TypeScript)

Most SDK work happens in `sdk/kit/src/`. The test suite is `sdk/kit/tests/`.

```bash
# Typecheck
pnpm -r --filter @usesigil/kit run build

# Run all kit tests
pnpm --filter @usesigil/kit test

# Run one test file
pnpm --filter @usesigil/kit exec mocha --require tsx tests/<file>.test.ts
```

If your change is user-visible (new export, API change, behavior change on an
existing function), **add a changeset:**

```bash
pnpm changeset
```

This creates a `.changeset/*.md` file describing the change at the version
level (patch / minor / major). Commit it in the same PR. Without a changeset,
the release workflow won't know how to bump versions, and CI will flag it.

## Branching & Commits

**Branch names:** `<scope>/<short-description>`. Scopes we use:

- `feat/` — new feature (user-visible)
- `fix/` — bug fix
- `refactor/` — code change, no behavior change
- `docs/` — docs only
- `chore/` — tooling, config, deps
- `test/` — test-only changes

**Commit messages:** [Conventional Commits](https://www.conventionalcommits.org/).
Examples from this repo:

```
feat(kit): Sigil facade + SigilVault handle (Sprint 2 B1+B2)
fix(plugins): migrate SAK plugin off private SigilClient constructor
chore(kit): delete legacy 21-bit bitmask helpers (A11)
test: clear 10 skipped tests (Issue #209 quick wins)
docs: align documentation with current source code
```

For WIP commits inside a multi-step branch: `[WIP step N/M] description`.

## Pull Requests

### Title + body

- **Title:** under 70 characters, imperative mood, conventional prefix.
- **Body:** use the PR template. Two sections are mandatory:
  - **Summary** — 1-3 bullets on what changed and why (the "why" matters more than the "what")
  - **Test plan** — bulleted checklist of how you verified it works

### Adversarial review pipeline (mandatory)

Every non-trivial PR must pass this review pipeline before merge:

1. **Local build + test** — `anchor build --no-idl`, restore IDL, run the relevant
   suite. Zero failures.
2. **Adversarial code review** — spawn `pr-review-toolkit:code-reviewer` or
   `pr-review-toolkit:silent-failure-hunter` with a prompt that explains what
   you built and tells the agent to attack it. The agent must read the actual
   code, not a summary.
3. **Fix all findings** — every CRITICAL and HIGH must be fixed before the PR
   is created. MEDIUM findings must be fixed or documented with explicit
   rationale for deferral.
4. **PR + CI green** — never push to `main` directly. Branch protection rejects
   it. All CI checks must be green before merge; no `--no-verify`, no
   force-merge.

This pipeline has caught 77 findings across this project including 2 CRITICALs
(assertion bypass vectors) that would have shipped without it. Not optional.

### What not to do

- **Don't skip hooks** (`--no-verify`, `--no-gpg-sign`). The pre-push hook runs
  prettier + cargo fmt; if it fails, your PR will fail CI anyway. Fix the
  underlying issue.
- **Don't force-push to `main`.** Ever. Branch protection blocks it but don't
  rely on that.
- **Don't commit `target/idl/` or `target/types/` drift** from `anchor build`
  without understanding why. The committed IDL is the source of truth.
- **Don't bundle unrelated changes** in a single PR. One concern per PR keeps
  the review pipeline fast and the revert surface small.

## Common Tasks

### Adding a new protocol to the allowlist

See `agent-middleware/docs/INSTRUCTIONS.md` for the full guide. Three steps:

1. Add the program ID constant to `programs/sigil/src/state/mod.rs`
2. Add the protocol to `SUPPORTED_PROTOCOLS` in `sdk/kit/src/types.ts`
3. Add a test in `tests/` that exercises an allowlisted call

Build + restore IDL + run tests. Open a PR with a changeset.

### Adding a new SDK helper

1. New file: `sdk/kit/src/helpers/<name>.ts`
2. Export from `sdk/kit/src/index.ts` (check `docs/BARREL-AUDIT.md` first — most
   internals should NOT go at root)
3. Tests: `sdk/kit/tests/<name>.test.ts`
4. Update `sdk/kit/README.md` if it's user-visible
5. Add a changeset

### Adding a new test tier

We use three tiers:

| Tier        | Tool                           | Speed  | When to use                                                |
| ----------- | ------------------------------ | ------ | ---------------------------------------------------------- |
| Unit        | LiteSVM (in-process VM)        | ~45s   | Default. Every new on-chain behavior needs a LiteSVM test. |
| Integration | Surfpool (LiteSVM-backed node) | ~60s   | Multi-transaction flows, Solana runtime features.          |
| Cluster     | Devnet                         | ~5 min | Real-network smoke tests before mainnet deployment.        |

LiteSVM first. Devnet only when you genuinely need real-network semantics.

### Bumping dependencies

1. Check if it's already flagged: `pnpm audit` and look at Dependabot alerts.
2. Bump in the relevant `package.json` — prefer widest compatible range.
3. `pnpm install` → verify lockfile delta is minimal and expected.
4. `pnpm test` → all green.
5. Commit with `chore(deps): bump <package>@<version>` and a changeset if
   any SDK consumer would feel the change.

## Releases

Releases are driven by [changesets](https://github.com/changesets/changesets):

1. Each PR that changes a package adds a `.changeset/*.md` describing the
   change at patch / minor / major granularity.
2. When multiple changesets accumulate on `main`, the changesets bot opens a
   "Version Packages" PR that bumps versions + updates CHANGELOG.md.
3. Merging that PR publishes to npm (via the release workflow).

**Don't skip the changeset.** Pre-1.0 we're strict about this because
downstream consumers (even internal ones like the dashboard) rely on the
version number to know whether to re-test.

See [`.changeset/README.md`](.changeset/README.md) for the pre-1.0 versioning
policy (what warrants a minor vs. patch vs. major on a 0.x line, and the rules
we follow to stop unnecessary version cascades).

## Getting Help

- **Architecture questions:** start with `docs/PROJECT.md` and
  `docs/ARCHITECTURE.md`.
- **Error codes:** `docs/ERROR-CODES.md` lists all 71 on-chain codes (6000-6070).
- **Build issues:** `docs/COMMANDS-REFERENCE.md` has every command we run.
- **Security:** `SECURITY.md` documents the threat model and disclosure path.

## Code of Conduct

Be excellent. This project is about making AI agents safer for the people who
own them — bring the same care to the people you work with here.
