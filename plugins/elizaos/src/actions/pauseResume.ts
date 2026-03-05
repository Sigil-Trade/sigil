import { getOrCreateShieldedWallet } from "../client-factory";

export const pauseResumeAction = {
  name: "SHIELD_PAUSE_RESUME",
  description:
    "Pause or resume Phalnx enforcement. When paused, transactions " +
    "pass through without policy checks or spend recording.",
  similes: [
    "pause shield",
    "resume shield",
    "pause enforcement",
    "resume enforcement",
    "disable shield",
    "enable shield",
  ],

  validate: async (runtime: any, message: any): Promise<boolean> => {
    try {
      await getOrCreateShieldedWallet(runtime);
    } catch {
      return false;
    }

    const text = (message.content?.text || "").toLowerCase();
    const keywords = [
      "pause shield",
      "resume shield",
      "pause enforcement",
      "resume enforcement",
      "disable shield",
      "enable shield",
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
      const text = (message.content?.text || "").toLowerCase();

      // Determine intent from message text
      const resumeKeywords = ["resume", "enable", "unpause", "activate"];
      const isResume = resumeKeywords.some((kw) => text.includes(kw));

      if (isResume) {
        wallet.resume();
        callback({
          text: "Phalnx enforcement resumed. Policy checks are active.",
        });
      } else {
        wallet.pause();
        callback({
          text: "Phalnx enforcement paused. Transactions will pass through without policy checks.",
        });
      }
    } catch (error: any) {
      callback({
        text: `Failed to pause/resume enforcement: ${error.message}`,
        error: true,
      });
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Pause the shield enforcement" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Phalnx enforcement paused. Transactions will pass through without policy checks.",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: { text: "Resume shield enforcement" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "Phalnx enforcement resumed. Policy checks are active.",
        },
      },
    ],
  ],
};
