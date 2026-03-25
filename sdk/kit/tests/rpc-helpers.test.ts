import { expect } from "chai";
import {
  BlockhashCache,
  sendAndConfirmTransaction,
} from "../src/rpc-helpers.js";
import type { Rpc, SolanaRpcApi, Base64EncodedWireTransaction } from "@solana/kit";

// ─── Mock RPC Factory ───────────────────────────────────────────────────────

const MOCK_BLOCKHASH_1 = {
  blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
  lastValidBlockHeight: 1000n,
};

const MOCK_BLOCKHASH_2 = {
  blockhash: "7XYZB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
  lastValidBlockHeight: 2000n,
};

let fetchCount = 0;
let blockhashToReturn = MOCK_BLOCKHASH_1;

function createMockRpc(overrides?: {
  sendTransaction?: (tx: string) => string;
  getSignatureStatuses?: () => { value: unknown[] };
}): Rpc<SolanaRpcApi> {
  return {
    getLatestBlockhash: () => ({
      send: async () => {
        fetchCount++;
        return { value: blockhashToReturn };
      },
    }),
    sendTransaction: (...args: unknown[]) => ({
      send: async () => {
        if (overrides?.sendTransaction) {
          return overrides.sendTransaction(args[0] as string);
        }
        return "5wHu1qwD7y5B7TFDx5UKo2KRDwfJpJdHnnRr8KeUQBJGG2ZxVjktjDqfUzE6jR2Kv8Zj";
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        if (overrides?.getSignatureStatuses) {
          return overrides.getSignatureStatuses();
        }
        return {
          value: [{ confirmationStatus: "confirmed", err: null }],
        };
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("rpc-helpers", () => {
  describe("BlockhashCache", () => {
    beforeEach(() => {
      fetchCount = 0;
      blockhashToReturn = MOCK_BLOCKHASH_1;
    });

    it("returns cached blockhash within TTL", async () => {
      const cache = new BlockhashCache(5_000);
      const rpc = createMockRpc();

      const first = await cache.get(rpc);
      const second = await cache.get(rpc);

      expect(first.blockhash).to.equal(MOCK_BLOCKHASH_1.blockhash);
      expect(second.blockhash).to.equal(MOCK_BLOCKHASH_1.blockhash);
      expect(fetchCount).to.equal(1); // Only one RPC call
    });

    it("refetches after TTL expiry", async () => {
      const cache = new BlockhashCache(1); // 1ms TTL
      const rpc = createMockRpc();

      await cache.get(rpc);
      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 10));
      blockhashToReturn = MOCK_BLOCKHASH_2;
      const second = await cache.get(rpc);

      expect(second.blockhash).to.equal(MOCK_BLOCKHASH_2.blockhash);
      expect(fetchCount).to.equal(2);
    });

    it("invalidate() forces refetch on next get()", async () => {
      const cache = new BlockhashCache(60_000); // long TTL
      const rpc = createMockRpc();

      await cache.get(rpc);
      expect(fetchCount).to.equal(1);

      cache.invalidate();
      blockhashToReturn = MOCK_BLOCKHASH_2;
      const result = await cache.get(rpc);

      expect(result.blockhash).to.equal(MOCK_BLOCKHASH_2.blockhash);
      expect(fetchCount).to.equal(2);
    });

    it("uses default 30s TTL when not specified", async () => {
      const cache = new BlockhashCache();
      const rpc = createMockRpc();

      const first = await cache.get(rpc);
      const second = await cache.get(rpc);

      expect(first.blockhash).to.equal(second.blockhash);
      expect(fetchCount).to.equal(1);
    });
  });

  describe("sendAndConfirmTransaction", () => {
    it("returns signature on successful confirmation", async () => {
      const rpc = createMockRpc();
      const sig = await sendAndConfirmTransaction(rpc, "base64encodedtx" as Base64EncodedWireTransaction);
      expect(sig).to.be.a("string");
      expect(sig.length).to.be.greaterThan(0);
    });

    it("throws on confirmed failure (err present)", async () => {
      const rpc = createMockRpc({
        getSignatureStatuses: () => ({
          value: [
            {
              confirmationStatus: "confirmed",
              err: { InstructionError: [0, "Custom"] },
            },
          ],
        }),
      });

      try {
        await sendAndConfirmTransaction(rpc, "base64encodedtx" as Base64EncodedWireTransaction, {
          timeoutMs: 2_000,
        });
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("failed");
      }
    });

    it("throws on timeout when status never confirms", async () => {
      const rpc = createMockRpc({
        getSignatureStatuses: () => ({
          value: [null],
        }),
      });

      try {
        await sendAndConfirmTransaction(rpc, "base64encodedtx" as Base64EncodedWireTransaction, {
          timeoutMs: 100,
          pollIntervalMs: 20,
        });
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("timed out");
      }
    });

    it("accepts finalized status as confirmed", async () => {
      const rpc = createMockRpc({
        getSignatureStatuses: () => ({
          value: [{ confirmationStatus: "finalized", err: null }],
        }),
      });

      const sig = await sendAndConfirmTransaction(rpc, "base64encodedtx" as Base64EncodedWireTransaction);
      expect(sig).to.be.a("string");
    });
  });
});
