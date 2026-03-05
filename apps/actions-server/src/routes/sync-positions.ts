import { Hono } from "hono";

const syncPositions = new Hono();

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
syncPositions.options("/api/actions/sync-positions", (c) => {
  return c.body(null, 200, ACTIONS_CORS_HEADERS);
});

/**
 * GET /api/actions/sync-positions — Returns Blink UI metadata.
 */
syncPositions.get("/api/actions/sync-positions", (c) => {
  const baseUrl = new URL(c.req.url).origin;

  const response = {
    type: "action",
    icon: `${baseUrl}/icon.png`,
    title: "Sync Position Counter",
    description:
      "Correct your vault's open position counter to match actual Flash Trade state. " +
      "Use this when keeper-executed TP/SL fills or limit order fills have caused the counter to drift. " +
      "Owner-only — agents cannot sync positions.",
    label: "Sync Positions",
  };

  return c.json(response, 200, ACTIONS_CORS_HEADERS);
});

/**
 * POST /api/actions/sync-positions — Builds unsigned sync_positions tx.
 * Body: { account: string }
 * Query: vaultId (required), actualPositions (required)
 */
syncPositions.post("/api/actions/sync-positions", async (c) => {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { buildSyncPositionsTransaction } =
      await import("../lib/build-sync-positions-tx");

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

    const actualStr = c.req.query("actualPositions");
    if (actualStr === undefined || actualStr === null || actualStr === "") {
      return c.json(
        { error: "Missing 'actualPositions' query parameter" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const actualPositions = parseInt(actualStr, 10);
    if (
      isNaN(actualPositions) ||
      actualPositions < 0 ||
      actualPositions > 255
    ) {
      return c.json(
        { error: "Invalid 'actualPositions': must be 0-255" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const { transaction, vaultAddress } = await buildSyncPositionsTransaction({
      owner,
      vaultId,
      actualPositions,
    });

    const serialized = Buffer.from(transaction.serialize()).toString("base64");

    return c.json(
      {
        transaction: serialized,
        message: `Position counter synced to ${actualPositions} for vault ${vaultAddress}.`,
      },
      200,
      ACTIONS_CORS_HEADERS,
    );
  } catch (error) {
    console.error(
      "[Phalnx] sync-positions error:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json(
      { error: "Internal server error" },
      500,
      ACTIONS_CORS_HEADERS,
    );
  }
});

export { syncPositions };
