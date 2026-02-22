#!/usr/bin/env node
//
// update-test-counts.js — Single source of truth for test counts.
//
// Reads scripts/test-counts.json and updates:
//   1. README.md badge + test suites table + total
//   2. .github/workflows/ci.yml header comments + step names
//   3. .github/workflows/release.yml step names
//   4. CLAUDE.md test count references
//
// Usage: node scripts/update-test-counts.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const data = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/test-counts.json"), "utf8"),
);

const total = data.suites.reduce((sum, s) => sum + s.count, 0);

// Use onChain flag instead of hardcoded .slice(0, 5)
const onChainSuites = data.suites.filter((s) => s.onChain);
const tsSuites = data.suites.filter((s) => !s.onChain);
const onChainCount = onChainSuites.reduce((sum, s) => sum + s.count, 0);
const tsCount = tsSuites.reduce((sum, s) => sum + s.count, 0);
const tsSuiteCount = tsSuites.length;

// Escape regex special characters
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Validate required files ────────────────────────────────────
const requiredFiles = [
  path.join(ROOT, "README.md"),
  path.join(ROOT, ".github/workflows/ci.yml"),
  path.join(ROOT, ".github/workflows/release.yml"),
];
for (const f of requiredFiles) {
  if (!fs.existsSync(f)) {
    console.error(`ERROR: Required file not found: ${f}`);
    process.exit(1);
  }
}

// ── README.md ──────────────────────────────────────────────────
const readmePath = path.join(ROOT, "README.md");
let readme = fs.readFileSync(readmePath, "utf8");

// Badge
readme = readme.replace(
  /tests-\d+-brightgreen/,
  `tests-${total}-brightgreen`,
);

// Inline comment: "Run all TypeScript tests (N tests across M suites)"
readme = readme.replace(
  /Run all TypeScript tests \(\d+ tests across \d+ suites\)/,
  `Run all TypeScript tests (${tsCount} tests across ${tsSuiteCount} suites)`,
);

// Rebuild table between "### Test Suites" and "## Security"
const tableHeader = `| Suite                                                | Tests   |
| ---------------------------------------------------- | ------- |`;
const rows = data.suites
  .map((s) => {
    const name = s.name.padEnd(52);
    const count = String(s.count).padStart(7);
    return `| ${name} | ${count} |`;
  })
  .join("\n");
const totalRow = `| **Total**                                            | **${total}** |`;
const newTable = `${tableHeader}\n${rows}\n${totalRow}`;

readme = readme.replace(
  /\| Suite\s+\| Tests\s+\|[\s\S]*?\| \*\*Total\*\*\s+\| \*\*\d+\*\* \|/,
  newTable,
);

fs.writeFileSync(readmePath, readme);

// ── .github/workflows/ci.yml ───────────────────────────────────
const ciPath = path.join(ROOT, ".github/workflows/ci.yml");
let ci = fs.readFileSync(ciPath, "utf8");

// Header: job count description
ci = ci.replace(
  /# (?:Nine|Eight|Seven|Six|\w+) jobs \([^)]*\):/,
  `# Eight jobs (1 detection + 6 parallel + 1 gate):`,
);

// Header: TS test count + suite count
ci = ci.replace(
  /\d+ TS tests across \d+ suites/,
  `${tsCount} TS tests across ${tsSuiteCount} suites`,
);

// Header: on-chain test count (simplified — no breakdown)
ci = ci.replace(
  /\d+ on-chain tests(?:\s*\([^)]*\))?/,
  `${onChainCount} on-chain tests`,
);

// Header: total
ci = ci.replace(
  /Total: \d+ tests across \d+ suites/,
  `Total: ${total} tests across ${data.suites.length} suites`,
);

// Job 1 comment
ci = ci.replace(
  /TypeScript build, lint, and tests \(\d+ suites, \d+ tests\)/,
  `TypeScript build, lint, and tests (${tsSuiteCount} suites, ${tsCount} tests)`,
);

// Step names: update test counts in step name lines
for (const suite of tsSuites) {
  if (!suite.ciStepName) continue;
  // Case-insensitive match preserves original casing via $1 backreference
  const re = new RegExp(
    "(" + escapeRegex(suite.ciStepName) + ") \\(\\d+ tests\\)",
    "gi",
  );
  ci = ci.replace(re, `$1 (${suite.count} tests)`);
}

fs.writeFileSync(ciPath, ci);

// ── .github/workflows/release.yml ──────────────────────────────
const releasePath = path.join(ROOT, ".github/workflows/release.yml");
let release = fs.readFileSync(releasePath, "utf8");

for (const suite of tsSuites) {
  if (!suite.ciStepName) continue;
  // Case-insensitive match preserves original casing via $1 backreference
  const re = new RegExp(
    "(" + escapeRegex(suite.ciStepName) + ") \\(\\d+ tests\\)",
    "gi",
  );
  release = release.replace(re, `$1 (${suite.count} tests)`);
}

fs.writeFileSync(releasePath, release);

// ── CLAUDE.md ──────────────────────────────────────────────────
const claudePath = path.join(ROOT, "CLAUDE.md");
if (fs.existsSync(claudePath)) {
  let claude = fs.readFileSync(claudePath, "utf8");
  claude = claude.replace(
    /\d+ tests passing across \d+ suites/,
    `${total} tests passing across ${data.suites.length} suites`,
  );
  fs.writeFileSync(claudePath, claude);
}

console.log(
  `Updated test counts: ${total} total (${onChainCount} on-chain + ${tsCount} TS across ${tsSuiteCount} suites)`,
);
