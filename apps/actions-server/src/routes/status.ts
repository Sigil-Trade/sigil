import { Hono } from "hono";

const status = new Hono();

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

/**
 * GET /api/actions/status/:sig — Poll transaction confirmation.
 * Heavy deps loaded dynamically.
 */
status.get("/api/actions/status/:sig", async (c) => {
  const sig = c.req.param("sig");

  if (!sig) {
    return c.json({ status: "not_found", error: "Missing signature" }, 400);
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
      return c.json({ status: "pending" });
    }

    if (txStatus.value.err) {
      return c.json({
        status: "not_found",
        error: `Transaction failed: ${JSON.stringify(txStatus.value.err)}`,
      });
    }

    if (
      txStatus.value.confirmationStatus === "confirmed" ||
      txStatus.value.confirmationStatus === "finalized"
    ) {
      // Try to extract vault address from the transaction
      let vaultAddress: string | undefined;
      try {
        const tx = await connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
        });
        if (tx?.transaction.message) {
          const keys = tx.transaction.message.getAccountKeys();
          // The vault PDA is typically the 2nd account in the initializeVault
          // instruction. We look for accounts owned by the program.
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
        // Non-critical — vault address is nice-to-have
      }

      return c.json({
        status: "confirmed",
        vaultAddress,
      });
    }

    return c.json({ status: "pending" });
  } catch (error) {
    console.error("[Phalnx] status error:", error);
    return c.json({ status: "not_found", error: "Internal server error" }, 500);
  }
});

export { status };
