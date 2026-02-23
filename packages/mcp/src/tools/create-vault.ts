import { z } from "zod";
import { BN } from "@coral-xyz/anchor";
import type { AgentShieldClient } from "@agent-shield/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";

export const createVaultSchema = z.object({
  vaultId: z.string().describe("Unique vault ID number"),
  dailySpendingCapUsd: z
    .string()
    .describe("Maximum daily spending in USD base units"),
  maxTransactionSizeUsd: z
    .string()
    .describe("Maximum single transaction size in USD base units"),
  protocolMode: z
    .number()
    .optional()
    .default(0)
    .describe(
      "Protocol access mode: 0 = all allowed, 1 = allowlist, 2 = denylist",
    ),
  protocols: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      "Protocol program IDs (base58) for allowlist/denylist. Max 10. Ignored when protocolMode=0.",
    ),
  maxLeverageBps: z
    .number()
    .describe("Maximum leverage in basis points (e.g. 30000 = 3x)"),
  maxConcurrentPositions: z
    .number()
    .describe("Maximum number of concurrent open positions"),
  feeDestination: z
    .string()
    .describe(
      "Fee destination wallet address (base58). Immutable after creation.",
    ),
  developerFeeRate: z
    .number()
    .optional()
    .default(0)
    .describe("Developer fee rate (max 500 = 5 BPS)"),
  allowedDestinations: z
    .array(z.string())
    .optional()
    .describe(
      "Allowed destination addresses for agent transfers (base58). Max 10.",
    ),
  timelockDuration: z
    .number()
    .optional()
    .default(0)
    .describe(
      "Timelock duration in seconds. When > 0, policy updates require queue → wait → apply.",
    ),
});

export type CreateVaultInput = z.infer<typeof createVaultSchema>;

export async function createVault(
  client: AgentShieldClient,
  input: CreateVaultInput,
): Promise<string> {
  try {
    const params = {
      vaultId: toBN(input.vaultId),
      dailySpendingCapUsd: toBN(input.dailySpendingCapUsd),
      maxTransactionSizeUsd: toBN(input.maxTransactionSizeUsd),
      protocolMode: input.protocolMode ?? 0,
      protocols: input.protocols ? input.protocols.map(toPublicKey) : [],
      maxLeverageBps: input.maxLeverageBps,
      maxConcurrentPositions: input.maxConcurrentPositions,
      feeDestination: toPublicKey(input.feeDestination),
      developerFeeRate: input.developerFeeRate,
      timelockDuration: input.timelockDuration
        ? new BN(input.timelockDuration)
        : new BN(0),
      allowedDestinations: input.allowedDestinations
        ? input.allowedDestinations.map(toPublicKey)
        : [],
    };

    const sig = await client.createVault(params);
    const owner = client.provider.wallet.publicKey;
    const [vaultPDA] = client.getVaultPDA(owner, params.vaultId);

    return [
      "## Vault Created Successfully",
      `- **Vault Address:** ${vaultPDA.toBase58()}`,
      `- **Owner:** ${owner.toBase58()}`,
      `- **Vault ID:** ${input.vaultId}`,
      `- **Transaction:** ${sig}`,
      "",
      "Next steps: Use shield_register_agent to register an agent key, " +
        "then shield_deposit to fund the vault.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const createVaultTool = {
  name: "shield_create_vault",
  description:
    "Create a new AgentShield vault with policy configuration. " +
    "Sets spending caps, protocol mode, leverage limits, and fee settings. " +
    "Tokens are managed via the global OracleRegistry.",
  schema: createVaultSchema,
  handler: createVault,
};
