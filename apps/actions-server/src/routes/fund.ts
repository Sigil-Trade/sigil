import { Hono } from "hono";

const fund = new Hono();

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
fund.options("/api/actions/fund", (c) => {
  return c.body(null, 200, ACTIONS_CORS_HEADERS);
});

/**
 * GET /api/actions/fund — Returns Blink UI metadata for funding.
 * Query: destination, mint?, amount?
 */
fund.get("/api/actions/fund", (c) => {
  const destination = c.req.query("destination") || "";
  const mint = c.req.query("mint");
  const amount = c.req.query("amount");

  const tokenLabel = mint ? "tokens" : "SOL";
  const amountLabel = amount ? ` ${amount}` : "";

  const response = {
    type: "action",
    icon: `${new URL(c.req.url).origin}/icon.png`,
    title: "Fund Phalnx Wallet",
    description: `Send${amountLabel} ${tokenLabel} to Phalnx wallet ${destination ? destination.slice(0, 8) + "..." : ""}`,
    label: `Send ${tokenLabel}`,
  };

  return c.json(response, 200, ACTIONS_CORS_HEADERS);
});

/**
 * POST /api/actions/fund — Build unsigned transfer transaction.
 * Query: destination (required), mint? (omit for SOL), amount (required)
 * Body: { account: string } — sender's wallet
 */
fund.post("/api/actions/fund", async (c) => {
  try {
    const body = await c.req.json<{ account: string }>();

    if (!body.account) {
      return c.json(
        { error: "Missing 'account' in request body" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const destination = c.req.query("destination");
    if (!destination) {
      return c.json(
        { error: "Missing 'destination' query parameter" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const amountStr = c.req.query("amount");
    if (!amountStr) {
      return c.json(
        { error: "Missing 'amount' query parameter" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      return c.json(
        { error: "Invalid 'amount': must be a positive number" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const mint = c.req.query("mint");

    // Dynamic imports to keep cold start fast
    const {
      PublicKey,
      SystemProgram,
      Transaction,
      Connection,
      LAMPORTS_PER_SOL,
    } = await import("@solana/web3.js");

    let sender: InstanceType<typeof PublicKey>;
    try {
      sender = new PublicKey(body.account);
    } catch {
      return c.json(
        { error: "Invalid 'account': not a valid public key" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    let dest: InstanceType<typeof PublicKey>;
    try {
      dest = new PublicKey(destination);
    } catch {
      return c.json(
        { error: "Invalid 'destination': not a valid public key" },
        400,
        ACTIONS_CORS_HEADERS,
      );
    }

    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    const tx = new Transaction();

    if (mint) {
      // SPL token transfer
      let mintPubkey: InstanceType<typeof PublicKey>;
      try {
        mintPubkey = new PublicKey(mint);
      } catch {
        return c.json(
          { error: "Invalid 'mint': not a valid public key" },
          400,
          ACTIONS_CORS_HEADERS,
        );
      }

      const {
        getAssociatedTokenAddress,
        createTransferInstruction,
        createAssociatedTokenAccountIdempotentInstruction,
      } = await import("@solana/spl-token");

      // Assume 6 decimals (USDC) — the most common case
      const tokenAmount = Math.round(amount * 1_000_000);

      const senderAta = await getAssociatedTokenAddress(mintPubkey, sender);
      const destAta = await getAssociatedTokenAddress(mintPubkey, dest, true);

      // Create destination ATA if needed
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          sender,
          destAta,
          dest,
          mintPubkey,
        ),
      );

      tx.add(
        createTransferInstruction(senderAta, destAta, sender, tokenAmount),
      );
    } else {
      // SOL transfer
      const lamports = Math.round(amount * LAMPORTS_PER_SOL);
      tx.add(
        SystemProgram.transfer({
          fromPubkey: sender,
          toPubkey: dest,
          lamports,
        }),
      );
    }

    tx.feePayer = sender;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const serialized = tx
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    return c.json(
      {
        transaction: serialized,
        message: `Sending ${amount} ${mint ? "tokens" : "SOL"} to ${destination.slice(0, 8)}...`,
      },
      200,
      ACTIONS_CORS_HEADERS,
    );
  } catch (error) {
    console.error("[Phalnx] fund error:", error);
    return c.json(
      { error: "Internal server error" },
      500,
      ACTIONS_CORS_HEADERS,
    );
  }
});

export { fund };
