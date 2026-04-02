import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  CrossmintWallet,
  crossmint,
  crossmintFromEnv,
  configFromEnv,
  validateConfig,
  CROSSMINT_ENV_KEYS,
  type CrossmintSDKClient,
  type CrossmintWalletConfig,
} from "../src/crossmint/index.js";

// ---------------------------------------------------------------------------
// Mock SDK client — simulates Crossmint API without real HTTP calls
// ---------------------------------------------------------------------------

/** A Keypair that acts as the "TEE-held" key in our mock. */
const teeKeypair = Keypair.generate();
const TEE_ADDRESS = teeKeypair.publicKey.toBase58();

function createMockClient(opts?: {
  failCreate?: boolean;
  failGet?: boolean;
  failSign?: boolean;
}): CrossmintSDKClient & { calls: { method: string; args: any[] }[] } {
  const calls: { method: string; args: any[] }[] = [];

  return {
    calls,

    async createWallet(params) {
      calls.push({ method: "createWallet", args: [params] });
      if (opts?.failCreate) {
        throw new Error("Mock: wallet creation failed");
      }
      return {
        address: TEE_ADDRESS,
        locator: `wallet:${TEE_ADDRESS}`,
      };
    },

    async getWallet(locator) {
      calls.push({ method: "getWallet", args: [locator] });
      if (opts?.failGet) {
        throw new Error("Mock: wallet lookup failed");
      }
      return { address: TEE_ADDRESS };
    },

    async signTransaction(locator, transaction, encoding) {
      calls.push({
        method: "signTransaction",
        args: [locator, transaction, encoding],
      });
      if (opts?.failSign) {
        throw new Error("Mock: signing failed");
      }

      // Decode the incoming transaction, sign with our TEE keypair, return
      // The adapter always sends base64; handle both for correctness
      const txBytes =
        encoding === "base64"
          ? Buffer.from(transaction, "base64")
          : Buffer.from(transaction, "base64"); // base58 not used in practice

      // Try legacy Transaction first, fall back to VersionedTransaction
      let signedBytes: Buffer;
      try {
        const legacyTx = Transaction.from(txBytes);
        legacyTx.partialSign(teeKeypair);
        signedBytes = Buffer.from(
          legacyTx.serialize({ requireAllSignatures: false }),
        );
      } catch {
        const vtx = VersionedTransaction.deserialize(txBytes);
        vtx.sign([teeKeypair]);
        signedBytes = Buffer.from(vtx.serialize());
      }

      return {
        signedTransaction: signedBytes.toString("base64"),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: create a minimal transaction for signing tests
// ---------------------------------------------------------------------------

function createTestTransaction(): Transaction {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: teeKeypair.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000_000,
    }),
  );
  tx.recentBlockhash = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
  tx.feePayer = teeKeypair.publicKey;
  return tx;
}

function createTestVersionedTransaction(): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: teeKeypair.publicKey,
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: teeKeypair.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 500_000,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

// ===========================================================================
// Tests
// ===========================================================================

describe("@usesigil/custody/crossmint", () => {
  // ---- Config & Validation ------------------------------------------------

  describe("config", () => {
    it("validateConfig throws on empty apiKey", () => {
      expect(() => validateConfig({ apiKey: "" })).to.throw(
        "apiKey is required",
      );
    });

    it("validateConfig throws on whitespace-only apiKey", () => {
      expect(() => validateConfig({ apiKey: "   " })).to.throw(
        "apiKey is required",
      );
    });

    it("validateConfig accepts a valid apiKey", () => {
      expect(() => validateConfig({ apiKey: "sk_test_123" })).to.not.throw();
    });
  });

  describe("configFromEnv", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore original env
      for (const key of Object.values(CROSSMINT_ENV_KEYS)) {
        if (originalEnv[key] !== undefined) {
          process.env[key] = originalEnv[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it("throws when CROSSMINT_API_KEY is missing", () => {
      delete process.env[CROSSMINT_ENV_KEYS.API_KEY];
      expect(() => configFromEnv()).to.throw("CROSSMINT_API_KEY");
    });

    it("parses minimal config (apiKey only)", () => {
      process.env[CROSSMINT_ENV_KEYS.API_KEY] = "sk_test_abc";
      const config = configFromEnv();
      expect(config.apiKey).to.equal("sk_test_abc");
      expect(config.locator).to.be.undefined;
      expect(config.signerType).to.be.undefined;
      expect(config.baseUrl).to.be.undefined;
    });

    it("parses full config from env", () => {
      process.env[CROSSMINT_ENV_KEYS.API_KEY] = "sk_test_full";
      process.env[CROSSMINT_ENV_KEYS.LOCATOR] = "wallet:abc123";
      process.env[CROSSMINT_ENV_KEYS.SIGNER_TYPE] = "api-key";
      process.env[CROSSMINT_ENV_KEYS.BASE_URL] =
        "https://staging.crossmint.com";
      process.env[CROSSMINT_ENV_KEYS.LINKED_USER] = "email:agent@test.com";

      const config = configFromEnv();
      expect(config.apiKey).to.equal("sk_test_full");
      expect(config.locator).to.equal("wallet:abc123");
      expect(config.signerType).to.equal("api-key");
      expect(config.baseUrl).to.equal("https://staging.crossmint.com");
      expect(config.linkedUser).to.equal("email:agent@test.com");
    });

    it("rejects invalid signer type", () => {
      process.env[CROSSMINT_ENV_KEYS.API_KEY] = "sk_test_invalid";
      process.env[CROSSMINT_ENV_KEYS.SIGNER_TYPE] = "bad-type";
      expect(() => configFromEnv()).to.throw("invalid");
    });
  });

  // ---- Wallet Creation ----------------------------------------------------

  describe("CrossmintWallet.create", () => {
    it("creates a new wallet when no locator provided", async () => {
      const client = createMockClient();
      const wallet = await CrossmintWallet.create(
        { apiKey: "sk_test_new" },
        client,
      );

      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
      expect(wallet.locator).to.equal(`wallet:${TEE_ADDRESS}`);
      expect(wallet.provider).to.equal("crossmint");
      expect(client.calls).to.have.length(1);
      expect(client.calls[0].method).to.equal("createWallet");
    });

    it("passes chain and signer type to createWallet", async () => {
      const client = createMockClient();
      await CrossmintWallet.create(
        { apiKey: "sk_test", chain: "solana", signerType: "api-key" },
        client,
      );

      const call = client.calls[0];
      expect(call.args[0].chain).to.equal("solana");
      expect(call.args[0].signer.type).to.equal("api-key");
    });

    it("passes linkedUser to createWallet", async () => {
      const client = createMockClient();
      await CrossmintWallet.create(
        { apiKey: "sk_test", linkedUser: "email:agent@test.com" },
        client,
      );

      expect(client.calls[0].args[0].linkedUser).to.equal(
        "email:agent@test.com",
      );
    });

    it("uses existing wallet when locator provided", async () => {
      const client = createMockClient();
      const wallet = await CrossmintWallet.create(
        { apiKey: "sk_test", locator: `wallet:${TEE_ADDRESS}` },
        client,
      );

      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
      expect(client.calls).to.have.length(1);
      expect(client.calls[0].method).to.equal("getWallet");
    });

    it("defaults chain to solana and signerType to api-key", async () => {
      const client = createMockClient();
      await CrossmintWallet.create({ apiKey: "sk_test" }, client);

      const call = client.calls[0];
      expect(call.args[0].chain).to.equal("solana");
      expect(call.args[0].signer.type).to.equal("api-key");
    });

    it("throws on wallet creation failure", async () => {
      const client = createMockClient({ failCreate: true });
      try {
        await CrossmintWallet.create({ apiKey: "sk_test" }, client);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("wallet creation failed");
      }
    });

    it("throws on wallet lookup failure", async () => {
      const client = createMockClient({ failGet: true });
      try {
        await CrossmintWallet.create(
          { apiKey: "sk_test", locator: "wallet:bad" },
          client,
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("wallet lookup failed");
      }
    });

    it("throws on empty apiKey", async () => {
      const client = createMockClient();
      try {
        await CrossmintWallet.create({ apiKey: "" }, client);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("apiKey is required");
      }
    });
  });

  // ---- Factory Functions --------------------------------------------------

  describe("crossmint() factory", () => {
    it("creates wallet via factory function", async () => {
      const client = createMockClient();
      const wallet = await crossmint({ apiKey: "sk_test_factory" }, client);

      expect(wallet).to.be.instanceOf(CrossmintWallet);
      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
    });
  });

  describe("crossmintFromEnv() factory", () => {
    const originalKey = process.env[CROSSMINT_ENV_KEYS.API_KEY];

    afterEach(() => {
      if (originalKey !== undefined) {
        process.env[CROSSMINT_ENV_KEYS.API_KEY] = originalKey;
      } else {
        delete process.env[CROSSMINT_ENV_KEYS.API_KEY];
      }
    });

    it("creates wallet from env vars", async () => {
      process.env[CROSSMINT_ENV_KEYS.API_KEY] = "sk_test_env";
      const client = createMockClient();
      const wallet = await crossmintFromEnv(client);

      expect(wallet).to.be.instanceOf(CrossmintWallet);
      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
    });

    it("throws when env var missing", async () => {
      delete process.env[CROSSMINT_ENV_KEYS.API_KEY];
      try {
        await crossmintFromEnv(createMockClient());
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("CROSSMINT_API_KEY");
      }
    });
  });

  // ---- WalletLike Contract ------------------------------------------------

  describe("WalletLike contract", () => {
    let wallet: CrossmintWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await CrossmintWallet.create({ apiKey: "sk_test_sign" }, client);
    });

    it("has publicKey property", () => {
      expect(wallet.publicKey).to.be.instanceOf(PublicKey);
      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
    });

    it("has signTransaction method", () => {
      expect(wallet.signTransaction).to.be.a("function");
    });

    it("has signAllTransactions method", () => {
      expect(wallet.signAllTransactions).to.be.a("function");
    });
  });

  // ---- Transaction Signing ------------------------------------------------

  describe("signTransaction (legacy)", () => {
    let wallet: CrossmintWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await CrossmintWallet.create({ apiKey: "sk_test" }, client);
    });

    it("signs a legacy Transaction", async () => {
      const tx = createTestTransaction();
      const signed = await wallet.signTransaction(tx);

      expect(signed).to.be.instanceOf(Transaction);
      // The mock client signs with teeKeypair, so the signature should be present
      expect(signed.signatures).to.have.length.greaterThan(0);
    });

    it("sends transaction to Crossmint API for signing", async () => {
      const tx = createTestTransaction();
      await wallet.signTransaction(tx);

      const signCall = client.calls.find((c) => c.method === "signTransaction");
      expect(signCall).to.exist;
      expect(signCall!.args[0]).to.equal(wallet.locator);
      expect(signCall!.args[2]).to.equal("base64");
    });

    it("throws on signing failure", async () => {
      const failClient = createMockClient({ failSign: true });
      const failWallet = await CrossmintWallet.create(
        { apiKey: "sk_test" },
        failClient,
      );

      const tx = createTestTransaction();
      try {
        await failWallet.signTransaction(tx);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("signing failed");
      }
    });
  });

  describe("signTransaction (versioned)", () => {
    let wallet: CrossmintWallet;

    beforeEach(async () => {
      const client = createMockClient();
      wallet = await CrossmintWallet.create({ apiKey: "sk_test" }, client);
    });

    it("signs a VersionedTransaction", async () => {
      const tx = createTestVersionedTransaction();
      const signed = await wallet.signTransaction(tx);

      expect(signed).to.be.instanceOf(VersionedTransaction);
      // VersionedTransaction.signatures is an array of Uint8Arrays
      expect(signed.signatures).to.have.length.greaterThan(0);
    });
  });

  describe("signAllTransactions", () => {
    let wallet: CrossmintWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await CrossmintWallet.create({ apiKey: "sk_test" }, client);
    });

    it("signs multiple transactions", async () => {
      const txs = [createTestTransaction(), createTestTransaction()];
      const signed = await wallet.signAllTransactions(txs);

      expect(signed).to.have.length(2);
      // Two signTransaction calls (one per tx) + one createWallet call
      const signCalls = client.calls.filter(
        (c) => c.method === "signTransaction",
      );
      expect(signCalls).to.have.length(2);
    });

    it("signs empty array", async () => {
      const signed = await wallet.signAllTransactions([]);
      expect(signed).to.have.length(0);
    });
  });

  // ---- shieldWallet() Compatibility ----------------------------------------

  describe("shieldWallet() compatibility", () => {
    it("CrossmintWallet satisfies WalletLike interface shape", async () => {
      const client = createMockClient();
      const wallet = await CrossmintWallet.create(
        { apiKey: "sk_test" },
        client,
      );

      // Structural type check: has publicKey + signTransaction
      const walletLike: {
        publicKey: PublicKey;
        signTransaction: Function;
        signAllTransactions?: Function;
      } = wallet;

      expect(walletLike.publicKey).to.be.instanceOf(PublicKey);
      expect(walletLike.signTransaction).to.be.a("function");
      expect(walletLike.signAllTransactions).to.be.a("function");
    });

    it("exposes provider metadata", async () => {
      const client = createMockClient();
      const wallet = await CrossmintWallet.create(
        { apiKey: "sk_test" },
        client,
      );

      expect(wallet.provider).to.equal("crossmint");
      expect(wallet.locator).to.be.a("string");
      expect(wallet.locator).to.include("wallet:");
    });
  });
});
