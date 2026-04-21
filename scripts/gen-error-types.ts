#!/usr/bin/env tsx
/**
 * Regenerate `sdk/kit/src/testing/errors/names.generated.ts` from the
 * canonical IDL at `target/idl/sigil.json`.
 *
 * Invoke:   pnpm --filter @usesigil/kit run gen:error-types
 * Or:       tsx scripts/gen-error-types.ts
 *
 * Works by parsing the IDL's `errors` array and emitting a stable,
 * alphabetically-sortable TypeScript file. The output is committed to
 * the repo so consumers don't need to regenerate; CI drift-check
 * (scripts/verify-error-drift.ts) guarantees the committed file stays
 * in sync.
 *
 * The Anchor framework-error table (2000–5999) is hand-curated — it is
 * not in the IDL — so this script only touches the SIGIL_ERRORS block.
 * The AnchorFrameworkName section survives unchanged across regens
 * because we emit by splicing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");
const IDL_PATH = resolve(repoRoot, "target/idl/sigil.json");
const TS_PATH = resolve(
  repoRoot,
  "sdk/kit/src/testing/errors/names.generated.ts",
);

const SIGIL_START_MARKER = "// Sigil program errors";
const SIGIL_END_MARKER =
  "// ────────────────────────────────────────────────────────────────\n// Anchor framework errors";

interface IdlError {
  code: number;
  name: string;
  msg?: string;
}

function main(): void {
  const rawIdl = readFileSync(IDL_PATH, "utf8");
  const json = JSON.parse(rawIdl) as { errors?: IdlError[] };
  const errors = json.errors ?? [];

  if (errors.length === 0) {
    console.error(
      `[gen-error-types] FAIL: IDL at ${IDL_PATH} has no errors[].`,
    );
    process.exit(2);
  }

  // Sort by numeric code for stable, reviewable diffs.
  errors.sort((a, b) => a.code - b.code);

  const minCode = errors[0].code;
  const maxCode = errors[errors.length - 1].code;

  const entries = errors.map((e) => `  ${e.name}: ${e.code},`).join("\n");

  // Generate the Sigil block — replaces the region between the
  // "Sigil program errors" marker and the "Anchor framework errors" marker.
  const sigilBlock = `// Sigil program errors (${minCode}-${maxCode})
// ────────────────────────────────────────────────────────────────

export const SIGIL_ERRORS = {
${entries}
} as const;

/**
 * Union of valid Sigil error names.
 *
 * A typo on the author's side (\`expectSigilError(err, { name: 'UnuthorizedAgent' })\`)
 * fails tsc. This is the compile-time safety net.
 */
export type SigilErrorName = keyof typeof SIGIL_ERRORS;

/**
 * Union of valid Sigil error codes.
 */
export type SigilErrorCode = (typeof SIGIL_ERRORS)[SigilErrorName];

/**
 * Conditional type: given a name, produce its code.
 * Used to couple \`{name, code}\` at the type level.
 */
export type SigilErrorCodeFor<N extends SigilErrorName> =
  (typeof SIGIL_ERRORS)[N];

`;

  const existing = readFileSync(TS_PATH, "utf8");

  const startIdx = existing.indexOf(SIGIL_START_MARKER);
  const endIdx = existing.indexOf(SIGIL_END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error(
      `[gen-error-types] FAIL: marker not found in ${TS_PATH}.\n` +
        `  Expected "${SIGIL_START_MARKER}" and "${SIGIL_END_MARKER}".`,
    );
    process.exit(2);
  }

  const nextContent =
    existing.slice(0, startIdx) + sigilBlock + existing.slice(endIdx);

  if (nextContent === existing) {
    console.log(
      `[gen-error-types] OK: no changes needed — ${errors.length} entries.`,
    );
    return;
  }

  writeFileSync(TS_PATH, nextContent);
  console.log(
    `[gen-error-types] OK: wrote ${errors.length} entries (${minCode}-${maxCode}) to ${TS_PATH}.`,
  );
}

main();
