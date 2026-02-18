import { z } from "zod";

export const provisionSchema = z.object({
  platformUrl: z
    .string()
    .optional()
    .default("https://app.agentshield.dev")
    .describe("AgentShield platform URL (default: https://app.agentshield.dev)"),
  template: z
    .enum(["conservative", "moderate", "aggressive"])
    .optional()
    .default("conservative")
    .describe("Policy template: conservative (500 USDC/day), moderate (2000), aggressive (10000)"),
  dailyCap: z
    .number()
    .optional()
    .describe("Custom daily spending cap in USDC (overrides template default)"),
});

export type ProvisionInput = z.infer<typeof provisionSchema>;

/**
 * Generate a Solana Action URL for vault provisioning.
 *
 * This tool does NOT create the vault itself — it generates a URL
 * that the user clicks to approve vault creation in their wallet.
 * The platform handles TEE wallet creation server-side.
 */
export async function provision(
  _client: any,
  input: ProvisionInput
): Promise<string> {
  const baseUrl = input.platformUrl.replace(/\/$/, "");

  const params = new URLSearchParams();
  params.set("template", input.template);
  if (input.dailyCap) {
    params.set("dailyCap", input.dailyCap.toString());
  }

  const actionUrl = `${baseUrl}/api/actions/provision?${params.toString()}`;
  const blinkUrl = `https://dial.to/?action=solana-action:${encodeURIComponent(actionUrl)}`;

  const dailyCap = input.dailyCap || {
    conservative: 500,
    moderate: 2000,
    aggressive: 10000,
  }[input.template];

  return [
    "## Vault Provisioning Request",
    "",
    "I need a protected wallet to trade. Please approve the vault creation by clicking the link below.",
    "",
    `**Policy:** ${input.template} (${dailyCap} USDC/day cap)`,
    "",
    "### How to approve:",
    `1. **Blink URL** (paste in any blink-compatible app): ${blinkUrl}`,
    `2. **Action URL** (for Solana Actions-compatible wallets): ${actionUrl}`,
    "",
    "The transaction atomically creates an on-chain vault with a TEE-backed agent wallet.",
    "You sign ONE transaction — if anything fails, everything reverts.",
    "",
    "After you sign, I'll be able to trade within your policy limits.",
  ].join("\n");
}

export const provisionTool = {
  name: "shield_provision",
  description:
    "Generate a Solana Action URL for one-click vault provisioning. " +
    "Creates an Action URL that the user clicks to approve vault creation with a TEE-backed agent wallet. " +
    "The user signs one transaction that atomically creates the vault, sets policies, and registers the agent.",
  schema: provisionSchema,
  handler: provision,
};
