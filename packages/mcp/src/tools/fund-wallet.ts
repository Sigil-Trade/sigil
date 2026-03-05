import { z } from "zod";
import { loadShieldConfig } from "../config";

const ACTIONS_SERVER_URL = "https://agent-middleware.vercel.app";

export const fundWalletSchema = z.object({
  mint: z
    .string()
    .optional()
    .describe(
      "Token mint address (base58). Omit for SOL. Use EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC.",
    ),
  amount: z
    .string()
    .optional()
    .describe(
      "Amount to fund (in human-readable units, e.g. '1.5' for 1.5 SOL)",
    ),
});

export type FundWalletInput = z.infer<typeof fundWalletSchema>;

/**
 * Generate funding URLs for the configured wallet.
 * Returns Blink URL (desktop), Solana Pay URL (mobile QR), and raw address.
 */
export async function fundWallet(
  _client: any,
  input: FundWalletInput,
): Promise<string> {
  const config = loadShieldConfig();
  if (!config) {
    return (
      "Phalnx is not configured yet. " +
      'Ask me to set it up first with "Set up Phalnx".'
    );
  }

  const destination = config.wallet.publicKey;

  const lines: string[] = [
    "## Fund Your Phalnx Wallet",
    "",
    `**Sending to:** ${destination}`,
    `**Wallet Type:** Phalnx wallet (TEE + on-chain enforced)`,
    `**Network:** ${config.network}`,
    "",
  ];

  // Build funding URLs
  const params = new URLSearchParams();
  params.set("destination", destination);
  if (input.mint) {
    params.set("mint", input.mint);
  }
  if (input.amount) {
    params.set("amount", input.amount);
  }

  const actionUrl = `${ACTIONS_SERVER_URL}/api/actions/fund?${params.toString()}`;
  const blinkUrl = `https://dial.to/?action=solana-action:${encodeURIComponent(actionUrl)}`;

  // Solana Pay URL
  const solPayParams = new URLSearchParams();
  if (input.amount) {
    solPayParams.set("amount", input.amount);
  }
  if (input.mint) {
    solPayParams.set("spl-token", input.mint);
  }
  const solanaPayUrl = `solana:${destination}${solPayParams.toString() ? "?" + solPayParams.toString() : ""}`;

  lines.push("### Option 1: Blink URL (Desktop)");
  lines.push(`${blinkUrl}`);
  lines.push("");
  lines.push("### Option 2: Solana Pay (Mobile QR)");
  lines.push(`${solanaPayUrl}`);
  lines.push("");
  lines.push("### Option 3: Send Directly");
  lines.push(`Address: \`${destination}\``);
  if (input.mint) {
    lines.push(`Token Mint: \`${input.mint}\``);
  }
  if (input.amount) {
    lines.push(`Amount: ${input.amount}`);
  }
  lines.push("");
  lines.push(
    `Send ${input.mint ? "tokens" : "SOL"} to the address above using any Solana wallet.`,
  );

  return lines.join("\n");
}

export const fundWalletTool = {
  name: "shield_fund_wallet",
  description:
    "Generate funding links for the configured Phalnx wallet. " +
    "Returns a Blink URL (desktop), Solana Pay URL (mobile QR), and raw address.",
  schema: fundWalletSchema,
  handler: fundWallet,
};
