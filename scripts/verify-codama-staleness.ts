#!/usr/bin/env tsx
/**
 * CI Staleness Detection — Verify ALL Codama-generated discriminators.
 *
 * Computes SHA256("global:<ix_name>")[0..8] from each protocol IDL,
 * then compares with the discriminator constant in the generated code.
 *
 * Usage:
 *   npx tsx scripts/verify-codama-staleness.ts
 *
 * Exit codes:
 *   0 — All discriminators match
 *   1 — Discriminator mismatch detected (protocol upgrade?)
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────────────

function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function computeAnchorDiscriminator(ixName: string): Uint8Array {
  const hash = createHash("sha256").update(`global:${ixName}`).digest();
  return new Uint8Array(hash.buffer, hash.byteOffset, 8);
}

function extractDiscriminatorFromFile(filePath: string): Uint8Array | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(
    /_DISCRIMINATOR\s*=\s*new\s+Uint8Array\(\[\s*([\d\s,]+)\s*\]\)/,
  );
  if (!match) return null;
  const bytes = match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s, 10));
  return new Uint8Array(bytes);
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Protocol config ────────────────────────────────────────────────────

const PROTOCOLS = [
  {
    name: "flash-trade",
    idlPath: join("sdk", "kit", "idls", "perpetuals.json"),
    generatedDir: join(
      "sdk",
      "kit",
      "src",
      "generated",
      "protocols",
      "flash-trade",
      "instructions",
    ),
    idlCase: "snake" as const,
  },
  {
    name: "kamino",
    idlPath: join("sdk", "kit", "idls", "kamino-lending.json"),
    generatedDir: join(
      "sdk",
      "kit",
      "src",
      "generated",
      "protocols",
      "kamino",
      "instructions",
    ),
    idlCase: "camel" as const,
  },
];

// ─── IDL-based verification (ALL instructions) ──────────────────────────

let totalChecked = 0;
let totalPassed = 0;
let totalFailed = 0;
let totalMissing = 0;

console.log("═══ IDL → Generated Code Discriminator Check ═══\n");

for (const proto of PROTOCOLS) {
  if (!existsSync(proto.idlPath)) {
    console.log(`  ${proto.name}: IDL not found at ${proto.idlPath} (skipped)`);
    continue;
  }

  const idl = JSON.parse(readFileSync(proto.idlPath, "utf-8"));
  const instructions = idl.instructions ?? [];
  let protoPassed = 0;
  let protoFailed = 0;
  let protoMissing = 0;

  for (const ix of instructions) {
    const idlName: string = ix.name;

    let snakeName: string;
    let camelName: string;

    if (proto.idlCase === "snake") {
      snakeName = idlName;
      camelName = snakeToCamel(idlName);
    } else {
      camelName = idlName;
      snakeName = camelToSnake(idlName);
    }

    const filePath = join(proto.generatedDir, `${camelName}.ts`);
    const expected = computeAnchorDiscriminator(snakeName);
    const actual = extractDiscriminatorFromFile(filePath);

    totalChecked++;

    if (!actual) {
      protoMissing++;
      totalMissing++;
      continue;
    }

    if (arraysEqual(expected, actual)) {
      protoPassed++;
      totalPassed++;
    } else {
      protoFailed++;
      totalFailed++;
      console.error(
        `❌ MISMATCH: ${proto.name}/${snakeName}\n` +
          `   Expected: [${Array.from(expected).join(", ")}]\n` +
          `   Actual:   [${Array.from(actual).join(", ")}]`,
      );
    }
  }

  console.log(
    `  ${proto.name}: ${protoPassed} passed, ${protoFailed} failed, ${protoMissing} no generated file (of ${instructions.length} IDL instructions)`,
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n═══ Summary ═══`);
console.log(
  `  IDL-based: ${totalPassed}/${totalChecked} verified (${totalMissing} skipped, ${totalFailed} failed)`,
);

if (totalFailed > 0) {
  console.error(
    `\n❌ Discriminator mismatches detected!\n` +
      `Re-generate Codama types: pnpm --filter @usesigil/kit codama:all`,
  );
  process.exit(1);
} else {
  console.log(`\n✅ All discriminators verified.`);
}
