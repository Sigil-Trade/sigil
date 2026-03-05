/**
 * SHIELD_PROVISION action for ElizaOS.
 *
 * Generates a Solana Action URL for one-click vault provisioning.
 * The user clicks the link (blink or Action URL) to approve vault creation
 * with a TEE-backed agent wallet.
 */

export const provisionAction = {
  name: "SHIELD_PROVISION",
  description:
    "Request a protected vault with a TEE-backed agent wallet. " +
    "Generates a Solana Action URL for the user to approve.",
  similes: [
    "provision wallet",
    "create vault",
    "need a wallet",
    "setup trading",
    "get agent wallet",
    "shield provision",
    "create protected wallet",
  ],

  validate: async (_runtime: any, message: any): Promise<boolean> => {
    const text = (message.content?.text || "").toLowerCase();
    const keywords = [
      "provision",
      "create vault",
      "need a wallet",
      "setup trading",
      "agent wallet",
      "protected wallet",
      "shield provision",
    ];
    return keywords.some((kw) => text.includes(kw));
  },

  handler: async (
    runtime: any,
    _message: any,
    _state: any,
    _options: any,
    callback: (response: any) => void,
  ) => {
    try {
      const platformUrl =
        runtime.getSetting?.("PHALNX_PLATFORM_URL") ||
        process.env.PHALNX_PLATFORM_URL ||
        "https://app.phalnx.io";

      const template =
        runtime.getSetting?.("PHALNX_DEFAULT_TEMPLATE") ||
        process.env.PHALNX_DEFAULT_TEMPLATE ||
        "conservative";

      const dailyCapStr =
        runtime.getSetting?.("PHALNX_DAILY_CAP") ||
        process.env.PHALNX_DAILY_CAP;
      const dailyCap = dailyCapStr ? parseInt(dailyCapStr, 10) : undefined;

      const baseUrl = platformUrl.replace(/\/$/, "");
      const params = new URLSearchParams();
      params.set("template", template);
      if (dailyCap) {
        params.set("dailyCap", dailyCap.toString());
      }

      const actionUrl = `${baseUrl}/api/actions/provision?${params.toString()}`;
      const blinkUrl = `https://dial.to/?action=solana-action:${encodeURIComponent(actionUrl)}`;

      const capDisplay =
        dailyCap ||
        {
          conservative: 500,
          moderate: 2000,
          aggressive: 10000,
        }[template as string] ||
        500;

      const lines = [
        "I need a protected wallet to trade. Please approve the vault creation:",
        "",
        `**Policy:** ${template} (${capDisplay} USDC/day cap)`,
        "",
        `**Blink URL:** ${blinkUrl}`,
        `**Action URL:** ${actionUrl}`,
        "",
        "Click the link above to approve. You'll sign ONE transaction that creates",
        "the vault and registers a TEE-backed agent wallet — all-or-nothing.",
      ];

      callback({ text: lines.join("\n") });
    } catch (error: any) {
      callback({
        text: `Failed to generate provision URL: ${error.message}`,
        error: true,
      });
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "I need you to set up a protected trading wallet" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "I need a protected wallet to trade. Please approve the vault creation:\n\n**Policy:** conservative (500 USDC/day cap)\n\n**Blink URL:** https://dial.to/?action=solana-action:...\n**Action URL:** https://app.phalnx.io/api/actions/provision?template=conservative",
        },
      },
    ],
  ],
};
