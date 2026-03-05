import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import {
  toPublicKey,
  formatVaultStatus,
  formatBN,
  formatTimestamp,
} from "../utils";
import { formatError } from "../errors";

export const checkVaultSchema = z.object({
  vault: z
    .string()
    .describe("Vault PDA address (base58). Provide this OR owner+vaultId."),
  owner: z
    .string()
    .optional()
    .describe(
      "Owner public key (base58). Used with vaultId to derive the vault PDA.",
    ),
  vaultId: z
    .string()
    .optional()
    .describe("Vault ID number. Used with owner to derive the vault PDA."),
});

export type CheckVaultInput = z.infer<typeof checkVaultSchema>;

export async function checkVault(
  client: PhalnxClient,
  input: CheckVaultInput,
): Promise<string> {
  try {
    let vaultAddress;

    if (input.vault) {
      vaultAddress = toPublicKey(input.vault);
    } else if (input.owner && input.vaultId) {
      const { BN } = await import("@coral-xyz/anchor");
      const [pda] = client.getVaultPDA(
        toPublicKey(input.owner),
        new BN(input.vaultId),
      );
      vaultAddress = pda;
    } else {
      return "Error: Provide either 'vault' (address) or both 'owner' and 'vaultId'.";
    }

    const vault = await client.fetchVaultByAddress(vaultAddress);
    const policy = await client.fetchPolicy(vaultAddress);

    const protocolModeLabels = ["All Allowed", "Allowlist", "Denylist"];
    const protocolModeLabel =
      protocolModeLabels[policy.protocolMode] ??
      `Unknown (${policy.protocolMode})`;
    const protocols =
      policy.protocols.map((p) => p.toBase58()).join(", ") || "None";
    const allowedDestinations =
      policy.allowedDestinations && policy.allowedDestinations.length > 0
        ? policy.allowedDestinations.map((d) => d.toBase58()).join(", ")
        : "Any";
    const timelockDuration = policy.timelockDuration
      ? formatBN(policy.timelockDuration)
      : "0";

    // Check for pending policy update
    let pendingStatus = "None";
    try {
      const pending = await client.fetchPendingPolicy(vaultAddress);
      if (pending) {
        const executesAt = pending.executesAt.toNumber();
        const now = Math.floor(Date.now() / 1000);
        const remaining = executesAt - now;
        pendingStatus =
          remaining > 0
            ? `Yes (executes in ${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m)`
            : "Yes (ready to apply)";
      }
    } catch {
      // fetchPendingPolicy returns null if not found
    }

    return [
      `## Vault: ${vaultAddress.toBase58()}`,
      `- **Status:** ${formatVaultStatus(vault.status)}`,
      `- **Owner:** ${vault.owner.toBase58()}`,
      `- **Agents:** ${
        vault.agents && vault.agents.length > 0
          ? vault.agents
              .map(
                (a) =>
                  `${a.pubkey.toBase58()} (permissions: ${a.permissions.toString()})`,
              )
              .join(", ")
          : "None"
      }`,
      `- **Fee Destination:** ${vault.feeDestination.toBase58()}`,
      `- **Created:** ${formatTimestamp(vault.createdAt)}`,
      `- **Total Transactions:** ${formatBN(vault.totalTransactions)}`,
      `- **Total Volume:** ${formatBN(vault.totalVolume)}`,
      `- **Open Positions:** ${vault.openPositions}`,
      `- **Total Fees Collected:** ${formatBN(vault.totalFeesCollected)}`,
      "",
      "### Policy",
      `- **Daily Spending Cap:** ${formatBN(policy.dailySpendingCapUsd)}`,
      `- **Max Transaction Size:** ${formatBN(policy.maxTransactionSizeUsd)}`,
      `- **Protocol Mode:** ${protocolModeLabel}`,
      `- **Protocols:** ${protocols}`,
      `- **Allowed Destinations:** ${allowedDestinations}`,
      `- **Max Leverage:** ${policy.maxLeverageBps} BPS`,
      `- **Can Open Positions:** ${policy.canOpenPositions}`,
      `- **Max Concurrent Positions:** ${policy.maxConcurrentPositions}`,
      `- **Developer Fee Rate:** ${policy.developerFeeRate}`,
      `- **Timelock Duration:** ${timelockDuration}s`,
      `- **Pending Policy Update:** ${pendingStatus}`,
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const checkVaultTool = {
  name: "shield_check_vault",
  description:
    "Check the status and policy configuration of an Phalnx vault. " +
    "Provide either the vault address directly, or owner + vaultId to derive it.",
  schema: checkVaultSchema,
  handler: checkVault,
};
