import { Hono } from "hono";

const emergency = new Hono();

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

// ═══ freeze-vault ═══════════════════════════════════════════

emergency.options("/api/actions/freeze-vault", (c) => {
  return c.body(null, 200, ACTIONS_CORS_HEADERS);
});

emergency.get("/api/actions/freeze-vault", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json(
    {
      type: "action",
      icon: `${baseUrl}/icon.png`,
      title: "Emergency Vault Freeze",
      description:
        "Freeze the vault immediately — blocks all agent actions while preserving agent entries. " +
        "Owner-only. Use Reactivate Vault to unfreeze.",
      label: "Freeze Vault",
    },
    200,
    ACTIONS_CORS_HEADERS,
  );
});

emergency.post("/api/actions/freeze-vault", async (c) => {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { buildFreezeVaultTransaction } =
      await import("../lib/build-freeze-vault-tx");

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

    const vaultIdStr = c.req.query("vaultId");
    if (!vaultIdStr) {
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

    const { transaction, vaultAddress } = await buildFreezeVaultTransaction({
      owner,
      vaultId,
    });

    const serialized = Buffer.from(transaction.serialize()).toString("base64");
    return c.json(
      {
        transaction: serialized,
        message: `Vault ${vaultAddress} frozen. All agent actions are now blocked.`,
      },
      200,
      ACTIONS_CORS_HEADERS,
    );
  } catch (error) {
    console.error(
      "[Phalnx] freeze-vault error:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json(
      { error: "Internal server error" },
      500,
      ACTIONS_CORS_HEADERS,
    );
  }
});

// ═══ pause-agent ════════════════════════════════════════════

emergency.options("/api/actions/pause-agent", (c) => {
  return c.body(null, 200, ACTIONS_CORS_HEADERS);
});

emergency.get("/api/actions/pause-agent", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json(
    {
      type: "action",
      icon: `${baseUrl}/icon.png`,
      title: "Pause Agent",
      description:
        "Pause a specific agent — blocks all its actions while preserving permissions and spend history. " +
        "Owner-only. Other agents in the vault are not affected.",
      label: "Pause Agent",
    },
    200,
    ACTIONS_CORS_HEADERS,
  );
});

emergency.post("/api/actions/pause-agent", async (c) => {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { buildPauseAgentTransaction } =
      await import("../lib/build-pause-agent-tx");

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

    let agentToPause: InstanceType<typeof PublicKey>;
    try {
      agentToPause = new PublicKey(agentPubkeyStr);
    } catch {
      return c.json(
        { error: "Invalid 'agentPubkey': not a valid public key" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const vaultIdStr = c.req.query("vaultId");
    if (!vaultIdStr) {
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

    const { transaction, vaultAddress } = await buildPauseAgentTransaction({
      owner,
      agentToPause,
      vaultId,
    });

    const serialized = Buffer.from(transaction.serialize()).toString("base64");
    return c.json(
      {
        transaction: serialized,
        message: `Agent ${agentPubkeyStr} paused in vault ${vaultAddress}.`,
      },
      200,
      ACTIONS_CORS_HEADERS,
    );
  } catch (error) {
    console.error(
      "[Phalnx] pause-agent error:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json(
      { error: "Internal server error" },
      500,
      ACTIONS_CORS_HEADERS,
    );
  }
});

// ═══ unpause-agent ══════════════════════════════════════════

emergency.options("/api/actions/unpause-agent", (c) => {
  return c.body(null, 200, ACTIONS_CORS_HEADERS);
});

emergency.get("/api/actions/unpause-agent", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json(
    {
      type: "action",
      icon: `${baseUrl}/icon.png`,
      title: "Unpause Agent",
      description:
        "Unpause a paused agent — restores its ability to execute actions. " +
        "Owner-only. Permissions and spend history are preserved.",
      label: "Unpause Agent",
    },
    200,
    ACTIONS_CORS_HEADERS,
  );
});

emergency.post("/api/actions/unpause-agent", async (c) => {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { buildUnpauseAgentTransaction } =
      await import("../lib/build-unpause-agent-tx");

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

    let agentToUnpause: InstanceType<typeof PublicKey>;
    try {
      agentToUnpause = new PublicKey(agentPubkeyStr);
    } catch {
      return c.json(
        { error: "Invalid 'agentPubkey': not a valid public key" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const vaultIdStr = c.req.query("vaultId");
    if (!vaultIdStr) {
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

    const { transaction, vaultAddress } = await buildUnpauseAgentTransaction({
      owner,
      agentToUnpause,
      vaultId,
    });

    const serialized = Buffer.from(transaction.serialize()).toString("base64");
    return c.json(
      {
        transaction: serialized,
        message: `Agent ${agentPubkeyStr} unpaused in vault ${vaultAddress}.`,
      },
      200,
      ACTIONS_CORS_HEADERS,
    );
  } catch (error) {
    console.error(
      "[Phalnx] unpause-agent error:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json(
      { error: "Internal server error" },
      500,
      ACTIONS_CORS_HEADERS,
    );
  }
});

export { emergency };
