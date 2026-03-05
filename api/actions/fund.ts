import type { VercelRequest, VercelResponse } from "@vercel/node";

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

function setCors(res: VercelResponse) {
  Object.entries(ACTIONS_CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
}

function handleGet(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  const url = new URL(req.url!, `https://${req.headers.host}`);
  const destination = url.searchParams.get("destination") || "";
  const mint = url.searchParams.get("mint");
  const amount = url.searchParams.get("amount");

  const tokenLabel = mint ? "tokens" : "SOL";
  const amountLabel = amount ? ` ${amount}` : "";

  return res.status(200).json({
    type: "action",
    icon: `${url.origin}/icon.png`,
    title: "Fund Phalnx Wallet",
    description: `Send${amountLabel} ${tokenLabel} to Phalnx wallet ${destination ? destination.slice(0, 8) + "..." : ""}`,
    label: `Send ${tokenLabel}`,
  });
}

async function handlePost(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  try {
    const body = req.body as { account?: string };
    if (!body?.account) {
      return res
        .status(400)
        .json({ error: "Missing 'account' in request body" });
    }

    const url = new URL(req.url!, `https://${req.headers.host}`);
    const destination = url.searchParams.get("destination");
    if (!destination) {
      return res
        .status(400)
        .json({ error: "Missing 'destination' query parameter" });
    }

    const amountStr = url.searchParams.get("amount");
    if (!amountStr) {
      return res
        .status(400)
        .json({ error: "Missing 'amount' query parameter" });
    }

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid 'amount': must be a positive number" });
    }

    const mint = url.searchParams.get("mint");

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
      return res
        .status(400)
        .json({ error: "Invalid 'account': not a valid public key" });
    }

    let dest: InstanceType<typeof PublicKey>;
    try {
      dest = new PublicKey(destination);
    } catch {
      return res
        .status(400)
        .json({ error: "Invalid 'destination': not a valid public key" });
    }

    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    const tx = new Transaction();

    if (mint) {
      let mintPubkey: InstanceType<typeof PublicKey>;
      try {
        mintPubkey = new PublicKey(mint);
      } catch {
        return res
          .status(400)
          .json({ error: "Invalid 'mint': not a valid public key" });
      }

      const {
        getAssociatedTokenAddress,
        createTransferInstruction,
        createAssociatedTokenAccountIdempotentInstruction,
      } = await import("@solana/spl-token");

      const tokenAmount = Math.round(amount * 1_000_000);
      const senderAta = await getAssociatedTokenAddress(mintPubkey, sender);
      const destAta = await getAssociatedTokenAddress(mintPubkey, dest, true);

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

    return res.status(200).json({
      transaction: serialized,
      message: `Sending ${amount} ${mint ? "tokens" : "SOL"} to ${destination.slice(0, 8)}...`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(200).end();
  }

  if (req.method === "GET") {
    return handleGet(req, res);
  }

  if (req.method === "POST") {
    return handlePost(req, res);
  }

  setCors(res);
  return res.status(405).json({ error: "Method not allowed" });
}
