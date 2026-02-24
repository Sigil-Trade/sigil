import { Hono } from "hono";
import { checkRateLimit, getClientIp } from "../lib/rate-limiter";

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
 * Body: { network?: "devnet" | "mainnet-beta", publicKey?: string }
 * Returns: { publicKey, locator }
 *
 * When `publicKey` is provided, the Crossmint `linkedUser` is deterministic
 * so the same caller always gets the same wallet (idempotent).
 */
provisionTee.post("/api/actions/provision-tee", async (c) => {
  try {
    // Rate limit check
    const clientIp = getClientIp(c.req.raw.headers);
    const limit = checkRateLimit(clientIp);
    if (!limit.allowed) {
      const retryAfterSec = Math.ceil((limit.retryAfterMs ?? 0) / 1000);
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429, {
        ...CORS_HEADERS,
        "Retry-After": String(retryAfterSec),
      });
    }

    const apiKey = process.env.CROSSMINT_API_KEY;
    if (!apiKey) {
      return c.json(
        { error: "TEE provisioning is not available — server misconfigured" },
        503,
        CORS_HEADERS,
      );
    }

    const body = await c.req
      .json<{ network?: string; publicKey?: string }>()
      .catch(() => ({}) as { network?: string; publicKey?: string });

    if (
      body.publicKey &&
      (body.publicKey.length < 32 || body.publicKey.length > 44)
    ) {
      return c.json({ error: "Invalid publicKey format" }, 400, CORS_HEADERS);
    }

    const network = body.network === "mainnet-beta" ? "mainnet" : "testnet";

    // Deterministic linkedUser when publicKey provided (idempotent),
    // otherwise fall back to timestamp (backwards compatible)
    const linkedUser = body.publicKey
      ? `userId:agent-shield-${body.publicKey}`
      : `userId:agent-shield-${Date.now()}`;

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
        linkedUser,
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
