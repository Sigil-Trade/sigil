import { expect } from "chai";
import {
  BlockhashCache,
  sendAndConfirmTransaction,
  signAndEncode,
} from "../src/rpc-helpers.js";
import type {
  Rpc,
  SolanaRpcApi,
  Base64EncodedWireTransaction,
  TransactionSigner,
} from "@solana/kit";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from "@solana/kit";

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
      const sig = await sendAndConfirmTransaction(
        rpc,
        "base64encodedtx" as Base64EncodedWireTransaction,
      );
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
        await sendAndConfirmTransaction(
          rpc,
          "base64encodedtx" as Base64EncodedWireTransaction,
          {
            timeoutMs: 2_000,
          },
        );
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
        await sendAndConfirmTransaction(
          rpc,
          "base64encodedtx" as Base64EncodedWireTransaction,
          {
            timeoutMs: 100,
            pollIntervalMs: 20,
          },
        );
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

      const sig = await sendAndConfirmTransaction(
        rpc,
        "base64encodedtx" as Base64EncodedWireTransaction,
      );
      expect(sig).to.be.a("string");
    });
  });

  describe("signAndEncode", () => {
    const BLOCKHASH = {
      blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
      lastValidBlockHeight: 1000n,
    } as const;

    function mockIx(): Instruction {
      return {
        programAddress:
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Instruction["programAddress"],
        accounts: [],
        data: new Uint8Array([1, 2, 3]),
      };
    }

    /** Build a compiled transaction whose fee payer is `signer`. */
    async function compiledTxFor(signer: TransactionSigner) {
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayerSigner(signer as any, tx),
        (tx) =>
          setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH as any, tx),
        (tx) => appendTransactionMessageInstructions([mockIx()], tx),
      );
      return compileTransaction(message as any);
    }

    // Regression: a @solana/kit KeyPairSigner is a TransactionPartialSigner —
    // its signTransactions() returns a SignatureDictionary, NOT a signed
    // transaction. The old signAndEncode fed that dictionary to the encoder and
    // threw "Cannot read properties of undefined (reading 'length')".
    it("signs + encodes with a KeyPairSigner (partial signer)", async () => {
      const signer = await generateKeyPairSigner();
      const compiledTx = await compiledTxFor(signer);

      const wire = await signAndEncode(signer, compiledTx);

      expect(wire).to.be.a("string");
      expect(wire.length).to.be.greaterThan(40);
      // Byte-identical to signing the same compiled tx via the canonical
      // message path would require a message (not a compiled tx); here we just
      // assert a non-empty, decodable wire transaction was produced.
    });

    // A TransactionModifyingSigner returns the signed transaction object
    // directly. signAndEncode must still handle it (it delegates to
    // signTransactionWithSigners, which applies modifying signers first).
    it("signs + encodes with a TransactionModifyingSigner", async () => {
      const inner = await generateKeyPairSigner();
      const compiledTx = await compiledTxFor(inner);

      // Wrap the keypair signer as a modifying signer: modifyAndSignTransactions
      // partial-signs each tx with the inner keypair and returns the signed tx.
      const { partiallySignTransaction } = await import("@solana/kit");
      const modifyingSigner = {
        address: inner.address,
        modifyAndSignTransactions: async (txs: readonly unknown[]) =>
          Promise.all(
            txs.map((t) => partiallySignTransaction([inner.keyPair], t as any)),
          ),
      } as unknown as TransactionSigner;

      const wire = await signAndEncode(modifyingSigner, compiledTx);
      expect(wire).to.be.a("string");
      expect(wire.length).to.be.greaterThan(40);
    });

    it("rejects a signer implementing neither sign method", async () => {
      const inner = await generateKeyPairSigner();
      const compiledTx = await compiledTxFor(inner);
      const bogus = { address: inner.address } as unknown as TransactionSigner;

      try {
        await signAndEncode(bogus, compiledTx);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(String(e.message)).to.match(/signTransactions|sign method/i);
      }
    });

    it("rejects when signatures are missing (wrong signer for fee payer)", async () => {
      // Fee payer is `feePayerSigner`, but we sign with a DIFFERENT keypair —
      // the required fee-payer signature is never produced, so the result is
      // not fully signed and signAndEncode surfaces the domain error.
      const feePayerSigner = await generateKeyPairSigner();
      const wrongSigner = await generateKeyPairSigner();
      const compiledTx = await compiledTxFor(feePayerSigner);

      try {
        await signAndEncode(wrongSigner, compiledTx);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(String(e.message)).to.match(/fully-signed|sign/i);
      }
    });

    it("produces a wire tx that round-trips against the canonical signer path", async () => {
      // Equivalence check: signAndEncode(KeyPairSigner, compiledTx) must match
      // signing the SAME compiled tx via signTransactionWithSigners directly.
      const signer = await generateKeyPairSigner();
      const compiledTx = await compiledTxFor(signer);

      const viaHelper = await signAndEncode(signer, compiledTx);

      const { signTransactionWithSigners } = await import("@solana/kit");
      const signed = await signTransactionWithSigners(
        [signer],
        compiledTx as any,
      );
      const viaCanonical = getBase64EncodedWireTransaction(signed as any);

      expect(viaHelper).to.equal(viaCanonical);
    });
  });
});
