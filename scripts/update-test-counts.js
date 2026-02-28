#!/usr/bin/env node
//
// update-test-counts.js — Single source of truth for test counts.
//
// Reads scripts/test-counts.json and updates EVERY file that references
// test counts across the entire repo:
//
//   1. README.md          — badge, TS count comment, test suites table
//   2. .github/workflows/ci.yml       — header comments, step names
//   3. .github/workflows/release.yml  — step names
//   4. .github/workflows/devnet-test.yml — header + echo line
//   5. CLAUDE.md           — total line, packages listing, testing section
//   6. Package READMEs     — per-suite count in code comments
//
// Usage: node scripts/update-test-counts.js
//
// To add a new test suite:
//   1. Add entry to scripts/test-counts.json
//   2. Add optional fields: ciStepName, claudePattern, packageReadme, packageReadmePattern
//   3. Run this script — all files updated automatically

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const data = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/test-counts.json"), "utf8"),
);

const total = data.suites.reduce((sum, s) => sum + s.count, 0);

// Categorize suites
const onChainSuites = data.suites.filter((s) => s.onChain);
const devnetSuites = data.suites.filter((s) => s.devnet);
const surfpoolSuites = data.suites.filter((s) => s.surfpool);
const tsSuites = data.suites.filter(
  (s) => !s.onChain && !s.devnet && !s.surfpool,
);
const onChainCount = onChainSuites.reduce((sum, s) => sum + s.count, 0);
const devnetCount = devnetSuites.reduce((sum, s) => sum + s.count, 0);
const surfpoolCount = surfpoolSuites.reduce((sum, s) => sum + s.count, 0);
const tsCount = tsSuites.reduce((sum, s) => sum + s.count, 0);
const tsSuiteCount = tsSuites.length;
const ciCount = onChainCount + tsCount; // CI = on-chain + TS (no devnet/surfpool)

// Escape regex special characters
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Convert a claudePattern like "foo (%d tests)" into a regex + replacement
// %d is the placeholder for the count number
function patternToRegex(pattern) {
  const escaped = escapeRegex(pattern).replace(/%d/, "\\d+");
  return new RegExp(escaped, "g");
}

function patternToReplacement(pattern, count) {
  return pattern.replace(/%d/, String(count));
}

// Track which files were updated
const updated = [];

function updateFile(filePath, label, updater) {
  const fullPath = path.join(ROOT, filePath);
  let before;
  try {
    before = fs.readFileSync(fullPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.warn(`  SKIP: ${filePath} (not found)`);
      return;
    }
    throw err;
  }
  const after = updater(before);
  if (after !== before) {
    fs.writeFileSync(fullPath, after);
    updated.push(filePath);
  }
}

// ── 1. README.md ───────────────────────────────────────────────────
updateFile("README.md", "root README", (content) => {
  // Badge (no commas in badge URLs)
  content = content.replace(
    /tests-[\d,]+-brightgreen/,
    `tests-${total}-brightgreen`,
  );

  // Inline comment: "Run all TypeScript tests (N tests across M suites)"
  content = content.replace(
    /Run all TypeScript tests \(\d+ tests across \d+ suites\)/,
    `Run all TypeScript tests (${tsCount} tests across ${tsSuiteCount} suites)`,
  );

  // On-chain test count in development comment
  content = content.replace(
    /Run on-chain tests \(\d+[^)]*tests/,
    `Run on-chain tests (${onChainCount} LiteSVM tests`,
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

  content = content.replace(
    /\| Suite\s+\| Tests\s+\|[\s\S]*?\| \*\*Total\*\*\s+\| \*\*\d+\*\* \|/,
    newTable,
  );

  return content;
});

// ── 2. .github/workflows/ci.yml ─────────────────────────────────────
updateFile(".github/workflows/ci.yml", "CI workflow", (content) => {
  // Header: job count description
  content = content.replace(
    /# (?:Nine|Eight|Seven|Six|\w+) jobs \([^)]*\):/,
    `# Eight jobs (1 detection + 6 parallel + 1 gate):`,
  );

  // Header: TS test count + suite count
  content = content.replace(
    /\d+ TS tests across \d+ suites/,
    `${tsCount} TS tests across ${tsSuiteCount} suites`,
  );

  // Header: on-chain test count
  content = content.replace(
    /\d+ on-chain tests(?:\s*\([^)]*\))?/,
    `${onChainCount} on-chain tests`,
  );

  // Header: total (with breakdown in parentheses)
  // Note: \d[\d,]* handles comma-formatted numbers like "1,032"
  content = content.replace(
    /Total: ~?\d[\d,]* tests across \d+ suites \([^)]*\)/,
    `Total: ~${total.toLocaleString()} tests across ${data.suites.length} suites (${tsCount} TS + ${onChainCount} on-chain + ${surfpoolCount} Surfpool + ${devnetCount} devnet)`,
  );

  // Job 1 comment
  content = content.replace(
    /TypeScript build, lint, and tests \(\d+ suites, \d+ tests\)/,
    `TypeScript build, lint, and tests (${tsSuiteCount} suites, ${tsCount} tests)`,
  );

  // Step names: update test counts in step name lines
  for (const suite of tsSuites) {
    if (!suite.ciStepName) continue;
    const re = new RegExp(
      "(" + escapeRegex(suite.ciStepName) + ") \\(\\d+ tests\\)",
      "gi",
    );
    content = content.replace(re, `$1 (${suite.count} tests)`);
  }

  // Surfpool comment line: "N tests"
  content = content.replace(
    /surfpool-integration\s+—[^,]*,\s*\d+ tests/,
    `surfpool-integration   — Surfpool integration tests, ${surfpoolCount} tests`,
  );

  // On-chain LiteSVM count in header
  content = content.replace(
    /LiteSVM \d+ tests/,
    `LiteSVM ${onChainCount} tests`,
  );

  return content;
});

// ── 3. .github/workflows/release.yml ──────────────────────────────
updateFile(".github/workflows/release.yml", "release workflow", (content) => {
  for (const suite of tsSuites) {
    if (!suite.ciStepName) continue;
    const re = new RegExp(
      "(" + escapeRegex(suite.ciStepName) + ") \\(\\d+ tests\\)",
      "gi",
    );
    content = content.replace(re, `$1 (${suite.count} tests)`);
  }
  return content;
});

// ── 4. .github/workflows/devnet-test.yml ──────────────────────────
updateFile(
  ".github/workflows/devnet-test.yml",
  "devnet workflow",
  (content) => {
    // Header comment: "N tests across 8 files"
    content = content.replace(
      /\d+ tests across 8 files/g,
      `${devnetCount} tests across 8 files`,
    );

    // Echo line: "(N tests, 8 files)"
    content = content.replace(
      /\(\d+ tests, 8 files\)/g,
      `(${devnetCount} tests, 8 files)`,
    );

    return content;
  },
);

// ── 5. CLAUDE.md ──────────────────────────────────────────────────
updateFile("CLAUDE.md", "CLAUDE.md", (content) => {
  // Total line: "N tests passing across M suites (X CI + Y Surfpool + Z devnet)"
  // Note: \d[\d,]* handles comma-formatted numbers like "1,032"
  content = content.replace(
    /~?\d[\d,]* tests passing across \d+ suites \([^)]*\)/,
    `~${total.toLocaleString()} tests passing across ${data.suites.length} suites (${ciCount} CI + ${surfpoolCount} Surfpool + ${devnetCount} devnet)`,
  );

  // Devnet total line: "Devnet total: N tests across 8 files"
  content = content.replace(
    /Devnet total: \d+ tests across \d+ files/,
    `Devnet total: ${devnetCount} tests across 8 files`,
  );

  // Individual suite lines in the Testing section (claudePattern field)
  for (const suite of data.suites) {
    if (!suite.claudePattern) continue;
    const re = patternToRegex(suite.claudePattern);
    const replacement = patternToReplacement(suite.claudePattern, suite.count);
    content = content.replace(re, replacement);
  }

  // Packages listing: "N tests)" at end of package description lines
  // These follow the pattern: `path/` — description (N tests)
  const packagePatterns = [
    {
      match: /`sdk\/core\/`[^)]*?(\d+) tests\)/,
      suite: "Core policy engine (`@agent-shield/core`)",
    },
    {
      match: /`sdk\/typescript\/`[^)]*?(\d+) tests\)/,
      suite: "SDK tests (`@agent-shield/sdk`)",
    },
    {
      match: /`sdk\/platform\/`[^)]*?(\d+) tests\)/,
      suite: "Platform client tests (`@agent-shield/platform`)",
    },
    {
      match: /`sdk\/custody\/crossmint\/`[^)]*?(\d+) tests\)/,
      suite: "Crossmint custody adapter",
    },
    {
      match: /`plugins\/solana-agent-kit\/`[^)]*?(\d+) tests\)/,
      suite: "SAK plugin (`@agent-shield/plugin-solana-agent-kit`)",
    },
    {
      match: /`plugins\/elizaos\/`[^)]*?(\d+) tests\)/,
      suite: "ElizaOS plugin (`@agent-shield/plugin-elizaos`)",
    },
    {
      match: /`packages\/mcp\/`[^)]*?(\d+) tests\)/,
      suite: "MCP server (`@agent-shield/mcp`)",
    },
    {
      match: /`apps\/actions-server\/`[^)]*?(\d+) tests\)/,
      suite: "Actions server (`@agent-shield/actions-server`)",
    },
  ];

  for (const { match, suite: suiteName } of packagePatterns) {
    const suite = data.suites.find((s) => s.name === suiteName);
    if (!suite) continue;
    content = content.replace(match, (full, oldCount) =>
      full.replace(`${oldCount} tests)`, `${suite.count} tests)`),
    );
  }

  return content;
});

// ── 6. Package READMEs ────────────────────────────────────────────
for (const suite of data.suites) {
  if (!suite.packageReadme || !suite.packageReadmePattern) continue;

  updateFile(suite.packageReadme, suite.name, (content) => {
    const re = patternToRegex(suite.packageReadmePattern);
    const replacement = patternToReplacement(
      suite.packageReadmePattern,
      suite.count,
    );
    content = content.replace(re, replacement);
    return content;
  });
}

// ── Summary ───────────────────────────────────────────────────────
if (updated.length > 0) {
  console.log(
    `Updated test counts: ${total} total (${onChainCount} on-chain + ${devnetCount} devnet + ${tsCount} TS across ${tsSuiteCount} suites)`,
  );
  console.log(`Files updated: ${updated.join(", ")}`);
} else {
  console.log(`All test counts already up to date (${total} total).`);
}
