import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { toPublicKey, toBN } from "../utils";
import { formatError } from "../errors";
import type { McpConfig } from "../config";
import { loadOwnerKeypair } from "../config";

const ACTION_TYPES = [
  "update_policy",
  "queue_policy_update",
  "apply_pending_policy",
  "emergency_close",
  "sync_positions",
] as const;

export const squadsProposeActionSchema = z.object({
  multisig: z.string().describe("Squads multisig address (base58)"),
  vaultIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Squads vault authority index (default 0)"),
  action: z.enum(ACTION_TYPES).describe("Phalnx admin action to propose"),
  phalnxVault: z.string().describe("Phalnx vault PDA address (base58)"),
  actionParams: z
    .string()
    .optional()
    .describe(
      "JSON string with action-specific params. " +
        "For update_policy/queue_policy_update: policy fields. " +
        "For sync_positions: {actualPositions: number}.",
    ),
  memo: z.string().optional().describe("Optional proposal memo"),
});

export type SquadsProposeActionInput = z.infer<
  typeof squadsProposeActionSchema
>;

export async function squadsProposeAction(
  client: PhalnxClient,
  config: McpConfig,
  input: SquadsProposeActionInput,
): Promise<string> {
  try {
    const ownerKeypair = loadOwnerKeypair(config);
    const multisigPda = toPublicKey(input.multisig);
    const phalnxVault = toPublicKey(input.phalnxVault);

    let actionParams: any = undefined;
    if (input.actionParams) {
      try {
        actionParams = JSON.parse(input.actionParams);
      } catch {
        return "Error: actionParams must be valid JSON.";
      }
    }

    // Convert BN string fields for policy updates
    if (
      actionParams &&
      (input.action === "update_policy" ||
        input.action === "queue_policy_update")
    ) {
      if (actionParams.dailySpendingCapUsd)
        actionParams.dailySpendingCapUsd = toBN(
          actionParams.dailySpendingCapUsd,
        );
      if (actionParams.maxTransactionSizeUsd)
        actionParams.maxTransactionSizeUsd = toBN(
          actionParams.maxTransactionSizeUsd,
        );
      if (actionParams.maxTransactionAmountUsd)
        actionParams.maxTransactionAmountUsd = toBN(
          actionParams.maxTransactionAmountUsd,
        );
      if (actionParams.protocols)
        actionParams.protocols = actionParams.protocols.map(toPublicKey);
      if (actionParams.timelockDuration)
        actionParams.timelockDuration = toBN(actionParams.timelockDuration);
      if (actionParams.allowedDestinations)
        actionParams.allowedDestinations =
          actionParams.allowedDestinations.map(toPublicKey);
    }

    const result = await client.squadsProposeAction(ownerKeypair, {
      multisigPda,
      vaultIndex: input.vaultIndex,
      action: input.action,
      phalnxVault,
      actionParams,
      memo: input.memo,
    });

    const actionLabel = input.action.replace(/_/g, " ");

    return [
      "## Squads Proposal Created",
      `- **Action:** ${actionLabel}`,
      `- **Multisig:** ${input.multisig}`,
      `- **Transaction Index:** ${result.transactionIndex}`,
      `- **Phalnx Vault:** ${input.phalnxVault}`,
      `- **Transaction:** ${result.signature}`,
      "",
      "The proposal is now **Active**. Members can vote with " +
        "shield_squads_approve or shield_squads_reject.",
    ].join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const squadsProposeActionTool = {
  name: "shield_squads_propose_action",
  description:
    "Propose an Phalnx admin action through Squads multisig governance. " +
    "Wraps the instruction in a vault transaction and opens a proposal for voting.",
  schema: squadsProposeActionSchema,
  handler: squadsProposeAction,
};
