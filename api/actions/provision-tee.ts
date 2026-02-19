import type { VercelRequest, VercelResponse } from "@vercel/node";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "Content-Type": "application/json",
};

function setCors(res: VercelResponse) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    setCors(res);
    return res.status(405).json({ error: "Method not allowed" });
  }

  setCors(res);

  try {
    const apiKey = process.env.CROSSMINT_API_KEY;
    if (!apiKey) {
      return res
        .status(503)
        .json({
          error: "TEE provisioning is not available — server misconfigured",
        });
    }

    const body = (req.body as { network?: string }) || {};
    const network = body.network === "mainnet-beta" ? "mainnet" : "testnet";

    const crossmintUrl = `https://${network === "mainnet" ? "" : "staging."}crossmint.com/api/v1-alpha2/wallets`;

    const response = await fetch(crossmintUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        type: "solana-mpc-wallet",
        linkedUser: `userId:agent-shield-${Date.now()}`,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[provision-tee] Crossmint API error: ${response.status} ${errorBody}`,
      );
      return res.status(502).json({ error: "Failed to provision TEE wallet" });
    }

    const result = (await response.json()) as {
      publicKey?: string;
      address?: string;
      locator?: string;
      id?: string;
      linkedUser?: string;
    };

    const publicKey = result.publicKey || result.address;
    const locator = result.locator || result.id || result.linkedUser;

    if (!publicKey || !locator) {
      console.error(
        "[provision-tee] Unexpected Crossmint response:",
        JSON.stringify(result),
      );
      return res
        .status(502)
        .json({ error: "Unexpected response from TEE provider" });
    }

    return res.status(200).json({ publicKey, locator });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[provision-tee] Error: ${message}`);
    return res.status(500).json({ error: message });
  }
}
