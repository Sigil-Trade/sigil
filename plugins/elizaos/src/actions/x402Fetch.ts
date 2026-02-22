import { getOrCreateShieldedWallet } from "../client-factory";

export const x402FetchAction = {
  name: "SHIELD_X402_FETCH",
  description:
    "Fetch a URL with automatic x402 (HTTP 402 Payment Required) support. " +
    "If the server requires payment, the shielded wallet signs and retries.",
  similes: [
    "x402 fetch",
    "paid api",
    "pay for api",
    "fetch with payment",
    "x402 request",
    "http 402",
    "paid endpoint",
  ],

  validate: async (runtime: any, message: any): Promise<boolean> => {
    try {
      await getOrCreateShieldedWallet(runtime);
    } catch {
      return false;
    }

    const text = (message.content?.text || "").toLowerCase();
    const keywords = [
      "x402",
      "paid api",
      "pay for api",
      "fetch with payment",
      "http 402",
      "paid endpoint",
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
      const { shieldedFetch } = await import("@agent-shield/sdk");

      // Extract URL from message
      const text = message.content?.text || "";
      const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/);
      if (!urlMatch) {
        callback({
          text: "Please provide a URL to fetch. Example: 'x402 fetch https://api.example.com/data'",
        });
        return;
      }

      const url = urlMatch[0];
      runtime.logger?.info(`[AgentShield] x402 fetch: ${url}`);

      const res = await shieldedFetch(wallet, url);
      const body = await res.text();
      const x402 = (res as any).x402;

      const lines = [`=== x402 Fetch Result ===`];
      lines.push(`URL: ${url}`);
      lines.push(`Status: ${res.status}`);

      if (x402) {
        lines.push(`Paid: ${x402.paid}`);
        if (x402.paid) {
          lines.push(`Amount: ${x402.amountPaid}`);
          lines.push(`Asset: ${x402.asset}`);
          if (x402.settlement?.transaction) {
            lines.push(`Transaction: ${x402.settlement.transaction}`);
          }
        }
      }

      lines.push(`Response: ${body.slice(0, 1000)}`);
      callback({ text: lines.join("\n") });
    } catch (error: any) {
      runtime.logger?.error(
        `[AgentShield] x402 fetch failed: ${error.message}`,
      );
      callback({
        text: `x402 fetch failed: ${error.message}`,
        error: true,
      });
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "x402 fetch https://api.example.com/paid-data" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "=== x402 Fetch Result ===\nURL: https://api.example.com/paid-data\nStatus: 200\nPaid: true\nAmount: 1000000\nAsset: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      },
    ],
  ],
};
