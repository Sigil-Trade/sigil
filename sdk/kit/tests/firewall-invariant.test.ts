/**
 * Firewall invariant test — kit must NEVER import `@sigil-trade/constraints`.
 *
 * The `@sigil-trade/constraints` package is a PRIVATE GitHub Packages parser
 * package. The kit is a public, browser-compatible, ESM-only SDK and cannot
 * depend on private code or Node-only `node:zlib` consumed by that parser.
 *
 * This test is the canonical enforcement of the firewall invariant —
 * "kit must never import from `@sigil-trade/constraints`." It walks `src/`
 * and rejects any
 * file that contains a real `import`/`from`/`require`/`export ... from`
 * statement targeting that package — while permitting JSDoc `@example`
 * blocks and prose mentions in comments.
 *
 * No eslint config exists in the repo, so this serves as the CI-time
 * enforcement. If/when a project-wide eslint config lands, the same rule
 * should be promoted to a `no-restricted-imports` lint rule and this
 * test can be deleted in favor of `pnpm lint`.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, "..", "src");

/**
 * Recursively walk a directory, yielding every `.ts` file path.
 * Skips `node_modules` and any nested `dist` if encountered.
 */
async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

/**
 * Match a real ESM/CJS import targeting `@sigil-trade/constraints` (or any
 * subpath thereof). The regex requires either a `from` or `require(` clause
 * on the same line, which excludes prose mentions in plain comments.
 *
 * Examples that MATCH (forbidden):
 *   import x from "@sigil-trade/constraints";
 *   import { y } from "@sigil-trade/constraints/idl/fetch";
 *   export { z } from "@sigil-trade/constraints";
 *   const c = require("@sigil-trade/constraints");
 *
 * Examples that DO NOT match (permitted):
 *   // The constraint parser lives in `@sigil-trade/constraints` ...
 *   * import { fetchIdl } from "@sigil-trade/constraints/idl/fetch";   (JSDoc)
 *   * @see @sigil-trade/constraints
 */
const IMPORT_RE =
  /(?:^|;|\s)(?:import|export)\b[^;]*?\bfrom\s*["']@sigil-trade\/constraints(?:\/[^"']*)?["']/;
const REQUIRE_RE =
  /(?:^|[^\w])require\s*\(\s*["']@sigil-trade\/constraints(?:\/[^"']*)?["']\s*\)/;
const DYNAMIC_IMPORT_RE =
  /(?:^|[^\w])import\s*\(\s*["']@sigil-trade\/constraints(?:\/[^"']*)?["']\s*\)/;

/**
 * Strip line and block comments from source so that import-like text inside
 * comments is not falsely flagged. Preserves line count for accurate error
 * reporting.
 *
 * Implementation: replace block comments `/* ... *\/` and line comments
 * `// ...` with the same number of newlines + spaces.
 */
function stripComments(src: string): string {
  // Strip block comments while preserving newlines.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // Strip line comments (non-greedy to end-of-line).
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

describe("Firewall invariant — kit MUST NOT import @sigil-trade/constraints", () => {
  it("no real import/require/export-from statement in src/", async () => {
    const offenders: { file: string; line: number; text: string }[] = [];

    for await (const file of walkTsFiles(SRC_ROOT)) {
      const raw = await fs.readFile(file, "utf8");
      const stripped = stripComments(raw);
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          IMPORT_RE.test(line) ||
          REQUIRE_RE.test(line) ||
          DYNAMIC_IMPORT_RE.test(line)
        ) {
          offenders.push({
            file: path.relative(SRC_ROOT, file),
            line: i + 1,
            text: raw.split("\n")[i]?.trim() ?? "",
          });
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join("\n");
      expect.fail(
        `Firewall invariant violated — kit must NEVER import from @sigil-trade/constraints (see tests/firewall-invariant.test.ts). Offenders:\n${msg}`,
      );
    }

    expect(offenders).to.have.lengthOf(0);
  });

  it("self-test: stripComments removes block comments containing import-like text", () => {
    const src = `/* import x from "@sigil-trade/constraints"; */\nconst y = 1;`;
    const cleaned = stripComments(src);
    expect(IMPORT_RE.test(cleaned)).to.equal(false);
  });

  it("self-test: stripComments removes line comments containing import-like text", () => {
    const src = `// import x from "@sigil-trade/constraints";\nconst y = 1;`;
    const cleaned = stripComments(src);
    expect(IMPORT_RE.test(cleaned)).to.equal(false);
  });

  it("self-test: IMPORT_RE matches a genuine import statement", () => {
    const src = `import { x } from "@sigil-trade/constraints";`;
    expect(IMPORT_RE.test(src)).to.equal(true);
  });

  it("self-test: IMPORT_RE matches an export-from statement", () => {
    const src = `export { x } from "@sigil-trade/constraints";`;
    expect(IMPORT_RE.test(src)).to.equal(true);
  });

  it("self-test: IMPORT_RE matches a subpath import", () => {
    const src = `import { fetchIdl } from "@sigil-trade/constraints/idl/fetch";`;
    expect(IMPORT_RE.test(src)).to.equal(true);
  });

  it("self-test: REQUIRE_RE matches a require call", () => {
    const src = `const c = require("@sigil-trade/constraints");`;
    expect(REQUIRE_RE.test(src)).to.equal(true);
  });

  it("self-test: DYNAMIC_IMPORT_RE matches a dynamic import", () => {
    const src = `const m = await import("@sigil-trade/constraints");`;
    expect(DYNAMIC_IMPORT_RE.test(src)).to.equal(true);
  });
});
