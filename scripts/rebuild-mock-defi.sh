#!/usr/bin/env bash
# Rebuild the committed mock-defi test fixture.
#
# The mock-defi Anchor program source lives at tests/fixtures/mock-defi-src/
# (NOT under programs/). It is intentionally outside the main Cargo
# workspace AND outside Anchor's programs/ scan path — see root
# Cargo.toml for the CI-compatibility rationale (cargo-certora-sbf and
# feature-flag builds). As a consequence its .so is committed at
# tests/fixtures/mock-defi.so and NOT rebuilt in CI.
#
# Run this script only when tests/fixtures/mock-defi-src/src/lib.rs
# changes. It temporarily stages the source under programs/ (where
# anchor build resolves deps against sigil's Cargo.lock), runs the
# build, copies the .so, and restores the layout.
#
# Exit code: 0 on success; non-zero on any failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ROOT_CARGO="Cargo.toml"
BACKUP="${ROOT_CARGO}.rebuild-mock-defi.bak"
SRC_FROM="tests/fixtures/mock-defi-src"
SRC_TO="programs/mock-defi"

echo "→ [1/5] Stage mock-defi source under programs/ for anchor build"
cp -R "$SRC_FROM" "$SRC_TO"

echo "→ [2/5] Temporarily add programs/mock-defi to the workspace"
cp "$ROOT_CARGO" "$BACKUP"
sed -i.tmp 's|^members = \["programs/sigil"\]$|members = ["programs/*"]|' "$ROOT_CARGO"
rm -f "${ROOT_CARGO}.tmp"

cleanup() {
    echo "→ Cleanup: restoring ${ROOT_CARGO} and removing ${SRC_TO}"
    [ -f "$BACKUP" ] && mv "$BACKUP" "$ROOT_CARGO"
    rm -rf "$SRC_TO"
}
trap cleanup EXIT

echo "→ [3/5] anchor build --no-idl"
anchor build --no-idl

echo "→ [4/5] Copy target/deploy/mock_defi.so → tests/fixtures/mock-defi.so"
mkdir -p tests/fixtures
cp target/deploy/mock_defi.so tests/fixtures/mock-defi.so

echo "→ [5/5] Restore committed IDL"
git checkout -- target/idl/ target/types/ 2>/dev/null || true

echo ""
echo "✓ Rebuilt tests/fixtures/mock-defi.so ($(ls -lh tests/fixtures/mock-defi.so | awk '{print $5}'))"
echo "  Commit: git add tests/fixtures/mock-defi.so"
