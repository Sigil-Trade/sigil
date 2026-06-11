#!/usr/bin/env bash
# Regenerate docs/ERROR-CODES.md from target/idl/sigil.json.
#
# Run this after every change to programs/sigil/src/errors.rs followed by
# an IDL build (nightly anchor build) — the doc is a deterministic projection
# of the IDL's `errors` array, so checked-in drift means the IDL was changed
# without regenerating the doc.
#
# Usage: bash scripts/regen-error-codes-doc.sh
set -euo pipefail

IDL=target/idl/sigil.json
OUT=docs/ERROR-CODES.md

if ! [ -f "$IDL" ]; then
  echo "FATAL: $IDL not found. Run nightly anchor build first." >&2
  exit 1
fi

ERR_COUNT=$(jq '.errors | length' "$IDL")
ERR_MIN=$(jq -r '.errors | first.code' "$IDL")
ERR_MAX=$(jq -r '.errors | last.code' "$IDL")

{
  echo "# Error Codes (${ERR_MIN}-${ERR_MAX})"
  echo
  echo "All ${ERR_COUNT} custom errors defined in \`programs/sigil/src/errors.rs\`. Use \`require!(condition, SigilError::Name)\`."
  echo
  echo "Source of truth: \`target/idl/sigil.json\` (regenerate this file by running \`bash scripts/regen-error-codes-doc.sh\` after any change to \`errors.rs\`)."
  echo
  echo "| Code | Name | Message |"
  echo "| ---- | ---- | ------- |"
  jq -r '.errors[] | "| \(.code) | `\(.name)` | \(.msg) |"' "$IDL"
} > "$OUT"

echo "Regenerated $OUT (${ERR_COUNT} errors, range ${ERR_MIN}-${ERR_MAX})"
