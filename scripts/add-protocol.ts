#!/usr/bin/env tsx
/**
 * Automated Protocol Onboarding Pipeline
 *
 * Generates the boilerplate files needed to add a new DeFi protocol to the
 * Sigil Kit SDK, from an Anchor IDL + human-authored YAML annotation.
 *
 * Usage:
 *   npx tsx scripts/add-protocol.ts --yaml sdk/kit/idls/orca.annotation.yaml
 *   npx tsx scripts/add-protocol.ts --yaml ... --verify-only
 *   npx tsx scripts/add-protocol.ts --yaml ... --schema-only
 *   npx tsx scripts/add-protocol.ts --yaml ... --dry-run
 *   npx tsx scripts/add-protocol.ts --yaml ... --force
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AnnotationConfig,
  AnchorIdl,
  PipelineOptions,
} from "./add-protocol/types.js";
import { validateAnnotation } from "./add-protocol/yaml-validator.js";
import { parseIdl } from "./add-protocol/idl-parser.js";
import { generateSchema } from "./add-protocol/generators/schema.js";
import { generateDescriptor } from "./add-protocol/generators/descriptor.js";
import { generateHandler } from "./add-protocol/generators/handler.js";
import { generateComposer } from "./add-protocol/generators/composer.js";
import { generateMarkets } from "./add-protocol/generators/markets.js";
import { generateCodamaEntry } from "./add-protocol/generators/codama-entry.js";
import { generateRegistryPatches } from "./add-protocol/generators/registry-patch.js";
import {
  runVerification,
  formatVerificationResult,
} from "./add-protocol/verify.js";

// ─── CLI Parsing ────────────────────────────────────────────────────────────

function parseArgs(): PipelineOptions {
  const args = process.argv.slice(2);

  const yamlArg = args.find(
    (a) => a.startsWith("--yaml=") || a.startsWith("--yaml "),
  );
  let yamlPath = "";

  const yamlIndex = args.indexOf("--yaml");
  if (yamlIndex !== -1 && args[yamlIndex + 1]) {
    yamlPath = args[yamlIndex + 1];
  } else {
    const eqArg = args.find((a) => a.startsWith("--yaml="));
    if (eqArg) {
      yamlPath = eqArg.split("=")[1];
    }
  }

  if (!yamlPath) {
    console.error(
      "Usage: npx tsx scripts/add-protocol.ts --yaml <path-to-annotation.yaml>",
    );
    console.error("");
    console.error("Flags:");
    console.error("  --verify-only   Run verification without generating");
    console.error("  --schema-only   Generate schema file only");
    console.error("  --dry-run       Show what would be generated");
    console.error("  --force         Overwrite existing files");
    process.exit(1);
  }

  return {
    yamlPath: resolve(yamlPath),
    verifyOnly: args.includes("--verify-only"),
    schemaOnly: args.includes("--schema-only"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log("═══ Protocol Onboarding Pipeline ═══\n");

  // ── Step 1: Load YAML annotation ────────────────────────────────────────
  console.log(`Loading annotation: ${opts.yamlPath}`);
  let yamlContent: string;
  try {
    yamlContent = readFileSync(opts.yamlPath, "utf-8");
  } catch {
    console.error(`❌ YAML file not found: ${opts.yamlPath}`);
    process.exit(1);
  }
  const config: AnnotationConfig = parseYaml(yamlContent);

  // ── Step 2: Load IDL ──────────────────────────────────────────────────
  const idlPath = resolve(dirname(opts.yamlPath), config.protocol.idlFile);
  console.log(`Loading IDL: ${idlPath}`);
  let idlContent: string;
  try {
    idlContent = readFileSync(idlPath, "utf-8");
  } catch {
    console.error(`❌ IDL file not found: ${idlPath}`);
    process.exit(1);
  }
  const idl: AnchorIdl = JSON.parse(idlContent);

  // ── Step 3: Validate YAML against IDL ──────────────────────────────────
  console.log("Validating annotation against IDL...");
  const validation = validateAnnotation(config, idl);

  if (validation.warnings.length > 0) {
    console.log("\n⚠️  Validation warnings:");
    for (const w of validation.warnings) {
      console.log(`  ${w}`);
    }
  }

  if (!validation.valid) {
    console.error("\n❌ Validation FAILED:");
    for (const e of validation.errors) {
      console.error(`  ${e}`);
    }
    process.exit(1);
  }
  console.log("  ✅ Validation passed.");

  // ── Step 4: Parse IDL + compute offsets ────────────────────────────────
  console.log("Parsing IDL and computing offsets...");
  const parsed = parseIdl(config, idl);
  console.log(`  Parsed ${parsed.length} instructions.`);

  // ── Step 5: Compute IDL hash ──────────────────────────────────────────
  const idlHash = createHash("sha256").update(idlContent).digest("hex");

  // ── Step 6: Generate files ────────────────────────────────────────────
  const protoId = config.protocol.id;
  const sdkKitRoot = join(process.cwd(), "sdk", "kit");

  const GENERATORS = [
    {
      name: "schema",
      path: join(
        sdkKitRoot,
        "src",
        "constraints",
        "protocols",
        `${protoId}-schema.ts`,
      ),
      generate: () => generateSchema(config, parsed),
      schemaOnly: false,
    },
    {
      name: "descriptor",
      path: join(
        sdkKitRoot,
        "src",
        "constraints",
        "protocols",
        `${protoId}-descriptor.ts`,
      ),
      generate: () => generateDescriptor(config, parsed),
      schemaOnly: true,
    },
    {
      name: "handler",
      path: join(sdkKitRoot, "src", "integrations", `${protoId}-handler.ts`),
      generate: () => generateHandler(config, parsed),
      schemaOnly: true,
    },
    {
      name: "composer",
      path: join(sdkKitRoot, "src", "integrations", `${protoId}-compose.ts`),
      generate: () => generateComposer(config, parsed),
      schemaOnly: true,
    },
    {
      name: "markets",
      path: join(
        sdkKitRoot,
        "src",
        "integrations",
        "config",
        `${protoId}-markets.ts`,
      ),
      generate: () => generateMarkets(config),
      schemaOnly: true,
    },
  ];

  // Check for existing files
  if (!opts.force && !opts.dryRun && !opts.verifyOnly) {
    const existing = GENERATORS.filter((gen) => existsSync(gen.path)).map(
      (gen) => `  ${gen.name}: ${gen.path}`,
    );

    if (existing.length > 0) {
      console.error("\n❌ Files already exist (use --force to overwrite):");
      console.error(existing.join("\n"));
      process.exit(1);
    }
  }

  // Generate content
  console.log("\nGenerating files...");

  const generated = new Map<string, string>();

  for (const gen of GENERATORS) {
    if (opts.schemaOnly && gen.schemaOnly) continue;
    generated.set(gen.name, gen.generate());
    console.log(
      `  ✅ ${gen.name[0].toUpperCase() + gen.name.slice(1)}: ${gen.path}`,
    );
  }

  // ── Step 7: Codama entry ──────────────────────────────────────────────
  const codamaEntry = generateCodamaEntry(config, idlHash);
  console.log(
    "\n── Codama Registry Entry (paste into sdk/kit/codama.mjs PROTOCOLS) ──",
  );
  console.log(codamaEntry);

  // ── Step 8: Verification gate ─────────────────────────────────────────
  console.log("\n── Verification Gate ──");
  const codamaDir = join(sdkKitRoot, "src", "generated", "protocols", protoId);
  const codamaDirExists = existsSync(codamaDir);

  const verifyResult = runVerification(
    config,
    idl,
    parsed,
    join(sdkKitRoot, "src", "constraints", "protocols"),
    codamaDirExists ? codamaDir : undefined,
  );

  console.log(formatVerificationResult(verifyResult));

  if (!verifyResult.passed) {
    console.error("\n❌ Verification gate failed — no files emitted.");
    process.exit(1);
  }

  // ── Step 9: Emit files ────────────────────────────────────────────────
  if (opts.verifyOnly) {
    console.log("\n--verify-only: skipping file emission.");
    return;
  }

  if (opts.dryRun) {
    console.log("\n── Dry Run: would generate these files ──");
    for (const gen of GENERATORS) {
      const content = generated.get(gen.name);
      if (content) {
        console.log(`  ${gen.path} (${content.split("\n").length} lines)`);
      }
    }
    return;
  }

  // Write generated files
  console.log("\nWriting files...");
  for (const gen of GENERATORS) {
    const content = generated.get(gen.name);
    if (!content) continue;

    const dir = dirname(gen.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(gen.path, content, "utf-8");
    console.log(`  ✅ ${gen.path}`);
  }

  // ── Step 10: Registry patches ─────────────────────────────────────────
  console.log("\n── Registry Patches (apply manually) ──");
  console.log(generateRegistryPatches(config));

  // ── Step 11: Summary ──────────────────────────────────────────────────
  const fileCount = generated.size;
  let lineCount = 0;
  for (const content of generated.values()) {
    lineCount += content.split("\n").length;
  }

  console.log(`\n═══ Done ═══`);
  console.log(
    `  Generated ${fileCount} files (${lineCount} total lines) for ${config.protocol.displayName}`,
  );
  console.log(`  Protocol: ${config.protocol.id}`);
  console.log(`  Instructions: ${parsed.length}`);
  console.log(`  IDL hash: ${idlHash.substring(0, 16)}...`);
  console.log(`\nNext steps:`);
  console.log(`  1. Add Codama entry to sdk/kit/codama.mjs`);
  console.log(`  2. Run: node sdk/kit/codama.mjs --protocol=${protoId}`);
  console.log(`  3. Apply registry patches (printed above)`);
  console.log(`  4. Implement TODO stubs in ${protoId}-compose.ts`);
  console.log(
    `  5. Run: npx tsx scripts/add-protocol.ts --yaml ${opts.yamlPath} --verify-only`,
  );
}

main().catch((err) => {
  console.error("❌ Pipeline error:", err.message);
  process.exit(1);
});
