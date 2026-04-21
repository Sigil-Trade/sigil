#!/usr/bin/env python3
"""
Codemod: migrate legacy *Legacy error helpers to strict typed helpers.

Transforms:
  expectSigilErrorLegacy(err.toString(), "Name")
    → expectSigilError(err, { name: "Name", code: <code> })
  expectSigilErrorLegacy(err.toString(), "Anchor", ...)
    → expectAnchorError(err, { name: "Anchor", code: <code> })
  expectSigilErrorLegacy(err.toString(), "A", "B")
    → expectOneOfSigilErrors(err, ["A", "B"])
  expectErrorLegacy(err, "Name")
    → expectSigilError(err, { name: "Name", code: <code> })
  expectErrorLegacy(err, "Name", "numericString")
    → expectSigilError(err, { name: "Name", code: <code> })
  expectErrorLegacy(err, "Name", "substringFallback")
    → expectSigilError(err, { name: "Name", code: <code> })  — drop substrings
  expectErrorLegacy(err, "A", "B")
    → expectOneOfSigilErrors(err, ["A", "B"])  — if both are Sigil names

Also:
  1. Adds import { expectSigilError, expectAnchorError, expectOneOfSigilErrors }
     from "@usesigil/kit/testing" at top of each modified file.
  2. Removes the legacy import from "./helpers/devnet-setup" / litesvm-setup.
  3. Emits a punt list to /tmp/codemod-punts.txt for manual review.

Council decision (7-0 STRICT):
  MEMORY/WORK/20260420-201121_test-assertion-precision-council/COUNCIL_DECISION.md
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
IDL_PATH = REPO_ROOT / "target" / "idl" / "sigil.json"

# Anchor framework names we expect to see in legacy calls (hand-curated).
# Source of truth: anchor-lang-0.32.1 constants. Subset of what we see in tests.
ANCHOR_FRAMEWORK_CODES = {
    "InstructionMissing": 100,
    "InstructionFallbackNotFound": 101,
    "InstructionDidNotDeserialize": 102,
    "InstructionDidNotSerialize": 103,
    "ConstraintMut": 2000,
    "ConstraintHasOne": 2001,
    "ConstraintSigner": 2002,
    "ConstraintRaw": 2003,
    "ConstraintOwner": 2004,
    "ConstraintRentExempt": 2005,
    "ConstraintSeeds": 2006,
    "ConstraintExecutable": 2007,
    "ConstraintState": 2008,
    "ConstraintAssociated": 2009,
    "ConstraintAssociatedInit": 2010,
    "ConstraintClose": 2011,
    "ConstraintAddress": 2012,
    "ConstraintZero": 2013,
    "ConstraintTokenMint": 2014,
    "ConstraintTokenOwner": 2015,
    "ConstraintMintMintAuthority": 2016,
    "ConstraintMintFreezeAuthority": 2017,
    "ConstraintMintDecimals": 2018,
    "ConstraintSpace": 2019,
    "ConstraintAccountIsNone": 2020,
    "ConstraintTokenTokenProgram": 2021,
    "ConstraintMintTokenProgram": 2022,
    "ConstraintAssociatedTokenTokenProgram": 2023,
    "AccountDiscriminatorAlreadySet": 3000,
    "AccountDiscriminatorNotFound": 3001,
    "AccountDiscriminatorMismatch": 3002,
    "AccountDidNotDeserialize": 3003,
    "AccountDidNotSerialize": 3004,
    "AccountNotEnoughKeys": 3005,
    "AccountNotMutable": 3006,
    "AccountOwnedByWrongProgram": 3007,
    "InvalidProgramId": 3008,
    "InvalidProgramExecutable": 3009,
    "AccountNotSigner": 3010,
    "AccountNotSystemOwned": 3011,
    "AccountNotInitialized": 3012,
    "AccountNotProgramData": 3013,
    "AccountNotAssociatedTokenAccount": 3014,
    "AccountSysvarMismatch": 3015,
    "AccountReallocExceedsLimit": 3016,
    "AccountDuplicateReallocs": 3017,
}


def load_sigil_names() -> dict[str, int]:
    """Load canonical Sigil error name → code map from IDL."""
    with IDL_PATH.open() as f:
        idl = json.load(f)
    return {e["name"]: e["code"] for e in idl["errors"]}


SIGIL_ERRORS = load_sigil_names()
print(f"[codemod] loaded {len(SIGIL_ERRORS)} Sigil error names from IDL")


def is_sigil_name(s: str) -> bool:
    return s in SIGIL_ERRORS


def is_anchor_name(s: str) -> bool:
    return s in ANCHOR_FRAMEWORK_CODES


def is_known_name(s: str) -> bool:
    return is_sigil_name(s) or is_anchor_name(s)


# ────────────────────────────────────────────────────────────────
# Pattern matcher — extracts args from legacy calls.
# ────────────────────────────────────────────────────────────────

# Matches: expectSigilErrorLegacy(<expr>, <arg1>, <arg2>, ...)
# where <expr> is err.toString() or similar, and args are string literals.
LEGACY_CALL_RE = re.compile(
    r'(expectSigilErrorLegacy|expectErrorLegacy)\(\s*'
    r'([^,]+?),\s*'      # first arg: error expr (e.g. `err.toString()` or `err`)
    r'((?:"[^"]*"(?:,\s*)?)+)'  # string-literal args (one or more)
    r'\s*\)',
    re.DOTALL,
)

# Extract quoted strings from the args group.
QUOTED_ARG_RE = re.compile(r'"([^"]*)"')


def classify_call(match: re.Match) -> tuple[Optional[str], Optional[str]]:
    """
    Given a matched legacy call, return (new_call_text, comment).
    new_call_text = the replacement code, or None if codemod punts.
    comment = optional diagnostic/TODO comment to insert before the call.
    """
    fn_name = match.group(1)
    err_expr = match.group(2).strip()
    string_args_block = match.group(3)

    args = QUOTED_ARG_RE.findall(string_args_block)
    if not args:
        return None, f"codemod-punt: no string args parsed from {match.group(0)[:80]}"

    # Normalize err expression: `err.toString()` → `err`
    if err_expr.endswith(".toString()"):
        err_expr_normalized = err_expr[: -len(".toString()")]
    elif err_expr == "err.toString()":
        err_expr_normalized = "err"
    else:
        err_expr_normalized = err_expr

    # Filter args into categories.
    sigil_names = [a for a in args if is_sigil_name(a)]
    anchor_names = [a for a in args if is_anchor_name(a)]
    numeric_strings = [
        a for a in args if re.fullmatch(r"[0-9]+|0x[0-9a-fA-F]+", a)
    ]
    # Unknown args are substring fallbacks: "has_one", "constraint", "seeds",
    # "Unauthorized" (not capitalized Sigil name), etc. We drop them silently.

    # Classification decision tree:
    #
    #   1. No known names → cannot codemod safely, punt.
    #   2. Exactly one Sigil name, no Anchor names → expectSigilError
    #   3. Exactly one Anchor name, no Sigil names → expectAnchorError
    #   4. Multiple Sigil names only (≤3) → expectOneOfSigilErrors
    #   5. Mixed Sigil + Anchor → punt (ambiguous intent)
    #   6. >3 Sigil names → punt (tuple-type limit)

    known = sigil_names + anchor_names

    if not known:
        return None, (
            f"codemod-punt: no known Sigil or Anchor name found in "
            f"[{', '.join(args)}] — args are all substring fallbacks"
        )

    if sigil_names and anchor_names:
        return None, (
            f"codemod-punt: mixed Sigil + Anchor names in "
            f"[{', '.join(args)}] — need manual decision on helper"
        )

    if len(sigil_names) > 3:
        return None, (
            f"codemod-punt: {len(sigil_names)} Sigil names exceeds "
            f"expectOneOfSigilErrors tuple limit (≤3). Split the test."
        )

    if len(sigil_names) == 1:
        name = sigil_names[0]
        code = SIGIL_ERRORS[name]
        return (
            f'expectSigilError({err_expr_normalized}, {{ name: "{name}", code: {code} }})',
            None,
        )

    if len(sigil_names) >= 2:
        quoted = ", ".join(f'"{n}"' for n in sigil_names)
        return (
            f"expectOneOfSigilErrors({err_expr_normalized}, [{quoted}])",
            None,
        )

    if len(anchor_names) == 1:
        name = anchor_names[0]
        code = ANCHOR_FRAMEWORK_CODES[name]
        return (
            f'expectAnchorError({err_expr_normalized}, {{ name: "{name}", code: {code} }})',
            None,
        )

    if 2 <= len(anchor_names) <= 3:
        quoted = ", ".join(f'"{n}"' for n in anchor_names)
        return (
            f"expectOneOfAnchorErrors({err_expr_normalized}, [{quoted}])",
            None,
        )

    if len(anchor_names) > 3:
        return None, (
            f"codemod-punt: {len(anchor_names)} Anchor names exceeds "
            f"expectOneOfAnchorErrors tuple limit (≤3). Split the test."
        )

    return None, f"codemod-punt: unreachable classifier branch for {known}"


# ────────────────────────────────────────────────────────────────
# Import management
# ────────────────────────────────────────────────────────────────

KIT_IMPORT_RE = re.compile(
    r'import\s*\{([^}]*)\}\s*from\s*"@usesigil/kit/testing"\s*;?',
    re.DOTALL,
)

# Matches the legacy imports we need to remove (only the legacy name — other
# imports from the same module stay).
LEGACY_NAMES = ("expectErrorLegacy", "expectSigilErrorLegacy")


def ensure_kit_testing_import(content: str, needed: set[str]) -> str:
    """
    Ensure `content` imports each name in `needed` from "@usesigil/kit/testing".
    Preserves existing imports from that module; adds a new one if missing.
    """
    if not needed:
        return content

    existing = KIT_IMPORT_RE.search(content)
    if existing:
        # Parse existing named imports; merge with `needed`.
        inner = existing.group(1)
        current_names = {
            n.strip().split(" ")[0]
            for n in inner.split(",")
            if n.strip()
        }
        merged = sorted(current_names | needed)
        new_import = (
            f'import {{\n  '
            + ",\n  ".join(merged)
            + f',\n}} from "@usesigil/kit/testing";'
        )
        content = content[: existing.start()] + new_import + content[existing.end() :]
    else:
        # Insert a new import. Place after the last top-level import
        # statement (rough heuristic: after the last line starting with
        # `import ` or `} from "...";`).
        import_insert_re = re.compile(
            r'^(import\s+[^\n]*\n|import\s+\{[^}]*\}\s*from\s*"[^"]+"\s*;?\n)+',
            re.MULTILINE,
        )
        m = import_insert_re.match(content)
        new_import = (
            f'// Strict error helpers — see MEMORY/WORK/20260420-201121_test-assertion-precision-council/\n'
            f'import {{\n  '
            + ",\n  ".join(sorted(needed))
            + f',\n}} from "@usesigil/kit/testing";\n'
        )
        if m:
            insert_at = m.end()
            content = content[:insert_at] + new_import + content[insert_at:]
        else:
            # Fallback: prepend.
            content = new_import + content
    return content


def remove_legacy_imports_if_unused(content: str) -> str:
    """Remove expectErrorLegacy / expectSigilErrorLegacy from import lists if
    no callsites remain in the file."""
    for legacy in LEGACY_NAMES:
        # Only remove if no more callsites reference it.
        pattern = re.compile(rf"\b{legacy}\b\s*\(")
        if pattern.search(content):
            continue  # Still used — keep import.
        # Remove the name from any import list. Multiple patterns to handle
        # different import styles.
        # `import { a, legacy, b } from "x"` → `import { a, b } from "x"`
        content = re.sub(
            rf",\s*{legacy}\b|{legacy}\s*,\s*|{legacy}\s*",
            "",
            content,
            count=1,
        )
    return content


# ────────────────────────────────────────────────────────────────
# File-level transformation
# ────────────────────────────────────────────────────────────────

def transform_file(path: Path) -> tuple[int, int, list[str]]:
    """Returns (callsites_transformed, callsites_punted, punt_messages)."""
    original = path.read_text()
    content = original

    punts: list[str] = []
    transformed = 0
    punted = 0
    needed_imports: set[str] = set()

    # Find all calls and transform them.
    def replace_call(m: re.Match) -> str:
        nonlocal transformed, punted
        result, comment = classify_call(m)
        if result is None:
            punted += 1
            punts.append(
                f"{path.relative_to(REPO_ROOT)}:{find_line(content, m.start())} "
                f"{comment}\n  call: {m.group(0)[:120]}"
            )
            return m.group(0)  # Leave untouched.

        transformed += 1
        # Register the imported name.
        if result.startswith("expectSigilError("):
            needed_imports.add("expectSigilError")
        elif result.startswith("expectAnchorError("):
            needed_imports.add("expectAnchorError")
        elif result.startswith("expectOneOfSigilErrors("):
            needed_imports.add("expectOneOfSigilErrors")
        return result

    content = LEGACY_CALL_RE.sub(replace_call, content)

    if transformed > 0:
        content = ensure_kit_testing_import(content, needed_imports)
        content = remove_legacy_imports_if_unused(content)

    if content != original:
        path.write_text(content)

    return transformed, punted, punts


def find_line(text: str, offset: int) -> int:
    return text[: offset].count("\n") + 1


# ────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────

def main():
    target_files = [
        "tests/devnet-fees.ts",
        "tests/devnet-positions.ts",  # may not exist after PR-258
        "tests/devnet-routing.ts",
        "tests/devnet-security.ts",
        "tests/devnet-sessions.ts",
        "tests/devnet-spending.ts",
        "tests/devnet-timelock.ts",
        "tests/devnet-transfers.ts",
        "tests/devnet/stress-test.ts",
        "tests/instruction-constraints.ts",
        "tests/security-exploits.ts",
        "tests/sigil.ts",
        "tests/toctou-security.ts",
    ]

    total_transformed = 0
    total_punted = 0
    all_punts: list[str] = []

    for rel in target_files:
        path = REPO_ROOT / rel
        if not path.exists():
            print(f"[skip] {rel} — not found (maybe deleted on main)")
            continue

        transformed, punted, punts = transform_file(path)
        if transformed or punted:
            print(f"[transform] {rel}: +{transformed} migrated, {punted} punted")
        total_transformed += transformed
        total_punted += punted
        all_punts.extend(punts)

    punt_file = Path("/tmp/codemod-punts.txt")
    punt_file.write_text("\n\n".join(all_punts) if all_punts else "(no punts)\n")

    print()
    print(f"[summary] migrated: {total_transformed}, punted: {total_punted}")
    print(f"[punts]   written to {punt_file}")

    if total_punted > 0:
        print()
        print("Punt list (first 10 entries):")
        for p in all_punts[:10]:
            print(f"  - {p}")

    return 0 if total_punted == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
