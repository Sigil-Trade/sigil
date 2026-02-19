import { Hono } from "hono";

const provisionTee = new Hono();

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "Content-Type": "application/json",
};

/** OPTIONS preflight for CORS */
provisionTee.options("/api/actions/provision-tee", (c) => {
  return c.body(null, 200, CORS_HEADERS);
});

/**
 * POST /api/actions/provision-tee — Provision a Crossmint TEE wallet.
 *
 * Uses CROSSMINT_API_KEY server-side env var (already on Vercel dashboard).
 * User does NOT need their own Crossmint account.
 *
 * Body: { network?: "devnet" | "mainnet-beta" }
 * Returns: { publicKey, locator }
 */
provisionTee.post("/api/actions/provision-tee", async (c) => {
  try {
    const apiKey = process.env.CROSSMINT_API_KEY;
    if (!apiKey) {
      return c.json(
        { error: "TEE provisioning is not available — server misconfigured" },
        503,
        CORS_HEADERS,
      );
    }

    const body = await c.req
      .json<{ network?: string }>()
      .catch(() => ({}) as { network?: string });
    const network = body.network === "mainnet-beta" ? "mainnet" : "testnet";

    // Crossmint API: create a Solana wallet
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
      return c.json(
        { error: "Failed to provision TEE wallet" },
        502,
        CORS_HEADERS,
      );
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
      return c.json(
        { error: "Unexpected response from TEE provider" },
        502,
        CORS_HEADERS,
      );
    }

    return c.json({ publicKey, locator }, 200, CORS_HEADERS);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[provision-tee] Error: ${message}`);
    return c.json({ error: message }, 500, CORS_HEADERS);
  }
});

export { provisionTee };
