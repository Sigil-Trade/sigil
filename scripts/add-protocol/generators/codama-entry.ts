import type { AnnotationConfig } from "../types.js";

/**
 * Generates a Codama registry entry string to paste into the PROTOCOLS
 * object in sdk/kit/codama.mjs.
 *
 * Pattern follows the existing entries:
 * ```js
 * const PROTOCOLS = {
 *   "flash-trade": {
 *     idlPath: join(__dirname, "idls", "perpetuals.json"),
 *     outputDir: join(__dirname, "src", "generated", "protocols", "flash-trade"),
 *     generateEventMap: false,
 *     expectedHash: "...",
 *   },
 * };
 * ```
 */
export function generateCodamaEntry(
  config: AnnotationConfig,
  idlHash: string,
): string {
  const { protocol } = config;
  const idlFile = protocol.idlFile;

  const lines: string[] = [];

  lines.push(`  // ${protocol.displayName}`);
  lines.push(`  "${protocol.id}": {`);
  lines.push(
    `    idlPath: join(__dirname, "idls", "${idlFile}"),`,
  );
  lines.push(
    `    outputDir: join(__dirname, "src", "generated", "protocols", "${protocol.id}"),`,
  );
  lines.push(`    generateEventMap: false,`);
  lines.push(`    expectedHash: "${idlHash}",`);
  lines.push(`  },`);

  return lines.join("\n") + "\n";
}
