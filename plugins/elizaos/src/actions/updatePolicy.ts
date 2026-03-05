import type { ShieldPolicies } from "@phalnx/sdk";
import { getOrCreateShieldedWallet } from "../client-factory";

export const updatePolicyAction = {
  name: "SHIELD_UPDATE_POLICY",
  description: "Update Phalnx spending limits or program blocking at runtime.",
  similes: [
    "update policy",
    "change limit",
    "change spending cap",
    "set budget",
    "update shield",
  ],

  validate: async (runtime: any, message: any): Promise<boolean> => {
    try {
      await getOrCreateShieldedWallet(runtime);
    } catch {
      return false;
    }

    const text = (message.content?.text || "").toLowerCase();
    const keywords = [
      "update policy",
      "change limit",
      "change cap",
      "set budget",
      "update shield",
    ];
    return keywords.some((kw) => text.includes(kw));
  },

  handler: async (
    runtime: any,
    message: any,
    _state: any,
    _options: any,
    callback: (response: any) => void,
  ) => {
    try {
      const { wallet } = await getOrCreateShieldedWallet(runtime);
      const params = message.content;

      const newPolicies: ShieldPolicies = {};
      const changes: string[] = [];

      if (params.maxSpend) {
        newPolicies.maxSpend = params.maxSpend;
        changes.push(`maxSpend: ${params.maxSpend}`);
      }

      if (params.blockUnknownPrograms !== undefined) {
        newPolicies.blockUnknownPrograms = params.blockUnknownPrograms;
        changes.push(`blockUnknownPrograms: ${params.blockUnknownPrograms}`);
      }

      if (changes.length === 0) {
        callback({
          text: "No policy changes specified. Provide maxSpend or blockUnknownPrograms.",
          error: true,
        });
        return;
      }

      wallet.updatePolicies(newPolicies);

      callback({
        text: `Phalnx policies updated: ${changes.join(", ")}`,
      });
    } catch (error: any) {
      callback({
        text: `Failed to update policies: ${error.message}`,
        error: true,
      });
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Update my shield limit to 1000 USDC per day",
          maxSpend: "1000 USDC/day",
        },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Phalnx policies updated: maxSpend: 1000 USDC/day",
        },
      },
    ],
  ],
};
