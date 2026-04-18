#!/usr/bin/env bash
# Rebuild the committed mock-defi test fixture.
#
# The mock-defi Anchor program is intentionally not in the main workspace
# (see root Cargo.toml — cargo-certora-sbf and feature-flag CI jobs cannot
# tolerate a second cdylib in workspace metadata). As a consequence its
# .so is committed at tests/fixtures/mock-defi.so and NOT rebuilt in CI.
#
# Run this script only when programs/mock-defi/src/lib.rs changes.
# Side effect: temporarily adds mock-defi back to the workspace so that
# anchor build can resolve deps against sigil's Cargo.lock, then restores
# the workspace config.
#
# Exit code: 0 on success; non-zero on any failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ROOT_CARGO="Cargo.toml"
BACKUP="${ROOT_CARGO}.rebuild-mock-defi.bak"

echo "→ [1/4] Temporarily adding programs/mock-defi to the workspace"
cp "$ROOT_CARGO" "$BACKUP"
# Replace the `members = ["programs/sigil"]` line with the glob form.
# sed -i works portably with .bak suffix on BSD/GNU both.
sed -i.tmp 's|^members = \["programs/sigil"\]$|members = ["programs/*"]|' "$ROOT_CARGO"
rm -f "${ROOT_CARGO}.tmp"

restore_cargo() {
    echo "→ Restoring ${ROOT_CARGO}"
    mv "$BACKUP" "$ROOT_CARGO"
}
trap restore_cargo EXIT

echo "→ [2/4] Running anchor build --no-idl"
anchor build --no-idl

echo "→ [3/4] Copying target/deploy/mock_defi.so → tests/fixtures/mock-defi.so"
mkdir -p tests/fixtures
cp target/deploy/mock_defi.so tests/fixtures/mock-defi.so

echo "→ [4/4] Restoring IDL (anchor build overwrites it)"
git checkout -- target/idl/ target/types/ 2>/dev/null || true

echo ""
echo "✓ Rebuilt tests/fixtures/mock-defi.so ($(ls -lh tests/fixtures/mock-defi.so | awk '{print $5}'))"
echo "  Don't forget to commit: git add tests/fixtures/mock-defi.so"
