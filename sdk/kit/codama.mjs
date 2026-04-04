// codama.mjs — Generate Kit-native clients from Anchor IDLs
//
// Usage:
//   node codama.mjs                     # Generate Sigil (default)
//   node codama.mjs --protocol=sigil    # Generate Sigil explicitly
//   node codama.mjs --protocol=flash-trade  # Generate Flash Trade
//   node codama.mjs --protocol=kamino       # Generate Kamino
//   node codama.mjs --all                   # Generate all protocols

import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, existsSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Protocol Registry ──────────────────────────────────────────────────────

const PROTOCOLS = {
  sigil: {
    idlPath: join(__dirname, "..", "..", "target", "idl", "sigil.json"),
    outputDir: join(__dirname, "src", "generated"),
    generateEventMap: true,
    expectedHash: null, // Sigil IDL changes with builds
  },
  "flash-trade": {
    idlPath: join(__dirname, "idls", "perpetuals.json"),
    outputDir: join(__dirname, "generated-protocols", "flash-trade"),
    generateEventMap: false,
    expectedHash: "66db991046f4c0029f0027a5a43ee11f58789cbc8276dd3108026ad2b4a24339",
  },
  kamino: {
    idlPath: join(__dirname, "idls", "kamino-lending.json"),
    outputDir: join(__dirname, "generated-protocols", "kamino"),
    generateEventMap: false,
    expectedHash: "5958e26f571077a32f730382bb481ad2b138ca28a18067bfcb28c46586c3a783",
  },
};

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const allFlag = args.includes("--all");
const protocolArg = args.find((a) => a.startsWith("--protocol="))?.split("=")[1];
const updateHashes = args.includes("--update-hashes");
const skipHashCheck = args.includes("--skip-hash-check");

// ─── IDL Validation ─────────────────────────────────────────────────────────

function validateIdl(idl, protocol) {
  const errors = [];
  if (typeof idl !== "object" || idl === null) errors.push("IDL root must be an object");
  // Support both top-level name/version and metadata.name/version (Anchor IDL spec variations)
  const hasName = typeof idl.name === "string" || typeof idl.metadata?.name === "string";
  const hasVersion = typeof idl.version === "string" || typeof idl.metadata?.version === "string";
  if (!hasName) errors.push("Missing 'name' field (checked root and metadata)");
  if (!hasVersion) errors.push("Missing 'version' field (checked root and metadata)");
  if (!Array.isArray(idl.instructions)) {
    errors.push("Missing 'instructions' array");
  } else {
    for (const [i, ix] of idl.instructions.entries()) {
      if (typeof ix.name !== "string") errors.push(`instructions[${i}] missing 'name'`);
      if (!Array.isArray(ix.accounts)) errors.push(`instructions[${i}].${ix.name ?? i} missing 'accounts'`);
      if (!Array.isArray(ix.args)) errors.push(`instructions[${i}].${ix.name ?? i} missing 'args'`);
    }
  }
  if (idl.accounts && !Array.isArray(idl.accounts)) errors.push("'accounts' must be an array");
  if (errors.length > 0) {
    console.error(`IDL validation failed for ${protocol}:`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
}

let protocolsToGenerate;
if (allFlag) {
  protocolsToGenerate = Object.keys(PROTOCOLS);
} else if (protocolArg) {
  if (!PROTOCOLS[protocolArg]) {
    console.error(`Unknown protocol: ${protocolArg}. Available: ${Object.keys(PROTOCOLS).join(", ")}`);
    process.exit(1);
  }
  protocolsToGenerate = [protocolArg];
} else {
  // Default: sigil only (backwards compatible)
  protocolsToGenerate = ["sigil"];
}

// ─── Generation ──────────────────────────────────────────────────────────────

for (const protocolName of protocolsToGenerate) {
  const config = PROTOCOLS[protocolName];

  if (!existsSync(config.idlPath)) {
    console.error(`IDL not found: ${config.idlPath}`);
    process.exit(1);
  }

  console.log(`\n─── Generating ${protocolName} ───`);

  // ─── IDL hash verification (Step 5) ─────────────────────────────────────
  const idlContent = readFileSync(config.idlPath);
  if (config.expectedHash) {
    const fileHash = createHash("sha256").update(idlContent).digest("hex");
    if (updateHashes) {
      console.log(`  IDL hash for ${protocolName}: ${fileHash}`);
    } else if (!skipHashCheck) {
      if (fileHash !== config.expectedHash) {
        console.error(`IDL content hash mismatch for ${protocolName}!`);
        console.error(`  Expected: ${config.expectedHash}`);
        console.error(`  Actual:   ${fileHash}`);
        process.exit(1);
      }
      console.log(`  IDL hash verified: ${fileHash.substring(0, 12)}...`);
    }
  }

  // ─── IDL schema validation (Step 4) ─────────────────────────────────────
  const anchorIdl = JSON.parse(idlContent.toString("utf-8"));
  validateIdl(anchorIdl, protocolName);

  const codama = createFromRoot(rootNodeFromAnchor(anchorIdl));

  // Render to temp dir
  const tempDir = mkdtempSync(join(tmpdir(), `codama-${protocolName}-`));

  try {
    await codama.accept(renderVisitor(tempDir));

    // ─── Two-phase atomic generation (Step 6) ───────────────────────────────
    const generatedSrc = join(tempDir, "src", "generated");
    if (!existsSync(generatedSrc)) {
      throw new Error(`Generation produced no output for ${protocolName}`);
    }

    const backupDir = `${config.outputDir}.bak`;
    const parentDir = dirname(config.outputDir);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Phase 1: backup existing
    if (existsSync(config.outputDir)) {
      renameSync(config.outputDir, backupDir);
    }

    try {
      // Phase 2: copy new
      cpSync(generatedSrc, config.outputDir, { recursive: true });

      // Phase 3: fix bare directory imports for Node ESM compatibility
      // Codama emits `from "../accounts"` which bundlers resolve but Node ESM rejects.
      // Rewrite to `from "../accounts/index.js"` in all generated .ts files.
      fixBareDirectoryImports(config.outputDir);

      // Success — remove backup
      if (existsSync(backupDir)) {
        rmSync(backupDir, { recursive: true, force: true });
      }
    } catch (err) {
      // Rollback — restore backup
      if (existsSync(backupDir)) {
        if (existsSync(config.outputDir)) rmSync(config.outputDir, { recursive: true, force: true });
        renameSync(backupDir, config.outputDir);
      }
      throw new Error(`Generation failed for ${protocolName}, rolling back: ${err.message}`);
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
  }

  const ixCount = anchorIdl.instructions?.length ?? 0;
  const acctCount = anchorIdl.accounts?.length ?? 0;
  console.log(`  Generated: ${ixCount} instructions, ${acctCount} accounts → ${config.outputDir}`);

  // ─── Event discriminator map (Sigil only) ──────────────────────────────
  if (config.generateEventMap) {
    const events = anchorIdl.events ?? [];
    if (events.length > 0) {
      const entries = events.map((evt) => {
        const disc = createHash("sha256")
          .update(`event:${evt.name}`)
          .digest()
          .subarray(0, 8)
          .toString("hex");
        return `  "${disc}": "${evt.name}",`;
      });

      const content = `// AUTO-GENERATED by codama.mjs — do not edit manually.
// Re-run \`pnpm run codama\` after any Rust event changes.
//
// Source: target/idl/sigil.json (${events.length} events)
// Discriminator = SHA256("event:<EventName>")[0..8]

export const EVENT_DISCRIMINATOR_MAP: Record<string, string> = {
${entries.join("\n")}
};
`;

      const eventMapPath = join(config.outputDir, "event-discriminators.ts");
      writeFileSync(eventMapPath, content, "utf-8");
      console.log(`  Event discriminator map: ${events.length} events`);
    }
  }
}

// ─── ESM Import Fixup ─────────────────────────────────────────────────────────
//
// Codama's renderers-js emits bare directory imports (e.g., from "../accounts")
// which work with bundlers but fail under Node's ESM loader. This rewrites them
// to explicit index.js paths (e.g., from "../accounts/index.js").

function fixBareDirectoryImports(dir) {
  // Codama emits bare imports that break under Node's ESM loader:
  //   from "."                  → from "./index.js"       (current dir index)
  //   from ".."                 → from "../index.js"      (parent dir index)
  //   from "./agentVault"       → from "./agentVault.js"  (sibling file)
  //   from "../accounts"        → from "../accounts/index.js"  (directory)
  //   from "../accounts/index.js" → unchanged (already has .js)
  const KNOWN_DIRS = new Set(["accounts", "errors", "instructions", "programs", "types"]);
  let fixedFiles = 0;
  let fixedImports = 0;

  function fixFile(filePath) {
    const src = readFileSync(filePath, "utf-8");
    let replaced = src;

    // Fix `from "."` → `from "./index.js"`
    replaced = replaced.replace(/((?:from|import)\s+)(["'])\.(\2)/g, '$1$2./index.js$3');

    // Fix `from ".."` → `from "../index.js"`
    replaced = replaced.replace(/((?:from|import)\s+)(["'])\.\.(\2)/g, '$1$2../index.js$3');

    // Fix relative path imports without .js extension
    replaced = replaced.replace(/((?:from|import)\s+["'])(\.\.?\/[^"']+)(["'])/g, (match, prefix, path, suffix) => {
      if (path.endsWith(".js") || path.endsWith(".json")) return match;
      const lastSegment = path.split("/").pop();
      if (KNOWN_DIRS.has(lastSegment)) {
        return `${prefix}${path}/index.js${suffix}`;
      }
      return `${prefix}${path}.js${suffix}`;
    });

    if (replaced !== src) {
      writeFileSync(filePath, replaced, "utf-8");
      const newJs = (replaced.match(/\.js["']/g) || []).length;
      const oldJs = (src.match(/\.js["']/g) || []).length;
      fixedFiles++;
      fixedImports += newJs - oldJs;
    }
  }

  function walk(d) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) fixFile(full);
    }
  }

  walk(dir);
  if (fixedImports > 0) {
    console.log(`  ESM fix: ${fixedImports} bare imports → .js extensions in ${fixedFiles} files`);
  }
}

console.log("\nDone.");
