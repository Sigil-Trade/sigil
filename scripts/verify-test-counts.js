#!/usr/bin/env node
//
// verify-test-counts.js — Drift detector for scripts/test-counts.json.
//
// Performs two independent checks:
//
//   1. COUNT DRIFT — counts tests in known suite paths and compares the sum
//      against scripts/test-counts.json. Exits non-zero on mismatch.
//
//   2. UNTRACKED LOCATION — scans the repo for any *.test.ts file or *.rs
//      file containing #[test] that lives OUTSIDE the tracked-path allowlist.
//      Exits non-zero with a pointer to add the new location to
//      scripts/test-counts.json. Catches the "someone added an entirely new
//      test directory and nobody updated the JSON schema" failure mode.
//
// Usage:
//   node scripts/verify-test-counts.js          # check, exit 1 on drift or untracked
//   node scripts/verify-test-counts.js --json   # emit actual counts as JSON
//
// Counting methodology (regex, applied line-by-line):
//   - TS tests:  \b(it|test|specify)(\.(skip|only|each|todo))?\s*\(
//   - Rust:      ^\s*#\[(tokio::)?test\]
//   - Trident:   #\[(flow|fuzz_test|test)\]
//
// If this script disagrees with scripts/test-counts.json, either the JSON is
// stale (update counts then run `node scripts/update-test-counts.js`) or this
// script's patterns need updating. Do not silently fix the JSON without
// investigating why.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const TS_RE = /\b(it|test|specify)(\.(skip|only|each|todo))?\s*\(/g;
const RUST_RE = /^\s*#\[(tokio::)?test\]/gm;
const TRIDENT_RE = /#\[(flow|fuzz_test|test)\]/g;

// Non-global single-match version for the untracked-location sentinel.
// (Global regexes have stateful .lastIndex — not safe for one-shot test().)
const RUST_HAS_TEST = /^\s*#\[(tokio::)?test\]/m;

// Path prefixes that are already accounted for in test-counts.json. Any file
// outside these prefixes that looks like a test is an untracked location.
const TRACKED_PREFIXES = [
  "tests/",
  "sdk/kit/tests/",
  "sdk/custody/tests/",
  "sdk/platform/tests/",
  "packages/plugins/tests/",
  "programs/",
  "trident-tests/",
];

// Directories skipped during the untracked-location walk.
const UNTRACKED_WALK_EXCLUDE = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".git",
  ".next",
  ".yarn",
  ".certora-venv",
  "coverage",
  ".turbo",
]);

function walk(dir, opts = {}) {
  const out = [];
  const exclude = new Set(opts.exclude || []);
  const absDir = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (opts.maxdepth === 1) continue;
      out.push(
        ...walk(path.relative(ROOT, full), {
          ...opts,
          maxdepth: opts.maxdepth ? opts.maxdepth - 1 : undefined,
        }),
      );
    } else if (entry.isFile() && opts.match.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function countInFile(file, regex) {
  let contents;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const matches = contents.match(regex);
  return matches ? matches.length : 0;
}

function countInFiles(files, regex) {
  return files.reduce((sum, f) => sum + countInFile(f, regex), 0);
}

function countOneFile(relPath, regex) {
  return countInFile(path.join(ROOT, relPath), regex);
}

// Walks the entire repo (skipping noise dirs) and returns relative paths for
// every file whose relative path matches `match`. Used by the untracked-
// location sentinel — unlike `walk()`, which filters by basename only.
function walkAllRelative(startDir, match) {
  const out = [];
  function recurse(absDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (UNTRACKED_WALK_EXCLUDE.has(entry.name)) continue;
      const full = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile()) {
        const rel = path.relative(ROOT, full);
        if (match.test(rel)) out.push(rel);
      }
    }
  }
  recurse(path.isAbsolute(startDir) ? startDir : path.join(ROOT, startDir));
  return out;
}

function isTrackedPath(relPath) {
  return TRACKED_PREFIXES.some((p) => relPath.startsWith(p));
}

// Finds test files living outside the tracked-path allowlist. Zero false
// positives by design: this only examines file paths + (for Rust) a
// single regex match on file content, no count grep.
function findUntrackedTests() {
  const tsFiles = walkAllRelative(ROOT, /\.test\.ts$/);
  const untrackedTs = tsFiles.filter((f) => !isTrackedPath(f));

  const rsFiles = walkAllRelative(ROOT, /\.rs$/);
  const untrackedRs = rsFiles.filter((f) => {
    if (isTrackedPath(f)) return false;
    let contents;
    try {
      contents = fs.readFileSync(path.join(ROOT, f), "utf8");
    } catch {
      return false;
    }
    return RUST_HAS_TEST.test(contents);
  });

  return { untrackedTs, untrackedRs };
}

const actual = {
  "tests/sigil.ts": countOneFile("tests/sigil.ts", TS_RE),
  "tests/jupiter-integration.ts": countOneFile(
    "tests/jupiter-integration.ts",
    TS_RE,
  ),
  "tests/jupiter-lend-integration.ts": countOneFile(
    "tests/jupiter-lend-integration.ts",
    TS_RE,
  ),
  "tests/flash-trade-integration.ts": countOneFile(
    "tests/flash-trade-integration.ts",
    TS_RE,
  ),
  "tests/security-exploits.ts": countOneFile(
    "tests/security-exploits.ts",
    TS_RE,
  ),
  "tests/instruction-constraints.ts": countOneFile(
    "tests/instruction-constraints.ts",
    TS_RE,
  ),
  "tests/escrow-integration.ts": countOneFile(
    "tests/escrow-integration.ts",
    TS_RE,
  ),
  "tests/toctou-security.ts": countOneFile("tests/toctou-security.ts", TS_RE),
  "tests/analytics-counters.ts": countOneFile(
    "tests/analytics-counters.ts",
    TS_RE,
  ),
  "tests/surfpool-integration.ts": countOneFile(
    "tests/surfpool-integration.ts",
    TS_RE,
  ),
  "tests/devnet-*.ts (9 root files)": countInFiles(
    walk("tests", { match: /^devnet-.*\.ts$/, maxdepth: 1 }),
    TS_RE,
  ),
  "tests/devnet/ subdir": countInFiles(
    walk("tests/devnet", { match: /\.ts$/ }),
    TS_RE,
  ),
  "sdk/kit/tests (excl devnet)": countInFiles(
    walk("sdk/kit/tests", { match: /\.test\.ts$/, exclude: ["devnet"] }),
    TS_RE,
  ),
  "sdk/kit/tests/devnet": countInFiles(
    walk("sdk/kit/tests/devnet", { match: /\.test\.ts$/ }),
    TS_RE,
  ),
  "sdk/custody/tests": countInFiles(
    walk("sdk/custody/tests", { match: /\.test\.ts$/ }),
    TS_RE,
  ),
  "sdk/platform/tests": countInFiles(
    walk("sdk/platform/tests", { match: /\.test\.ts$/ }),
    TS_RE,
  ),
  "packages/plugins/tests": countInFiles(
    walk("packages/plugins/tests", { match: /\.test\.ts$/ }),
    TS_RE,
  ),
  "programs/ (Rust #[test])": countInFiles(
    walk("programs", { match: /\.rs$/, exclude: ["target"] }),
    RUST_RE,
  ),
  "trident-tests/": countInFiles(
    walk("trident-tests", { match: /\.rs$/, exclude: ["target"] }),
    TRIDENT_RE,
  ),
};

const actualTotal = Object.values(actual).reduce((s, n) => s + n, 0);
const data = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/test-counts.json"), "utf8"),
);
const jsonTotal = data.suites.reduce((s, x) => s + x.count, 0);
const drift = actualTotal - jsonTotal;

const { untrackedTs, untrackedRs } = findUntrackedTests();
const untrackedCount = untrackedTs.length + untrackedRs.length;

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { actual, actualTotal, jsonTotal, drift, untrackedTs, untrackedRs },
      null,
      2,
    ),
  );
  process.exit(drift === 0 && untrackedCount === 0 ? 0 : 1);
}

console.log("Per-location counts:");
for (const [loc, n] of Object.entries(actual)) {
  console.log(`  ${String(n).padStart(5)}  ${loc}`);
}
console.log("");
console.log(`  Actual total: ${actualTotal}`);
console.log(`  JSON total:   ${jsonTotal}`);
console.log(`  Drift:        ${drift >= 0 ? "+" : ""}${drift}`);
console.log("");

if (untrackedCount > 0) {
  console.error(
    `ERROR: ${untrackedCount} test file(s) found outside the tracked-path allowlist.`,
  );
  console.error(
    `These locations are not counted by scripts/test-counts.json and will`,
  );
  console.error(`silently drift if not tracked. Files:`);
  for (const f of untrackedTs) console.error(`  (ts) ${f}`);
  for (const f of untrackedRs) console.error(`  (rs) ${f}`);
  console.error("");
  console.error(
    `Fix: either (a) add the new path under an existing TRACKED_PREFIXES`,
  );
  console.error(
    `entry in scripts/verify-test-counts.js and a matching suite entry`,
  );
  console.error(
    `in scripts/test-counts.json, or (b) delete/relocate the file if it`,
  );
  console.error(`is not an actual test file.`);
  process.exit(1);
}

if (drift !== 0) {
  console.error(
    `ERROR: test-counts.json is out of date.\n  Update scripts/test-counts.json with current counts, then run:\n    node scripts/update-test-counts.js\n  to propagate to README, CI workflows, and CLAUDE.md.`,
  );
  process.exit(1);
}

console.log("OK: test-counts.json matches actual counts.");
