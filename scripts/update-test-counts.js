#!/usr/bin/env node
//
// update-test-counts.js — Single source of truth for test counts.
//
// Reads scripts/test-counts.json and updates:
//   1. README.md badge + test suites table + total
//   2. .github/workflows/ci.yml header comments
//   3. CLAUDE.md test count references
//
// Usage: node scripts/update-test-counts.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const data = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/test-counts.json"), "utf8"),
);

const total = data.suites.reduce((sum, s) => sum + s.count, 0);

// On-chain suites are the first 5 (vault, jupiter, flash, oracle, security-exploits)
const onChainCount = data.suites
  .slice(0, 5)
  .reduce((sum, s) => sum + s.count, 0);
const tsCount = total - onChainCount;
const tsSuiteCount = data.suites.length - 5;

// ── README.md ──────────────────────────────────────────────────
const readmePath = path.join(ROOT, "README.md");
let readme = fs.readFileSync(readmePath, "utf8");

// Badge
readme = readme.replace(
  /tests-\d+-brightgreen/,
  `tests-${total}-brightgreen`,
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

// Line 5: TS test count + suite count
ci = ci.replace(
  /\d+ TS tests across \d+ suites/,
  `${tsCount} TS tests across ${tsSuiteCount} suites`,
);

// Line 7: on-chain test count
ci = ci.replace(
  /\d+ on-chain tests \(\d+ \+ \d+ security exploits\)/,
  `${onChainCount} on-chain tests (${onChainCount - 28} + 28 security exploits)`,
);

// Line 9: total
ci = ci.replace(
  /Total: \d+ tests across \d+ suites/,
  `Total: ${total} tests across ${data.suites.length} suites`,
);

// Job 1 comment
ci = ci.replace(
  /TypeScript build, lint, and tests \(\d+ suites, \d+ tests\)/,
  `TypeScript build, lint, and tests (${tsSuiteCount} suites, ${tsCount} tests)`,
);

fs.writeFileSync(ciPath, ci);

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

console.log(`Updated test counts: ${total} total (${onChainCount} on-chain + ${tsCount} TS)`);
