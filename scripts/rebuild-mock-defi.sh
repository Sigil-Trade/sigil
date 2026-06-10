#!/usr/bin/env bash
# Rebuild the committed mock-defi test fixture.
#
# The mock-defi Anchor program source lives at tests/fixtures/mock-defi-src/
# (NOT under programs/). It is its OWN Cargo workspace root (declares an empty
# [workspace] table) and is intentionally outside the main workspace AND
# Anchor's programs/ scan path — see root Cargo.toml for the CI-compatibility
# rationale (cargo-certora-sbf and feature-flag builds). Its compiled binary is
# committed at tests/fixtures/mock-defi.so and is NOT rebuilt in CI.
#
# Run this script only when tests/fixtures/mock-defi-src/src/lib.rs changes
# (e.g. a declare_id! update). It builds the program STANDALONE via
# `cargo build-sbf` against the package's own Cargo.lock.
#
# NOTE: the previous approach — staging the source under programs/ and adding
# programs/* to the root workspace, then `anchor build` — fails under
# cargo-build-sbf with "multiple workspace roots found in the same workspace"
# because mock-defi-src declares its own [workspace] root. The standalone
# build below avoids that conflict entirely.
#
# Exit code: 0 on success; non-zero on any failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SRC="tests/fixtures/mock-defi-src"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR" "$SRC/target"' EXIT

echo "→ [1/2] cargo build-sbf (standalone — mock-defi-src is its own workspace root)"
cargo build-sbf --manifest-path "$SRC/Cargo.toml" --sbf-out-dir "$OUT_DIR"

echo "→ [2/2] Copy mock_defi.so → tests/fixtures/mock-defi.so"
mkdir -p tests/fixtures
cp "$OUT_DIR/mock_defi.so" tests/fixtures/mock-defi.so

echo ""
echo "✓ Rebuilt tests/fixtures/mock-defi.so ($(ls -lh tests/fixtures/mock-defi.so | awk '{print $5}'))"
echo "  Commit: git add tests/fixtures/mock-defi.so"
