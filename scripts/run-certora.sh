#!/usr/bin/env bash
# run-certora.sh — Run Certora Solana Prover locally
#
# The conf file specifies cargo_tools_version = "v1.51", which tells
# cargo-certora-sbf to download platform-tools v1.51 (bundling Rust
# 1.84.1+). This compiler supports Cargo.lock v4 and modern crate
# MSRVs, so no lockfile workarounds are needed.
#
# Prerequisites:
#   - CERTORAKEY environment variable set (get from certoracloud.com)
#   - certora-cli installed: pip install certora-cli
#   - cargo-certora-sbf installed: cargo install cargo-certora-sbf
#
# Usage:
#   ./scripts/run-certora.sh

set -euo pipefail

# Navigate to repo root (script may be called from any directory)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Check prerequisites ──────────────────────────────────────────────

if [[ -z "${CERTORAKEY:-}" ]]; then
  echo "ERROR: CERTORAKEY environment variable is not set."
  echo "  Get your key from https://prover.certora.com and export it:"
  echo "  export CERTORAKEY=your_key_here"
  exit 1
fi

if ! command -v certoraSolanaProver &>/dev/null; then
  echo "ERROR: certora-cli not found. Install it with:"
  echo "  pip install certora-cli"
  exit 1
fi

if ! command -v cargo-certora-sbf &>/dev/null; then
  echo "ERROR: cargo-certora-sbf not found. Install it with:"
  echo "  cargo install cargo-certora-sbf"
  exit 1
fi

# ── Run the prover ───────────────────────────────────────────────────

echo "Running Certora Solana Prover (platform-tools v1.51)..."
certoraSolanaProver certora/conf/phalnx.conf

echo "Done. Certora report available in .certora_internal/"
