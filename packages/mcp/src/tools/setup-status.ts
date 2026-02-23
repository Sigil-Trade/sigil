import { z } from "zod";
import {
  loadShieldConfig,
  isFullyConfigured,
  type ShieldLocalConfig,
} from "../config";

export const setupStatusSchema = z.object({});

export type SetupStatusInput = z.infer<typeof setupStatusSchema>;

/**
 * Check the current AgentShield setup status.
 * Reads ~/.agentshield/config.json and reports layer status, wallet, policy, network.
 *
 * This tool works without an SDK client — it only reads local config.
 */
export async function setupStatus(
  _client: any,
  _input: SetupStatusInput,
): Promise<string> {
  const config = loadShieldConfig();

  if (!config) {
    return [
      "## AgentShield Setup Status",
      "",
      "**Status:** Not configured",
      "",
      "AgentShield is not configured on this machine.",
      "",
      "AgentShield provides on-chain guardrails for AI agents on Solana:",
      "- Client-side policy checks (fast deny)",
      "- TEE key custody (hardware enclave protection)",
      "- On-chain vault enforcement (blockchain-enforced policies)",
      "",
      'Say "Set up AgentShield" to get started.',
    ].join("\n");
  }

  const fullyConfigured = isFullyConfigured(config);

  const lines: string[] = [
    "## AgentShield Setup Status",
    "",
    `**Status:** ${fullyConfigured ? "Fully configured" : "Partially configured"}`,
    `**Network:** ${config.network}`,
    `**Template:** ${config.template}`,
    `**Configured:** ${config.configuredAt}`,
    "",
  ];

  // Wallet info
  lines.push("### Wallet");
  lines.push(`- **Type:** ${config.wallet.type}`);
  lines.push(`- **Public Key:** ${config.wallet.publicKey}`);
  if (config.wallet.path) {
    lines.push(`- **Keypair Path:** ${config.wallet.path}`);
  }
  lines.push("");

  // Shield layer
  lines.push("### Policy Configuration");
  const shield = config.layers.shield;
  lines.push(`- **Enabled:** ${shield.enabled}`);
  if (shield.enabled) {
    lines.push(`- **Daily Cap:** $${shield.dailySpendingCapUsd}`);
    const protocolModeLabels = ["All Allowed", "Allowlist", "Denylist"];
    lines.push(
      `- **Protocol Mode:** ${protocolModeLabels[shield.protocolMode] ?? `Unknown (${shield.protocolMode})`}`,
    );
    lines.push(
      `- **Protocols:** ${shield.protocols.length > 0 ? shield.protocols.join(", ") : "None"}`,
    );
    lines.push(`- **Max Leverage:** ${shield.maxLeverageBps} BPS`);
    lines.push(`- **Rate Limit:** ${shield.rateLimit} tx/min`);
  }
  lines.push("");

  // TEE layer
  lines.push("### TEE Custody");
  const tee = config.layers.tee;
  lines.push(`- **Enabled:** ${tee.enabled}`);
  if (tee.enabled) {
    lines.push(`- **Public Key:** ${tee.publicKey}`);
    lines.push(`- **Locator:** ${tee.locator}`);
  }
  lines.push("");

  // Vault layer
  lines.push("### On-Chain Vault");
  const vault = config.layers.vault;
  lines.push(`- **Enabled:** ${vault.enabled}`);
  if (vault.enabled) {
    lines.push(`- **Vault Address:** ${vault.address}`);
    lines.push(`- **Owner:** ${vault.owner}`);
    lines.push(`- **Vault ID:** ${vault.vaultId}`);
  }

  // Setup recommendation
  if (!fullyConfigured) {
    lines.push("");
    lines.push("### Setup Incomplete");
    const missing: string[] = [];
    if (!config.layers.shield.enabled) missing.push("Policy checks");
    if (!config.layers.tee.enabled) missing.push("TEE custody");
    if (!config.layers.vault.enabled) missing.push("On-chain vault");
    lines.push(`Missing: ${missing.join(", ")}`);
    lines.push("");
    lines.push("Run shield_configure to set up full protection.");
  }

  return lines.join("\n");
}

export const setupStatusTool = {
  name: "shield_setup_status",
  description:
    "Check the current AgentShield setup status. Shows wallet configuration, guardrails, and network. " +
    "Works even when AgentShield is not configured — " +
    "reports setup instructions in that case.",
  schema: setupStatusSchema,
  handler: setupStatus,
};
