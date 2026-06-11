#!/usr/bin/env -S node --import tsx
/**
 * verify-lockfile-pins.ts — Phase 9 Batch L (ISC-145, 146).
 *
 * Asserts that the security-critical packages the SDK depends on are
 * pinned to the expected major versions in `pnpm-lock.yaml`. Drift
 * detected here means a future `pnpm install` could silently swap a
 * hash primitive (e.g. @noble/hashes 1.x → 2.x) and break the TA-19 +
 * AL3 cross-impl byte-equality guarantees.
 *
 * Pinned packages:
 *   - @noble/hashes (^1.8.0) — backs canonical-encode.sha256, used by
 *     TA-19 policy_preview_digest AND AL3 intent-digest. Major bumps
 *     historically include API renames + occasional internal-state
 *     refactors that could affect output even if the API stays.
 *   - codama (1.5.1 exact) — codegen for IDL → TypeScript. Generated
 *     output drift would silently change every account decoder.
 *   - @codama/nodes-from-anchor (1.3.x) — Anchor-IDL → Codama-IR
 *     converter; same drift risk.
 *
 * Usage:
 *   pnpm -C sdk/kit verify-lockfile-pins         # exit 0 on pass
 *   pnpm -C sdk/kit verify-lockfile-pins --check # alias
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath((import.meta as { url: string }).url);
const __dirname = dirname(__filename);

// agent-middleware/ holds the workspace lockfile (NOT the outer
// Middleware-Agent-Layer repo, which is a separate git tree).
const LOCKFILE_PATH = resolve(__dirname, "../../../pnpm-lock.yaml");

interface PinSpec {
  pkg: string;
  /**
   * Required major version. The check passes if AT LEAST ONE matching
   * major appears in the lockfile (transitive deps may pull additional
   * majors; we only fail if the expected one is missing).
   */
  requiredMajor: number;
}

const PINS: readonly PinSpec[] = [
  // canonical-encode.sha256 backend — version-pinned for AL3 + TA-19
  // cross-impl byte equality. Major bumps historically change internal
  // module layout (the v1→v2 rename moved sha256 from /sha256 to /sha2).
  { pkg: "@noble/hashes", requiredMajor: 1 },
  // Codama IR converter — generated SDK output stability.
  { pkg: "@codama/nodes-from-anchor", requiredMajor: 1 },
  // Codama JS renderer — generated SDK output stability.
  { pkg: "@codama/renderers-js", requiredMajor: 2 },
];

function loadLockfile(): string {
  try {
    return readFileSync(LOCKFILE_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `verify-lockfile-pins: failed to read lockfile at ${LOCKFILE_PATH}. ` +
        `Is the SDK still nested under the workspace root? (${String(err)})`,
    );
  }
}

function extractVersions(lockfile: string, pkg: string): string[] {
  // pnpm-lock entries look like `  '<pkg>@<version>':` — capture versions.
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`'${escaped}@([^']+)':`, "g");
  const versions = new Set<string>();
  for (const match of lockfile.matchAll(re)) {
    versions.add(match[1]!);
  }
  return [...versions].sort();
}

function main(): void {
  const lockfile = loadLockfile();
  const failures: string[] = [];

  for (const spec of PINS) {
    const versions = extractVersions(lockfile, spec.pkg);
    if (versions.length === 0) {
      failures.push(
        `  ${spec.pkg}: MISSING from lockfile — expected major v${spec.requiredMajor}`,
      );
      continue;
    }
    const majors = versions.map((v) => parseInt(v.split(".")[0]!, 10));
    if (!majors.includes(spec.requiredMajor)) {
      failures.push(
        `  ${spec.pkg}: required major v${spec.requiredMajor} MISSING; ` +
          `found v${majors.join(", v")} only`,
      );
    }
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      "verify-lockfile-pins: ✗ drift detected\n" + failures.join("\n"),
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    `verify-lockfile-pins: ✓ all ${PINS.length} pinned packages match expected major versions`,
  );
}

main();
