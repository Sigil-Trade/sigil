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

// ── Inline rate limiter (can't import from apps/actions-server in Vercel build)
// Simplified copy of apps/actions-server/src/lib/rate-limiter.ts (no lazy eviction — cold starts handle it)
const RL_MAX = 5;
const RL_WINDOW_MS = 60 * 60 * 1000;
const rlStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  const now = Date.now();
  const entry = rlStore.get(ip);
  if (!entry || now >= entry.resetAt) {
    rlStore.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= RL_MAX) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count += 1;
  return { allowed: true };
}

function getClientIp(req: VercelRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length > 0) return xff[0].split(",")[0].trim();
  const xri = req.headers["x-real-ip"];
  if (typeof xri === "string") return xri;
  return "unknown";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    setCors(res);
    return res.status(405).json({ error: "Method not allowed" });
  }

  setCors(res);

  // Rate limit check
  const clientIp = getClientIp(req);
  const limit = checkRateLimit(clientIp);
  if (!limit.allowed) {
    const retryAfterSec = Math.ceil((limit.retryAfterMs ?? 0) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    return res
      .status(429)
      .json({ error: "Rate limit exceeded. Try again later." });
  }

  try {
    const apiKey = process.env.CROSSMINT_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: "TEE provisioning is not available — server misconfigured",
      });
    }

    const body = (req.body as { network?: string; publicKey?: string }) || {};

    if (
      body.publicKey &&
      (body.publicKey.length < 32 || body.publicKey.length > 44)
    ) {
      return res.status(400).json({ error: "Invalid publicKey format" });
    }

    const network = body.network === "mainnet-beta" ? "mainnet" : "testnet";

    // Deterministic linkedUser when publicKey provided (idempotent),
    // otherwise fall back to timestamp (backwards compatible)
    const linkedUser = body.publicKey
      ? `userId:agent-shield-${body.publicKey}`
      : `userId:agent-shield-${Date.now()}`;

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
