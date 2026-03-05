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

type TeeProvider = "crossmint" | "privy" | "turnkey";

/** OPTIONS preflight for CORS */
provisionTee.options("/api/actions/provision-tee", (c) => {
  return c.body(null, 200, CORS_HEADERS);
});

// ── Provider-specific provisioning helpers ─────────────────────────

async function provisionCrossmint(
  network: string,
  linkedUser: string,
): Promise<{ publicKey: string; locator: string }> {
  const apiKey = process.env.CROSSMINT_API_KEY;
  if (!apiKey) {
    throw new ProviderNotConfiguredError("crossmint");
  }

  const crossmintNetwork = network === "mainnet-beta" ? "mainnet" : "testnet";
  const crossmintUrl = `https://${crossmintNetwork === "mainnet" ? "" : "staging."}crossmint.com/api/v1-alpha2/wallets`;

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
    throw new ProviderError("Crossmint");
  }

  const result = (await response.json()) as Record<string, unknown>;
  const publicKey = (result.publicKey as string) || (result.address as string);
  const locator =
    (result.locator as string) ||
    (result.id as string) ||
    (result.linkedUser as string);

  if (!publicKey || !locator) {
    console.error(
      "[provision-tee] Unexpected Crossmint response:",
      JSON.stringify(result),
    );
    throw new ProviderError("Crossmint");
  }

  return { publicKey, locator };
}

async function provisionPrivy(): Promise<{
  publicKey: string;
  locator: string;
}> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new ProviderNotConfiguredError("privy");
  }

  const credentials = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const response = await fetch("https://api.privy.io/v1/wallets", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "privy-app-id": appId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chain_type: "solana" }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      `[provision-tee] Privy API error: ${response.status} ${errorBody}`,
    );
    throw new ProviderError("Privy");
  }

  const result = (await response.json()) as Record<string, unknown>;
  const publicKey = result.address as string;
  const locator = result.id as string;

  if (!publicKey || !locator) {
    console.error(
      "[provision-tee] Unexpected Privy response:",
      JSON.stringify(result),
    );
    throw new ProviderError("Privy");
  }

  return { publicKey, locator };
}

async function provisionTurnkey(): Promise<{
  publicKey: string;
  locator: string;
}> {
  const orgId = process.env.TURNKEY_ORGANIZATION_ID;
  const apiKeyId = process.env.TURNKEY_API_KEY_ID;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  if (!orgId || !apiKeyId || !apiPrivateKey) {
    throw new ProviderNotConfiguredError("turnkey");
  }

  // Use dynamic import to avoid bundling crypto stamp logic in the route
  // The Turnkey REST API uses P-256 ECDSA request stamping
  const { createHash, sign, createPrivateKey } = await import("crypto");

  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_CREATE_WALLET",
    timestampMs: Date.now().toString(),
    organizationId: orgId,
    parameters: {
      walletName: `phalnx-agent-${Date.now()}`,
      accounts: [
        {
          curve: "CURVE_ED25519",
          pathFormat: "PATH_FORMAT_BIP32",
          path: "m/44'/501'/0'/0'",
          addressFormat: "ADDRESS_FORMAT_SOLANA",
        },
      ],
    },
  });

  const hash = createHash("sha256").update(body).digest();
  const key = createPrivateKey({
    key: apiPrivateKey,
    format: "pem",
    type: "pkcs8",
  });
  const signature = sign("sha256", hash, {
    key,
    dsaEncoding: "ieee-p1363",
  });

  const stamp = JSON.stringify({
    publicKey: apiKeyId,
    signature: signature.toString("hex"),
    scheme: "SIGNATURE_SCHEME_TK_API_P256",
  });

  const response = await fetch(
    "https://api.turnkey.com/public/v1/submit/create_wallet",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stamp": stamp,
      },
      body,
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      `[provision-tee] Turnkey API error: ${response.status} ${errorBody}`,
    );
    throw new ProviderError("Turnkey");
  }

  const data = (await response.json()) as Record<string, unknown>;
  const activity = data.activity as Record<string, unknown> | undefined;
  const result = activity?.result as Record<string, unknown> | undefined;
  const walletResult = result?.createWalletResult as
    | Record<string, unknown>
    | undefined;
  const walletId = walletResult?.walletId as string;
  const addresses = walletResult?.addresses as
    | Array<Record<string, unknown>>
    | undefined;
  const publicKey = addresses?.[0]?.address as string;

  if (!publicKey || !walletId) {
    console.error(
      "[provision-tee] Unexpected Turnkey response:",
      JSON.stringify(data),
    );
    throw new ProviderError("Turnkey");
  }

  return { publicKey, locator: walletId };
}

// ── Error types ────────────────────────────────────────────────────

class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(
      `${provider} TEE provisioning is not available — server misconfigured`,
    );
    this.name = "ProviderNotConfiguredError";
  }
}

class ProviderError extends Error {
  constructor(provider: string) {
    super(`Failed to provision TEE wallet via ${provider}`);
    this.name = "ProviderError";
  }
}

// ── Main route ─────────────────────────────────────────────────────

/**
 * POST /api/actions/provision-tee — Provision a TEE wallet.
 *
 * Supports multiple providers: crossmint (default), privy, turnkey.
 * Uses server-side env vars — user does NOT need their own provider account.
 *
 * Body: { network?: "devnet" | "mainnet-beta", publicKey?: string, provider?: "crossmint" | "privy" | "turnkey" }
 * Returns: { publicKey, locator }
 *
 * When `publicKey` is provided with Crossmint, the `linkedUser` is deterministic
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

    const body = await c.req
      .json<{
        network?: string;
        publicKey?: string;
        provider?: TeeProvider;
      }>()
      .catch(
        () =>
          ({}) as {
            network?: string;
            publicKey?: string;
            provider?: TeeProvider;
          },
      );

    if (
      body.publicKey &&
      (body.publicKey.length < 32 || body.publicKey.length > 44)
    ) {
      return c.json({ error: "Invalid publicKey format" }, 400, CORS_HEADERS);
    }

    const provider: TeeProvider = body.provider || "crossmint";
    const network = body.network || "devnet";

    let result: { publicKey: string; locator: string };

    switch (provider) {
      case "crossmint": {
        // Deterministic linkedUser when publicKey provided (idempotent)
        const linkedUser = body.publicKey
          ? `userId:phalnx-${body.publicKey}`
          : `userId:phalnx-${Date.now()}`;
        result = await provisionCrossmint(network, linkedUser);
        break;
      }
      case "privy":
        result = await provisionPrivy();
        break;
      case "turnkey":
        result = await provisionTurnkey();
        break;
      default:
        return c.json(
          {
            error: `Unknown provider '${provider}'. Supported: crossmint, privy, turnkey.`,
          },
          400,
          CORS_HEADERS,
        );
    }

    return c.json(result, 200, CORS_HEADERS);
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      return c.json({ error: error.message }, 503, CORS_HEADERS);
    }
    if (error instanceof ProviderError) {
      return c.json({ error: error.message }, 502, CORS_HEADERS);
    }
    console.error("[Phalnx] provision-tee error:", error);
    return c.json({ error: "Internal server error" }, 500, CORS_HEADERS);
  }
});

export { provisionTee };
