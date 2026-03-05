import { Hono } from "hono";
import { TEMPLATES, type TemplateName } from "../lib/templates";

const provision = new Hono();

const ACTIONS_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "Content-Type": "application/json",
  "X-Action-Version": "2.1.3",
  "X-Blockchain-Ids": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

/** OPTIONS preflight for CORS */
provision.options("/api/actions/provision", (c) => {
  return c.body(null, 200, ACTIONS_CORS_HEADERS);
});

/**
 * GET /api/actions/provision — Returns Blink UI metadata.
 * No heavy dependencies needed — just template labels.
 */
provision.get("/api/actions/provision", (c) => {
  const template = (c.req.query("template") as TemplateName) || "conservative";
  const config = TEMPLATES[template] || TEMPLATES.conservative;

  const baseUrl = new URL(c.req.url).origin;

  const response = {
    type: "action",
    icon: `${baseUrl}/icon.png`,
    title: "Create Phalnx Vault",
    description: `Set up a policy-enforced agent vault. Template: ${config.label} — ${config.description}`,
    label: "Create Vault",
    links: {
      actions: [
        {
          label: `Conservative — $500/day`,
          href: `${baseUrl}/api/actions/provision?template=conservative`,
        },
        {
          label: `Moderate — $2,000/day`,
          href: `${baseUrl}/api/actions/provision?template=moderate`,
        },
        {
          label: `Aggressive — $10,000/day`,
          href: `${baseUrl}/api/actions/provision?template=aggressive`,
        },
      ],
    },
  };

  return c.json(response, 200, ACTIONS_CORS_HEADERS);
});

/**
 * POST /api/actions/provision — Builds unsigned vault-creation transaction.
 * Body: { account: string }
 * Query: template, dailyCap, agentPubkey
 *
 * Heavy deps loaded dynamically on first call.
 */
provision.post("/api/actions/provision", async (c) => {
  try {
    // Dynamic import — only loads on POST, not on cold start
    const { PublicKey } = await import("@solana/web3.js");
    const { buildProvisionTransaction } = await import("../lib/build-tx");

    const body = await c.req.json<{ account: string }>();

    if (!body.account) {
      return c.json(
        { error: "Missing 'account' in request body" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    let owner: InstanceType<typeof PublicKey>;
    try {
      owner = new PublicKey(body.account);
    } catch {
      return c.json(
        { error: "Invalid 'account': not a valid public key" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const template =
      (c.req.query("template") as TemplateName) || "conservative";
    if (!TEMPLATES[template]) {
      return c.json(
        { error: `Invalid template: ${template}` },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const dailyCapStr = c.req.query("dailyCap");
    const dailyCap = dailyCapStr ? parseInt(dailyCapStr, 10) : undefined;
    if (dailyCap !== undefined && (isNaN(dailyCap) || dailyCap <= 0)) {
      return c.json(
        { error: "Invalid dailyCap: must be a positive number" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const agentPubkeyStr = c.req.query("agentPubkey");
    if (!agentPubkeyStr) {
      return c.json(
        { error: "Missing 'agentPubkey' query parameter" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    let agentPubkey: InstanceType<typeof PublicKey>;
    try {
      agentPubkey = new PublicKey(agentPubkeyStr);
    } catch {
      return c.json(
        { error: "Invalid 'agentPubkey': not a valid public key" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const vaultIdStr = c.req.query("vaultId");
    const vaultId = vaultIdStr ? parseInt(vaultIdStr, 10) : 0;

    const { transaction, vaultAddress } = await buildProvisionTransaction({
      owner,
      agentPubkey,
      template,
      dailyCap,
      vaultId,
    });

    const serialized = Buffer.from(transaction.serialize()).toString("base64");
    const config = TEMPLATES[template];

    return c.json(
      {
        transaction: serialized,
        message: `Vault created at ${vaultAddress}. Template: ${config.label} — ${config.description}`,
      },
      200,
      ACTIONS_CORS_HEADERS,
    );
  } catch (error) {
    console.error("[Phalnx] provision error:", error);
    return c.json(
      { error: "Internal server error" },
      500,
      ACTIONS_CORS_HEADERS,
    );
  }
});

export { provision };
