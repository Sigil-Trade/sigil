#!/usr/bin/env bash
# Rebuild the committed second mock-defi test fixture (mock-defi-2).
#
# The mock-defi-2 source at tests/fixtures/mock-defi-2-src/ is a byte-for-byte
# clone of mock-defi with a DISTINCT declare_id! — it gives the LiteSVM cap
# tests a SECOND independent allowlisted DeFi program so per-protocol cap
# INDEPENDENCE can be proven (a spend on one protocol must not consume the
# other's cap). Loading mock-defi.so at a second address is impossible —
# Anchor's runtime declare_id! check reverts — so a second binary is required.
#
# Unlike scripts/rebuild-mock-defi.sh (which stages the source under programs/),
# this crate is built STANDALONE in its own directory via `cargo build-sbf`.
# The crate's Cargo.toml declares an empty `[workspace]` table (its own
# workspace root) with its own Cargo.lock, so it resolves deps independently
# and never touches the main workspace or programs/sigil. The staged-under-
# programs/ approach FAILS here: a nested `[workspace]` inside the root members
# glob trips cargo's "multiple workspace roots" error.
#
# Run this only when tests/fixtures/mock-defi-2-src/src/lib.rs changes.
# Exit code: 0 on success; non-zero on any failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/tests/fixtures/mock-defi-2-src"

echo "→ [1/3] cargo build-sbf (standalone, in ${SRC_DIR})"
( cd "$SRC_DIR" && cargo build-sbf )

echo "→ [2/3] Copy target/deploy/mock_defi_2.so → tests/fixtures/mock-defi-2.so"
cp "$SRC_DIR/target/deploy/mock_defi_2.so" "$REPO_ROOT/tests/fixtures/mock-defi-2.so"

echo "→ [3/3] Remove build artifacts (do not commit target/)"
rm -rf "$SRC_DIR/target"

echo ""
echo "✓ Rebuilt tests/fixtures/mock-defi-2.so ($(ls -lh "$REPO_ROOT/tests/fixtures/mock-defi-2.so" | awk '{print $5}'))"
echo "  Commit: git add tests/fixtures/mock-defi-2.so"
