import { Hono } from "hono";

const revokeAgent = new Hono();

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
revokeAgent.options("/api/actions/revoke-agent", (c) => {
  return c.body(null, 200, ACTIONS_CORS_HEADERS);
});

/**
 * GET /api/actions/revoke-agent — Returns Blink UI metadata.
 * Emergency vault freeze — immediately stops all agent actions.
 */
revokeAgent.get("/api/actions/revoke-agent", (c) => {
  const baseUrl = new URL(c.req.url).origin;

  const response = {
    type: "action",
    icon: `${baseUrl}/icon.png`,
    title: "Emergency Vault Freeze",
    description:
      "Emergency vault freeze — immediately stops all agent actions. " +
      "Only the vault owner can reactivate the vault after freezing.",
    label: "Freeze Vault",
  };

  return c.json(response, 200, ACTIONS_CORS_HEADERS);
});

/**
 * POST /api/actions/revoke-agent — Builds unsigned revoke_agent tx.
 * Body: { account: string }
 * Query: vaultId (required), agentPubkey (required)
 */
revokeAgent.post("/api/actions/revoke-agent", async (c) => {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { buildRevokeAgentTransaction } =
      await import("../lib/build-revoke-agent-tx");

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

    const agentPubkeyStr = c.req.query("agentPubkey");
    if (!agentPubkeyStr) {
      return c.json(
        { error: "Missing 'agentPubkey' query parameter" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    let agentToRemove: InstanceType<typeof PublicKey>;
    try {
      agentToRemove = new PublicKey(agentPubkeyStr);
    } catch {
      return c.json(
        { error: "Invalid 'agentPubkey': not a valid public key" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const vaultIdStr = c.req.query("vaultId");
    if (vaultIdStr === undefined || vaultIdStr === null || vaultIdStr === "") {
      return c.json(
        { error: "Missing 'vaultId' query parameter" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const vaultId = parseInt(vaultIdStr, 10);
    if (isNaN(vaultId) || vaultId < 0) {
      return c.json(
        { error: "Invalid 'vaultId': must be a non-negative integer" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const { transaction, vaultAddress } = await buildRevokeAgentTransaction({
      owner,
      agentToRemove,
      vaultId,
    });

    const serialized = Buffer.from(transaction.serialize()).toString("base64");

    return c.json(
      {
        transaction: serialized,
        message: `Vault ${vaultAddress} frozen. All agent actions are now blocked. Use reactivate_vault to restore access.`,
      },
      200,
      ACTIONS_CORS_HEADERS,
    );
  } catch (error) {
    console.error(
      "[Phalnx] revoke-agent error:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json(
      { error: "Internal server error" },
      500,
      ACTIONS_CORS_HEADERS,
    );
  }
});

export { revokeAgent };
