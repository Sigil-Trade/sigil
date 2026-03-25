/**
 * Kit-native RPC helpers for Phalnx SDK.
 *
 * - BlockhashCache: Caches getLatestBlockhash with configurable TTL
 * - signAndEncode: Sign a compiled TX + encode to base64 wire format
 * - sendAndConfirmTransaction: Send + poll getSignatureStatuses
 */

import type { Rpc, SolanaRpcApi, Commitment, Base64EncodedWireTransaction, TransactionSigner } from "@solana/kit";
import { getBase64EncodedWireTransaction } from "@solana/kit";

/** Typed shape of a getSignatureStatuses value entry. */
interface SignatureStatusValue {
  err: unknown;
  confirmationStatus: string;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Blockhash {
  blockhash: string;
  lastValidBlockHeight: bigint;
}

export interface SendAndConfirmOptions {
  /** Max time to wait for confirmation (ms). Default: 30_000 */
  timeoutMs?: number;
  /** Poll interval (ms). Default: 1_000 */
  pollIntervalMs?: number;
  /** Confirmation commitment. Default: "confirmed" */
  commitment?: Commitment;
}

// ─── BlockhashCache ─────────────────────────────────────────────────────────

const DEFAULT_BLOCKHASH_TTL_MS = 30_000;

export class BlockhashCache {
  private cached: Blockhash | null = null;
  private fetchedAt = 0;
  private readonly ttlMs: number;

  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_BLOCKHASH_TTL_MS;
  }

  /**
   * Get a blockhash, returning cached value if still within TTL.
   */
  async get(rpc: Rpc<SolanaRpcApi>): Promise<Blockhash> {
    const now = Date.now();
    if (this.cached && now - this.fetchedAt < this.ttlMs) {
      return this.cached;
    }
    return this.refresh(rpc);
  }

  /**
   * Force a fresh blockhash fetch regardless of TTL.
   */
  invalidate(): void {
    this.cached = null;
    this.fetchedAt = 0;
  }

  private async refresh(rpc: Rpc<SolanaRpcApi>): Promise<Blockhash> {
    const result = await rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();

    const value = result.value as {
      blockhash: string;
      lastValidBlockHeight: bigint;
    };
    this.cached = {
      blockhash: value.blockhash,
      lastValidBlockHeight: value.lastValidBlockHeight,
    };
    this.fetchedAt = Date.now();
    return this.cached;
  }
}

// ─── signAndEncode ───────────────────────────────────────────────────────────

/**
 * Sign a compiled transaction and encode to base64 wire format.
 *
 * Handles Kit's TransactionSigner interface which may expose
 * `modifyAndSignTransactions` or `signTransactions` (both accept/return arrays).
 *
 * @returns Base64-encoded wire transaction ready for sendTransaction RPC.
 */
export async function signAndEncode(
  signer: TransactionSigner,
  compiledTx: unknown,
): Promise<Base64EncodedWireTransaction> {
  const signerTyped = signer as TransactionSigner & {
    modifyAndSignTransactions?: (...args: unknown[]) => Promise<unknown[]>;
    signTransactions?: (...args: unknown[]) => Promise<unknown[]>;
  };
  const signFn = signerTyped.modifyAndSignTransactions ?? signerTyped.signTransactions;
  if (typeof signFn !== "function") {
    throw new Error(
      "Signer must implement signTransactions() or modifyAndSignTransactions()",
    );
  }
  const results = await signFn.call(signerTyped, [compiledTx]);
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("signTransactions returned invalid result: expected non-empty array");
  }
  const [signedTx] = results;
  return getBase64EncodedWireTransaction(
    signedTx as Parameters<typeof getBase64EncodedWireTransaction>[0],
  );
}

// ─── sendAndConfirmTransaction ──────────────────────────────────────────────

/**
 * Send a base64-encoded transaction and poll for confirmation.
 * Throws on timeout or confirmed failure.
 */
export async function sendAndConfirmTransaction(
  rpc: Rpc<SolanaRpcApi>,
  encodedTransaction: Base64EncodedWireTransaction,
  options?: SendAndConfirmOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 1_000;
  const commitment = options?.commitment ?? "confirmed";

  // Send the transaction
  const signature = await rpc
    .sendTransaction(
      encodedTransaction,
      {
        encoding: "base64" as const,
        skipPreflight: false,
        preflightCommitment: commitment,
      },
    )
    .send();

  // Poll for confirmation
  const deadline = Date.now() + timeoutMs;
  let delay = pollIntervalMs;

  while (Date.now() < deadline) {
    const statusResult = await rpc
      .getSignatureStatuses([signature])
      .send();

    const statuses = (statusResult as unknown as { value: readonly (SignatureStatusValue | null)[] }).value;
    if (statuses && statuses[0]) {
      const status = statuses[0];

      // Check for error
      if (status.err) {
        throw new Error(
          `Transaction ${signature} failed: ${JSON.stringify(status.err)}`,
        );
      }

      // Check for sufficient confirmation
      const level = status.confirmationStatus;
      if (
        level === "confirmed" ||
        level === "finalized" ||
        (commitment === "processed" && level === "processed")
      ) {
        return signature as string;
      }
    }

    // Exponential backoff: 1s → 1.5s → 2.25s → ...
    await sleep(delay);
    delay = Math.min(delay * (1.3 + Math.random() * 0.4), 5_000);
  }

  throw new Error(
    `Transaction ${signature} confirmation timed out after ${timeoutMs}ms`,
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
