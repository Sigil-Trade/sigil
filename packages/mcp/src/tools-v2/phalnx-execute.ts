/**
 * phalnx_execute — The primary agent interaction tool (~80% of calls).
 *
 * Handles all 28+ intent types + protocol + passthrough through a single
 * schema. Delegates to IntentEngine.run() for validate → precheck → execute.
 */

import { z } from "zod";
import type { PhalnxClient, IntentAction, AgentError } from "@phalnx/sdk";
import { isAgentError } from "@phalnx/sdk";
import {
  formatAgentError,
  formatEscalation,
  formatExecuteResult,
} from "./format";
import { formatError } from "../errors";
import {
  loadAgentKeypair,
  loadShieldConfig,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";
import { toPublicKey } from "../utils";

export const phalnxExecuteSchema = z.object({
  action: z
    .enum([
      // Core
      "swap",
      "transfer",
      "deposit",
      "withdraw",
      // Flash Trade perps
      "openPosition",
      "closePosition",
      "increasePosition",
      "decreasePosition",
      "addCollateral",
      "removeCollateral",
      "placeTriggerOrder",
      "editTriggerOrder",
      "cancelTriggerOrder",
      "placeLimitOrder",
      "editLimitOrder",
      "cancelLimitOrder",
      "swapAndOpenPosition",
      "closeAndSwapPosition",
      // Escrow
      "createEscrow",
      "settleEscrow",
      "refundEscrow",
      // Drift
      "driftDeposit",
      "driftWithdraw",
      "driftPerpOrder",
      "driftSpotOrder",
      "driftCancelOrder",
      // Kamino
      "kaminoDeposit",
      "kaminoBorrow",
      "kaminoRepay",
      "kaminoWithdraw",
      "kaminoVaultDeposit",
      "kaminoVaultWithdraw",
      "kaminoMultiply",
      // Generic
      "protocol",
      "passthrough",
    ])
    .describe("The action type to execute"),
  params: z
    .record(z.string(), z.unknown())
    .describe("Action-specific parameters"),
  vault: z
    .string()
    .optional()
    .describe("Vault PDA address (base58). Uses default vault if omitted."),
});

export type PhalnxExecuteInput = z.infer<typeof phalnxExecuteSchema>;

export async function phalnxExecute(
  client: PhalnxClient,
  config: McpConfig,
  input: PhalnxExecuteInput,
  custodyWallet?: CustodyWalletLike | null,
): Promise<string> {
  try {
    // Resolve vault
    const rawVault =
      input.vault ?? loadShieldConfig()?.layers.vault.address ?? undefined;
    const vaultAddress = rawVault ? toPublicKey(rawVault) : null;

    if (!vaultAddress) {
      return "No vault specified and no default vault configured. Pass a vault address or run phalnx_setup step='configure'.";
    }

    // Build IntentAction from input.
    // Cast is safe: Zod enum validation on phalnxExecuteSchema.action runs
    // before this code, guaranteeing input.action is a valid IntentAction type.
    const intent: IntentAction = {
      type: input.action,
      params: input.params,
    } as IntentAction;

    // Resolve signers
    let signers: import("@solana/web3.js").Signer[] = [];
    if (!custodyWallet) {
      const agentKeypair = loadAgentKeypair(config);
      signers = [agentKeypair];
    }

    // Execute through IntentEngine
    const result = await client.intents.run(intent, vaultAddress, {
      signers,
    });

    // Check for AgentError
    if (isAgentError(result)) {
      const agentErr = result as AgentError;
      // Special formatting for escalation errors
      if (agentErr.category === "ESCALATION_REQUIRED") {
        return formatEscalation(agentErr);
      }
      return formatAgentError(agentErr);
    }

    // Success
    return formatExecuteResult(result);
  } catch (error) {
    return formatError(error);
  }
}
