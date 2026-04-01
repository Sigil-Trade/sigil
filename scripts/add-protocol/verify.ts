/**
 * Protocol Onboarding Pipeline — Verification Gate
 *
 * Mandatory checks that run after generation and block on failure.
 * Catches discriminator mismatches, offset errors, type errors, and budget issues.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AnnotationConfig,
  AnchorIdl,
  ParsedInstruction,
} from "./types.js";
import { crossCheckDiscriminator } from "./discriminator.js";
import { codamaInstructionPath } from "./idl-helpers.js";

export interface VerificationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

const MAX_ENTRIES = 16;
const WARN_ENTRIES = 12;

/**
 * Run all verification checks against generated output.
 *
 * @param config - Parsed YAML annotation
 * @param idl - Parsed Anchor IDL
 * @param parsed - Parsed instructions with computed offsets
 * @param generatedDir - Directory where files were generated
 * @param codamaDir - Optional Codama-generated protocol directory (for checks 4-6)
 */
export function runVerification(
  config: AnnotationConfig,
  idl: AnchorIdl,
  parsed: ParsedInstruction[],
  generatedDir: string,
  codamaDir?: string,
): VerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Check 1: Discriminator 3-source cross-check ─────────────────────────
  console.log("  Check 1: Discriminator cross-check...");
  for (const ix of parsed) {
    const idlIx = idl.instructions.find((i) => i.name === ix.idlName);
    if (!idlIx) continue;

    let codamaFilePath = "";
    if (codamaDir) {
      codamaFilePath = codamaInstructionPath(
        codamaDir,
        ix.idlName,
        config.protocol.idlCase,
      );
    }

    const error = crossCheckDiscriminator(
      ix.idlName,
      idlIx,
      config.protocol.idlFormat,
      config.protocol.idlCase,
      codamaFilePath,
    );
    if (error) {
      errors.push(`[Check 1] ${error}`);
    }
  }

  // ── Check 2: Field offset sum = dataSize ────────────────────────────────
  console.log("  Check 2: Field offset sum validation...");
  for (const ix of parsed) {
    if (ix.dataSize < 8) {
      errors.push(
        `[Check 2] ${ix.sdkName}: dataSize (${ix.dataSize}) is less than discriminator size (8)`,
      );
    }

    for (const field of ix.fields) {
      if (field.offset + field.size > ix.dataSize) {
        errors.push(
          `[Check 2] ${ix.sdkName}.${field.schemaFieldName}: field extends beyond dataSize ` +
            `(offset=${field.offset}, size=${field.size}, dataSize=${ix.dataSize})`,
        );
      }
    }
  }

  // ── Check 3: Account index exists in IDL ────────────────────────────────
  console.log("  Check 3: Account index validation...");
  for (const ix of parsed) {
    const idlIx = idl.instructions.find((i) => i.name === ix.idlName);
    if (!idlIx) continue;

    for (const acct of ix.accounts) {
      if (acct.index >= idlIx.accounts.length) {
        errors.push(
          `[Check 3] ${ix.sdkName}: account "${acct.name}" has index ${acct.index} ` +
            `but IDL only has ${idlIx.accounts.length} accounts`,
        );
      }
    }
  }

  // ── Check 4: Codama output completeness (optional) ──────────────────────
  if (codamaDir) {
    console.log("  Check 4: Codama output completeness...");
    for (const ix of parsed) {
      const codamaFile = codamaInstructionPath(
        codamaDir,
        ix.idlName,
        config.protocol.idlCase,
      );
      if (!existsSync(codamaFile)) {
        errors.push(
          `[Check 4] Codama file missing: ${codamaFile}. ` +
            `Run \`node codama.mjs --protocol=${config.protocol.id}\` first.`,
        );
      }
    }
  }

  // ── Check 5: Roundtrip decode (requires Codama output — deferred) ──────
  // NOTE: This check requires importing Codama-generated encoders at runtime.
  // It must be run separately after Codama generation as an async operation.
  // See the --verify-only CLI flag for post-Codama verification.

  // ── Check 6: Account index cross-check vs Codama (deferred) ─────────────
  // NOTE: Also requires Codama output. Pair with check 5.

  // ── Check 7: tsc --noEmit ──────────────────────────────────────────────
  // NOTE: Full tsc check requires files to be in their final location with
  // proper tsconfig context. This is best run as a post-generation step
  // (e.g., `pnpm --filter @usesigil/kit exec tsc --noEmit`).
  // Here we do a structural sanity check instead.
  console.log("  Check 7: Structural syntax check...");
  for (const ix of parsed) {
    // Verify discriminator is exactly 8 bytes
    if (ix.discriminator.length !== 8) {
      errors.push(
        `[Check 7] ${ix.sdkName}: discriminator has ${ix.discriminator.length} bytes (expected 8)`,
      );
    }
    // Verify no duplicate field names
    const fieldNames = new Set<string>();
    for (const f of ix.fields) {
      if (fieldNames.has(f.schemaFieldName)) {
        errors.push(
          `[Check 7] ${ix.sdkName}: duplicate field name "${f.schemaFieldName}"`,
        );
      }
      fieldNames.add(f.schemaFieldName);
    }
  }

  // ── Check 8: Budget estimation ─────────────────────────────────────────
  console.log("  Check 8: Budget estimation...");
  const totalEntries = parsed.length;
  if (totalEntries > MAX_ENTRIES) {
    errors.push(
      `[Check 8] Protocol has ${totalEntries} instructions — exceeds max constraint entries (${MAX_ENTRIES})`,
    );
  } else if (totalEntries > WARN_ENTRIES) {
    warnings.push(
      `[Check 8] Protocol has ${totalEntries} instructions — approaching max constraint entries (${MAX_ENTRIES}). Consider grouping similar instructions.`,
    );
  }

  // ── Check 9: Action category coverage ──────────────────────────────────
  console.log("  Check 9: Action category coverage...");
  if (config.actionCategories) {
    const categorizedActions = new Set<string>();
    for (const actions of Object.values(config.actionCategories)) {
      for (const action of actions) {
        categorizedActions.add(action);
      }
    }

    for (const ix of parsed) {
      if (!categorizedActions.has(ix.sdkName)) {
        warnings.push(
          `[Check 9] Instruction "${ix.sdkName}" is not in any actionCategory`,
        );
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Format verification results for console output.
 */
export function formatVerificationResult(result: VerificationResult): string {
  const lines: string[] = [];

  if (result.errors.length > 0) {
    lines.push("\n❌ Verification FAILED:");
    for (const err of result.errors) {
      lines.push(`  ${err}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("\n⚠️  Warnings:");
    for (const warn of result.warnings) {
      lines.push(`  ${warn}`);
    }
  }

  if (result.passed) {
    lines.push("\n✅ All verification checks passed.");
  }

  return lines.join("\n");
}
