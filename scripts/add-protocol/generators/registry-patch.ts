import type { AnnotationConfig } from "../types.js";
import { pascalCase, upperSnake } from "../naming.js";

/**
 * Prints human-readable diff-style instructions for the 4 registry files
 * that need manual patching when onboarding a new protocol.
 */
export function generateRegistryPatches(config: AnnotationConfig): string {
  const { protocol } = config;
  const pascal = pascalCase(protocol.id);
  const upper = upperSnake(protocol.id);

  const sections: string[] = [];

  // Header
  sections.push(
    `=== Registry Patches for ${protocol.displayName} (${protocol.id}) ===`,
  );
  sections.push(``);
  sections.push(
    `The following 4 files need manual updates. Copy-paste the snippets below.`,
  );

  // 1. sdk/kit/src/client.ts
  sections.push(``);
  sections.push(`--- 1. sdk/kit/src/client.ts ---`);
  sections.push(``);
  sections.push(
    `Add import at the top with the other protocol handler imports:`,
  );
  sections.push(``);
  sections.push(
    `  import { ${pascal}Handler } from "./integrations/${protocol.id}-handler.js";`,
  );
  sections.push(``);
  sections.push(
    `Add registration inside the constructor or init block (near existing reg.register calls):`,
  );
  sections.push(``);
  sections.push(`  reg.register(new ${pascal}Handler());`);

  // 2. sdk/kit/src/constraints/index.ts
  sections.push(``);
  sections.push(`--- 2. sdk/kit/src/constraints/index.ts ---`);
  sections.push(``);
  sections.push(`Add exports for the protocol schema and descriptor:`);
  sections.push(``);
  sections.push(`  // ${protocol.displayName}`);
  sections.push(
    `  export { ${upper}_SCHEMA, ${upper}_PROGRAM } from "./protocols/${protocol.id}-schema.js";`,
  );
  sections.push(
    `  export { ${pascal}Descriptor } from "./protocols/${protocol.id}-descriptor.js";`,
  );

  // 3. scripts/verify-codama-staleness.ts
  sections.push(``);
  sections.push(`--- 3. scripts/verify-codama-staleness.ts ---`);
  sections.push(``);
  sections.push(
    `Add the protocol entry to the PROTOCOLS array (or object) alongside existing protocols:`,
  );
  sections.push(``);
  sections.push(`  {`);
  sections.push(`    name: "${protocol.id}",`);
  sections.push(
    `    idlPath: join("sdk", "kit", "idls", "${protocol.idlFile}"),`,
  );
  sections.push(
    `    generatedDir: join("sdk", "kit", "src", "generated", "protocols", "${protocol.id}", "instructions"),`,
  );
  sections.push(`    idlCase: "${protocol.idlCase}" as const,`);
  sections.push(`  },`);
  sections.push(``);
  sections.push(`Add the schema import at the top for Layer 2 checks:`);
  sections.push(``);
  sections.push(
    `  import { ${upper}_SCHEMA } from "../sdk/kit/src/constraints/protocols/${protocol.id}-schema.js";`,
  );

  // 4. sdk/kit/src/intent-engine.ts
  sections.push(``);
  sections.push(`--- 4. sdk/kit/src/intent-engine.ts ---`);
  sections.push(``);
  sections.push(
    `If this protocol introduces new intent types, add mapping entries:`,
  );
  sections.push(``);
  sections.push(`  // In the intent type mapping switch/object:`);

  // Derive intent entries from actionCategories if available
  if (
    config.actionCategories &&
    Object.keys(config.actionCategories).length > 0
  ) {
    for (const category of Object.keys(config.actionCategories)) {
      const actions = config.actionCategories[category];
      sections.push(`  // Category "${category}": ${actions.join(", ")}`);
    }
    sections.push(``);
    sections.push(
      `  Add intent-to-action mappings for each category above that maps`,
    );
    sections.push(
      `  to a Sigil ActionType (e.g., Swap, OpenPosition, Deposit, etc.).`,
    );
  } else {
    sections.push(
      `  No action categories defined in YAML. Add intent mappings manually`,
    );
    sections.push(`  once the protocol's action types are determined.`);
  }

  sections.push(``);
  sections.push(`=== End of registry patches ===`);

  return sections.join("\n") + "\n";
}
