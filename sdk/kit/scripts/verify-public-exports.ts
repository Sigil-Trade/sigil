#!/usr/bin/env node
/**
 * verify-public-exports.ts — L-1 audit close (2026-05-25).
 *
 * Asserts that `sdk/kit/package.json`'s `"exports"` field does NOT expose
 * any path under `dist/generated/*`. Exposing those Codama-generated
 * raw instruction builders would let consumers deep-import them and
 * bypass the AL2 mainnet-confirmation gate baked into the
 * `mutations.createPostAssertions` / `mutations.closePostAssertions` /
 * `seal.executeSeal` wrappers.
 *
 * The gate is a UX safety net, not a security boundary — the on-chain
 * program still enforces every invariant — but the audit
 * (silent-failure-hunter, 2026-05-25) flagged the theoretical bypass as
 * worth structural enforcement. This script is the structural enforcer:
 * if a future PR accidentally adds an export like
 * `"./generated/instructions/*": "./dist/generated/instructions/*.js"`,
 * CI fails with a clear error rather than silently widening the API
 * surface.
 *
 * Documented in `sdk/kit/README.md` ("Public API surface vs internals")
 * and `sdk/kit/MIGRATION.md` (top-of-file banner).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath((import.meta as { url: string }).url);
const __dirname = dirname(__filename);
const packageJsonPath = resolve(__dirname, "..", "package.json");

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  exports?: Record<string, unknown>;
};

if (!pkg.exports || typeof pkg.exports !== "object") {
  console.error(
    "verify-public-exports: package.json has no exports field — cannot enforce public-API surface policy.",
  );
  process.exit(1);
}

const FORBIDDEN_INTERNAL_SEGMENTS = [
  "generated/",
  "generated/instructions",
  "generated/accounts",
  "generated/types",
  "generated/errors",
  "generated/programs",
];

const violations: Array<{ subpath: string; target: string; segment: string }> =
  [];

for (const [subpath, value] of Object.entries(pkg.exports)) {
  const targets = collectTargetStrings(value);
  for (const target of targets) {
    for (const segment of FORBIDDEN_INTERNAL_SEGMENTS) {
      if (target.includes(segment) || subpath.includes(segment)) {
        violations.push({ subpath, target, segment });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    "verify-public-exports: package.json `exports` field exposes internal paths:",
  );
  for (const v of violations) {
    console.error(
      `  - subpath "${v.subpath}" → target "${v.target}" (matches forbidden segment "${v.segment}")`,
    );
  }
  console.error(
    "\nL-1 audit close 2026-05-25: `dist/generated/*` is internal Codama output and MUST NOT be in the exports surface. See sdk/kit/README.md 'Public API surface vs internals' for the full policy.",
  );
  process.exit(1);
}

console.log(
  `verify-public-exports: OK — ${Object.keys(pkg.exports).length} exports declared, 0 forbidden internal paths.`,
);

function collectTargetStrings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (node && typeof node === "object") {
    return Object.values(node as Record<string, unknown>).flatMap(
      collectTargetStrings,
    );
  }
  return [];
}
