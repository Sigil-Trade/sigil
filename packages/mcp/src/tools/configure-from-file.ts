import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  saveShieldConfig,
  loadShieldConfig,
  isFullyConfigured,
  type ShieldLocalConfig,
  type ShieldLayerConfig,
} from "../config";

export const configureFromFileSchema = z.object({
  configFile: z
    .string()
    .describe(
      "Absolute or ~-relative path to a JSON config file matching the ShieldLocalConfig schema",
    ),
});

export type ConfigureFromFileInput = z.infer<typeof configureFromFileSchema>;

/**
 * Apply an Phalnx configuration from a pre-written JSON file.
 *
 * Designed for programmatic deployments (CI/CD pipelines, orchestrator
 * platforms) that need a non-interactive config path. The human who
 * wrote the config file is the human-in-the-loop.
 *
 * The config file must match the ShieldLocalConfig schema. Minimal
 * required fields:
 * ```json
 * {
 *   "version": 1,
 *   "layers": {
 *     "shield": { "enabled": true, "dailySpendingCapUsd": 500, "protocolMode": 0, "protocols": [], "maxLeverageBps": 0, "rateLimit": 60 },
 *     "tee": { "enabled": false, "locator": null, "publicKey": null },
 *     "vault": { "enabled": false, "address": null, "owner": null, "vaultId": null }
 *   },
 *   "wallet": { "type": "keypair", "path": "~/.phalnx/wallets/agent.json", "publicKey": "<base58>" },
 *   "network": "devnet",
 *   "template": "conservative",
 *   "configuredAt": "2026-01-01T00:00:00.000Z"
 * }
 * ```
 */
export async function configureFromFile(
  _client: any,
  input: ConfigureFromFileInput,
): Promise<string> {
  try {
    // Resolve ~ in path
    const filePath = input.configFile.startsWith("~")
      ? input.configFile.replace("~", os.homedir())
      : input.configFile;

    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      return `Error: Config file not found at ${resolved}`;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(resolved, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error reading config file: ${msg}`;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return `Error: Config file is not valid JSON`;
    }

    // Validate required fields
    const errors = validateConfig(parsed);
    if (errors.length > 0) {
      return [
        "Error: Config file has invalid structure:",
        "",
        ...errors.map((e) => `- ${e}`),
        "",
        "See shield_setup_status for the expected schema.",
      ].join("\n");
    }

    const config = parsed as ShieldLocalConfig;

    // Check if already configured
    const existing = loadShieldConfig();
    const isOverwrite = existing !== null;

    // Save config
    saveShieldConfig(config);

    const fullyConfigured = isFullyConfigured(config);

    const lines: string[] = [
      `## Phalnx Configured from File${isOverwrite ? " (overwritten)" : ""}`,
      "",
      `**Source:** ${resolved}`,
      `**Status:** ${fullyConfigured ? "Fully configured" : "Partially configured"}`,
      `**Network:** ${config.network}`,
      `**Template:** ${config.template}`,
      `**Wallet:** ${config.wallet.publicKey}`,
      `**Daily Cap:** $${config.layers.shield.dailySpendingCapUsd}`,
    ];

    if (!fullyConfigured) {
      lines.push("");
      lines.push(
        "**Note:** For production use with real funds, ensure all layers are enabled " +
          "(Policy + TEE + Vault) for on-chain policy enforcement that " +
          "cannot be bypassed even by compromised agent software.",
      );
    }

    return lines.join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error applying config from file: ${msg}`;
  }
}

/**
 * Validate that a parsed object matches the ShieldLocalConfig shape.
 * Returns an array of error messages (empty = valid).
 */
function validateConfig(obj: any): string[] {
  const errors: string[] = [];

  if (typeof obj !== "object" || obj === null) {
    return ["Config must be a JSON object"];
  }

  if (obj.version !== 1) {
    errors.push('Missing or invalid "version" (must be 1)');
  }

  // Layers
  if (typeof obj.layers !== "object" || obj.layers === null) {
    errors.push('Missing "layers" object');
  } else {
    // Shield
    if (typeof obj.layers.shield !== "object" || obj.layers.shield === null) {
      errors.push('Missing "layers.shield" object');
    } else {
      if (typeof obj.layers.shield.enabled !== "boolean") {
        errors.push('"layers.shield.enabled" must be a boolean');
      }
      if (typeof obj.layers.shield.dailySpendingCapUsd !== "number") {
        errors.push('"layers.shield.dailySpendingCapUsd" must be a number');
      }
      if (
        obj.layers.shield.protocolMode !== undefined &&
        typeof obj.layers.shield.protocolMode !== "number"
      ) {
        errors.push('"layers.shield.protocolMode" must be a number (0/1/2)');
      }
      if (!Array.isArray(obj.layers.shield.protocols)) {
        errors.push('"layers.shield.protocols" must be an array');
      }
      if (typeof obj.layers.shield.maxLeverageBps !== "number") {
        errors.push('"layers.shield.maxLeverageBps" must be a number');
      }
      if (typeof obj.layers.shield.rateLimit !== "number") {
        errors.push('"layers.shield.rateLimit" must be a number');
      }
    }

    // TEE
    if (typeof obj.layers.tee !== "object" || obj.layers.tee === null) {
      errors.push('Missing "layers.tee" object');
    } else {
      if (typeof obj.layers.tee.enabled !== "boolean") {
        errors.push('"layers.tee.enabled" must be a boolean');
      }
    }

    // Vault
    if (typeof obj.layers.vault !== "object" || obj.layers.vault === null) {
      errors.push('Missing "layers.vault" object');
    } else {
      if (typeof obj.layers.vault.enabled !== "boolean") {
        errors.push('"layers.vault.enabled" must be a boolean');
      }
    }
  }

  // Wallet
  if (typeof obj.wallet !== "object" || obj.wallet === null) {
    errors.push('Missing "wallet" object');
  } else {
    if (obj.wallet.type !== "keypair" && obj.wallet.type !== "crossmint") {
      errors.push('"wallet.type" must be "keypair" or "crossmint"');
    }
    if (typeof obj.wallet.publicKey !== "string" || !obj.wallet.publicKey) {
      errors.push('"wallet.publicKey" must be a non-empty string');
    }
  }

  // Network
  if (obj.network !== "devnet" && obj.network !== "mainnet-beta") {
    errors.push('"network" must be "devnet" or "mainnet-beta"');
  }

  // Template
  if (!["conservative", "moderate", "aggressive"].includes(obj.template)) {
    errors.push(
      '"template" must be "conservative", "moderate", or "aggressive"',
    );
  }

  // configuredAt
  if (typeof obj.configuredAt !== "string") {
    errors.push('"configuredAt" must be an ISO date string');
  }

  return errors;
}

export const configureFromFileTool = {
  name: "shield_configure_from_file",
  description:
    "Apply Phalnx configuration from a pre-written JSON file. " +
    "Designed for CI/CD pipelines and orchestrator platforms that need " +
    "non-interactive setup. The config file must match the ShieldLocalConfig " +
    "schema (same format as ~/.phalnx/config.json).",
  schema: configureFromFileSchema,
  handler: configureFromFile,
};
