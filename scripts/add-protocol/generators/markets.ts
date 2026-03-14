import type { AnnotationConfig } from "../types.js";

function pascalCase(kebab: string): string {
  return kebab
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

function camelCase(kebab: string): string {
  const parts = kebab.split("-");
  return (
    parts[0] +
    parts
      .slice(1)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("")
  );
}

function upperSnakeCase(kebab: string): string {
  return kebab.replace(/-/g, "_").toUpperCase();
}

/**
 * Generates a market config file from the YAML markets section.
 *
 * Pattern follows sdk/kit/src/integrations/config/flash-trade-markets.ts:
 * - PROGRAM constant with Address type
 * - TypeScript interface for the market entry shape
 * - Config map populated from YAML market addresses
 * - resolve{Protocol}Accounts stub
 */
export function generateMarkets(config: AnnotationConfig): string {
  const { protocol, markets } = config;
  const pascal = pascalCase(protocol.id);
  const upper = upperSnakeCase(protocol.id);

  const lines: string[] = [];

  lines.push(`import type { Address } from "@solana/kit";`);
  lines.push(``);
  lines.push(
    `export const ${upper}_PROGRAM = "${protocol.programAddress}" as Address;`,
  );

  if (!markets || Object.keys(markets).length === 0) {
    lines.push(``);
    lines.push(
      `// No markets defined in annotation YAML. Add a markets section to generate config.`,
    );
    return lines.join("\n") + "\n";
  }

  // Derive interface fields from the first market entry's keys
  const marketNames = Object.keys(markets);
  const firstMarket = markets[marketNames[0]];
  const fieldNames = Object.keys(firstMarket);

  lines.push(``);
  lines.push(`export interface ${pascal}Market {`);
  for (const field of fieldNames) {
    lines.push(`  ${field}: Address;`);
  }
  lines.push(`}`);

  // Generate the config map
  const configVarName = `${camelCase(protocol.id)}Markets`;
  lines.push(``);
  lines.push(
    `export const ${configVarName}: Record<string, ${pascal}Market> = {`,
  );

  for (const marketName of marketNames) {
    const entry = markets[marketName];
    lines.push(`  "${marketName}": {`);
    for (const field of fieldNames) {
      const value = entry[field] ?? "";
      lines.push(`    ${field}: "${value}" as Address,`);
    }
    lines.push(`  },`);
  }

  lines.push(`};`);

  // Generate resolve function stub
  lines.push(``);
  lines.push(`/**`);
  lines.push(
    ` * Resolves accounts needed for ${protocol.displayName} instructions.`,
  );
  lines.push(` * @param market - The market name to resolve accounts for.`);
  lines.push(` */`);
  lines.push(
    `export function resolve${pascal}Accounts(market: string): ${pascal}Market {`,
  );
  lines.push(`  // TODO: implement account resolution`);
  lines.push(`  const entry = ${configVarName}[market];`);
  lines.push(`  if (!entry) {`);
  lines.push(
    `    throw new Error(\`Unknown ${protocol.displayName} market: \${market}\`);`,
  );
  lines.push(`  }`);
  lines.push(`  return entry;`);
  lines.push(`}`);

  return lines.join("\n") + "\n";
}
