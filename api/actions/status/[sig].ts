import type { VercelRequest, VercelResponse } from "@vercel/node";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { sig } = req.query;

  if (!sig || typeof sig !== "string") {
    return res
      .status(400)
      .json({ status: "not_found", error: "Missing signature" });
  }

  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const { PHALNX_PROGRAM_ID } = await import("@phalnx/sdk");

    const PROGRAM_ID = process.env.PHALNX_PROGRAM_ID
      ? new PublicKey(process.env.PHALNX_PROGRAM_ID)
      : PHALNX_PROGRAM_ID;

    const connection = new Connection(RPC_URL, "confirmed");
    const txStatus = await connection.getSignatureStatus(sig, {
      searchTransactionHistory: true,
    });

    if (!txStatus.value) {
      return res.status(200).json({ status: "pending" });
    }

    if (txStatus.value.err) {
      return res.status(200).json({
        status: "not_found",
        error: `Transaction failed: ${JSON.stringify(txStatus.value.err)}`,
      });
    }

    if (
      txStatus.value.confirmationStatus === "confirmed" ||
      txStatus.value.confirmationStatus === "finalized"
    ) {
      let vaultAddress: string | undefined;
      try {
        const tx = await connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
        });
        if (tx?.transaction.message) {
          const keys = tx.transaction.message.getAccountKeys();
          for (let i = 0; i < keys.length; i++) {
            const key = keys.get(i);
            if (key) {
              const info = await connection.getAccountInfo(key);
              if (info?.owner.equals(PROGRAM_ID)) {
                vaultAddress = key.toBase58();
                break;
              }
            }
          }
        }
      } catch {
        // Non-critical
      }

      return res.status(200).json({ status: "confirmed", vaultAddress });
    }

    return res.status(200).json({ status: "pending" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ status: "not_found", error: message });
  }
}
