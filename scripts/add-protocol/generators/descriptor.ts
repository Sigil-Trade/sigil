/**
 * Protocol Onboarding Pipeline — Descriptor Skeleton Generator
 *
 * Generates a ProtocolDescriptor file matching the pattern of:
 *   sdk/kit/src/constraints/protocols/flash-trade-descriptor.ts
 *
 * ~70% auto-generated, with HAND-EDIT markers for protocol-specific logic.
 */

import type { AnnotationConfig, ParsedInstruction, RuleTypeAnnotation } from "../types.js";

function pascalCase(kebab: string): string {
  return kebab
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

function upperSnake(kebab: string): string {
  return kebab.toUpperCase().replace(/-/g, "_");
}

/**
 * Generate a complete descriptor TypeScript file.
 */
export function generateDescriptor(
  config: AnnotationConfig,
  parsed: ParsedInstruction[],
): string {
  const proto = config.protocol;
  const UPPER = upperSnake(proto.id);
  const Pascal = pascalCase(proto.id);

  const lines: string[] = [];

  // Header
  lines.push(`/**`);
  lines.push(` * ${proto.displayName} Protocol Descriptor — Rule Compilation`);
  lines.push(` *`);
  lines.push(` * Auto-generated skeleton by scripts/add-protocol.ts`);
  lines.push(` * Lines marked HAND-EDIT require protocol-specific implementation.`);
  lines.push(` */`);
  lines.push(``);

  // Imports
  lines.push(`import type { Address, ReadonlyUint8Array } from "@solana/kit";`);
  lines.push(`import { ConstraintOperator } from "../../generated/index.js";`);
  lines.push(`import type { AccountConstraintArgs, DataConstraintArgs } from "../../generated/index.js";`);
  lines.push(`import { bigintToLeBytes } from "../encoding.js";`);
  lines.push(`import type {`);
  lines.push(`  ActionRule,`);
  lines.push(`  CompiledConstraint,`);
  lines.push(`  InstructionSchema,`);
  lines.push(`  ProtocolDescriptor,`);
  lines.push(`  RuleParamMeta,`);
  lines.push(`  RuleTypeMetadata,`);
  lines.push(`} from "../types.js";`);

  // Schema imports
  const schemaExports = buildSchemaImports(config, UPPER);
  lines.push(`import {`);
  for (const exp of schemaExports) {
    lines.push(`  ${exp},`);
  }
  lines.push(`} from "./${proto.id}-schema.js";`);

  // Market config import (if markets exist)
  if (config.markets && Object.keys(config.markets).length > 0) {
    lines.push(`// HAND-EDIT: Import market config for account constraint resolution`);
    lines.push(`// import { ${UPPER}_MARKET_MAP } from "../../integrations/config/${proto.id}-markets.js";`);
  }
  lines.push(``);

  // Field mapping tables from YAML ruleTypes
  if (config.ruleTypes) {
    for (const rt of config.ruleTypes) {
      if (rt.constraintType === "data" && Object.keys(rt.fieldMapping).length > 0) {
        const mapName = `${camelToUpper(rt.type)}_FIELD_MAP`;
        lines.push(`/** Map instruction name to the field for ${rt.type} */`);
        lines.push(`const ${mapName}: Record<string, string> = {`);
        for (const [action, field] of Object.entries(rt.fieldMapping)) {
          lines.push(`  ${action}: "${field}",`);
        }
        lines.push(`};`);
        lines.push(``);
      }
    }
  }

  // Helpers
  lines.push(`// ─── Helpers ────────────────────────────────────────────────────────────────`);
  lines.push(``);
  lines.push(`function getSchema(action: string): InstructionSchema {`);
  lines.push(`  const schema = ${UPPER}_SCHEMA.instructions.get(action);`);
  lines.push(`  if (!schema) {`);
  lines.push(`    throw new Error(\`Unknown ${proto.displayName} action: \${action}\`);`);
  lines.push(`  }`);
  lines.push(`  return schema;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function makeDiscriminatorConstraint(disc: Uint8Array): DataConstraintArgs {`);
  lines.push(`  return {`);
  lines.push(`    offset: 0,`);
  lines.push(`    operator: ConstraintOperator.Eq,`);
  lines.push(`    value: disc as ReadonlyUint8Array,`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function makeLteConstraint(`);
  lines.push(`  schema: InstructionSchema,`);
  lines.push(`  fieldName: string,`);
  lines.push(`  maxValue: bigint,`);
  lines.push(`): DataConstraintArgs {`);
  lines.push(`  const field = schema.fields.find((f) => f.name === fieldName);`);
  lines.push(`  if (!field) {`);
  lines.push(`    throw new Error(`);
  lines.push(`      \`Field "\${fieldName}" not found in \${schema.name}. Available: \${schema.fields.map((f) => f.name).join(", ")}\`,`);
  lines.push(`    );`);
  lines.push(`  }`);
  lines.push(`  return {`);
  lines.push(`    offset: field.offset,`);
  lines.push(`    operator: ConstraintOperator.Lte,`);
  lines.push(`    value: bigintToLeBytes(maxValue, field.size) as ReadonlyUint8Array,`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);

  // Rule compilers
  lines.push(`// ─── Rule Compilers ─────────────────────────────────────────────────────────`);
  lines.push(``);

  // Always generate allowAll
  lines.push(`function compileAllowAll(rule: ActionRule): CompiledConstraint[] {`);
  lines.push(`  return rule.actions.map((action) => {`);
  lines.push(`    const schema = getSchema(action);`);
  lines.push(`    return {`);
  lines.push(`      discriminators: [schema.discriminator],`);
  lines.push(`      dataConstraints: [makeDiscriminatorConstraint(schema.discriminator)],`);
  lines.push(`      accountConstraints: [],`);
  lines.push(`    };`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push(``);

  // Generate data constraint compilers from YAML ruleTypes
  if (config.ruleTypes) {
    for (const rt of config.ruleTypes) {
      if (rt.constraintType === "data") {
        generateDataRuleCompiler(lines, rt, config, UPPER);
      } else if (rt.constraintType === "account") {
        generateAccountRuleCompiler(lines, rt, config, UPPER);
      }
    }
  }

  // Rule compiler map
  lines.push(`// ─── Descriptor ─────────────────────────────────────────────────────────────`);
  lines.push(``);
  lines.push(`const RULE_COMPILERS: Record<string, (rule: ActionRule) => CompiledConstraint[]> = {`);
  lines.push(`  allowAll: compileAllowAll,`);
  if (config.ruleTypes) {
    for (const rt of config.ruleTypes) {
      const fnName = `compile${pascalCase(rt.type)}`;
      lines.push(`  ${rt.type}: ${fnName},`);
    }
  }
  lines.push(`};`);
  lines.push(``);

  // Rule type metadata
  lines.push(`const RULE_TYPE_METADATA: RuleTypeMetadata[] = [`);
  // allowAll always first
  lines.push(`  {`);
  lines.push(`    type: "allowAll",`);
  lines.push(`    displayName: "Allow All Parameters",`);
  lines.push(`    description: "Allow the action with any parameters (discriminator-only constraint).",`);
  lines.push(`    applicableActions: [...Array.from(${UPPER}_SCHEMA.instructions.keys())],`);
  lines.push(`    params: [],`);
  lines.push(`  },`);
  if (config.ruleTypes) {
    for (const rt of config.ruleTypes) {
      lines.push(`  {`);
      lines.push(`    type: "${rt.type}",`);
      lines.push(`    displayName: "${rt.displayName}",`);
      lines.push(`    description: "${rt.description}",`);
      lines.push(`    applicableActions: [${rt.applicableActions.map((a) => `"${a}"`).join(", ")}],`);
      lines.push(`    params: [`);
      for (const p of rt.params) {
        lines.push(`      {`);
        lines.push(`        name: "${p.name}",`);
        lines.push(`        type: "${mapParamType(p.type)}",`);
        lines.push(`        label: "${p.label}",`);
        lines.push(`        required: ${p.required},`);
        if (p.options) {
          lines.push(`        options: [`);
          for (const opt of p.options) {
            lines.push(`          { value: "${opt.value}", label: "${opt.label}" },`);
          }
          lines.push(`        ],`);
        }
        lines.push(`      },`);
      }
      lines.push(`    ],`);
      lines.push(`  },`);
    }
  }
  lines.push(`];`);
  lines.push(``);

  // Descriptor export
  lines.push(`export const ${Pascal}Descriptor: ProtocolDescriptor = {`);
  lines.push(`  protocolId: "${proto.id}",`);
  lines.push(`  programAddress: ${UPPER}_PROGRAM,`);
  lines.push(`  schema: ${UPPER}_SCHEMA,`);
  lines.push(``);
  lines.push(`  compileRule(rule: ActionRule): CompiledConstraint[] {`);
  lines.push(`    const compiler = RULE_COMPILERS[rule.type];`);
  lines.push(`    if (!compiler) {`);
  lines.push(`      throw new Error(`);
  lines.push(`        \`Unknown ${proto.displayName} rule type: \${rule.type}. Available: \${Object.keys(RULE_COMPILERS).join(", ")}\`,`);
  lines.push(`      );`);
  lines.push(`    }`);
  lines.push(`    return compiler(rule);`);
  lines.push(`  },`);
  lines.push(``);
  lines.push(`  getRuleTypes(): RuleTypeMetadata[] {`);
  lines.push(`    return RULE_TYPE_METADATA;`);
  lines.push(`  },`);
  lines.push(``);
  lines.push(`  checkStrictModeWarnings: checkStrictModeWarnings,`);
  lines.push(``);
  lines.push(`  validateRule(rule: ActionRule): string[] {`);
  lines.push(`    const errors: string[] = [];`);
  lines.push(``);
  lines.push(`    if (!RULE_COMPILERS[rule.type]) {`);
  lines.push(`      errors.push(\`Unknown rule type: \${rule.type}\`);`);
  lines.push(`      return errors;`);
  lines.push(`    }`);
  lines.push(``);
  lines.push(`    for (const action of rule.actions) {`);
  lines.push(`      if (!${UPPER}_SCHEMA.instructions.has(action)) {`);
  lines.push(`        errors.push(\`Unknown action: \${action}\`);`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(``);
  // Type-specific validation from ruleTypes
  if (config.ruleTypes) {
    lines.push(`    switch (rule.type) {`);
    for (const rt of config.ruleTypes) {
      const requiredParams = rt.params.filter((p) => p.required);
      if (requiredParams.length > 0) {
        lines.push(`      case "${rt.type}": {`);
        for (const p of requiredParams) {
          lines.push(`        if (rule.params.${p.name} === undefined) {`);
          lines.push(`          errors.push(\`${rt.type} requires "${p.name}" param\`);`);
          lines.push(`        }`);
          if (p.type === "multiselect") {
            lines.push(`        if (!Array.isArray(rule.params.${p.name}) || (rule.params.${p.name} as unknown[]).length === 0) {`);
            lines.push(`          errors.push(\`${rt.type} requires non-empty "${p.name}" array\`);`);
            lines.push(`        }`);
          }
        }
        lines.push(`        break;`);
        lines.push(`      }`);
      }
    }
    lines.push(`    }`);
  }
  lines.push(``);
  lines.push(`    return errors;`);
  lines.push(`  },`);
  lines.push(`};`);
  lines.push(``);

  // checkStrictModeWarnings
  generateStrictModeWarnings(lines, config, UPPER);

  return lines.join("\n");
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

function buildSchemaImports(config: AnnotationConfig, upper: string): string[] {
  const imports: string[] = [`${upper}_SCHEMA`, `${upper}_PROGRAM`];
  if (config.actionCategories) {
    for (const category of Object.keys(config.actionCategories)) {
      imports.push(categoryToConstName(category, upper));
    }
  }
  return imports;
}

function categoryToConstName(category: string, upper: string): string {
  const catUpper = category.replace(/([A-Z])/g, "_$1").toUpperCase();
  return `${upper}_${catUpper}_ACTIONS`;
}

function camelToUpper(camel: string): string {
  return camel.replace(/([A-Z])/g, "_$1").toUpperCase();
}

function mapParamType(type: string): string {
  switch (type) {
    case "bigint": return "bigint";
    case "multiselect": return "multiselect";
    case "string": return "select";
    default: return "number";
  }
}

function generateDataRuleCompiler(
  lines: string[],
  rt: RuleTypeAnnotation,
  config: AnnotationConfig,
  upper: string,
): void {
  const fnName = `compile${pascalCase(rt.type)}`;
  const fieldMapName = `${camelToUpper(rt.type)}_FIELD_MAP`;
  const categoryConst = findApplicableCategory(rt, config, upper);

  // Determine the param name for the max value
  const valueParam = rt.params.find((p) => p.type === "bigint");
  const paramName = valueParam?.name ?? "maxValue";

  lines.push(`function ${fnName}(rule: ActionRule): CompiledConstraint[] {`);
  lines.push(`  const ${paramName} = BigInt(rule.params.${paramName} as string | bigint);`);
  lines.push(`  return rule.actions`);
  if (categoryConst) {
    lines.push(`    .filter((a) => ${categoryConst}.includes(a as typeof ${categoryConst}[number]))`);
  }
  lines.push(`    .map((action) => {`);
  lines.push(`      const schema = getSchema(action);`);
  lines.push(`      const fieldName = ${fieldMapName}[action];`);
  lines.push(`      return {`);
  lines.push(`        discriminators: [schema.discriminator],`);
  lines.push(`        dataConstraints: [`);
  lines.push(`          makeDiscriminatorConstraint(schema.discriminator),`);
  lines.push(`          makeLteConstraint(schema, fieldName, ${paramName}),`);
  lines.push(`        ],`);
  lines.push(`        accountConstraints: [],`);
  lines.push(`      };`);
  lines.push(`    });`);
  lines.push(`}`);
  lines.push(``);
}

function generateAccountRuleCompiler(
  lines: string[],
  rt: RuleTypeAnnotation,
  config: AnnotationConfig,
  upper: string,
): void {
  const fnName = `compile${pascalCase(rt.type)}`;

  lines.push(`// HAND-EDIT: Account constraint compiler requires protocol-specific market config`);
  lines.push(`function ${fnName}(rule: ActionRule): CompiledConstraint[] {`);
  lines.push(`  // TODO: Implement account constraint compilation`);
  lines.push(`  // Pattern: iterate rule.actions, look up market addresses, create AccountConstraintArgs`);
  lines.push(`  // See flash-trade-descriptor.ts compileAllowedMarkets() for reference.`);
  lines.push(`  return rule.actions`);
  lines.push(`    .filter((a) => ${upper}_SCHEMA.instructions.has(a))`);
  lines.push(`    .map((action) => {`);
  lines.push(`      const schema = getSchema(action);`);
  lines.push(`      return {`);
  lines.push(`        discriminators: [schema.discriminator],`);
  lines.push(`        dataConstraints: [makeDiscriminatorConstraint(schema.discriminator)],`);
  lines.push(`        accountConstraints: [],`);
  lines.push(`      };`);
  lines.push(`    });`);
  lines.push(`}`);
  lines.push(``);
}

function generateStrictModeWarnings(
  lines: string[],
  config: AnnotationConfig,
  upper: string,
): void {
  const spendingConst = config.actionCategories?.spending
    ? categoryToConstName("spending", upper)
    : null;
  const riskReducingConst = config.actionCategories?.riskReducing
    ? categoryToConstName("riskReducing", upper)
    : null;

  lines.push(`export function checkStrictModeWarnings(config: {`);
  lines.push(`  actionRules: ActionRule[];`);
  lines.push(`  strictMode?: boolean;`);
  lines.push(`}): string[] {`);
  lines.push(`  if (!config.strictMode) return [];`);
  lines.push(``);
  lines.push(`  const warnings: string[] = [];`);
  lines.push(`  const coveredActions = new Set<string>();`);
  lines.push(``);
  lines.push(`  for (const rule of config.actionRules) {`);
  lines.push(`    for (const action of rule.actions) {`);
  lines.push(`      coveredActions.add(action);`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(``);

  if (spendingConst && riskReducingConst) {
    lines.push(`  const hasSpendingAction = ${spendingConst}.some((a) =>`);
    lines.push(`    coveredActions.has(a),`);
    lines.push(`  );`);
    lines.push(``);
    lines.push(`  if (!hasSpendingAction) return warnings;`);
    lines.push(``);
    lines.push(`  const missingRiskReducing = ${riskReducingConst}.filter(`);
    lines.push(`    (a) => !coveredActions.has(a),`);
    lines.push(`  );`);
    lines.push(``);
    lines.push(`  if (missingRiskReducing.length > 0) {`);
    lines.push(`    warnings.push(`);
    lines.push(`      \`strict_mode is ON but these risk-reducing actions have no rules (agent cannot execute them): \${missingRiskReducing.join(", ")}. \` +`);
    lines.push(`      \`Add an "allowAll" rule for these actions to prevent the agent from being unable to close positions.\`,`);
    lines.push(`    );`);
    lines.push(`  }`);
  } else {
    lines.push(`  // No spending/riskReducing categories defined — add strict mode checks as needed`);
  }

  lines.push(``);
  lines.push(`  return warnings;`);
  lines.push(`}`);
}

function findApplicableCategory(
  rt: RuleTypeAnnotation,
  config: AnnotationConfig,
  upper: string,
): string | null {
  if (!config.actionCategories) return null;
  // Find which category's action list matches the rule's applicableActions
  for (const [category, actions] of Object.entries(config.actionCategories)) {
    const rtSet = new Set(rt.applicableActions);
    if (actions.every((a) => rtSet.has(a)) && actions.length === rt.applicableActions.length) {
      return categoryToConstName(category, upper);
    }
  }
  return null;
}
