import { z } from "zod";

export const provisionSchema = z.object({
  platformUrl: z
    .string()
    .optional()
    .describe("Phalnx platform URL (default: https://app.phalnx.io)"),
  template: z
    .enum(["conservative", "moderate", "aggressive"])
    .optional()
    .describe(
      "Policy template: conservative (500 USDC/day), moderate (2000), aggressive (10000)",
    ),
  dailyCap: z
    .number()
    .optional()
    .describe("Custom daily spending cap in USDC (overrides template default)"),
});

export type ProvisionInput = z.infer<typeof provisionSchema>;

/**
 * Generate a Solana Action URL for vault provisioning.
 *
 * This tool creates a URL that the user clicks to approve vault creation
 * with a TEE-backed agent wallet. No signing happens on the agent side.
 */
export async function provision(
  _agent: any,
  _config: any,
  input: ProvisionInput,
): Promise<string> {
  const baseUrl = (input.platformUrl || "https://app.phalnx.io").replace(
    /\/$/,
    "",
  );
  const template = input.template || "conservative";

  const params = new URLSearchParams();
  params.set("template", template);
  if (input.dailyCap) {
    params.set("dailyCap", input.dailyCap.toString());
  }

  const actionUrl = `${baseUrl}/api/actions/provision?${params.toString()}`;
  const blinkUrl = `https://dial.to/?action=solana-action:${encodeURIComponent(actionUrl)}`;

  const dailyCap =
    input.dailyCap ||
    { conservative: 500, moderate: 2000, aggressive: 10000 }[template] ||
    500;

  return [
    "=== Vault Provisioning ===",
    `Policy: ${template} (${dailyCap} USDC/day cap)`,
    "",
    `Blink URL: ${blinkUrl}`,
    `Action URL: ${actionUrl}`,
    "",
    "Have the user click the link above to approve vault creation.",
    "One transaction — creates vault + registers TEE agent wallet atomically.",
  ].join("\n");
}
