#!/usr/bin/env bash
# regen.sh — regenerate every IDL-derived artifact in dependency order.
#
#   pnpm regen          regenerate all (IDL → types → codama → error maps → doc)
#   pnpm regen:check    verify committed artifacts are fresh (regen + git diff)
#
# WHY THIS EXISTS: every generated artifact descends from target/idl/sigil.json,
# but the normal dev loop (`anchor build --no-idl` + `git checkout -- target/idl/`)
# actively MASKS IDL updates, and the downstream chain is six commands in a
# forced order. Forgetting a link has reddened main twice (#355, #422) and a PR
# (#425). This script is the single ordered, fail-closed path.
#
# Order (each later step reads the committed IDL, so step 1 must run first):
#   1. RUSTUP_TOOLCHAIN=nightly anchor idl build  -> target/idl/sigil.json
#   2. anchor idl type                            -> target/types/sigil.ts
#   3. kit codama                                 -> sdk/kit/src/generated/**
#   4. gen:error-types                            -> sdk/kit/src/testing/errors/names.generated.ts
#   5. kit codegen:errors                         -> sdk/kit/src/errors/agent-errors.generated.ts
#   6. regen-error-codes-doc.sh                   -> docs/ERROR-CODES.md
#
# DELIBERATELY NOT AUTOMATED (their source of truth is not the IDL, or is
# irreducibly human — auto-touching would propagate stale data):
#   - scripts/test-counts.json + `pnpm update-readme` (hand-counted source)
#   - sdk/kit/src/agent-errors.ts (hand-maintained ON_CHAIN_ERROR_MAP + MAX)
#   - tests/helpers/strict-errors.ts (hand-synced LiteSVM shim)
#   - sdk/kit/tests/agent-errors.test.ts (hardcoded count/max bounds)
# The checklist printed at the end covers these; their drift gates
# (error-map-drift.test.ts, verify:error-drift, count:check) stay authoritative.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

GEN_SET=(
  target/idl/sigil.json
  target/types/sigil.ts
  sdk/kit/src/generated
  sdk/kit/src/testing/errors/names.generated.ts
  sdk/kit/src/errors/agent-errors.generated.ts
  docs/ERROR-CODES.md
)

CHECK_MODE=0
[ "${1:-}" = "--check" ] && CHECK_MODE=1

# ── Preconditions (fail closed — a silent skip is how the masking trap ships) ──
if ! RUSTUP_TOOLCHAIN=nightly cargo --version >/dev/null 2>&1; then
  echo "error: nightly Rust toolchain is required (anchor idl build)." >&2
  echo "  install: rustup toolchain install nightly" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (docs/ERROR-CODES.md regeneration)." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "error: node_modules missing — run 'pnpm install' first (codama + tsx generators)." >&2
  exit 1
fi
# CI pins anchor-cli 0.32.1; a different local version can format the IDL
# differently and make regen:check disagree with CI. Parity is fail-closed.
if ! anchor --version 2>/dev/null | grep -q '0\.32\.1'; then
  echo "error: anchor-cli 0.32.1 required (found: $(anchor --version 2>/dev/null || echo 'none'))." >&2
  echo "  CI pins 0.32.1 — a version mismatch makes regen output disagree with CI." >&2
  exit 1
fi

if [ "$CHECK_MODE" = 1 ]; then
  # A dirty generated set would contaminate the freshness diff below.
  # Three kinds of dirt: unstaged edits, STAGED-but-uncommitted edits, and
  # untracked files inside the generated set.
  if ! git diff --quiet -- "${GEN_SET[@]}" || \
     ! git diff --cached --quiet -- "${GEN_SET[@]}" || \
     [ -n "$(git ls-files --others --exclude-standard -- "${GEN_SET[@]}")" ]; then
    echo "error: generated artifacts have uncommitted (or staged) changes — commit or stash" >&2
    echo "       them before running regen:check (the freshness diff would be meaningless)." >&2
    git status --short -- "${GEN_SET[@]}" >&2
    exit 1
  fi
fi

# ── 1. IDL (nightly side-build; crash-safe: never clobber the committed IDL
#         with a partial/failed build — write to a temp file, validate, then move)
echo "[regen 1/6] target/idl/sigil.json (nightly anchor idl build — compiles the program, takes a while)"
# Temp file lives NEXT TO the target so the final `mv` is a same-filesystem
# atomic rename ($TMPDIR is often a different mount → copy+unlink, not atomic).
mkdir -p target/idl
IDL_TMP=$(mktemp target/idl/.sigil.json.tmp.XXXXXX)
trap 'rm -f "$IDL_TMP"' EXIT
if ! RUSTUP_TOOLCHAIN=nightly anchor idl build 2>/dev/null \
    | grep -v '^\s*Compiling\|^\s*Finished\|^\s*Running' > "$IDL_TMP"; then
  echo "error: 'anchor idl build' failed. Re-run it directly to see compiler errors:" >&2
  echo "  RUSTUP_TOOLCHAIN=nightly anchor idl build" >&2
  exit 1
fi
if ! [ -s "$IDL_TMP" ] || ! jq empty "$IDL_TMP" 2>/dev/null; then
  echo "error: 'anchor idl build' produced empty/invalid JSON — committed IDL left untouched." >&2
  exit 1
fi
mv "$IDL_TMP" target/idl/sigil.json
trap - EXIT

# ── 2. TS types from the IDL ──
echo "[regen 2/6] target/types/sigil.ts (anchor idl type)"
anchor idl type target/idl/sigil.json -o target/types/sigil.ts

# ── 3. codama client ──
echo "[regen 3/6] sdk/kit/src/generated/** (codama)"
pnpm --filter @usesigil/kit run codama

# ── 4 + 5. error projections ──
echo "[regen 4/6] sdk/kit/src/testing/errors/names.generated.ts (gen:error-types)"
pnpm run gen:error-types
echo "[regen 5/6] sdk/kit/src/errors/agent-errors.generated.ts (codegen:errors)"
pnpm --filter @usesigil/kit run codegen:errors

# ── 6. error-codes doc ──
echo "[regen 6/6] docs/ERROR-CODES.md (regen-error-codes-doc.sh)"
bash scripts/regen-error-codes-doc.sh

# names.generated.ts is the one generated file that is NOT prettier-ignored
# (CI lints sdk/kit/src/**), so normalize it.
pnpm exec prettier --write sdk/kit/src/testing/errors/names.generated.ts >/dev/null

if [ "$CHECK_MODE" = 1 ]; then
  # `git diff` alone is blind to BRAND-NEW generated files (untracked), so
  # probe those explicitly too.
  UNTRACKED=$(git ls-files --others --exclude-standard -- "${GEN_SET[@]}")
  if [ -n "$UNTRACKED" ]; then
    echo "regen:check FAILED — regeneration created new untracked files:" >&2
    echo "$UNTRACKED" >&2
    echo "Run 'pnpm regen', review, and commit the result." >&2
    exit 1
  fi
  if git diff --exit-code -- "${GEN_SET[@]}"; then
    echo "regen:check OK — all generated artifacts are fresh."
  else
    echo "" >&2
    echo "regen:check FAILED — the files above are stale. Run 'pnpm regen' and commit the result." >&2
    exit 1
  fi
  exit 0
fi

cat <<'EOF'

regen complete. Review `git status` and commit the regenerated artifacts.

HAND-SYNC CHECKLIST — required only if the on-chain ERROR SET changed
(new/renamed code; drift gates will fail CI until these are updated):
  [ ] sdk/kit/src/agent-errors.ts        — bump SIGIL_ON_CHAIN_ERROR_MAX + add the
                                           ON_CHAIN_ERROR_MAP entry (category,
                                           retryable, recovery_actions)
  [ ] tests/helpers/strict-errors.ts     — copy the SIGIL_ERRORS block from
                                           names.generated.ts (LiteSVM shim)
  [ ] sdk/kit/tests/agent-errors.test.ts — bump the hardcoded count / max-code bounds
If TEST FILES changed: edit scripts/test-counts.json, then `pnpm update-readme`.
EOF
